// 事件時間軸（SPEC §9 存事件不存交易）：篩選來源／種類／AI 員工／成員／期間，可匯出 CSV。
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { API_BASE, getToken, request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBox, Loading } from '../../components/QueryState'
import '../../guide/i18n'
import type { StudioModule } from '../registry'
import { GlobalSearchBox, SearchPage, searchI18n } from './search'

export interface StudioEvent {
  id: string; ts: string; kind: string; source: string; subject: string; agent: string; member_id: string; company_id: string
  payload: Record<string, unknown>; decision: string; delivery: string
  seq: number; causes: string[]
}
export interface EventChain { event: StudioEvent; upstream: (StudioEvent & { effect: string })[]; downstream: StudioEvent[]; truncated: boolean }
export interface EventFilter { source?: string; kind?: string; agent?: string; member_id?: string; subject?: string; since?: string; until?: string; q?: string; limit?: number; offset?: number }
interface Facet { value: string; count: number }
export interface Facets { sources: Facet[]; kinds: Facet[]; agents: Facet[]; members: Facet[] }

function qs(f: EventFilter) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}
export const eventsApi = {
  list: (f: EventFilter) => request<{ items: StudioEvent[]; total: number; limit: number; offset: number }>(`/events${qs(f)}`),
  facets: () => request<Facets>('/events/facets'),
  chain: (id: string) => request<EventChain>(`/events/${encodeURIComponent(id)}/chain`),
  exportUrl: (f: EventFilter) => `${API_BASE}/events/export.csv${qs(f)}`,
}

const SOURCE_COLOR: Record<string, string> = {
  chat: 'bg-indigo-500', workflow: 'bg-emerald-500', groupchat: 'bg-sky-500', kanban: 'bg-amber-500', studio: 'bg-zinc-500',
  line: 'bg-green-600', webhook: 'bg-fuchsia-500', api: 'bg-fuchsia-500', cron: 'bg-teal-500', coding: 'bg-violet-500',
}

function fmtTime(s: string) {
  const d = new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z')
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}
function localDate(offsetDays: number) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

function summarize(e: StudioEvent): string {
  const p = e.payload ?? {}
  const pick = (...ks: string[]) => ks.map((k) => p[k]).find((v) => typeof v === 'string' && v) as string | undefined
  return pick('excerpt', 'title', 'workflow_name', 'command', 'text', 'note', 'error') ?? ''
}

