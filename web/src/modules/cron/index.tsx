// D. 排程任務：CRUD／暫停／恢復／立即執行／執行歷史；表達式快捷預設；投遞目標
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import type { StudioModule } from '../registry'
import { useProfiles } from '../profiles'

export interface CronJob {
  id: string; name: string; prompt?: string; deliver?: string; schedule?: unknown; schedule_display?: string
  enabled?: boolean; state?: string; paused: boolean; next_run_at?: string | null; last_run_at?: string | null; last_status?: string | null; last_error?: string | null
  skills?: string[]; repeat?: { times?: number | null; completed?: number } | number | null; failure_streak?: number
}
export interface CronRun { id: string; status: string; claimed_at: string; started_at?: string; finished_at?: string; error?: string; duration_s?: number }

const json = (b: unknown) => JSON.stringify(b)
const q = (profile?: string) => (profile && profile !== 'default' ? `?profile=${encodeURIComponent(profile)}` : '')
export const cronApi = {
  presets: () => request<{ presets: { id: string; label: string; schedule: string; repeat?: number }[] }>('/cron/presets'),
  targets: (profile?: string) => request<{ targets: { id: string; label: string; kind: string; hint?: string }[] }>(`/cron/targets${q(profile)}`),
  list: (profile?: string) => request<{ jobs: CronJob[] }>(`/cron/jobs${q(profile)}`),
  create: (body: { name: string; schedule: string; prompt: string; deliver: string; repeat?: number; profile?: string }) => request<CronJob>('/cron/jobs', { method: 'POST', body: json(body) }),
  update: (id: string, body: Record<string, unknown>) => request<CronJob>(`/cron/jobs/${id}`, { method: 'PATCH', body: json(body) }),
  remove: (id: string, profile?: string) => request<{ ok: boolean }>(`/cron/jobs/${id}${q(profile)}`, { method: 'DELETE' }),
  action: (id: string, action: 'pause' | 'resume' | 'run', profile?: string) => request<CronJob>(`/cron/jobs/${id}/${action}${q(profile)}`, { method: 'POST' }),
  runs: (id: string, profile?: string) => request<{ runs: CronRun[]; outputs: { filename: string; size: number }[] }>(`/cron/jobs/${id}/runs${q(profile)}`),
  output: (id: string, filename: string, profile?: string) => request<{ text: string }>(`/cron/jobs/${id}/output/${encodeURIComponent(filename)}${q(profile)}`),
}

function JobForm({ profile, onDone, initial }: { profile?: string; onDone: () => void; initial?: CronJob }) {
  const { t } = useTranslation()
  const presets = useQuery({ queryKey: ['cron', 'presets'], queryFn: cronApi.presets })
  const targets = useQuery({ queryKey: ['cron', 'targets', profile], queryFn: () => cronApi.targets(profile) })
  const [name, setName] = useState(initial?.name ?? '')
  const [schedule, setSchedule] = useState(initial?.schedule_display ?? '0 9 * * *')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [deliver, setDeliver] = useState(initial?.deliver ?? 'local')
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: () => initial ? cronApi.update(initial.id, { name, schedule, prompt, deliver, profile }) : cronApi.create({ name, schedule, prompt, deliver, profile }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cron', 'jobs'] }); onDone() },
  })
  return (
    <div className="card space-y-2 p-3">
      <h3 className="font-medium">{initial ? t('cron.edit') : t('cron.create')}</h3>
      <div className="grid gap-2 md:grid-cols-2">
        <input className="input" placeholder={t('cron.name')} value={name} onChange={(e) => setName(e.target.value)} aria-label={t('cron.name')} />
        <div className="flex gap-1">
          <input className="input font-mono" placeholder="0 9 * * *" value={schedule} onChange={(e) => setSchedule(e.target.value)} aria-label={t('cron.schedule')} />
          <select className="input w-auto" aria-label={t('cron.presets')} value="" onChange={(e) => { if (e.target.value) setSchedule(e.target.value) }}>
            <option value="">{t('cron.presets')}</option>
            {presets.data?.presets.map((p) => <option key={p.id} value={p.schedule}>{p.label}（{p.schedule}）</option>)}
          </select>
        </div>
      </div>
      <textarea className="input min-h-[100px]" placeholder={t('cron.promptPlaceholder')} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label={t('cron.prompt')} />
      <div className="flex items-center gap-2 text-sm">
        <label className="text-xs text-zinc-600 dark:text-zinc-400">{t('cron.deliver')}</label>
        <select className="input w-auto" value={deliver} onChange={(e) => setDeliver(e.target.value)} aria-label={t('cron.deliver')}>
          {targets.data?.targets.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          {!targets.data?.targets.some((x) => x.id === deliver) && <option value={deliver}>{deliver}</option>}
        </select>
        <input className="input w-56" placeholder={t('cron.deliverCustom')} onBlur={(e) => { if (e.target.value) setDeliver(e.target.value) }} aria-label={t('cron.deliverCustom')} />
        <span className="ml-auto flex gap-2">
          <button className="btn-outline" onClick={onDone}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={!name.trim() || !schedule.trim() || save.isPending} onClick={() => save.mutate()}>{t('common.save')}</button>
        </span>
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('cron.scheduleHint')}</p>
      {save.error && <ErrorBox error={save.error} />}
    </div>
  )
}

