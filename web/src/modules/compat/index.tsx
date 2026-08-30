// 相容性：Hermes 升級會不會斷。目前版本／已測版本／最新版、契約測試報告（可展開失敗項與受影響功能）、
// 升級預檢（背景任務輪詢）、每週自動盯排程、能力降級一覽。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { HELP_PAGES } from '../../help'
import type { StudioModule } from '../registry'

export type Verdict = 'compatible' | 'partial' | 'incompatible' | ''
export interface ReportItem {
  id: string; status: 'pass' | 'fail' | 'skip'; reason: string; ms: number; kind: string; risk: 'low' | 'medium' | 'high'
  label: string; critical: boolean; affects: string[]; note: string; detail: Record<string, unknown>
}
export interface Summary {
  pass: number; fail: number; skip: number; total: number; verdict: Verdict; failed_ids: string[]
  affected_modules: { module: string; failed: string[] }[]
  by_risk?: Record<string, { pass: number; fail: number; skip: number }>
}
export interface Report {
  hermes: { version: string; cli_version: string; date: string; api_url: string; home: string; profile: string }
  mode: { sandbox: boolean; writes: boolean }; started_at: string; finished_at: string; duration_ms: number
  summary: Summary; items: ReportItem[]; cleanups: string[]; run_id?: string; precheck?: { tag: string; version: string }
}
export interface CompatRun {
  id: string; kind: 'check' | 'precheck'; want: string; tag: string; version: string; status: string; verdict: Verdict
  summary: Summary | Record<string, never>; error: string; log_path: string; triggered_by: string; created_at: string; finished_at: string | null
  report?: Report | null
}
export interface Schedule { enabled: boolean; weekday: number; hour: number; minute: number; last_run: string | null }
export interface Status {
  schedule: Schedule
  tested: { tag: string; version: string; at: string | null }
  latest_seen: { tag: string; at: string | null }
  current: { version: string; checked_at: string | null; verdict: Verdict; run_id: string }
  last_precheck: CompatRun | null
  running: PrecheckJob[]
}
export interface PrecheckJob {
  id: string; want: string; status: string; tag: string; version: string; progress: { ts: string; step: string; msg: string }[]
  error: string; log_path: string; started_at: string; finished_at: string; summary: Summary | null; report?: Report | null
}
export interface Capability { module: string; description: string; status: 'available' | 'degraded' | 'unavailable' | 'unknown'; missing: string[]; degraded: string[] }
export interface Capabilities { source: { finished_at: string; verdict: Verdict; hermes_version: string } | null; modules: Capability[] }

const json = (b: unknown) => JSON.stringify(b)
export const compatApi = {
  status: () => request<Status>('/compat/status'),
  runs: (kind?: string) => request<CompatRun[]>(`/compat/runs${kind ? `?kind=${kind}` : ''}`),
  run: (id: string) => request<CompatRun>(`/compat/runs/${id}`),
  check: (writes = false) => request<Report>('/compat/check', { method: 'POST', body: json({ writes }) }),
  precheck: (version = 'latest') => request<PrecheckJob>('/compat/precheck', { method: 'POST', body: json({ version }) }),
  precheckJob: (id: string) => request<PrecheckJob>(`/compat/precheck/${id}`),
  checkLatest: () => request<{ result: string }>('/compat/check-latest', { method: 'POST' }),
  capabilities: () => request<Capabilities>('/compat/capabilities'),
  schedule: (b: Partial<Schedule>) => request<Schedule>('/compat/schedule', { method: 'PATCH', body: json(b) }),
}
export const compatQk = ['compat'] as const

/** 純函式：report 的 items → 模組 → 失敗項（前端展開用） */
export function failuresByModule(items: ReportItem[]): Record<string, ReportItem[]> {
  const out: Record<string, ReportItem[]> = {}
  for (const it of items) if (it.status === 'fail') for (const m of it.affects) (out[m] ??= []).push(it)
  return out
}
export const isJobRunning = (s: string) => !['done', 'failed', 'timeout'].includes(s)

