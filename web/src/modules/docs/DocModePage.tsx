// /doc-mode：工作臺的「文件模式」。左文件清單、中央文件、右側對話。
// 文件在視線正中央是刻意的：這個系統以文件為核心，對話是編輯它的手段，不是主角。
//
// 使用者的心智模型：一個對話串的核心就是完成一份文件；不停對話＝不停更新這份文件。
// 所以這裡每個對話都綁一份 doc：AI 每輪用 ```doc 圍欄回完整新版 → 後端建版本 → WS 推 doc.updated →
// 右邊面板亮出「新版本」條與 diff，人可以「接受」（確認）或「還原上一版」。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useAgents } from '../../api/hooks'
import { useChatMessages, useCreateChatSession, type Attachment, type ChatSession } from '../../api/sessions'
import type { ApprovalDecision, WsServerEvent } from '../../api/types'
import { Composer } from '../../components/chat/Composer'
import { MessageList } from '../../components/chat/MessageList'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { useChatSocket } from '../../ws/chatSocket'
import {
  addUserMessage, applyEvent, emptyChat, fromMessages, markApprovalDecided,
  type ChatItem, type ChatState,
} from '../../ws/chatState'
import { DocPanel, type PendingUpdate } from './DocPanel'
import { docsApi, stripDocFence, useDocs, useDocSessions, type Doc } from './api'

