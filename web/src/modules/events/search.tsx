// 全站搜尋（FTS5）：對話／群聊／工作流節點輸出／事件，中文可搜；結果帶跳轉連結。路由 /search（由 events 模組註冊）。
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { CollapsiblePanel, PanelGroup, WorkArea } from '../../components/layout/index'
import { ErrorBox, Loading } from '../../components/QueryState'

export type SearchScope = 'all' | 'chat' | 'group' | 'workflow' | 'events'
export const SEARCH_SCOPES: SearchScope[] = ['all', 'chat', 'group', 'workflow', 'events']

export interface SearchHit {
  scope: Exclude<SearchScope, 'all'>; ref: string; company_id: string; agent: string; member_id: string; ts: string; title: string
  snippet: string; score: number; link: string; meta: Record<string, unknown>
}
export interface SearchResult { items: SearchHit[]; total: number; q: string; scopes: string[]; match?: string; limit?: number; offset?: number }
export interface SearchParams { q: string; scope?: SearchScope; from?: string; to?: string; agent?: string; limit?: number; offset?: number }

function qs(p: Record<string, string | number | undefined>) {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== '' && v !== null) u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}
export const searchApi = {
  search: (p: SearchParams) => request<SearchResult>(`/search${qs({ ...p })}`),
}

const SCOPE_COLOR: Record<string, string> = { chat: 'bg-indigo-500', group: 'bg-sky-500', workflow: 'bg-emerald-500', events: 'bg-amber-500' }

function fmtTime(s: string) {
  if (!s) return ''
  const d = new Date(s.endsWith('Z') || s.includes('+') ? s : s + 'Z')
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

/** 片段裡把命中的詞標粗（大小寫不敏感；只做展示） */
export function highlight(snippet: string, q: string) {
  const terms = q.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length)
  if (!terms.length) return [snippet]
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return snippet.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i} className="rounded bg-yellow-200 px-0.5 dark:bg-yellow-700/60">{part}</mark> : part))
}

