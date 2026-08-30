// 待辦收件匣：聚合工作流閘門／對話危險指令／看板 blocked／群聊 @ 我／上限超額，一頁處理。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBox, Loading } from '../../components/QueryState'
import '../../guide/i18n'
import type { StudioModule } from '../registry'

export interface InboxItem {
  id: string
  kind: 'workflow_gate' | 'chat_approval' | 'kanban_blocked' | 'groupchat_mention' | 'limit_exceeded' | string
  ref_id: string
  ref?: string
  title: string
  detail: string
  agent: string
  created_at: string | null
  link: string
  actions: string[]
  api: Record<string, string>
  run_id?: string
  session_id?: string
}
export interface InboxData { items: InboxItem[]; count: number; by_kind: Record<string, number>; warnings: string[] }

const json = (b: unknown) => JSON.stringify(b)
export const inboxApi = {
  list: (kind?: string) => request<InboxData>(`/inbox${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`),
  count: () => request<{ count: number; by_kind: Record<string, number> }>('/inbox/count'),
  post: (path: string, body?: unknown) => request<unknown>(path, { method: 'POST', body: body === undefined ? undefined : json(body) }),
}
export const inboxQk = ['inbox'] as const
/** 給導覽 badge 用：每 30 秒更新 */
export const useInboxCount = () => useQuery({ queryKey: [...inboxQk, 'count'], queryFn: inboxApi.count, refetchInterval: 30_000 })

const KINDS = ['workflow_gate', 'chat_approval', 'kanban_blocked', 'groupchat_mention', 'limit_exceeded'] as const
const KIND_COLOR: Record<string, string> = {
  workflow_gate: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
  chat_approval: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  kanban_blocked: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  groupchat_mention: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  limit_exceeded: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
}

