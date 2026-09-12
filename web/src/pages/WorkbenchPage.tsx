import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../components/EmptyState'
import { CollapsiblePanel, WorkArea } from '../components/layout/index'
import { useIsMobile } from '../components/nav/useNavState'
import { DocPanel, type PendingUpdate } from '../modules/docs/DocPanel'
import { docsApi, stripDocFence } from '../modules/docs/api'
import '../guide/i18n'
import { useQueryClient } from '@tanstack/react-query'
import { useAgents } from '../api/hooks'
import {
  useCategories, useCategoryMutations, useChatMessages, useChatSessions, useCreateChatSession, useDeleteChatSession, useHermesSources,
  usePatchSession, useSetSessionModel, type Attachment, type ChatSession, type SearchHit,
} from '../api/sessions'
import type { Agent, ApprovalDecision, WsServerEvent } from '../api/types'
import { Composer } from '../components/chat/Composer'
import { FilePreview } from '../components/preview'
import { HermesHistoryList, HermesHistoryView } from '../components/chat/HermesHistoryView'
import { MessageList } from '../components/chat/MessageList'
import { ModelBadge, ModelPicker } from '../components/chat/ModelPicker'
import { SearchPalette } from '../components/chat/SearchPalette'
import { SessionSidebar } from '../components/chat/SessionSidebar'
import { Empty, ErrorBox, Loading } from '../components/QueryState'
import { RuntimeBadge, isCoding } from '../components/agents/RuntimeBadge'
import { useChatSocket } from '../ws/chatSocket'
import { useEngineerMode } from '../prefs/engineerMode'
import { addUserMessage, applyEvent, dropLastTurn, emptyChat, fromMessages, markApprovalDecided, type ChatState, type TextItem } from '../ws/chatState'

const fmt = (s?: string) => (s ? new Date(s).toLocaleString() : '—')

const AGENTS_OPEN_KEY = 'mhc.workbench.agents'