/** 因果鏈：沿 causes 往上游（由近到遠）＋直接下游 */
function ChainView({ id }: { id: string }) {
  const { t } = useTranslation()
  const chain = useQuery({ queryKey: ['events', 'chain', id], queryFn: () => eventsApi.chain(id) })
  if (chain.isLoading) return <Loading />
  if (chain.error) return <ErrorBox error={chain.error} onRetry={() => chain.refetch()} />
  const c = chain.data!
  const row = (e: StudioEvent, arrow: string) => (
    <li key={e.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid={`chain-${e.id}`}>
      <span className="shrink-0 text-zinc-600 dark:text-zinc-400">{arrow}</span>
      <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">#{e.seq}</span>
      <span className="whitespace-nowrap">{fmtTime(e.ts)}</span>
      <code className="whitespace-nowrap">{e.kind}</code>
      <span className="min-w-0 truncate font-mono text-zinc-600 dark:text-zinc-400" title={e.subject}>{e.subject}</span>
      {e.decision && <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{e.decision}</span>}
      <span className="min-w-0 truncate" title={summarize(e)}>{summarize(e)}</span>
    </li>
  )
  return (
    <div className="mt-1 rounded border border-zinc-200 p-2 dark:border-zinc-700" data-testid={`chain-of-${id}`}>
      {c.upstream.length === 0 && c.downstream.length === 0 && <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('events.chainEmpty')}</div>}
      {c.upstream.length > 0 && <div className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">{t('events.upstream')}</div>}
      <ul className="space-y-0.5">{c.upstream.map((e) => row(e, '←'))}</ul>
      {c.truncated && <div className="text-[11px] text-zinc-600 dark:text-zinc-400">…</div>}
      {c.downstream.length > 0 && <div className="mt-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-400">{t('events.downstream')}</div>}
      <ul className="space-y-0.5">{c.downstream.map((e) => row(e, '→'))}</ul>
    </div>
  )
}

export function EventsPage() {
  const { t } = useTranslation()
  const [sp] = useSearchParams()
  // 搜尋結果／skill 連結可帶 ?subject= 或 ?q=（有帶就不預設只看 7 天）
  const initial: EventFilter = sp.get('subject') || sp.get('q') || sp.get('kind')
    ? { subject: sp.get('subject') ?? undefined, q: sp.get('q') ?? undefined, kind: sp.get('kind') ?? undefined }
    : { since: localDate(-7) }
  const [f, setF] = useState<EventFilter>(initial)
  const [page, setPage] = useState(0)
  const limit = 50
  const facets = useQuery({ queryKey: ['events', 'facets'], queryFn: eventsApi.facets })
  const [open, setOpen] = useState<string | null>(null)
  const [chainOf, setChainOf] = useState<string | null>(sp.get('event'))
  const set = (patch: EventFilter) => { setF({ ...f, ...patch }); setPage(0) }
  const sinceIso = f.since ? `${f.since}T00:00:00` : undefined
  const untilIso = f.until ? `${f.until}T23:59:59` : undefined
  const apiFilter = { ...f, since: sinceIso, until: untilIso }
  const query = useQuery({ queryKey: ['events', 'list', apiFilter, page], queryFn: () => eventsApi.list({ ...apiFilter, limit, offset: page * limit }) })
  const total = query.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / limit))
  const exportHref = () => {
    const tok = getToken()
    // 下載走 fetch＋blob（要帶 Authorization）
    fetch(eventsApi.exportUrl(apiFilter), { headers: tok ? { Authorization: `Bearer ${tok}` } : {} })
      .then((r) => r.blob())
      .then((b) => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(b)
        a.download = 'events.csv'
        a.click()
        URL.revokeObjectURL(a.href)
      })
  }
  const sel = (label: string, key: keyof EventFilter, opts: Facet[] | undefined) => (
    <select className="input min-w-0 flex-1 basis-[45%] sm:w-40 sm:flex-none sm:basis-auto" aria-label={label} value={(f[key] as string) ?? ''} onChange={(e) => set({ [key]: e.target.value } as EventFilter)}>
      <option value="">{label}</option>
      {(opts ?? []).map((o) => <option key={o.value} value={o.value}>{o.value} ({o.count})</option>)}
    </select>
  )
  return (
    <div className="p-4">
      <PageHeader title={t('events.title')} subtitle={t('events.subtitle')}
        actions={<div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto"><GlobalSearchBox className="min-w-0 flex-1" /><button className="btn-outline" onClick={exportHref} disabled={!total}>{t('events.exportCsv')}</button></div>} />
      <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
        {sel(t('events.source'), 'source', facets.data?.sources)}
        {sel(t('events.kind'), 'kind', facets.data?.kinds)}
        {sel(t('events.agent'), 'agent', facets.data?.agents)}
        {sel(t('events.member'), 'member_id', facets.data?.members)}
        <input className="input min-w-0 flex-1 basis-[40%] sm:w-36 sm:flex-none sm:basis-auto" type="date" aria-label={t('events.since')} value={f.since ?? ''} onChange={(e) => set({ since: e.target.value })} />
        <span>–</span>
        <input className="input min-w-0 flex-1 basis-[40%] sm:w-36 sm:flex-none sm:basis-auto" type="date" aria-label={t('events.until')} value={f.until ?? ''} onChange={(e) => set({ until: e.target.value })} />
        <input className="input min-w-0 flex-1 basis-[45%] sm:w-48 sm:flex-none sm:basis-auto" placeholder={t('events.search')} aria-label={t('events.search')} value={f.q ?? ''} onChange={(e) => set({ q: e.target.value })} />
        {f.subject && <span className="badge max-w-full truncate bg-zinc-200 dark:bg-zinc-800" title={f.subject}>subject={f.subject}</span>}
        <button className="btn-ghost" onClick={() => { setF({ since: localDate(-7) }); setPage(0) }}>{t('events.clear')}</button>
        <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{t('events.total', { n: total })}</span>
      </div>
      {query.isLoading && <Loading />}
      {query.error && <ErrorBox error={query.error} onRetry={() => query.refetch()} />}
      {query.data && query.data.items.length === 0 && <EmptyState testId="empty-events" title={t('guide.empty.events.title')} body={t('guide.empty.events.body')} action={{ label: t('guide.empty.events.action'), to: '/' }} />}
      <ol className="relative ml-3 border-l border-zinc-300 dark:border-zinc-700">
        {(query.data?.items ?? []).map((e) => (
          <li key={e.id} className="ml-4 py-2" data-testid={`event-${e.id}`}>
            <span className={`absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ${SOURCE_COLOR[e.source] ?? 'bg-zinc-400'}`} title={e.source} />
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">#{e.seq}</span>
              <span className="whitespace-nowrap">{fmtTime(e.ts)}</span>
              <span className="badge bg-zinc-200 dark:bg-zinc-800">{e.source}</span>
              <code className="whitespace-nowrap">{e.kind}</code>
              {e.agent && <code className="whitespace-nowrap text-indigo-700 dark:text-indigo-300">{e.agent}</code>}
              {e.member_id && <span className="whitespace-nowrap">👤 {e.member_id}</span>}
              {e.decision && <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">{t('events.decision')}: {e.decision}</span>}
              {e.delivery && <span className="badge bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200">{t('events.delivery')}: {e.delivery}</span>}
            </div>
            <div className="text-sm">
              <span className="path-text inline text-zinc-600 dark:text-zinc-400">{e.subject}</span> {summarize(e)}
            </div>
            <button className="btn-ghost px-1 py-0 text-[11px]" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? t('events.hidePayload') : t('events.showPayload')}</button>
            <button className="btn-ghost px-1 py-0 text-[11px]" data-testid={`chain-btn-${e.id}`} onClick={() => setChainOf(chainOf === e.id ? null : e.id)}>
              {chainOf === e.id ? t('events.hideChain') : t('events.showChain')}{e.causes?.length ? ` (${e.causes.length})` : ''}
            </button>
            {chainOf === e.id && <ChainView id={e.id} />}
            {open === e.id && <pre className="mt-1 max-h-64 overflow-auto rounded bg-zinc-100 p-2 text-[11px] dark:bg-zinc-800">{JSON.stringify(e.payload, null, 2)}</pre>}
          </li>
        ))}
      </ol>
      {pages > 1 && (
        <div className="mt-3 flex items-center gap-2 text-xs">
          <button className="btn-outline" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
          <span>{page + 1} / {pages}</span>
          <button className="btn-outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>›</button>
        </div>
      )}
    </div>
  )
}