function fmtTime(s: string | null) {
  if (!s) return ''
  const d = new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z')
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

function Item({ it, onDone }: { it: InboxItem; onDone: () => void }) {
  const { t } = useTranslation()
  const nav = useNavigate()
  const [comment, setComment] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => inboxApi.post(path, body),
    onSuccess: onDone,
    onError: (e: Error) => setErr(e.message),
  })
  const doneBody = it.api.done === '/inbox/done' ? { ref: it.ref ?? it.id } : undefined
  const kindLabel = t(`inbox.kind.${it.kind}`, { defaultValue: it.kind })
  return (
    <li className="card p-3" data-testid={`inbox-${it.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${KIND_COLOR[it.kind] ?? 'bg-zinc-200 dark:bg-zinc-800'}`}>{kindLabel}</span>
            {it.agent && <code className="text-[11px] text-zinc-600 dark:text-zinc-400">{it.agent}</code>}
            <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{fmtTime(it.created_at)}</span>
          </div>
          <div className="mt-1 font-medium">{it.title}</div>
          {it.detail && (
            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
              <pre className={`whitespace-pre-wrap break-words font-sans ${open ? '' : 'line-clamp-3'}`}>{it.detail}</pre>
              {it.detail.length > 160 && (
                <button className="btn-ghost mt-1 px-1 py-0 text-[11px]" onClick={() => setOpen(!open)}>{open ? t('inbox.less') : t('inbox.more')}</button>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {(it.actions.includes('approve') || it.actions.includes('reject')) && (
            <input className="input w-56" placeholder={t('inbox.commentPh')} aria-label={t('inbox.comment')} value={comment} onChange={(e) => setComment(e.target.value)} />
          )}
          <div className="flex flex-wrap justify-end gap-1">
            {it.actions.includes('approve') && (
              <button className="btn-primary" disabled={act.isPending} onClick={() => act.mutate({ path: it.api.approve, body: { comment } })}>{t('inbox.approve')}</button>
            )}
            {it.actions.includes('reject') && (
              <button className="btn-danger" disabled={act.isPending} onClick={() => act.mutate({ path: it.api.reject, body: { comment } })}>{t('inbox.reject')}</button>
            )}
            {['once', 'session', 'always', 'deny'].filter((d) => it.actions.includes(d)).map((d) => (
              <button key={d} className={d === 'deny' ? 'btn-danger' : 'btn-outline'} disabled={act.isPending}
                onClick={() => act.mutate({ path: it.api.resolve, body: { decision: d } })}>{t(`inbox.decision.${d}`)}</button>
            ))}
            {it.actions.includes('done') && (
              <button className="btn-outline" disabled={act.isPending} onClick={() => act.mutate({ path: it.api.done, body: doneBody })}>{t('inbox.done')}</button>
            )}
            {it.actions.includes('goto') && it.link && (
              <button className="btn-ghost" onClick={() => nav(it.link)}>{t('inbox.goto')}</button>
            )}
          </div>
          {err && <div className="text-xs text-rose-600 dark:text-rose-400">{err}</div>}
        </div>
      </div>
    </li>
  )
}

export function InboxPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [kind, setKind] = useState<string>('')
  const q = useQuery({ queryKey: [...inboxQk, 'list'], queryFn: () => inboxApi.list(), refetchInterval: 30_000 })
  const refresh = () => { qc.invalidateQueries({ queryKey: inboxQk }) }
  const items = (q.data?.items ?? []).filter((x) => !kind || x.kind === kind)
  return (
    <div className="p-4">
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')}
        actions={<button className="btn-outline" onClick={refresh}>{t('inbox.refresh')}</button>} />
      <div className="mb-3 flex flex-wrap gap-1 text-xs">
        <button className={`btn-outline ${!kind ? 'bg-zinc-200 dark:bg-zinc-800' : ''}`} onClick={() => setKind('')}>
          {t('inbox.all')} <span className="rounded-full bg-zinc-300 px-1.5 dark:bg-zinc-700">{q.data?.count ?? 0}</span>
        </button>
        {KINDS.map((k) => (
          <button key={k} className={`btn-outline ${kind === k ? 'bg-zinc-200 dark:bg-zinc-800' : ''}`} onClick={() => setKind(kind === k ? '' : k)} data-testid={`filter-${k}`}>
            {t(`inbox.kind.${k}`)} <span className="rounded-full bg-zinc-300 px-1.5 dark:bg-zinc-700">{q.data?.by_kind?.[k] ?? 0}</span>
          </button>
        ))}
      </div>
      {q.data?.warnings?.length ? <div className="mb-2 text-xs text-amber-700 dark:text-amber-300">{q.data.warnings.join('；')}</div> : null}
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && items.length === 0 && <EmptyState testId="empty-inbox" title={t('guide.empty.inbox.title')} body={t('guide.empty.inbox.body')} action={{ label: t('guide.empty.inbox.action'), to: '/workflows' }} />}
      <ul className="space-y-2">{items.map((it) => <Item key={it.id} it={it} onDone={refresh} />)}</ul>
    </div>
  )
}

const zhTW = {
  nav: { inbox: '收件匣' },
  inbox: {
    title: '待辦收件匣', subtitle: '所有需要人決定的事：工作流閘門、對話危險指令、看板卡住、群聊點名、用量超額', refresh: '重新整理',
    all: '全部', empty: '沒有待辦，太好了。', more: '展開', less: '收合', comment: '意見', commentPh: '核准／退回意見（選填）',
    approve: '核准', reject: '退回', done: '已處理', goto: '前往',
    kind: { workflow_gate: '工作流閘門', chat_approval: '危險指令', kanban_blocked: '看板卡住', groupchat_mention: '群聊點名', limit_exceeded: '用量超額', notice: '通知' },
    decision: { once: '允許一次', session: '本次對話允許', always: '永遠允許', deny: '拒絕' },
  },
}
const en = {
  nav: { inbox: 'Inbox' },
  inbox: {
    title: 'Inbox', subtitle: 'Everything that needs a human decision', refresh: 'Refresh',
    all: 'All', empty: 'Nothing pending.', more: 'More', less: 'Less', comment: 'Comment', commentPh: 'Comment (optional)',
    approve: 'Approve', reject: 'Reject', done: 'Done', goto: 'Open',
    kind: { workflow_gate: 'Workflow gate', chat_approval: 'Dangerous command', kanban_blocked: 'Kanban blocked', groupchat_mention: 'Mention', limit_exceeded: 'Limit exceeded', notice: 'Notice' },
    decision: { once: 'Allow once', session: 'Allow this session', always: 'Always allow', deny: 'Deny' },
  },
}

const mod: StudioModule = {
  name: 'inbox',
  routes: [{ path: '/inbox', element: <InboxPage /> }],
  nav: [{ to: '/inbox', key: 'inbox', order: 15, group: 'work', icon: 'Inbox' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
