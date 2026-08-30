// 成本護欄：公司／AI 員工每日 token／美元上限，今日進度條，超額停用與重設。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import type { StudioModule } from '../registry'

export interface LimitToday { tokens: number; usd: number; runs: number; tokens_pct: number | null; usd_pct: number | null; exceeded: boolean; triggered_today: boolean }
export interface UsageLimit {
  id: string; scope: 'company' | 'agent'; agent_id: string; daily_tokens: number; daily_usd: number; enabled: boolean; action: 'disable' | 'notify'
  last_triggered_on: string; disabled_agents: string[]; created_at: string; updated_at: string
  agent: { id: string; name: string; profile: string; enabled: boolean } | null; today: LimitToday
}
export interface TodayUsage { date: string; company: { tokens: number; usd: number; runs: number }; agents: { agent_id: string; name: string; profile: string; enabled: boolean; model: string; tokens: number; usd: number; runs: number }[] }

const json = (b: unknown) => JSON.stringify(b)
export const limitsApi = {
  list: () => request<UsageLimit[]>('/limits'),
  today: () => request<TodayUsage>('/limits/today'),
  create: (b: { scope: string; agent_id?: string; daily_tokens: number; daily_usd: number; action: string }) => request<UsageLimit>('/limits', { method: 'POST', body: json(b) }),
  update: (id: string, b: Partial<{ daily_tokens: number; daily_usd: number; enabled: boolean; action: string }>) => request<UsageLimit>(`/limits/${id}`, { method: 'PATCH', body: json(b) }),
  remove: (id: string) => request<void>(`/limits/${id}`, { method: 'DELETE' }),
  reset: (id: string) => request<{ ok: boolean; re_enabled: string[] }>(`/limits/${id}/reset`, { method: 'POST' }),
  check: () => request<{ fired: unknown[] }>('/limits/check', { method: 'POST' }),
}
export const limitsQk = ['limits'] as const

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)))
const usd = (n: number) => `$${n.toFixed(n >= 10 ? 2 : 4)}`

export function Bar({ pct, label, testId }: { pct: number | null; label: string; testId?: string }) {
  if (pct === null) return <div className="text-[11px] text-zinc-600 dark:text-zinc-400">{label}</div>
  const p = Math.min(100, Math.max(0, pct))
  const color = pct >= 100 ? 'bg-rose-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <div className="text-[11px]" data-testid={testId}>
      <div className="flex justify-between"><span>{label}</span><span>{pct.toFixed(0)}%</span></div>
      <div className="h-2 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800"><div className={`h-2 ${color}`} style={{ width: `${p}%` }} role="progressbar" aria-valuenow={Math.round(pct)} /></div>
    </div>
  )
}

