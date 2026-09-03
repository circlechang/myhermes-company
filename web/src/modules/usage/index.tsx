// C. 用量分析：總 token、session 數、成本、快取命中率、模型分佈、30 日趨勢（recharts）＋表；價格表可編輯
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { ErrorBox, Loading } from '../../components/QueryState'
import type { StudioModule } from '../registry'
import { useProfiles } from '../profiles'

interface Bucket { key: string; sessions: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number }
export interface UsageSummary {
  totals: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number
    sessions: number; sessions_per_day: number; api_calls: number; messages: number; tool_calls: number; cost_usd: number; cost_hermes_usd: number; cost_table_usd: number
    sessions_unpriced: number; cache_hit_rate: number; days: number }
  daily: Bucket[]; by_model: Bucket[]; by_source: Bucket[]; by_profile: Bucket[]
  studio: { sessions: number; messages: number; input_tokens: number; output_tokens: number }
  sources: { profile: string; path: string; exists: boolean; sessions: number }[]
}
interface Price { model: string; input: number; output: number; cache_read: number; source: 'builtin' | 'custom' }

const json = (b: unknown) => JSON.stringify(b)
export const usageApi = {
  summary: (p: { days: number; profile?: string; company?: boolean }) => {
    const qs = new URLSearchParams({ days: String(p.days) })
    if (p.profile) qs.set('profile', p.profile)
    if (p.company) qs.set('company', '1')
    return request<UsageSummary>(`/usage/summary?${qs}`)
  },
  prices: () => request<{ prices: Price[]; unit: string }>('/usage/prices'),
  setPrice: (b: { model: string; input: number; output: number; cache_read: number }) => request<unknown>('/usage/prices', { method: 'PUT', body: json(b) }),
  deletePrice: (model: string) => request<unknown>(`/usage/prices/${encodeURIComponent(model)}`, { method: 'DELETE' }),
}

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n))
const usd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`
const COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316', '#64748b', '#a3e635']

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card flex min-w-0 flex-col p-3">
      <div className="text-xs text-zinc-600 dark:text-zinc-400">{label}</div>
      <div className="text-xl font-semibold" data-testid={`stat-${label}`}>{value}</div>
      {sub && <div className="mt-auto pt-1 text-xs leading-4 text-zinc-600 dark:text-zinc-400">{sub}</div>}
    </div>
  )
}

function PriceTable() {
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['usage', 'prices'], queryFn: usageApi.prices })
  const qc = useQueryClient()
  const inv = () => { qc.invalidateQueries({ queryKey: ['usage'] }) }
  const set = useMutation({ mutationFn: usageApi.setPrice, onSuccess: inv })
  const del = useMutation({ mutationFn: usageApi.deletePrice, onSuccess: inv })
  const [row, setRow] = useState({ model: '', input: '', output: '', cache_read: '' })
  return (
    <div className="card p-3">
      <h3 className="font-medium">{t('usage.prices')} <span className="text-xs text-zinc-600 dark:text-zinc-400">{q.data?.unit}</span></h3>
      <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">{t('usage.pricesHint')}</p>
      <div className="mb-2 flex flex-wrap gap-1 text-xs">
        <input className="input w-full sm:w-44" placeholder={t('usage.priceModel')} value={row.model} onChange={(e) => setRow({ ...row, model: e.target.value })} aria-label={t('usage.priceModel')} />
        <input className="input w-24" placeholder="input" type="number" value={row.input} onChange={(e) => setRow({ ...row, input: e.target.value })} aria-label="input" />
        <input className="input w-24" placeholder="output" type="number" value={row.output} onChange={(e) => setRow({ ...row, output: e.target.value })} aria-label="output" />
        <input className="input w-24" placeholder="cache" type="number" value={row.cache_read} onChange={(e) => setRow({ ...row, cache_read: e.target.value })} aria-label="cache" />
        <button className="btn-primary" disabled={!row.model || set.isPending}
          onClick={() => set.mutate({ model: row.model, input: Number(row.input || 0), output: Number(row.output || 0), cache_read: Number(row.cache_read || 0) })}>{t('common.save')}</button>
      </div>
      <div className="max-h-56 overflow-auto">
        <div className="table-wrap">
        <table className="w-full text-xs">
          <thead className="text-left text-zinc-600 dark:text-zinc-400"><tr><th>{t('usage.priceModel')}</th><th className="nowrap-cell">in</th><th className="nowrap-cell">out</th><th className="nowrap-cell">cache</th><th></th></tr></thead>
          <tbody>
            {q.data?.prices.map((p) => (
              <tr key={p.model} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="w-full max-w-0 truncate py-0.5 pr-2" title={p.model}><code className="font-mono">{p.model}</code> {p.source === 'custom' && <span className="text-indigo-700 dark:text-indigo-400">{t('usage.custom')}</span>}</td>
                <td className="nowrap-cell">{p.input}</td><td className="nowrap-cell">{p.output}</td><td className="nowrap-cell">{p.cache_read}</td>
                <td className="nowrap-cell text-right">
                  <button className="btn-ghost" onClick={() => setRow({ model: p.model, input: String(p.input), output: String(p.output), cache_read: String(p.cache_read) })}>{t('common.edit')}</button>
                  {p.source === 'custom' && <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => del.mutate(p.model)}>{t('common.delete')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

export function UsagePage() {
  const { t } = useTranslation()
  const [days, setDays] = useState(30)
  const [profile, setProfile] = useState('')
  const [company, setCompany] = useState(false)
  const profiles = useProfiles()
  const q = useQuery({ queryKey: ['usage', 'summary', days, profile, company], queryFn: () => usageApi.summary({ days, profile: profile || undefined, company }) })
  const s = q.data
  const tot = s?.totals
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <PageHeader title={t('usage.title')} subtitle={t('usage.subtitle')} actions={
        <>
          <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t('usage.days')}>
            {[7, 30, 90].map((d) => <option key={d} value={d}>{t('usage.lastDays', { n: d })}</option>)}
          </select>
          <select className="input w-auto" value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="profile">
            <option value="">{t('usage.allProfiles')}</option>
            {profiles.data?.profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs"><input type="checkbox" checked={company} onChange={(e) => setCompany(e.target.checked)} />{t('usage.companyOnly')}</label>
        </>
      } />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {tot && s && (
        <>
          <div className="grid auto-rows-fr grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Stat label={t('usage.inputTokens')} value={fmt(tot.input_tokens)} sub={`${t('usage.cacheRead')} ${fmt(tot.cache_read_tokens)}`} />
            <Stat label={t('usage.outputTokens')} value={fmt(tot.output_tokens)} sub={`${t('usage.reasoning')} ${fmt(tot.reasoning_tokens)}`} />
            <Stat label={t('usage.sessions')} value={String(tot.sessions)} sub={t('usage.perDay', { n: tot.sessions_per_day })} />
            <Stat label={t('usage.cost')} value={usd(tot.cost_usd)} sub={t('usage.costSplit', { h: usd(tot.cost_hermes_usd), t: usd(tot.cost_table_usd), u: tot.sessions_unpriced })} />
            <Stat label={t('usage.cacheHit')} value={`${(tot.cache_hit_rate * 100).toFixed(1)}%`} sub={t('usage.cacheHitHint')} />
            <Stat label={t('usage.apiCalls')} value={fmt(tot.api_calls)} sub={`${t('usage.toolCalls')} ${fmt(tot.tool_calls)}`} />
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="card p-3 lg:col-span-2">
              <h3 className="mb-1 text-sm font-medium">{t('usage.trend')}</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={s.daily}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#8884" />
                    <XAxis dataKey="key" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => fmt(v)} />
                    <Tooltip formatter={(v: number) => fmt(v)} />
                    <Legend />
                    <Line type="monotone" dataKey="input_tokens" name={t('usage.inputTokens')} stroke="#4f46e5" dot={false} />
                    <Line type="monotone" dataKey="output_tokens" name={t('usage.outputTokens')} stroke="#10b981" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={s.daily}>
                    <XAxis dataKey="key" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="sessions" name={t('usage.sessions')} fill="#0ea5e9" />
                    <Bar dataKey="cost_usd" name={t('usage.cost')} fill="#f59e0b" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card p-3">
              <h3 className="mb-1 text-sm font-medium">{t('usage.byModel')}</h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={s.by_model.slice(0, 8)} dataKey="input_tokens" nameKey="key" innerRadius={40} outerRadius={80}>
                      {s.by_model.slice(0, 8).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: number) => fmt(v)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="table-wrap">
                <table className="w-full text-xs">
                  <tbody>
                    {s.by_model.slice(0, 8).map((b, i) => (
                      <tr key={b.key}><td className="w-full max-w-0 truncate pr-2" title={b.key}><span className="mr-1 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: COLORS[i % COLORS.length] }} /><code className="font-mono">{b.key}</code></td>
                        <td className="nowrap-cell text-right">{b.sessions}</td><td className="nowrap-cell text-right">{fmt(b.input_tokens + b.output_tokens)}</td><td className="nowrap-cell text-right">{usd(b.cost_usd)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {[['bySource', s.by_source], ['byProfile', s.by_profile]].map(([k, rows]) => (
              <div key={k as string} className="card p-3">
                <h3 className="mb-1 text-sm font-medium">{t(`usage.${k as string}`)}</h3>
                <div className="table-wrap">
                  <table className="w-full text-xs">
                    <thead className="text-left text-zinc-600 dark:text-zinc-400"><tr><th></th><th className="nowrap-cell text-right">{t('usage.sessions')}</th><th className="nowrap-cell text-right">tokens</th><th className="nowrap-cell text-right">{t('usage.cost')}</th></tr></thead>
                    <tbody>{(rows as Bucket[]).map((b) => <tr key={b.key} className="border-t border-zinc-200 dark:border-zinc-800"><td className="w-full max-w-0 truncate pr-2" title={b.key}><code className="font-mono">{b.key}</code></td><td className="nowrap-cell text-right">{b.sessions}</td><td className="nowrap-cell text-right">{fmt(b.input_tokens + b.output_tokens)}</td><td className="nowrap-cell text-right">{usd(b.cost_usd)}</td></tr>)}</tbody>
                  </table>
                </div>
              </div>
            ))}
            <div className="card p-3 text-xs">
              <h3 className="mb-1 text-sm font-medium">{t('usage.studio')}</h3>
              <div>{t('usage.sessions')}: {s.studio.sessions} · {t('usage.messages')}: {s.studio.messages}</div>
              <div>in {fmt(s.studio.input_tokens)} / out {fmt(s.studio.output_tokens)}</div>
              <h3 className="mb-1 mt-3 text-sm font-medium">{t('usage.sources')}</h3>
              <ul>{s.sources.map((x) => <li key={x.profile} className="truncate" title={x.profile}><code className="font-mono">{x.profile}</code> {x.exists ? `${x.sessions} sessions` : t('usage.noDb')}</li>)}</ul>
            </div>
          </div>
          <details className="card p-3">
            <summary className="cursor-pointer text-sm font-medium">{t('usage.dailyTable')}</summary>
            <div className="table-wrap mt-2">
            <table className="w-full text-xs">
              <thead className="text-left text-zinc-600 dark:text-zinc-400"><tr><th className="nowrap-cell">{t('usage.date')}</th><th className="nowrap-cell text-right">{t('usage.sessions')}</th><th className="nowrap-cell text-right">in</th><th className="nowrap-cell text-right">out</th><th className="nowrap-cell text-right">cache</th><th className="nowrap-cell text-right">{t('usage.cost')}</th></tr></thead>
              <tbody>{[...s.daily].reverse().map((b) => <tr key={b.key} className="border-t border-zinc-200 dark:border-zinc-800"><td className="nowrap-cell">{b.key}</td><td className="nowrap-cell text-right">{b.sessions}</td><td className="nowrap-cell text-right">{fmt(b.input_tokens)}</td><td className="nowrap-cell text-right">{fmt(b.output_tokens)}</td><td className="nowrap-cell text-right">{fmt(b.cache_read_tokens)}</td><td className="nowrap-cell text-right">{usd(b.cost_usd)}</td></tr>)}</tbody>
            </table>
            </div>
          </details>
          <PriceTable />
        </>
      )}
    </div>
  )
}

const zhTW = {
  nav: { usage: '用量' },
  usage: {
    title: '用量分析', subtitle: '來源：Hermes state.db（唯讀，各 profile 各一份）＋ Studio 對話',
    days: '期間', lastDays: '最近 {{n}} 天', allProfiles: '全部 profile', companyOnly: '只算本公司 Studio 建立的對話',
    inputTokens: '輸入 token', outputTokens: '輸出 token', cacheRead: '快取讀取', reasoning: '推理', sessions: 'Session 數', perDay: '日均 {{n}}',
    cost: '估算成本', costSplit: 'Hermes 算 {{h}} ＋ 價格表算 {{t}}；{{u}} 個 session 無價格', cacheHit: '快取命中率', cacheHitHint: 'cache_read ÷ (input + cache_read)',
    apiCalls: 'API 呼叫', toolCalls: '工具呼叫', trend: '趨勢（每日）', byModel: '模型分佈', bySource: '來源分佈', byProfile: 'Profile 分佈',
    studio: 'Studio 對話', messages: '訊息', sources: '資料來源', noDb: '（沒有 state.db）', dailyTable: '每日明細表', date: '日期',
    prices: '價格表', pricesHint: '每 1M token 美元；自訂會覆蓋內建（關鍵字包含比對，長的優先）。Hermes 自己算出的成本優先於價格表。', priceModel: '模型關鍵字', custom: '自訂',
  },
}
const en = {
  nav: { usage: 'Usage' },
  usage: {
    title: 'Usage', subtitle: 'Sources: Hermes state.db (read-only, per profile) + Studio sessions',
    days: 'Period', lastDays: 'Last {{n}} days', allProfiles: 'All profiles', companyOnly: 'Only this company\'s Studio sessions',
    inputTokens: 'Input tokens', outputTokens: 'Output tokens', cacheRead: 'cache read', reasoning: 'reasoning', sessions: 'Sessions', perDay: '{{n}}/day',
    cost: 'Est. cost', costSplit: 'Hermes {{h}} + table {{t}}; {{u}} unpriced', cacheHit: 'Cache hit', cacheHitHint: 'cache_read ÷ (input + cache_read)',
    apiCalls: 'API calls', toolCalls: 'tool calls', trend: 'Daily trend', byModel: 'By model', bySource: 'By source', byProfile: 'By profile',
    studio: 'Studio sessions', messages: 'messages', sources: 'Sources', noDb: '(no state.db)', dailyTable: 'Daily table', date: 'Date',
    prices: 'Price table', pricesHint: 'USD per 1M tokens; custom overrides builtin.', priceModel: 'Model keyword', custom: 'custom',
  },
}

const mod: StudioModule = {
  name: 'usage',
  routes: [{ path: '/usage', element: <UsagePage /> }],
  nav: [{ to: '/usage', key: 'usage', order: 94.5, group: 'settings', icon: 'Wallet', hidden: true }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