const verdictClass: Record<string, string> = {
  compatible: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  incompatible: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  '': 'bg-zinc-200 dark:bg-zinc-800',
}
const statusClass: Record<string, string> = {
  pass: 'text-emerald-600 dark:text-emerald-400', fail: 'text-rose-600 dark:text-rose-400', skip: 'text-zinc-600 dark:text-zinc-400',
  available: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  degraded: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  unavailable: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  unknown: 'bg-zinc-200 dark:bg-zinc-800',
}
const fmtTs = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—')

export function VerdictBadge({ v }: { v: Verdict }) {
  const { t } = useTranslation()
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${verdictClass[v] ?? verdictClass['']}`} data-testid="verdict">{v ? t(`compat.verdict.${v}`) : t('compat.verdict.none')}</span>
}

export function ReportTable({ report }: { report: Report }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<'all' | 'fail' | 'skip'>('all')
  const items = report.items.filter((i) => filter === 'all' || i.status === filter)
  return (
    <div className="card p-3" data-testid="report-table">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <VerdictBadge v={report.summary.verdict} />
        <span>{t('compat.counts', { pass: report.summary.pass, fail: report.summary.fail, skip: report.summary.skip, total: report.summary.total })}</span>
        <span className="text-zinc-600 dark:text-zinc-400">· Hermes {report.hermes.version || '?'} · {(report.duration_ms / 1000).toFixed(1)}s{report.mode.sandbox ? ` · ${t('compat.sandbox')}` : ''}{!report.mode.writes ? ` · ${t('compat.noWrites')}` : ''}</span>
        <span className="ml-auto flex gap-1">
          {(['all', 'fail', 'skip'] as const).map((f) => (
            <button key={f} className={`rounded px-2 py-0.5 ${filter === f ? 'bg-indigo-600 text-white' : 'bg-zinc-200 dark:bg-zinc-800'}`} onClick={() => setFilter(f)}>{t(`compat.filter.${f}`)}</button>
          ))}
        </span>
      </div>
      {report.summary.affected_modules.length > 0 && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950/30" data-testid="affected">
          <div className="font-medium">{t('compat.affected')}</div>
          <ul className="mt-1 flex flex-wrap gap-2">
            {report.summary.affected_modules.map((m) => <li key={m.module}><code className="font-medium">{m.module}</code> <span className="text-zinc-600 dark:text-zinc-400">({m.failed.join(', ')})</span></li>)}
          </ul>
        </div>
      )}
      <div className="overflow-x-auto">
        <div className="table-wrap">
        <table className="w-full text-xs">
          <thead className="text-left text-zinc-600 dark:text-zinc-400"><tr><th className="w-8"></th><th>{t('compat.col.item')}</th><th>{t('compat.col.kind')}</th><th>{t('compat.col.risk')}</th><th>{t('compat.col.affects')}</th><th className="text-right">ms</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <Fragment key={it.id}>
                <tr className="cursor-pointer border-t border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-800/50" data-testid={`item-${it.id}`} onClick={() => setOpen((o) => ({ ...o, [it.id]: !o[it.id] }))}>
                  <td className={`font-bold ${statusClass[it.status]}`}>{{ pass: '✓', fail: '✗', skip: '–' }[it.status]}</td>
                  <td><span className="font-medium">{it.label}</span> <code className="text-zinc-600 dark:text-zinc-400">{it.id}</code>{it.critical && <span className="ml-1 rounded bg-rose-100 px-1 text-[10px] text-rose-700 dark:bg-rose-900/40">{t('compat.critical')}</span>}</td>
                  <td>{it.kind}</td>
                  <td><span className={`rounded px-1 ${it.risk === 'high' ? 'bg-rose-100 dark:bg-rose-900/40' : it.risk === 'medium' ? 'bg-amber-100 dark:bg-amber-900/40' : 'bg-emerald-100 dark:bg-emerald-900/40'}`}>{t(`compat.risk.${it.risk}`)}</span></td>
                  <td className="text-zinc-600 dark:text-zinc-400">{it.affects.join(', ')}</td>
                  <td className="text-right text-zinc-600 dark:text-zinc-400">{it.ms}</td>
                </tr>
                {(open[it.id] || it.status === 'fail') && (
                  <tr className="bg-zinc-50 dark:bg-zinc-800/40" data-testid={`detail-${it.id}`}>
                    <td></td>
                    <td colSpan={5} className="py-1 text-xs">
                      {it.reason && <div className={it.status === 'fail' ? 'text-rose-700 dark:text-rose-300' : 'text-zinc-600 dark:text-zinc-300'}>{it.reason}</div>}
                      {it.status === 'fail' && it.affects.length > 0 && <div className="mt-0.5">{t('compat.affectsLine')}: {it.affects.map((m) => <code key={m} className="mr-1 rounded bg-zinc-200 px-1 dark:bg-zinc-700">{m}</code>)}</div>}
                      {it.note && <div className="mt-0.5 text-zinc-600 dark:text-zinc-400">{it.note}</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      {items.length === 0 && <Empty text={t('compat.noItems')} />}
    </div>
  )
}

function ScheduleEditor({ s, onSaved }: { s: Schedule; onSaved: () => void }) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(s.enabled)
  const [weekday, setWeekday] = useState(s.weekday)
  const [hour, setHour] = useState(s.hour)
  const [minute, setMinute] = useState(s.minute)
  const save = useMutation({ mutationFn: () => compatApi.schedule({ enabled, weekday, hour, minute }), onSuccess: onSaved })
  const days = [0, 1, 2, 3, 4, 5, 6]
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="schedule">
      <label className="flex items-center gap-1"><input type="checkbox" aria-label={t('compat.schedule.enabled')} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t('compat.schedule.enabled')}</label>
      <select className="input w-auto" aria-label={t('compat.schedule.weekday')} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{days.map((d) => <option key={d} value={d}>{t(`compat.weekday.${d}`)}</option>)}</select>
      <input className="input w-16" type="number" min={0} max={23} aria-label={t('compat.schedule.hour')} value={hour} onChange={(e) => setHour(Number(e.target.value))} />:
      <input className="input w-16" type="number" min={0} max={59} aria-label={t('compat.schedule.minute')} value={minute} onChange={(e) => setMinute(Number(e.target.value))} />
      <button className="btn-outline" disabled={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</button>
      <span className="text-zinc-600 dark:text-zinc-400">{t('compat.schedule.lastRun')}: {fmtTs(s.last_run)}</span>
      {save.error && <span className="text-rose-600 dark:text-rose-400">{(save.error as Error).message}</span>}
    </div>
  )
}

function PrecheckPanel({ job }: { job: PrecheckJob }) {
  const { t } = useTranslation()
  const running = isJobRunning(job.status)
  return (
    <div className="card p-3" data-testid="precheck-panel">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{t('compat.precheck.title')} {job.tag || job.want}{job.version ? ` (${job.version})` : ''}</span>
        <span className={`rounded px-2 py-0.5 text-xs ${running ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200' : job.status === 'done' ? 'bg-emerald-100 dark:bg-emerald-900/40' : 'bg-rose-100 dark:bg-rose-900/40'}`} data-testid="precheck-status">{t(`compat.step.${job.status}`, { defaultValue: job.status })}</span>
        {job.summary && <VerdictBadge v={job.summary.verdict} />}
      </div>
      <ol className="mt-2 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
        {job.progress.map((p, i) => <li key={i}>{new Date(p.ts).toLocaleTimeString()} · {t(`compat.step.${p.step}`, { defaultValue: p.step })} {p.msg && <span className="text-zinc-600 dark:text-zinc-300">— {p.msg}</span>}</li>)}
      </ol>
      {job.error && <div className="mt-2 text-xs text-rose-600 dark:text-rose-400">{job.error}{job.log_path && <div className="text-zinc-600 dark:text-zinc-400">log: {job.log_path}</div>}</div>}
      {job.report && <div className="mt-3"><ReportTable report={job.report} /></div>}
    </div>
  )
}