export function WorkbenchPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const agentsQ = useAgents()
  // 工程師模式關：右欄只留老闆看得懂的（連線、員工、來源、時間、訊息數、用量）
  const engineer = useEngineerMode()
  // 手機：清單優先。沒選對話就整頁是「員工＋對話」清單；選了才進聊天室，左上角「‹ 對話」回清單
  const isMobile = useIsMobile()
  const [agentId, setAgentId] = useState<string | undefined>()
  const [agentsOpen, setAgentsOpenState] = useState<boolean>(() => {
    try { return localStorage.getItem(AGENTS_OPEN_KEY) !== '0' } catch { return true }
  })
  const setAgentsOpen = (fn: (v: boolean) => boolean) => setAgentsOpenState((v) => {
    const next = fn(v)
    try { localStorage.setItem(AGENTS_OPEN_KEY, next ? '1' : '0') } catch { /* 私密視窗 */ }
    return next
  })
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [hermesView, setHermesView] = useState<{ profile: string; id: string } | undefined>()
  const [openHermesProfile, setOpenHermesProfile] = useState<string | undefined>()
  const [showArchived, setShowArchived] = useState(false)
  const sessionsQ = useChatSessions(agentId, showArchived)
  const messagesQ = useChatMessages(sessionId)
  const categoriesQ = useCategories()
  const hermesSourcesQ = useHermesSources()
  const createSession = useCreateChatSession()
  const deleteSession = useDeleteChatSession()
  const patchSession = usePatchSession()
  const setModel = useSetSessionModel()
  const catMut = useCategoryMutations()

  // UI 狀態
  const [reply, setReply] = useState<TextItem | undefined>()
  const [editing, setEditing] = useState<TextItem | undefined>()
  const [previewPath, setPreviewPath] = useState<string | undefined>()
  const [docPending, setDocPending] = useState<Record<string, PendingUpdate | undefined>>({})
  const [docBusy, setDocBusy] = useState(false)
  const [external, setExternal] = useState<Attachment[] | undefined>()
  const [searchOpen, setSearchOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [catManager, setCatManager] = useState(false)

  // 每個 session 一份聊天狀態，切換不丟串流中的內容
  const [chats, setChats] = useState<Record<string, ChatState>>({})
  const chat: ChatState = (sessionId ? chats[sessionId] : undefined) ?? emptyChat()
  const update = useCallback((sid: string, fn: (s: ChatState) => ChatState) => {
    setChats((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? emptyChat()) }))
  }, [])

  // 首次選 agent
  useEffect(() => {
    if (!agentId && agentsQ.data?.length) setAgentId(agentsQ.data.find((a) => a.enabled)?.id ?? agentsQ.data[0].id)
  }, [agentsQ.data, agentId])

  // Ctrl/⌘+K 開搜尋
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen((o) => !o) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // 載入歷史訊息：每個 session 只合併一次；若使用者已先送出訊息，歷史接在前面
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
      // 綁了文件的對話：AI 每一輪都可能產出新版本，右側文件面板要跟著亮起來
      if (ev.type === 'doc.updated') {
        const e = ev as unknown as { doc_id: string; version: number; summary?: string; diff_stat?: { added: number; removed: number } }
        setDocPending((prev) => ({ ...prev, [e.doc_id]: { version: e.version, summary: e.summary, diff_stat: e.diff_stat } }))
        qc.invalidateQueries({ queryKey: ['docs'] })
        return
      }
      if (!ev.session_id) return
      update(ev.session_id, (s) => applyEvent(s, ev))
      if (ev.type === 'run.started' || ev.type === 'run.completed' || ev.type === 'run.failed' || ev.type === 'run.cancelled') {
        qc.invalidateQueries({ queryKey: ['sessions'] })
      }
    },
    [update, qc],
  )
  const { status, send } = useChatSocket(onEvent)

  // ---- 動作 ---------------------------------------------------------------
  const sendMessage = (text: string, attachments: Attachment[], replyTo?: string) => {
    if (!sessionId || chat.running) return false
    const ok = send({ type: 'run', session_id: sessionId, input: text, attachments, reply_to: replyTo } as never)
    if (ok) {
      update(sessionId, (s) => addUserMessage(s, text || '（請看附件）', { attachments, reply_to: replyTo }))
      setReply(undefined)
    }
    return ok
  }
  const stop = () => chat.runId && send({ type: 'stop', run_id: chat.runId })
  const steer = (text: string) => !!chat.runId && send({ type: 'steer', run_id: chat.runId, input: text })
  const decide = (runId: string, approvalId: string, d: ApprovalDecision) => {
    if (send({ type: 'approval', run_id: runId, decision: d, approval_id: approvalId }) && sessionId) {
      update(sessionId, (s) => markApprovalDecided(s, approvalId, d))
    }
  }
  const regenerate = () => {
    if (!sessionId || chat.running) return
    if (send({ type: 'regenerate', session_id: sessionId } as never)) update(sessionId, (s) => dropLastTurn(s, false))
  }
  const submitEdit = (text: string) => {
    if (!sessionId || !editing || chat.running) return false
    const ok = send({ type: 'edit', session_id: sessionId, input: text, message_id: editing.message_id } as never)
    if (ok) {
      update(sessionId, (s) => addUserMessage(dropLastTurn(s, true), text, { attachments: editing.attachments, reply_to: editing.reply_to }))
      setEditing(undefined)
    }
    return ok
  }

  const selectSession = (id: string) => {
    setSessionId(id)
    setHermesView(undefined)
    setReply(undefined)
    setEditing(undefined)
  }
  /** 手機「‹ 對話」：清掉選取，回到清單 */
  const backToList = () => {
    setSessionId(undefined)
    setHermesView(undefined)
    setReply(undefined)
    setEditing(undefined)
  }
  const newSession = async () => {
    if (!agentId) return
    const s = await createSession.mutateAsync({ agent_id: agentId })
    selectSession(s.id)
  }
  const removeSession = async (s: ChatSession) => {
    if (!window.confirm(t('chat.confirmDelete'))) return
    await deleteSession.mutateAsync(s.id)
    if (sessionId === s.id) setSessionId(undefined)
  }
  const renameSession = async (s: ChatSession) => {
    const title = window.prompt(t('chat.rename.prompt'), s.title ?? '')
    if (title && title.trim()) await patchSession.mutateAsync({ id: s.id, body: { title: title.trim() } })
  }
  const pickSearch = (h: SearchHit) => {
    if (h.session.agent_id !== agentId) setAgentId(h.session.agent_id)
    selectSession(h.session.id)
  }

  const agent = agentsQ.data?.find((a) => a.id === agentId)
  const session = sessionsQ.data?.find((s) => s.id === sessionId)
  const docId = session?.doc_id || ''

  /** 把這個對話變成「經營一份文件」：建一份 HTML 文件並綁上去。
   *  綁上之後每一輪 AI 都會拿到文件全文，並用 ```doc 圍欄回完整新版（見後端 docs/chat_link）。 */
  // 綁了文件時對話裡不重複貼整份文件：圍欄內容後端已抽掉，串流中的用前端再擋一次
  const chatItems = useMemo(
    () => (docId ? chat.items.map((it) => (it.kind === 'text' && it.role === 'assistant' ? { ...it, content: stripDocFence(it.content) } : it)) : chat.items),
    [chat.items, docId],
  )

  const openDoc = async () => {
    if (!session || docId || docBusy) return
    setDocBusy(true)
    try {
      const d = await docsApi.create({ title: session.title || t('workbench.untitled'), origin: 'chat', format: 'html' })
      await patchSession.mutateAsync({ id: session.id, body: { doc_id: d.id } })
      await qc.invalidateQueries({ queryKey: ['docs'] })
    } finally {
      setDocBusy(false)
    }
  }
  const usage = chat.sessionUsage ?? session?.usage

  const sidebar = (
    <>
      {/* 員工清單可收合：收起時只留標題＋目前選的員工，把高度讓給對話清單；狀態記在 localStorage */}
      <button
        type="button"
        className="panel-title flex w-full items-center gap-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
        aria-expanded={agentsOpen}
        aria-label={t('workbench.agentsToggle')}
        onClick={() => setAgentsOpen((v) => !v)}
        data-testid="workbench-agents-toggle"
      >
        <span className="w-3 shrink-0 text-center">{agentsOpen ? '▾' : '▸'}</span>
        <span className="min-w-0 truncate">{t('workbench.agents')}</span>
        {!agentsOpen && agent && <span className="min-w-0 truncate font-normal normal-case tracking-normal text-zinc-700 dark:text-zinc-300">· {agent.name}</span>}
        <span className="badge ml-auto bg-zinc-200 px-1 text-2xs font-normal dark:bg-zinc-700">{agentsQ.data?.length ?? 0}</span>
      </button>
      {agentsOpen && (
      <div className="max-h-[32%] overflow-auto px-2" data-testid="workbench-agents-list">
        {agentsQ.isLoading && <Loading />}
        {agentsQ.error && <ErrorBox error={agentsQ.error} onRetry={() => agentsQ.refetch()} />}
        {agentsQ.data?.map((a) => (
          <AgentRow key={a.id} agent={a} active={a.id === agentId} onClick={() => { setAgentId(a.id); setSessionId(undefined); setHermesView(undefined) }} />
        ))}
      </div>
      )}
      {!agentId && <Empty text={t('workbench.noAgent')} />}
      {sessionsQ.isLoading && <Loading />}
      <SessionSidebar
        sessions={sessionsQ.data ?? []}
        categories={categoriesQ.data ?? []}
        activeId={sessionId}
        onSelect={selectSession}
        onNew={newSession}
        newDisabled={!agentId || createSession.isPending}
        onRename={renameSession}
        onDelete={removeSession}
        onArchive={(s, archived) => patchSession.mutate({ id: s.id, body: { archived } })}
        onAssignCategory={(s, cid) => patchSession.mutate({ id: s.id, body: { category_id: cid ?? '' } })}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
        onManageCategories={() => setCatManager(true)}
        onOpenSearch={() => setSearchOpen(true)}
        hermes={{
          sources: hermesSourcesQ.data,
          active: hermesView,
          openProfile: openHermesProfile,
          onOpenGroup: (p) => setOpenHermesProfile((cur) => (cur === p ? undefined : p)),
          children: openHermesProfile ? (
            <HermesHistoryList profile={openHermesProfile} active={hermesView} onOpen={(s) => { setHermesView({ profile: s.profile, id: s.id }); setSessionId(undefined) }} />
          ) : null,
        }}
      />
    </>
  )

  const conversationOpen = !!sessionId || !!hermesView
  // 手機：清單與聊天室二選一；桌面兩邊都在
  const showList = !isMobile || !conversationOpen
  const showChat = !isMobile || conversationOpen

  return (
    <div className="relative flex h-full min-h-0 w-full">
      {/* 左：AI 員工 + 對話（手機沒選對話時就是整頁） */}
      {showList && (
      <div className={isMobile ? 'contents' : 'hidden md:contents'}>
        <CollapsiblePanel
          id="workbench.left"
          side="left"
          title={t('panels.agents')}
          icon="Users"
          defaultWidth={260}
          min={200}
          max={440}
          bodyClassName="flex flex-col overflow-hidden"
          mobileMode="inline"
          data-testid="sidebar-desktop"
        >
          {sidebar}
        </CollapsiblePanel>
      </div>
      )}

      {/* 中：聊天（永遠 min-w-0，側欄再寬也擠不扁） */}
      {showChat && (
      <WorkArea>
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-1.5 text-xs dark:border-zinc-800">
          {isMobile && (
            <button type="button" className="btn-ghost shrink-0 !px-1.5" onClick={backToList} aria-label={t('panels.backToSessions')} data-testid="mobile-back">
              ‹ {t('panels.backToSessions')}
            </button>
          )}
          <span className="min-w-0 truncate font-medium">{hermesView ? t('chat.hermes.title') : session?.title ?? agent?.name ?? ''}</span>
          {session && !hermesView && (
            docId ? (
              <span className="badge shrink-0 bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200" data-testid="doc-bound">
                {t('docs.workbench.bound')}
              </span>
            ) : (
              <button
                type="button"
                className="btn-ghost shrink-0 !px-2 !py-0.5 text-xs"
                onClick={() => void openDoc()}
                disabled={docBusy}
                title={t('docs.workbench.openHint')}
                data-testid="workbench-open-doc"
              >
                + {t('docs.workbench.open')}
              </button>
            )
          )}
          {session && (
            <div className="relative ml-auto shrink-0">
              <ModelBadge model={session.model} fallback={agent?.model} usage={usage} onClick={() => setPickerOpen((o) => !o)} />
              {pickerOpen && (
                <div className="absolute right-0">
                  <ModelPicker
                    profile={agent?.profile}
                    value={session.model}
                    onChange={(model, provider) => setModel.mutate({ id: session.id, model, provider })}
                    onClose={() => setPickerOpen(false)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        {hermesView ? (
          <HermesHistoryView profile={hermesView.profile} id={hermesView.id} onOpenFile={setPreviewPath} onImported={(id) => { if (agentId) qc.invalidateQueries({ queryKey: ['sessions'] }); selectSession(id) }} />
        ) : !sessionId ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState testId="empty-sessions" title={t('guide.empty.sessions.title')} body={t('guide.empty.sessions.body')} action={{ label: t('guide.empty.sessions.action'), onClick: () => void newSession(), disabled: !agentId || createSession.isPending }} />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-auto">
              {messagesQ.isLoading && !chats[sessionId] && <Loading />}
              {messagesQ.error && <ErrorBox error={messagesQ.error} onRetry={() => messagesQ.refetch()} />}
              {chat.items.length === 0 && !messagesQ.isLoading && (
                <div className="p-8 text-center text-sm text-zinc-600 dark:text-zinc-400">{t('workbench.emptyChat', { name: agent?.name ?? '' })}</div>
              )}
              <MessageList
                items={chatItems}
                onDecide={decide}
                running={chat.running}
                actions={{ onOpenFile: setPreviewPath, onReply: (it) => { setReply(it); setEditing(undefined) }, onEdit: (it) => { setEditing(it); setReply(undefined) }, onRegenerate: regenerate }}
              />
            </div>
            <Composer
              sessionId={sessionId}
              disabled={status !== 'open'}
              running={chat.running}
              onSend={sendMessage}
              onStop={() => void stop()}
              onSteer={steer}
              reply={reply}
              onCancelReply={() => setReply(undefined)}
              editing={editing}
              onCancelEdit={() => setEditing(undefined)}
              onSubmitEdit={submitEdit}
              compression={chat.compression}
              externalAttachments={external}
              onConsumeExternal={() => setExternal(undefined)}
            />
          </>
        )}
      </WorkArea>
      )}

      {/* 右：預覽 or session 資訊（<lg 時預覽用覆蓋層） */}
      {previewPath && (
        <aside className="fixed inset-0 z-30 flex flex-col bg-white lg:static lg:z-auto lg:w-2/5 lg:min-w-[360px] lg:max-w-[560px] lg:shrink-0 lg:border-l lg:border-zinc-200 dark:bg-zinc-900 dark:lg:border-zinc-800">
          <FilePreview
            source={{ kind: 'path', path: previewPath }}
            onClose={() => setPreviewPath(undefined)}
            onOpenFile={setPreviewPath}
            actions={
              sessionId ? (
                <button
                  type="button"
                  className="btn-ghost !px-1.5 !py-0.5 text-xs"
                  onClick={() => setExternal([{ name: previewPath.split('/').pop() ?? previewPath, path: previewPath, mime: '', size: 0 }])}
                >
                  {t('chat.preview.attach')}
                </button>
              ) : undefined
            }
          />
        </aside>
      )}
      {/* 綁了文件的對話：右側讓給文件本身。系統以文件為核心，session 資訊不該擋在前面。 */}
      {!previewPath && docId && showChat && (
        <div className={isMobile ? 'contents' : 'hidden lg:contents'}>
          <CollapsiblePanel
            id="workbench.doc"
            side="right"
            title={t('docs.panel.title')}
            icon="FileText"
            defaultWidth={420}
            min={320}
            max={720}
            bodyClassName="flex flex-col overflow-hidden"
            mobileMode="sheet"
            data-testid="workbench-doc-panel"
          >
            <DocPanel
              docId={docId}
              pending={docPending[docId]}
              onAccept={() => setDocPending((prev) => ({ ...prev, [docId]: undefined }))}
              compact
            />
          </CollapsiblePanel>
        </div>
      )}
      {!previewPath && !docId && (
        <div className="hidden lg:contents">
        <CollapsiblePanel
          id="workbench.right"
          side="right"
          title={engineer ? t('workbench.sessionInfo') : t('workbench.sessionInfoPlain')}
          icon="Info"
          defaultWidth={300}
          min={220}
          max={480}
          mobileMode="hidden"
          data-testid="session-info"
        >
          <dl className="space-y-2 px-3 pb-3 text-xs">
            <Info k={t('workbench.wsStatus')}>
              <span className={`inline-block h-2 w-2 rounded-full ${status === 'open' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-500' : 'bg-zinc-400'}`} />{' '}
              {status === 'open' ? t('workbench.wsConnected') : status === 'connecting' ? t('workbench.wsConnecting') : t('workbench.wsDisconnected')}
            </Info>
            <Info k={t('workbench.agent')}>{agent?.name ?? '—'}</Info>
            {engineer && (
              <Info k={agent && isCoding(agent) ? t('agents.workspace') : t('workbench.profile')}>
                <code className="break-all">{(agent && isCoding(agent) ? agent.workspace : agent?.profile) || '—'}</code>
              </Info>
            )}
            {agent && isCoding(agent) && <Info k={t('agents.runtime')}><RuntimeBadge agent={agent} /></Info>}
            {engineer && <Info k={t('workbench.model')}>{session?.model || agent?.model || '—'}{session && !session.model && <span className="text-zinc-600 dark:text-zinc-400"> ({t('chat.model.default')})</span>}</Info>}
            {engineer && <Info k={t('workbench.sessionId')}><code className="break-all">{session?.id ?? '—'}</code></Info>}
            <Info k={t('workbench.source')}>{session?.source ?? '—'}</Info>
            <Info k={t('workbench.createdAt')}>{fmt(session?.created_at)}</Info>
            <Info k={t('workbench.updatedAt')}>{fmt(session?.last_message_at ?? session?.updated_at)}</Info>
            <Info k={t('workbench.messages')}>{chat.items.filter((i) => i.kind === 'text').length}</Info>
            {engineer && <Info k={t('workbench.runId')}><code className="break-all">{chat.runId ?? '—'}</code></Info>}
            {usage && (
              <Info k={engineer ? t('chat.info.tokens') : t('workbench.usage')}>
                <div>{t('chat.info.inTok')} {usage.input_tokens} · {t('chat.info.outTok')} {usage.output_tokens}</div>
                <div>Σ {usage.total_tokens} · {t('chat.info.ctxTok')} {usage.context_tokens}</div>
              </Info>
            )}
            {engineer && chat.usage && <Info k={t('workbench.usage')}><pre className="whitespace-pre-wrap">{JSON.stringify(chat.usage, null, 1)}</pre></Info>}
          </dl>
        </CollapsiblePanel>
        </div>
      )}

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} onPick={pickSearch} />
      {catManager && (
        <CategoryManager
          categories={categoriesQ.data ?? []}
          onClose={() => setCatManager(false)}
          onCreate={(name, color) => catMut.create.mutate({ name, color })}
          onRename={(id, name) => catMut.patch.mutate({ id, body: { name } })}
          onDelete={(id) => { if (window.confirm(t('chat.category.confirmDelete'))) catMut.remove.mutate(id) }}
        />
      )}
    </div>
  )
}

function CategoryManager({ categories, onClose, onCreate, onRename, onDelete }: {
  categories: { id: string; name: string; color: string }[]
  onClose: () => void
  onCreate: (name: string, color: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [color, setColor] = useState('#fde68a')
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose} data-testid="category-manager">
      <div className="card w-full max-w-sm p-4 text-sm shadow-xl" role="dialog" aria-label={t('chat.category.title')} onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between font-medium">
          <span>{t('chat.category.title')}</span>
          <button type="button" className="btn-ghost text-xs" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>
        <ul className="mb-3 space-y-1">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <span className="h-3 w-3 rounded" style={{ background: c.color || '#e4e4e7' }} />
              <span className="flex-1">{c.name}</span>
              <button type="button" className="btn-ghost text-xs" onClick={() => { const n = window.prompt(t('chat.rename.prompt'), c.name); if (n?.trim()) onRename(c.id, n.trim()) }}>{t('common.edit')}</button>
              <button type="button" className="btn-ghost text-xs text-rose-600 dark:text-rose-400" onClick={() => onDelete(c.id)}>{t('common.delete')}</button>
            </li>
          ))}
          {categories.length === 0 && <li className="text-xs text-zinc-600 dark:text-zinc-400">{t('common.empty')}</li>}
        </ul>
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { onCreate(name.trim(), color); setName('') } }}>
          <input className="input" placeholder={t('chat.category.newName')} value={name} onChange={(e) => setName(e.target.value)} aria-label={t('chat.category.newName')} />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label={t('chat.category.color')} className="h-8 w-10 cursor-pointer rounded border border-zinc-300 dark:border-zinc-700" />
          <button type="submit" className="btn-primary" disabled={!name.trim()}>{t('chat.category.add')}</button>
        </form>
      </div>
    </div>
  )
}

function Info({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-zinc-600 dark:text-zinc-400">{k}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

function AgentRow({ agent, active, onClick }: { agent: Agent; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        active ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
      } ${agent.enabled ? '' : 'opacity-50'}`}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-200">
        {agent.avatar || agent.name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium">{agent.name}</span>
          {isCoding(agent) && <RuntimeBadge agent={agent} />}
        </span>
        <span className="block truncate text-xs text-zinc-600 dark:text-zinc-400">
          {isCoding(agent) ? agent.workspace || '—' : agent.title || agent.profile}
        </span>
      </span>
    </button>
  )
}