function LimitRow({ lim, onChange }: { lim: UsageLimit; onChange: () => void }) {
  const { t } = useTranslation()
  const [edit, setEdit] = useState(false)
  const [tok, setTok] = useState(String(lim.daily_tokens))
  const [money, setMoney] = useState(String(lim.daily_usd))
  const upd = useMutation({ mutationFn: (b: Parameters<typeof limitsApi.update>[1]) => limitsApi.update(lim.id, b), onSuccess: () => { setEdit(false); onChange() } })
  const del = useMutation({ mutationFn: () => limitsApi.remove(lim.id), onSuccess: onChange })
  const reset = useMutation({ mutationFn: () => limitsApi.reset(lim.id), onSuccess: onChange })
  const title = lim.scope === 'company' ? t('limits.company') : `${lim.agent?.name ?? lim.agent_id}${lim.agent ? ` (${lim.agent.profile})` : ''}`
  return (
    <li className={`card p-3 ${lim.today.exceeded ? 'border-rose-400' : ''}`} data-testid={`limit-${lim.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-medium" title={title}>{title}</span>
            <span className="badge bg-zinc-200 px-1.5 text-[11px] dark:bg-zinc-800">{t(`limits.action.${lim.action}`)}</span>
            {!lim.enabled && <span className="badge bg-zinc-200 px-1.5 text-[11px] dark:bg-zinc-800">{t('limits.paused')}</span>}
            {lim.today.exceeded && <span className="badge bg-rose-100 px-1.5 text-[11px] text-rose-800 dark:bg-rose-900/40 dark:text-rose-200">{t('limits.exceeded')}</span>}
            {lim.agent && !lim.agent.enabled && <span className="badge bg-amber-100 px-1.5 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('limits.agentDisabled')}</span>}
          </div>
          <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
            {t('limits.todayUse', { tokens: fmt(lim.today.tokens), usd: usd(lim.today.usd), runs: lim.today.runs })}
            {lim.last_triggered_on && ` · ${t('limits.lastTriggered', { d: lim.last_triggered_on })}`}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Bar pct={lim.today.tokens_pct} label={lim.daily_tokens ? `${t('limits.tokens')} ${fmt(lim.today.tokens)} / ${fmt(lim.daily_tokens)}` : t('limits.noTokenLimit')} testId={`bar-tokens-${lim.id}`} />
            <Bar pct={lim.today.usd_pct} label={lim.daily_usd ? `${t('limits.usd')} ${usd(lim.today.usd)} / $${lim.daily_usd}` : t('limits.noUsdLimit')} testId={`bar-usd-${lim.id}`} />
          </div>
          {edit && (
            <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
              <input className="input w-32" type="number" aria-label={t('limits.tokens')} value={tok} onChange={(e) => setTok(e.target.value)} />
              <input className="input w-28" type="number" step="0.01" aria-label={t('limits.usd')} value={money} onChange={(e) => setMoney(e.target.value)} />
              <button className="btn-primary" disabled={upd.isPending} onClick={() => upd.mutate({ daily_tokens: Number(tok || 0), daily_usd: Number(money || 0) })}>{t('common.save')}</button>
              <button className="btn-ghost" onClick={() => setEdit(false)}>{t('common.cancel')}</button>
              {upd.error && <span className="text-rose-600 dark:text-rose-400">{(upd.error as Error).message}</span>}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {(lim.today.triggered_today || lim.disabled_agents.length > 0) && (
            <button className="btn-primary" disabled={reset.isPending} onClick={() => reset.mutate()}>{t('limits.reset')}</button>
          )}
          <button className="btn-outline" onClick={() => setEdit(!edit)}>{t('common.edit')}</button>
          <button className="btn-outline" onClick={() => upd.mutate({ enabled: !lim.enabled })}>{lim.enabled ? t('limits.pause') : t('limits.resume')}</button>
          <button className="btn-outline" onClick={() => upd.mutate({ action: lim.action === 'disable' ? 'notify' : 'disable' })}>{lim.action === 'disable' ? t('limits.toNotify') : t('limits.toDisable')}</button>
          <button className="btn-danger" disabled={del.isPending} onClick={() => del.mutate()}>{t('common.delete')}</button>
        </div>
      </div>
    </li>
  )
}

export function LimitsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const list = useQuery({ queryKey: [...limitsQk, 'list'], queryFn: limitsApi.list, refetchInterval: 60_000 })
  const today = useQuery({ queryKey: [...limitsQk, 'today'], queryFn: limitsApi.today, refetchInterval: 60_000 })
  const agents = useQuery({ queryKey: ['agents'], queryFn: api.agents.list })
  const refresh = () => { qc.invalidateQueries({ queryKey: limitsQk }); qc.invalidateQueries({ queryKey: ['agents'] }) }
  const [form, setForm] = useState({ scope: 'agent', agent_id: '', daily_tokens: '', daily_usd: '', action: 'disable' })
  const create = useMutation({
    mutationFn: () => limitsApi.create({ scope: form.scope, agent_id: form.agent_id || undefined, daily_tokens: Number(form.daily_tokens || 0), daily_usd: Number(form.daily_usd || 0), action: form.action }),
    onSuccess: () => { setForm({ ...form, daily_tokens: '', daily_usd: '' }); refresh() },
  })
  const check = useMutation({ mutationFn: limitsApi.check, onSuccess: refresh })
  return (
    <div className="p-4">
      <PageHeader title={t('limits.title')} subtitle={t('limits.subtitle')}
        actions={<button className="btn-outline" disabled={check.isPending} onClick={() => check.mutate()}>{t('limits.checkNow')}</button>} />
      <div className="card mb-4 p-3">
        <h3 className="mb-2 text-sm font-medium">{t('limits.add')}</h3>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <select className="input w-32" aria-label={t('limits.scope')} value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
            <option value="agent">{t('limits.scopeAgent')}</option>
            <option value="company">{t('limits.scopeCompany')}</option>
          </select>
          {form.scope === 'agent' && (
            <select className="input w-48" aria-label={t('limits.agent')} value={form.agent_id} onChange={(e) => setForm({ ...form, agent_id: e.target.value })}>
              <option value="">{t('limits.pickAgent')}</option>
              {(agents.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.profile})</option>)}
            </select>
          )}
          <input className="input w-36" type="number" placeholder={t('limits.dailyTokens')} aria-label={t('limits.dailyTokens')} value={form.daily_tokens} onChange={(e) => setForm({ ...form, daily_tokens: e.target.value })} />
          <input className="input w-32" type="number" step="0.01" placeholder={t('limits.dailyUsd')} aria-label={t('limits.dailyUsd')} value={form.daily_usd} onChange={(e) => setForm({ ...form, daily_usd: e.target.value })} />
          <select className="input w-40" aria-label={t('limits.actionLabel')} value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
            <option value="disable">{t('limits.action.disable')}</option>
            <option value="notify">{t('limits.action.notify')}</option>
          </select>
          <button className="btn-primary" disabled={create.isPending || (form.scope === 'agent' && !form.agent_id) || (!form.daily_tokens && !form.daily_usd)} onClick={() => create.mutate()}>{t('common.add')}</button>
          {create.error && <span className="text-rose-600 dark:text-rose-400">{(create.error as Error).message}</span>}
        </div>
        <p className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">{t('limits.hint')}</p>
      </div>
      {list.isLoading && <Loading />}
      {list.error && <ErrorBox error={list.error} onRetry={() => list.refetch()} />}
      {list.data && list.data.length === 0 && <Empty text={t('limits.empty')} />}
      <ul className="space-y-2">{(list.data ?? []).map((l) => <LimitRow key={l.id} lim={l} onChange={refresh} />)}</ul>
      {today.data && (
        <div className="card mt-4 p-3">
          <h3 className="mb-1 text-sm font-medium">{t('limits.todayTitle', { d: today.data.date })}</h3>
          <div className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">{t('limits.company')}: {fmt(today.data.company.tokens)} tokens · {usd(today.data.company.usd)} · {today.data.company.runs} runs</div>
          <div className="table-wrap">
          <table className="w-full text-xs">
            <thead className="text-left text-zinc-600 dark:text-zinc-400"><tr><th className="nowrap-cell pr-3">{t('limits.agent')}</th><th className="nowrap-cell pr-3">model</th><th className="nowrap-cell text-right">tokens</th><th className="nowrap-cell text-right">USD</th><th className="nowrap-cell text-right">runs</th><th></th></tr></thead>
            <tbody>
              {today.data.agents.map((a) => (
                <tr key={a.agent_id} className="border-t border-zinc-200 dark:border-zinc-800" data-testid={`today-${a.profile}`}>
                  <td className="nowrap-cell max-w-[16rem] truncate pr-3" title={`${a.name} ${a.profile}`}>{a.name} <code className="font-mono text-zinc-600 dark:text-zinc-400">{a.profile}</code></td><td className="nowrap-cell pr-3"><code className="font-mono">{a.model}</code></td>
                  <td className="nowrap-cell text-right">{fmt(a.tokens)}</td><td className="nowrap-cell text-right">{usd(a.usd)}</td><td className="nowrap-cell text-right">{a.runs}</td>
                  <td className="nowrap-cell text-right">{a.enabled ? '' : <span className="text-amber-700 dark:text-amber-400">{t('limits.agentDisabled')}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  )
}

const zhTW = {
  nav: { limits: '成本護欄' },
  limits: {
    title: '成本護欄', subtitle: '公司／AI 員工每日 token 與美元上限；超過就自動停用（或只通知），事件與收件匣都會留紀錄',
    add: '新增上限', scope: '範圍', scopeAgent: 'AI 員工', scopeCompany: '整家公司', agent: 'AI 員工', pickAgent: '選擇 AI 員工',
    dailyTokens: '每日 tokens 上限', dailyUsd: '每日美元上限', actionLabel: '超過時', action: { disable: '停用員工', notify: '只通知' },
    hint: '0＝不限；至少設一項。用量來自 Studio 對話的 run usage（UTC 當日），美元優先用 run 回報的成本，沒有就用用量頁價格表估算。',
    company: '整家公司', paused: '已暫停', exceeded: '已超額', agentDisabled: '員工已停用', tokens: 'tokens', usd: 'USD',
    noTokenLimit: '（不限 tokens）', noUsdLimit: '（不限美元）', todayUse: '今日 {{tokens}} tokens · {{usd}} · {{runs}} 次', lastTriggered: '上次觸發 {{d}}',
    reset: '重設並重新啟用', pause: '暫停', resume: '恢復', toNotify: '改為只通知', toDisable: '改為停用', checkNow: '立即檢查',
    empty: '還沒有設定任何上限。', todayTitle: '今日用量（{{d}}，UTC）',
  },
  common: { add: '新增' },
}
const en = {
  nav: { limits: 'Limits' },
  limits: {
    title: 'Cost guardrails', subtitle: 'Daily token / USD limits per company or agent; exceeding disables the agent (or notifies)',
    add: 'Add limit', scope: 'Scope', scopeAgent: 'Agent', scopeCompany: 'Company', agent: 'Agent', pickAgent: 'Pick an agent',
    dailyTokens: 'Daily tokens', dailyUsd: 'Daily USD', actionLabel: 'On exceed', action: { disable: 'Disable agent', notify: 'Notify only' },
    hint: '0 = unlimited; set at least one.', company: 'Company', paused: 'Paused', exceeded: 'Exceeded', agentDisabled: 'Agent disabled', tokens: 'tokens', usd: 'USD',
    noTokenLimit: '(no token limit)', noUsdLimit: '(no USD limit)', todayUse: 'Today {{tokens}} tokens · {{usd}} · {{runs}} runs', lastTriggered: 'last triggered {{d}}',
    reset: 'Reset & re-enable', pause: 'Pause', resume: 'Resume', toNotify: 'Notify only', toDisable: 'Disable on exceed', checkNow: 'Check now',
    empty: 'No limits yet.', todayTitle: 'Today ({{d}}, UTC)',
  },
  common: { add: 'Add' },
}

const mod: StudioModule = {
  name: 'limits',
  routes: [{ path: '/limits', element: <LimitsPage /> }],
  nav: [{ to: '/limits', key: 'limits', order: 45, group: 'system', icon: 'Activity' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