/** 小型搜尋框：事件頁頂端用，Enter 跳到 /search?q= */
export function GlobalSearchBox({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  const [v, setV] = useState('')
  const nav = useNavigate()
  const go = () => { if (v.trim()) nav(`/search?q=${encodeURIComponent(v.trim())}`) }
  return (
    <form className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`} role="search" onSubmit={(e) => { e.preventDefault(); go() }}>
      <input className="input min-w-0 flex-1 basis-40 sm:w-56 sm:flex-none sm:basis-auto" placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} value={v} onChange={(e) => setV(e.target.value)} />
      <button type="submit" className="btn-outline" disabled={!v.trim()} data-testid="global-search-go">{t('search.go')}</button>
    </form>
  )
}

export function SearchPage() {
  const { t } = useTranslation()
  const [sp, setSp] = useSearchParams()
  const [q, setQ] = useState(sp.get('q') ?? '')
  const scope = (sp.get('scope') as SearchScope) || 'all'
  const from = sp.get('from') ?? ''
  const to = sp.get('to') ?? ''
  const agent = sp.get('agent') ?? ''
  const page = Number(sp.get('page') ?? '0') || 0
  const limit = 20
  const submitted = sp.get('q') ?? ''
  useEffect(() => { setQ(sp.get('q') ?? '') }, [sp])
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k)
    if (!('page' in patch)) next.delete('page')
    setSp(next)
  }
  const params: SearchParams = { q: submitted, scope, from: from ? `${from}T00:00:00` : undefined, to: to ? `${to}T23:59:59` : undefined, agent: agent || undefined, limit, offset: page * limit }
  const query = useQuery({ queryKey: ['search', params], queryFn: () => searchApi.search(params), enabled: !!submitted })
  const total = query.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / limit))
  return (
    <PanelGroup>
      <CollapsiblePanel id="search.filters" side="left" title={t('panels.filters')} icon="Filter" defaultWidth={260} min={200} max={420}>
      <form className="panel-filters" role="search" onSubmit={(e) => { e.preventDefault(); set({ q: q.trim() }) }}>
        <input className="input min-w-0 flex-1 basis-48 sm:w-72 sm:flex-none sm:basis-auto" placeholder={t('search.placeholder')} aria-label={t('search.placeholder')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <button className="btn-primary" type="submit" disabled={!q.trim()}>{t('search.go')}</button>
        <input className="input min-w-0 flex-1 basis-[40%] sm:w-36 sm:flex-none sm:basis-auto" type="date" aria-label={t('events.since')} value={from} onChange={(e) => set({ from: e.target.value })} />
        <span>–</span>
        <input className="input min-w-0 flex-1 basis-[40%] sm:w-36 sm:flex-none sm:basis-auto" type="date" aria-label={t('events.until')} value={to} onChange={(e) => set({ to: e.target.value })} />
        <input className="input min-w-0 flex-1 basis-[40%] sm:w-36 sm:flex-none sm:basis-auto" placeholder={t('events.agent')} aria-label={t('events.agent')} value={agent} onChange={(e) => set({ agent: e.target.value })} />
      </form>
      </CollapsiblePanel>
      <WorkArea className="overflow-auto p-4">
      <PageHeader title={t('search.title')} subtitle={t('search.subtitle')} />
      <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label={t('search.scope')}>
        {SEARCH_SCOPES.map((s) => (
          <button key={s} role="tab" aria-selected={scope === s} data-testid={`scope-${s}`}
            className={`whitespace-nowrap rounded-full px-3 py-0.5 text-xs ${scope === s ? 'bg-indigo-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`}
            onClick={() => set({ scope: s === 'all' ? '' : s })}>{t(`search.scopes.${s}`)}</button>
        ))}
        {submitted && <span className="ml-2 self-center text-xs text-zinc-600 dark:text-zinc-400">{t('search.total', { n: total, q: submitted })}</span>}
      </div>
      {query.isLoading && <Loading />}
      {query.error && <ErrorBox error={query.error} onRetry={() => query.refetch()} />}
      {!submitted && <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('search.hint')}</p>}
      {query.data && submitted && query.data.items.length === 0 && <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="search-empty">{t('search.empty', { q: submitted })}</p>}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {(query.data?.items ?? []).map((h) => (
          <li key={`${h.scope}:${h.ref}`} className="py-2" data-testid={`hit-${h.scope}-${h.ref}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${SCOPE_COLOR[h.scope] ?? 'bg-zinc-400'}`} />
              <span className="badge bg-zinc-200 dark:bg-zinc-800">{t(`search.scopes.${h.scope}`)}</span>
              <span className="whitespace-nowrap">{fmtTime(h.ts)}</span>
              {h.agent && <code className="whitespace-nowrap text-indigo-700 dark:text-indigo-300">{h.agent}</code>}
              {h.title && <span className="line-clamp-1 min-w-0 font-medium text-zinc-800 dark:text-zinc-200" title={h.title}>{h.title}</span>}
            </div>
            <div className="line-clamp-3 text-sm">{highlight(h.snippet, submitted)}</div>
            <Link className="whitespace-nowrap text-xs text-indigo-700 hover:underline dark:text-indigo-300" to={h.link}>{t('search.open')}</Link>
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <div className="mt-3 flex items-center gap-2 text-xs">
          <button className="btn-outline" disabled={page === 0} onClick={() => set({ page: String(page - 1) })}>‹</button>
          <span>{page + 1} / {pages}</span>
          <button className="btn-outline" disabled={page + 1 >= pages} onClick={() => set({ page: String(page + 1) })}>›</button>
        </div>
      )}
      </WorkArea>
    </PanelGroup>
  )
}

export const searchI18n = {
  'zh-TW': {
    nav: { search: '全站搜尋' },
    search: {
      title: '全站搜尋', subtitle: '一次搜對話、群聊、工作流節點輸出與事件；中文可直接搜，多個詞以空白分開＝同時包含',
      placeholder: '搜尋內容（例：文案、客訴、上週交辦）', go: '搜尋', scope: '範圍', open: '開啟 →', hint: '輸入關鍵字後按 Enter。',
      total: '「{{q}}」共 {{n}} 筆', empty: 'Studio 裡找不到含「{{q}}」的紀錄。',
      scopes: { all: '全站', chat: '對話', group: '群聊', workflow: '工作流', events: '事件' },
    },
  },
  en: {
    nav: { search: 'Search' },
    search: {
      title: 'Search', subtitle: 'Search chats, group rooms, workflow node outputs and events at once', placeholder: 'Search…', go: 'Search',
      scope: 'Scope', open: 'Open →', hint: 'Type a keyword and press Enter.', total: '{{n}} results for "{{q}}"', empty: 'Nothing matches "{{q}}".',
      scopes: { all: 'All', chat: 'Chat', group: 'Group chat', workflow: 'Workflows', events: 'Events' },
    },
  },
}