function RunHistory({ job, profile }: { job: CronJob; profile?: string }) {
  const { t } = useTranslation()
  const h = useQuery({ queryKey: ['cron', 'runs', job.id, profile], queryFn: () => cronApi.runs(job.id, profile) })
  const [file, setFile] = useState<string | null>(null)
  const out = useQuery({ queryKey: ['cron', 'output', job.id, file], queryFn: () => cronApi.output(job.id, file!, profile), enabled: !!file })
  if (h.isLoading) return <Loading />
  if (h.error) return <ErrorBox error={h.error} />
  return (
    <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
      <div>
        <div className="mb-1 font-medium text-zinc-600 dark:text-zinc-400">{t('cron.runs')}</div>
        {h.data?.runs.length === 0 && <Empty text={t('cron.noRuns')} />}
        <div className="table-wrap">
        <table className="w-full">
          <tbody>
            {h.data?.runs.map((r) => (
              <tr key={r.id} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className="py-1">{r.claimed_at?.slice(0, 19).replace('T', ' ')}</td>
                <td><span className={r.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : r.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : ''}>{r.status}</span></td>
                <td>{r.duration_s != null ? `${r.duration_s}s` : ''}</td>
                <td className="truncate text-rose-600 dark:text-rose-400">{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      <div>
        <div className="mb-1 font-medium text-zinc-600 dark:text-zinc-400">{t('cron.outputs')}</div>
        <ul className="space-y-0.5">
          {h.data?.outputs.map((o) => <li key={o.filename}><button className="underline" onClick={() => setFile(o.filename)}>{o.filename}</button> <span className="text-zinc-600 dark:text-zinc-400">{o.size} B</span></li>)}
        </ul>
        {file && out.data && <pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-100 p-2 dark:bg-zinc-800">{out.data.text}</pre>}
      </div>
    </div>
  )
}

export function CronPage() {
  const { t } = useTranslation()
  const profiles = useProfiles()
  const [profile, setProfile] = useState<string>('default')
  const jobs = useQuery({ queryKey: ['cron', 'jobs', profile], queryFn: () => cronApi.list(profile) })
  const qc = useQueryClient()
  const inv = () => qc.invalidateQueries({ queryKey: ['cron', 'jobs'] })
  const act = useMutation({ mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'run' }) => cronApi.action(id, action, profile), onSuccess: inv })
  const del = useMutation({ mutationFn: (id: string) => cronApi.remove(id, profile), onSuccess: inv })
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<CronJob | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <PageHeader title={t('cron.title')} subtitle={t('cron.subtitle')} actions={
        <>
          <select className="input w-auto" value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="profile">
            {(profiles.data?.profiles ?? [{ name: 'default' }]).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <button className="btn-primary" onClick={() => { setCreating(true); setEditing(null) }}>{t('cron.create')}</button>
        </>
      } />
      {creating && <JobForm profile={profile} onDone={() => setCreating(false)} />}
      {editing && <JobForm key={editing.id} profile={profile} initial={editing} onDone={() => setEditing(null)} />}
      {jobs.isLoading && <Loading />}
      {jobs.error && <ErrorBox error={jobs.error} onRetry={() => jobs.refetch()} />}
      {(act.error || del.error) && <ErrorBox error={act.error ?? del.error} />}
      {jobs.data?.jobs.length === 0 && <Empty text={t('cron.noJobs')} />}
      <div className="space-y-2">
        {jobs.data?.jobs.map((j) => (
          <div key={j.id} className="card p-3" data-testid={`job-${j.id}`}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`inline-block h-2 w-2 rounded-full ${j.paused ? 'bg-zinc-400' : 'bg-emerald-500'}`} />
              <button className="font-medium" onClick={() => setExpanded(expanded === j.id ? null : j.id)}>{j.name}</button>
              <code className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">{j.schedule_display}</code>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">→ {j.deliver}</span>
              {j.paused && <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('cron.paused')}</span>}
              <span className="ml-auto flex gap-1 text-xs">
                <button className="btn-ghost" onClick={() => act.mutate({ id: j.id, action: 'run' })}>{t('cron.runNow')}</button>
                {j.paused ? <button className="btn-ghost" onClick={() => act.mutate({ id: j.id, action: 'resume' })}>{t('cron.resume')}</button>
                  : <button className="btn-ghost" onClick={() => act.mutate({ id: j.id, action: 'pause' })}>{t('cron.pause')}</button>}
                <button className="btn-ghost" onClick={() => { setEditing(j); setCreating(false) }}>{t('common.edit')}</button>
                <button className="btn-ghost text-rose-600 dark:text-rose-400" onClick={() => { if (confirm(t('cron.confirmDelete', { name: j.name }))) del.mutate(j.id) }}>{t('common.delete')}</button>
              </span>
            </div>
            <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {t('cron.next')}: {j.next_run_at ?? '—'} · {t('cron.last')}: {j.last_run_at ?? '—'} {j.last_status && `(${j.last_status})`}
              {j.last_error && <span className="text-rose-600 dark:text-rose-400"> · {j.last_error}</span>}
            </div>
            {j.prompt && <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-400">{j.prompt}</div>}
            {expanded === j.id && <RunHistory job={j} profile={profile} />}
          </div>
        ))}
      </div>
    </div>
  )
}

const zhTW = {
  nav: { cron: '排程' },
  cron: {
    title: '排程任務', subtitle: 'Hermes cron：定時讓 AI 員工執行任務並投遞到平台（走 gateway /api/jobs）',
    create: '新增排程', edit: '編輯排程', name: '名稱', schedule: '排程表達式', presets: '快捷預設', prompt: '任務指令', promptPlaceholder: '要 AI 做什麼（自成一段、不依賴對話上下文）',
    deliver: '投遞到', deliverCustom: '或自訂：telegram:123 / line:Uxxx', scheduleHint: '支援 cron 5 欄（0 9 * * *）、間隔（30m、every 2h）或一次性；時區依 Hermes 設定。',
    runNow: '立即執行', pause: '暫停', resume: '恢復', paused: '已暫停', confirmDelete: '刪除排程「{{name}}」？', noJobs: '還沒有排程', next: '下次', last: '上次',
    runs: '執行歷史（executions.db）', noRuns: '沒有紀錄', outputs: '輸出檔',
  },
}
const en = {
  nav: { cron: 'Cron' },
  cron: {
    title: 'Scheduled jobs', subtitle: 'Hermes cron via gateway /api/jobs', create: 'New job', edit: 'Edit job', name: 'Name', schedule: 'Schedule', presets: 'Presets', prompt: 'Prompt',
    promptPlaceholder: 'Self-contained task instruction', deliver: 'Deliver to', deliverCustom: 'custom: telegram:123', scheduleHint: 'cron 5-field, interval (30m, every 2h) or one-shot.',
    runNow: 'Run now', pause: 'Pause', resume: 'Resume', paused: 'paused', confirmDelete: 'Delete job "{{name}}"?', noJobs: 'No jobs yet', next: 'next', last: 'last',
    runs: 'Run history', noRuns: 'No runs', outputs: 'Outputs',
  },
}

const mod: StudioModule = {
  name: 'cron',
  routes: [{ path: '/cron', element: <CronPage /> }],
  nav: [{ to: '/cron', key: 'cron', order: 43, group: 'connect', icon: 'CalendarClock' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