export function DocModePage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const docsQ = useDocs()
  const sessionsQ = useDocSessions()
  const agentsQ = useAgents()
  const createSession = useCreateChatSession()

  const [docId, setDocId] = useState(params.get('doc') ?? '')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [agentId, setAgentId] = useState<string | undefined>()
  const [pending, setPending] = useState<Record<string, PendingUpdate>>({})
  const [newTitle, setNewTitle] = useState('')
  const messagesQ = useChatMessages(sessionId)

  useEffect(() => {
    if (!agentId && agentsQ.data?.length) setAgentId(agentsQ.data.find((a) => a.enabled)?.id ?? agentsQ.data[0].id)
  }, [agentsQ.data, agentId])

  // 這份文件已經有的對話（session.doc_id）；沒有就開一個
  const sessionForDoc = useMemo<ChatSession | undefined>(
    () => (docId ? (sessionsQ.data ?? []).find((s) => s.doc_id === docId) : undefined),
    [sessionsQ.data, docId],
  )
  useEffect(() => {
    setSessionId(sessionForDoc?.id)
  }, [sessionForDoc?.id, docId])

  const [chats, setChats] = useState<Record<string, ChatState>>({})
  const chat: ChatState = (sessionId ? chats[sessionId] : undefined) ?? emptyChat()
  const update = useCallback((sid: string, fn: (s: ChatState) => ChatState) => {
    setChats((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? emptyChat()) }))
  }, [])

  const historyLoaded = useRef(new Set<string>())
  useEffect(() => {
    if (!sessionId || !messagesQ.data || historyLoaded.current.has(sessionId)) return
    historyLoaded.current.add(sessionId)
    const history = fromMessages(messagesQ.data)
    setChats((prev) => {
      const local = prev[sessionId]
      return { ...prev, [sessionId]: local ? { ...local, items: [...history.items, ...local.items] } : history }
    })
  }, [sessionId, messagesQ.data])

  const onEvent = useCallback(
    (ev: WsServerEvent) => {
      if (ev.type === 'doc.updated') {
        const e = ev as unknown as { doc_id: string; version: number; summary?: string; diff_stat?: { added: number; removed: number } }
        setPending((p) => ({ ...p, [e.doc_id]: { version: e.version, summary: e.summary, diff_stat: e.diff_stat } }))
        qc.invalidateQueries({ queryKey: ['docs'] })
        return
      }
      if (ev.type === 'doc.patch_failed') {
        const e = ev as unknown as { session_id?: string; reason?: string }
        if (e.session_id) {
          update(e.session_id, (s) => ({
            ...s,
            items: [...s.items, { kind: 'notice', id: `dp-${Date.now()}`, level: 'info', text: t('docs.mode.patchFailed', { reason: e.reason ?? '' }) }],
          }))
        }
        return
      }
      if (!ev.session_id) return
      update(ev.session_id, (s) => applyEvent(s, ev))
      if (ev.type.startsWith('run.')) qc.invalidateQueries({ queryKey: ['sessions'] })
    },
    [update, qc, t],
  )
  const { status, send } = useChatSocket(onEvent)

  const pickDoc = (id: string) => {
    setDocId(id)
    setParams(id ? { doc: id } : {}, { replace: true })
  }

  const startChat = async () => {
    if (!agentId || !docId) return
    const s = await createSession.mutateAsync({ agent_id: agentId, doc_id: docId, title: docsQ.data?.find((d) => d.id === docId)?.title })
    await sessionsQ.refetch()
    setSessionId(s.id)
  }

  const createDoc = async () => {
    const title = newTitle.trim()
    if (!title || !agentId) return
    const d: Doc = await docsApi.create({ title, origin: 'chat' })
    setNewTitle('')
    await qc.invalidateQueries({ queryKey: ['docs'] })
    pickDoc(d.id)
    const s = await createSession.mutateAsync({ agent_id: agentId, doc_id: d.id, title })
    await sessionsQ.refetch()
    setSessionId(s.id)
  }

  const sendMessage = (text: string, attachments: Attachment[], replyTo?: string) => {
    if (!sessionId || chat.running) return false
    const ok = send({ type: 'run', session_id: sessionId, input: text, attachments, reply_to: replyTo } as never)
    if (ok) update(sessionId, (s) => addUserMessage(s, text, { attachments, reply_to: replyTo }))
    return ok
  }
  const decide = (runId: string, approvalId: string, d: ApprovalDecision) => {
    if (send({ type: 'approval', run_id: runId, decision: d, approval_id: approvalId }) && sessionId) {
      update(sessionId, (s) => markApprovalDecided(s, approvalId, d))
    }
  }

  // 對話裡不重複貼整份文件：圍欄內容在後端已抽掉，串流中的用前端再擋一次
  const items: ChatItem[] = useMemo(
    () => chat.items.map((it) => (it.kind === 'text' && it.role === 'assistant' ? { ...it, content: stripDocFence(it.content) } : it)),
    [chat.items],
  )

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)_minmax(340px,32%)]" data-testid="doc-mode-page">
      {/* 左：文件清單 */}
      <aside className="flex min-h-0 flex-col overflow-auto border-r border-zinc-200 dark:border-zinc-800">
        <div className="panel-title">{t('docs.mode.docs')}</div>
        <div className="flex items-center gap-1 px-2 pb-2">
          <input className="input h-7 text-xs" placeholder={t('docs.newTitle')} aria-label={t('docs.newTitle')} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} data-testid="doc-mode-new-title" />
          <button type="button" className="btn-primary !px-2 !py-1 text-xs" disabled={!newTitle.trim()} onClick={() => void createDoc()} data-testid="doc-mode-new">
            {t('docs.new')}
          </button>
        </div>
        {docsQ.isLoading && <Loading />}
        {docsQ.error && <ErrorBox error={docsQ.error} onRetry={() => docsQ.refetch()} />}
        {docsQ.data?.length === 0 && <Empty text={t('docs.empty')} />}
        <ul className="space-y-0.5 px-2 pb-2">
          {(docsQ.data ?? []).map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${d.id === docId ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}
                onClick={() => pickDoc(d.id)}
                data-testid={`doc-pick-${d.id}`}
              >
                <span className="block truncate font-medium">{d.title}</span>
                <span className="block truncate text-xs text-zinc-600 dark:text-zinc-400">
                  v{d.latest_version ?? 0} · {t(`docs.status.${d.status}`)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* 中：文件（主角） */}
      <section className="flex min-h-0 flex-col overflow-hidden">
        {docId ? (
          <DocPanel docId={docId} pending={pending[docId]} onAccept={() => setPending((p) => ({ ...p, [docId]: undefined as unknown as PendingUpdate }))} />
        ) : (
          <div className="p-6 text-center text-xs text-zinc-600 dark:text-zinc-400">{t('docs.mode.pickDoc')}</div>
        )}
      </section>
      {/* 右：對話 */}
      <section className="flex min-h-0 flex-col border-l border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
          <span className="min-w-0 flex-1 truncate font-medium">{docsQ.data?.find((d) => d.id === docId)?.title ?? t('docs.mode.pickDoc')}</span>
          <select className="input h-6 w-36 py-0 text-xs" aria-label={t('workbench.agent')} value={agentId ?? ''} onChange={(e) => setAgentId(e.target.value)} data-testid="doc-mode-agent">
            {(agentsQ.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <span className={`inline-block h-2 w-2 rounded-full ${status === 'open' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-500' : 'bg-zinc-400'}`} title={status} />
        </div>
        {!docId ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-zinc-600 dark:text-zinc-400" data-testid="doc-mode-empty">
            {t('docs.mode.hint')}
          </div>
        ) : !sessionId ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
            <p className="text-zinc-600 dark:text-zinc-400">{t('docs.mode.noSession')}</p>
            <button type="button" className="btn-primary" disabled={!agentId || createSession.isPending} onClick={() => void startChat()} data-testid="doc-mode-start">
              {t('docs.mode.start')}
            </button>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-auto">
              {messagesQ.isLoading && !chats[sessionId] && <Loading />}
              {items.length === 0 && !messagesQ.isLoading && (
                <div className="p-8 text-center text-sm text-zinc-600 dark:text-zinc-400">{t('docs.mode.firstTurn')}</div>
              )}
              <MessageList items={items} onDecide={decide} running={chat.running} actions={{}} />
            </div>
            <Composer
              sessionId={sessionId}
              disabled={status !== 'open'}
              running={chat.running}
              onSend={sendMessage}
              onStop={() => {
                if (chat.runId) send({ type: 'stop', run_id: chat.runId })
              }}
              onSteer={(text) => !!chat.runId && send({ type: 'steer', run_id: chat.runId, input: text })}
              onCancelReply={() => undefined}
              onCancelEdit={() => undefined}
              onSubmitEdit={() => false}
            />
          </>
        )}
      </section>

    </div>
  )
}