export function CompatPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: compatQk })
  const status = useQuery({ queryKey: [...compatQk, 'status'], queryFn: compatApi.status, refetchInterval: (q) => ((q.state.data?.running?.length ?? 0) > 0 ? 3000 : false) })
  const caps = useQuery({ queryKey: [...compatQk, 'caps'], queryFn: compatApi.capabilities })
  const runs = useQuery({ queryKey: [...compatQk, 'runs'], queryFn: () => compatApi.runs() })
  const [jobId, setJobId] = useState<string | null>(null)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const job = useQuery({ queryKey: [...compatQk, 'job', jobId], queryFn: () => compatApi.precheckJob(jobId!), enabled: !!jobId, refetchInterval: (q) => (q.state.data && !isJobRunning(q.state.data.status) ? false : 2000) })
  const runDetail = useQuery({ queryKey: [...compatQk, 'run', openRun], queryFn: () => compatApi.run(openRun!), enabled: !!openRun })
  const [writes, setWrites] = useState(false)
  const check = useMutation({ mutationFn: () => compatApi.check(writes), onSuccess: (r) => { setOpenRun(r.run_id ?? null); refresh() } })
  const precheck = useMutation({ mutationFn: (v: string) => compatApi.precheck(v), onSuccess: (j) => { setJobId(j.id); refresh() } })
  const latest = useMutation({ mutationFn: compatApi.checkLatest, onSuccess: (r) => { const m = r.result.match(/^precheck:[^:]+:(.+)$/); if (m) setJobId(m[1]); refresh() } })
  const [ver, setVer] = useState('latest')
  const jobDone = job.data && !isJobRunning(job.data.status)
  if (jobDone && job.data && !status.isFetching && status.data?.running?.length) refresh()

  const s = status.data
  return (
    <div className="p-4">
      <PageHeader title={t('compat.title')} subtitle={t('compat.subtitle')} actions={
        <>
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={writes} onChange={(e) => setWrites(e.target.checked)} aria-label={t('compat.writes')} />{t('compat.writes')}</label>
          <button className="btn-outline" disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? t('compat.checking') : t('compat.runCheck')}</button>
          <button className="btn-primary" disabled={precheck.isPending || !!(s?.running?.length)} onClick={() => precheck.mutate('latest')}>{t('compat.precheckLatest')}</button>
        </>
      } />
      {status.isLoading && <Loading />}
      {status.error && <ErrorBox error={status.error} onRetry={() => status.refetch()} />}
      {check.error && <ErrorBox error={check.error} />}
      {precheck.error && <ErrorBox error={precheck.error} />}
      {s && (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="card p-3" data-testid="card-current">
            <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('compat.current')}</div>
            <div className="text-lg font-semibold">{s.current.version || '—'}</div>
            <div className="mt-1 flex items-center gap-2 text-xs"><VerdictBadge v={s.current.verdict} /><span className="text-zinc-600 dark:text-zinc-400">{fmtTs(s.current.checked_at)}</span></div>
            {s.current.run_id && <button className="btn-ghost mt-1 text-xs" onClick={() => setOpenRun(s.current.run_id)}>{t('compat.viewReport')}</button>}
          </div>
          <div className="card p-3" data-testid="card-tested">
            <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('compat.tested')}</div>
            <div className="text-lg font-semibold">{s.tested.tag ? `${s.tested.tag}${s.tested.version ? ` (${s.tested.version})` : ''}` : '—'}</div>
            <div className="text-xs text-zinc-600 dark:text-zinc-400">{fmtTs(s.tested.at)}</div>
          </div>
          <div className="card p-3" data-testid="card-latest">
            <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('compat.latest')}</div>
            <div className="text-lg font-semibold">{s.latest_seen.tag || '—'}</div>
            <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">{fmtTs(s.latest_seen.at)}
              <button className="btn-ghost text-xs" disabled={latest.isPending} onClick={() => latest.mutate()}>{t('compat.checkNow')}</button>
            </div>
            {latest.data && <div className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="latest-result">{latest.data.result}</div>}
          </div>
        </div>
      )}
      {s && (
        <div className="card mt-3 p-3">
          <div className="mb-1 text-sm font-medium">{t('compat.schedule.title')}</div>
          <ScheduleEditor key={`${s.schedule.enabled}-${s.schedule.weekday}-${s.schedule.hour}-${s.schedule.minute}`} s={s.schedule} onSaved={refresh} />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <input className="input w-40" aria-label={t('compat.precheck.version')} value={ver} onChange={(e) => setVer(e.target.value)} placeholder="latest / v2026.8.27" />
            <button className="btn-outline" disabled={precheck.isPending || !!(s.running?.length)} onClick={() => precheck.mutate(ver)}>{t('compat.precheck.run')}</button>
            <span className="text-zinc-600 dark:text-zinc-400">{t('compat.precheck.hint')}</span>
          </div>
        </div>
      )}
      {job.data && <div className="mt-3"><PrecheckPanel job={job.data} /></div>}
      {!job.data && s?.running?.map((j) => <div key={j.id} className="mt-3"><button className="btn-ghost text-xs" onClick={() => setJobId(j.id)}>{t('compat.precheck.follow')} {j.id}</button></div>)}

      <div className="card mt-3 p-3" data-testid="capabilities">
        <div className="mb-1 flex items-center gap-2 text-sm font-medium">{t('compat.caps.title')}
          {caps.data?.source && <span className="text-xs font-normal text-zinc-600 dark:text-zinc-400">{t('compat.caps.source', { v: caps.data.source.hermes_version, at: fmtTs(caps.data.source.finished_at) })}</span>}
        </div>
        {caps.data && !caps.data.source && <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('compat.caps.none')}</div>}
        <ul className="flex flex-wrap gap-1.5">
          {(caps.data?.modules ?? []).map((m) => (
            <li key={m.module} className={`rounded px-2 py-0.5 text-xs ${statusClass[m.status]}`} title={[m.description, ...m.missing, ...m.degraded].filter(Boolean).join('\n')} data-testid={`cap-${m.module}`}>
              {m.module} · {t(`compat.caps.${m.status}`)}{m.missing.length + m.degraded.length > 0 && <span className="ml-1 opacity-70">({[...m.missing, ...m.degraded].join(', ')})</span>}
            </li>
          ))}
        </ul>
      </div>

      {openRun && runDetail.data?.report && (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">{t('compat.report')} <code className="text-xs text-zinc-600 dark:text-zinc-400">{openRun}</code><button className="btn-ghost text-xs" onClick={() => setOpenRun(null)}>{t('common.close')}</button></div>
          <ReportTable report={runDetail.data.report} />
        </div>
      )}

      <div className="card mt-3 p-3">
        <div className="mb-1 text-sm font-medium">{t('compat.history')}</div>
        {runs.data && runs.data.length === 0 && <Empty text={t('compat.noRuns')} />}
        <div className="table-wrap">
        <table className="w-full text-xs">
          <tbody>
            {(runs.data ?? []).map((r) => (
              <tr key={r.id} className="border-t border-zinc-200 dark:border-zinc-800" data-testid={`run-${r.id}`}>
                <td className="py-1">{fmtTs(r.created_at)}</td>
                <td>{t(`compat.kind.${r.kind}`)}</td>
                <td>{r.tag || r.version || r.want}</td>
                <td><VerdictBadge v={r.verdict} />{r.status !== 'done' && <span className="ml-1 text-rose-600 dark:text-rose-400">{r.status}</span>}</td>
                <td className="text-zinc-600 dark:text-zinc-400">{'pass' in r.summary ? `${r.summary.pass}/${r.summary.fail}/${r.summary.skip}` : ''}</td>
                <td className="text-zinc-600 dark:text-zinc-400">{r.triggered_by}</td>
                <td className="text-right">{r.status === 'done' && <button className="btn-ghost text-xs" onClick={() => setOpenRun(r.id)}>{t('compat.viewReport')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  )
}

const zhTW = {
  nav: { compat: '相容性' },
  compat: {
    title: 'Hermes 相容性', subtitle: '把 Studio 碰到 Hermes 的每一個點列成清單，一鍵驗證；升級前先在沙盒跑一次，看哪些功能會斷',
    writes: '含會建資料的呼叫（建完清掉）', runCheck: '跑契約測試', checking: '檢查中…', precheckLatest: '檢查最新版相容性',
    current: '目前 Hermes', tested: '已測版本', latest: '最新版（GitHub）', checkNow: '立即檢查', viewReport: '看報告',
    verdict: { compatible: '相容', partial: '部分相容', incompatible: '不相容', none: '尚未檢查' },
    counts: '通過 {{pass}}・失敗 {{fail}}・跳過 {{skip}}（共 {{total}}）', sandbox: '沙盒', noWrites: '未含寫入呼叫',
    filter: { all: '全部', fail: '只看失敗', skip: '只看跳過' }, affected: '受影響的功能', affectsLine: '受影響模組', critical: '關鍵', noItems: '沒有項目',
    col: { item: '接觸面', kind: '類型', risk: '風險', affects: '影響模組' }, risk: { low: '低', medium: '中', high: '高' },
    schedule: { title: '每週自動盯', enabled: '啟用', weekday: '星期', hour: '時', minute: '分', lastRun: '上次執行' },
    weekday: { 0: '週一', 1: '週二', 2: '週三', 3: '週四', 4: '週五', 5: '週六', 6: '週日' },
    precheck: { title: '升級預檢', version: '版本', run: '預檢指定版本', hint: 'latest 或 tag（vYYYY.M.D）；在暫存目錄安裝、絕不動 ~/.hermes', follow: '追蹤進行中的預檢' },
    step: { queued: '排隊', resolving: '查版本', cloning: '下載', installing: '安裝', starting: '啟動沙盒 gateway', testing: '契約測試', cleanup: '清理', done: '完成', failed: '失敗', timeout: '逾時' },
    caps: { title: '能力狀態（由最近一次契約測試推導）', source: 'Hermes {{v}}，{{at}}', none: '還沒跑過契約測試；全部標「未知」，不阻擋任何功能。', available: '可用', degraded: '部分', unavailable: '不可用', unknown: '未知' },
    report: '報告', history: '歷史', noRuns: '還沒有任何檢查紀錄。', kind: { check: '契約測試', precheck: '升級預檢' },
  },
  common: { close: '關閉' },
}
const en = {
  nav: { compat: 'Compatibility' },
  compat: {
    title: 'Hermes compatibility', subtitle: 'Every point where Studio touches Hermes, verified in one click; precheck a new version in a sandbox before upgrading',
    writes: 'include data-creating calls (cleaned up)', runCheck: 'Run contract test', checking: 'Checking…', precheckLatest: 'Precheck latest',
    current: 'Current Hermes', tested: 'Tested version', latest: 'Latest (GitHub)', checkNow: 'Check now', viewReport: 'Report',
    verdict: { compatible: 'compatible', partial: 'partially compatible', incompatible: 'incompatible', none: 'not checked' },
    counts: 'pass {{pass}} · fail {{fail}} · skip {{skip}} ({{total}})', sandbox: 'sandbox', noWrites: 'no write calls',
    filter: { all: 'all', fail: 'failed', skip: 'skipped' }, affected: 'Affected features', affectsLine: 'Affected modules', critical: 'critical', noItems: 'No items',
    col: { item: 'Surface', kind: 'Kind', risk: 'Risk', affects: 'Affects' }, risk: { low: 'low', medium: 'medium', high: 'high' },
    schedule: { title: 'Weekly watch', enabled: 'Enabled', weekday: 'Weekday', hour: 'Hour', minute: 'Minute', lastRun: 'Last run' },
    weekday: { 0: 'Mon', 1: 'Tue', 2: 'Wed', 3: 'Thu', 4: 'Fri', 5: 'Sat', 6: 'Sun' },
    precheck: { title: 'Upgrade precheck', version: 'Version', run: 'Precheck version', hint: 'latest or tag (vYYYY.M.D); installed in a temp dir, never touches ~/.hermes', follow: 'Follow running precheck' },
    step: { queued: 'queued', resolving: 'resolving', cloning: 'cloning', installing: 'installing', starting: 'starting sandbox gateway', testing: 'contract test', cleanup: 'cleanup', done: 'done', failed: 'failed', timeout: 'timeout' },
    caps: { title: 'Capabilities (from last contract test)', source: 'Hermes {{v}}, {{at}}', none: 'No contract test yet; everything is "unknown" and nothing is blocked.', available: 'available', degraded: 'degraded', unavailable: 'unavailable', unknown: 'unknown' },
    report: 'Report', history: 'History', noRuns: 'No runs yet.', kind: { check: 'contract test', precheck: 'precheck' },
  },
  common: { close: 'Close' },
}

// 「？」說明抽屜：在模組內註冊，不動 src/help/*
HELP_PAGES['zh-TW'].push({
  path: '/compat', title: 'Hermes 相容性',
  what: ['Studio 碰到 Hermes 的每一個點（gateway 端點、CLI 指令、檔案／DB 欄位）都列成清單，一鍵驗證。', '升級前先在暫存沙盒裝新版跑同一套測試，看哪些功能會斷。'],
  how: ['「跑契約測試」對目前的 Hermes 逐項驗，報告裡失敗項會自動展開並列出受影響模組。', '「檢查最新版相容性」在暫存目錄安裝最新 tag、起沙盒 gateway 跑測試；進度會自動更新。', '每週自動盯預設週六 22:00，可改時間或關閉；有失敗會寫進收件匣。', '能力狀態區塊由最近一次測試推導：可用／部分／不可用。'],
  faq: [{ q: '會動到 ~/.hermes 嗎？', a: '不會。預檢用自己的 HERMES_HOME；正式環境的測試預設只讀，勾「含會建資料的呼叫」才會建（建完清掉）。' },
        { q: '風險分級是什麼？', a: '低＝公開 gateway API；中＝CLI --json；高＝表格解析與內部檔案／DB 欄位，升級最容易斷。' }],
  related: [{ to: '/inbox', label: '收件匣' }, { to: '/events', label: '事件' }],
})
HELP_PAGES.en.push({
  path: '/compat', title: 'Hermes compatibility',
  what: ['Every point where Studio touches Hermes, verified in one click.', 'Precheck a new Hermes version in a temp sandbox before upgrading.'],
  how: ['"Run contract test" checks the current Hermes; failed items expand with affected modules.', '"Precheck latest" installs the newest tag in a temp dir and runs the same tests.', 'Weekly watch defaults to Saturday 22:00; failures land in the inbox.'],
  faq: [{ q: 'Does it touch ~/.hermes?', a: 'No. The sandbox uses its own HERMES_HOME; production checks are read-only unless you enable write calls (cleaned up afterwards).' }],
  related: [{ to: '/inbox', label: 'Inbox' }],
})

const mod: StudioModule = {
  name: 'compat',
  routes: [{ path: '/compat', element: <CompatPage /> }],
  nav: [{ to: '/compat', key: 'compat', order: 62, group: 'system', icon: 'Puzzle' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