const zhTW = {
  nav: { events: '事件', ...searchI18n['zh-TW'].nav },
  events: {
    title: '事件時間軸', subtitle: '所有進入中樞的事：來源、時間、對象、處理的 AI 員工、人類決策、投遞結果（只存事件，不存交易）',
    source: '來源', kind: '種類', agent: 'AI 員工', member: '成員', since: '起', until: '迄', search: '搜尋內容', clear: '清除篩選',
    total: '共 {{n}} 筆', empty: '這段期間沒有事件。', exportCsv: '匯出 CSV', decision: '決策', delivery: '投遞', showPayload: '看內容', hidePayload: '收起',
    showChain: '因果鏈', hideChain: '收起因果鏈', upstream: '上游（這件事因何而起）', downstream: '下游（引發了什麼）', chainEmpty: '沒有記錄到上下游事件。',
  },
  search: searchI18n['zh-TW'].search,
}
const en = {
  nav: { events: 'Events', ...searchI18n.en.nav },
  events: {
    title: 'Event timeline', subtitle: 'Everything that entered the hub: source, time, subject, agent, human decision, delivery',
    source: 'Source', kind: 'Kind', agent: 'Agent', member: 'Member', since: 'From', until: 'To', search: 'Search', clear: 'Clear',
    total: '{{n}} events', empty: 'No events in this period.', exportCsv: 'Export CSV', decision: 'decision', delivery: 'delivery', showPayload: 'payload', hidePayload: 'hide',
    showChain: 'Chain', hideChain: 'Hide chain', upstream: 'Upstream (causes)', downstream: 'Downstream (effects)', chainEmpty: 'No linked events.',
  },
  search: searchI18n.en.search,
}

const mod: StudioModule = {
  name: 'events',
  routes: [{ path: '/events', element: <EventsPage /> }, { path: '/search', element: <SearchPage /> }],
  nav: [{ to: '/events', key: 'events', order: 46 }, { to: '/search', key: 'search', order: 46.5, icon: 'Search' }], // round3：/search 有 help 頁後掛上側欄
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
