// 待辦收件匣：聚合流程等你看／對話危險指令／看板 blocked／群聊 @ 我／上限超額。
// 2026-09 起併進「今天」頁的「等你決定」卡：這裡只留資料層、單筆列、篩選面板（InboxPanel）；
// /inbox 路由保留但直接轉到 /today，頂欄 badge 連過來還是對的；側欄不再列它。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate } from 'react-router-dom'
import { request } from '../../api/client'
import { useAgents } from '../../api/hooks'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBox, Loading } from '../../components/QueryState'
import { fmtWhen } from '../../lib/format'
import { useEngineerMode } from '../../prefs/engineerMode'
import '../../guide/i18n'
import type { StudioModule } from '../registry'

export interface InboxItem {
  id: string
  kind: 'workflow_gate' | 'chat_approval' | 'kanban_blocked' | 'groupchat_mention' | 'limit_exceeded' | string
  ref_id: string
  ref?: string
  title: string
  detail: string
  /** Hermes profile id（例：researcher），不是員工名字；畫面上要換成員工名 */
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
/** 清單本體；今天頁與 /inbox 面板共用同一把 key，核准後兩邊一起更新 */
export const useInboxList = () => useQuery({ queryKey: [...inboxQk, 'list'], queryFn: () => inboxApi.list(), refetchInterval: 30_000 })

export const KINDS = ['workflow_gate', 'chat_approval', 'kanban_blocked', 'groupchat_mention', 'limit_exceeded'] as const
const KIND_COLOR: Record<string, string> = {
  workflow_gate: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
  chat_approval: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  kanban_blocked: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  groupchat_mention: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  limit_exceeded: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
}

/**
 * profile id → 員工名。找不到：工程師模式給原始 id，老闆模式給「AI 員工」（他不需要知道 profile 這個字）。
 * 空字串回空，畫面不佔位。
 */
export function useStaffName(): (profile?: string | null) => string {
  const { t } = useTranslation()
  const agents = useAgents()
  const engineer = useEngineerMode()
  return (profile) => {
    if (!profile) return ''
    const hit = (agents.data ?? []).find((a) => a.profile === profile || a.id === profile)
    if (hit?.name) return hit.name
    // 員工清單還沒回來就先留白，免得先閃一下「AI 員工」再換成名字
    if (!agents.data && agents.isPending) return ''
    return engineer ? profile : t('inbox.staffFallback')
  }
}

/** 單筆待辦列；/today 的「等你決定」也用這一個，避免兩套核准按鈕 */
export function InboxRow({ it, onDone }: { it: InboxItem; onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const nav = useNavigate()
  const staffName = useStaffName()
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
  const who = staffName(it.agent)
  return (
    <li className="card p-3" data-testid={`inbox-${it.id}`}>
      {/* 手機上下堆疊（文字先、按鈕後），桌機才左右分欄；避免 390px 時標題被擠成一字一行 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${KIND_COLOR[it.kind] ?? 'bg-zinc-200 dark:bg-zinc-800'}`}>{kindLabel}</span>
            {who && <span className="text-xs text-zinc-700 dark:text-zinc-300" data-testid={`inbox-${it.id}-staff`}>{who}</span>}
            <span className="text-xs text-zinc-600 dark:text-zinc-400" data-testid={`inbox-${it.id}-when`}>{fmtWhen(it.created_at, new Date(), i18n.language)}</span>
          </div>
          <div className="mt-1 font-medium">{it.title}</div>
          {it.detail && (
            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
              <pre className={`whitespace-pre-wrap break-words font-sans ${open ? '' : 'line-clamp-3'}`}>{it.detail}</pre>
              {it.detail.length > 160 && (
                <button className="btn-ghost mt-1 px-1 py-0 text-xs" onClick={() => setOpen(!open)}>{open ? t('inbox.less') : t('inbox.more')}</button>
              )}
            </div>
          )}
        </div>
        <div className="flex w-full shrink-0 flex-col gap-1 sm:w-auto sm:items-end">
          {(it.actions.includes('approve') || it.actions.includes('reject')) && (
            <input className="input w-full sm:w-56" placeholder={t('inbox.commentPh')} aria-label={t('inbox.comment')} value={comment} onChange={(e) => setComment(e.target.value)} />
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

/** 「重新整理」圖示鈕：今天頁的卡片標題列與 /inbox 頁頭都用它 */
export function InboxRefreshButton({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const list = useInboxList()
  return (
    <button type="button" className={`btn-ghost p-1 ${className}`} title={t('inbox.refresh')} aria-label={t('inbox.refresh')} data-testid="inbox-refresh"
      onClick={() => qc.invalidateQueries({ queryKey: inboxQk })}>
      <RefreshCw className={`h-4 w-4 ${list.isFetching ? 'animate-spin' : ''}`} aria-hidden />
    </button>
  )
}

/**
 * 收件匣面板：種類 chip（只列有數字的）＋清單＋動作。今天頁「等你決定」與 /inbox 都是它。
 * `compact` 給今天頁：空清單只給一行字（emptyText），不畫大空狀態。
 */
export function InboxPanel({ compact = false, emptyText }: { compact?: boolean; emptyText?: string }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [kind, setKind] = useState<string>('')
  const q = useInboxList()
  const refresh = () => { qc.invalidateQueries({ queryKey: inboxQk }) }
  const byKind = q.data?.by_kind ?? {}
  const kinds = KINDS.filter((k) => (byKind[k] ?? 0) > 0)
  const items = (q.data?.items ?? []).filter((x) => !kind || x.kind === kind)
  const chip = (active: boolean) => `btn-outline text-xs ${active ? 'bg-zinc-200 dark:bg-zinc-800' : ''}`
  const pill = 'rounded-full bg-zinc-300 px-1.5 dark:bg-zinc-700'
  return (
    <div data-testid="inbox-panel">
      {(q.data?.count ?? 0) > 0 && (
        <div className="mb-3 flex flex-wrap gap-1 text-xs" data-testid="inbox-chips">
          <button className={chip(!kind)} onClick={() => setKind('')} data-testid="filter-all">
            {t('inbox.all')} <span className={pill}>{q.data?.count ?? 0}</span>
          </button>
          {kinds.map((k) => (
            <button key={k} className={chip(kind === k)} onClick={() => setKind(kind === k ? '' : k)} data-testid={`filter-${k}`}>
              {t(`inbox.kind.${k}`)} <span className={pill}>{byKind[k] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
      {q.data?.warnings?.length ? <div className="mb-2 text-xs text-amber-700 dark:text-amber-300">{q.data.warnings.join('；')}</div> : null}
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && items.length === 0 && (compact
        ? <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="today-decide-empty">{emptyText ?? t('inbox.empty')}</p>
        : <EmptyState testId="empty-inbox" title={t('guide.empty.inbox.title')} body={t('guide.empty.inbox.body')} action={{ label: t('guide.empty.inbox.action'), to: '/workflows' }} />)}
      <ul className="space-y-2">{items.map((it) => <InboxRow key={it.id} it={it} onDone={refresh} />)}</ul>
    </div>
  )
}

/** 獨立頁面（給既有測試與直接 render 用）；路由上 /inbox 已轉到 /today */
export function InboxPage() {
  const { t } = useTranslation()
  return (
    <div className="p-4">
      <PageHeader title={t('inbox.title')} subtitle={t('inbox.subtitle')} actions={<InboxRefreshButton />} />
      <InboxPanel />
    </div>
  )
}

const zhTW = {
  nav: { inbox: '收件匣' },
  inbox: {
    title: '待辦收件匣', subtitle: '所有需要人決定的事：流程等你看、對話危險指令、看板卡住、群聊點名、用量超額', refresh: '重新整理',
    all: '全部', empty: '沒有待辦，太好了。', more: '展開', less: '收合', comment: '意見', commentPh: '核准／退回意見（選填）',
    approve: '可以', reject: '退回', done: '已處理', goto: '前往', staffFallback: 'AI 員工',
    kind: { workflow_gate: '流程等你看', chat_approval: '危險指令', kanban_blocked: '看板卡住', groupchat_mention: '群聊點名', limit_exceeded: '用量超額', notice: '通知' },
    decision: { once: '允許一次', session: '本次對話允許', always: '永遠允許', deny: '拒絕' },
  },
}
const en = {
  nav: { inbox: 'Inbox' },
  inbox: {
    title: 'Inbox', subtitle: 'Everything that needs a human decision', refresh: 'Refresh',
    all: 'All', empty: 'Nothing pending.', more: 'More', less: 'Less', comment: 'Comment', commentPh: 'Comment (optional)',
    approve: 'Approve', reject: 'Reject', done: 'Done', goto: 'Open', staffFallback: 'AI staff',
    kind: { workflow_gate: 'Workflow gate', chat_approval: 'Dangerous command', kanban_blocked: 'Kanban blocked', groupchat_mention: 'Mention', limit_exceeded: 'Limit exceeded', notice: 'Notice' },
    decision: { once: 'Allow once', session: 'Allow this session', always: 'Always allow', deny: 'Deny' },
  },
}

const mod: StudioModule = {
  name: 'inbox',
  // 路由留著：頂欄 badge 與說明頁的舊連結都指 /inbox；內容已併進「今天」，所以直接轉過去
  routes: [{ path: '/inbox', element: <Navigate to="/today" replace /> }],
  // hidden：不進側欄（今天頁就是收件匣），但頁標題與設定總覽仍認得它
  nav: [{ to: '/inbox', key: 'inbox', order: 20, group: 'work', icon: 'Inbox', hidden: true }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
