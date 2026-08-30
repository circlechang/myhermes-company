// 首次設定精靈：① 檢查 Hermes ② 開 API 門 ③ profile → AI 員工 ④ admin 密碼 ⑤ 完成 → 工作臺＋首次導覽
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import type { Agent } from '../../api/types'
import { useAuth } from '../../auth/AuthContext'
import { LangSwitch } from '../../components/LangSwitch'
import { startTour, TOUR_KEY } from '../../components/guide/Tour'
import { setupApi, setSetupSkipped, type SetupJob, type SetupStatus } from './api'

const STEPS = ['hermes', 'api', 'agents', 'password', 'done'] as const
type StepKey = (typeof STEPS)[number]

function stepFromStatus(s: SetupStatus): number {
  if (s.next_step === 'install') return 0
  if (s.next_step === 'api') return 1
  return 2
}

export function SetupPage() {
  const { t } = useTranslation()
  const { member } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['setup', 'status'], queryFn: setupApi.status, retry: false, enabled: member?.role === 'owner' })
  const [step, setStep] = useState<number | null>(null)
  const [pwSkipped, setPwSkipped] = useState(false)
  const [pwSaved, setPwSaved] = useState(false)
  // 第一次載入依偵測結果跳到該做的那一步；之後由使用者控制
  useEffect(() => {
    if (step === null && status.data) setStep(stepFromStatus(status.data))
  }, [status.data, step])

  if (member && member.role !== 'owner') {
    return (
      <Shell>
        <p className="text-sm" data-testid="setup-not-owner">{t('setup.notOwner')}</p>
        <button type="button" className="btn-outline mt-4" onClick={() => nav('/')}>{t('setup.done.go')}</button>
      </Shell>
    )
  }
  const i = step ?? 0
  const key: StepKey = STEPS[i]
  const s = status.data
  const canNext = !!s && (key !== 'api' || (s.api.key_configured && (s.api.reachable || s.dry_run)))

  return (
    <Shell>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <h1 className="text-lg font-semibold">{t('setup.title')}</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('setup.subtitle')}</p>
        </div>
        <LangSwitch />
      </div>
      <ol className="mb-5 flex flex-wrap gap-2 text-xs" aria-label={t('setup.title')}>
        {STEPS.map((k, idx) => (
          <li key={k} className={`whitespace-nowrap rounded-full px-3 py-1 ${idx === i ? 'bg-indigo-600 text-white' : idx < i ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-zinc-100 text-zinc-600 dark:text-zinc-400 dark:bg-zinc-800'}`} data-testid={`setup-step-${k}`} aria-current={idx === i ? 'step' : undefined}>
            {idx + 1}. {t(`setup.steps.${k}`)}
          </li>
        ))}
      </ol>
      <div className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('setup.stepOf', { i: i + 1, n: STEPS.length })}</div>
      {status.isLoading && <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">…</p>}
      {status.error && (
        <div role="alert" className="mt-4 rounded-md bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {t('setup.loadFailed')}：{(status.error as Error).message}
        </div>
      )}
      {s && (
        <div className="mt-3" data-testid={`setup-panel-${key}`}>
          {key === 'hermes' && <HermesStep s={s} onRefresh={() => status.refetch()} busy={status.isFetching} />}
          {key === 'api' && <ApiStep s={s} onChanged={() => status.refetch()} />}
          {key === 'agents' && <AgentsStep />}
          {key === 'password' && (
            <PasswordStep s={s} saved={pwSaved} onSaved={() => { setPwSaved(true); status.refetch() }} onSkip={() => { setPwSkipped(true); setStep(i + 1) }} />
          )}
          {key === 'done' && <DoneStep s={s} pwSkipped={pwSkipped && !pwSaved} onGo={async () => {
            const r = await setupApi.complete()
            // 先把 gate 看的快取寫成 completed，再導向；否則 SetupGate 會用舊資料把人彈回 /setup
            qc.setQueryData(['setup', 'state'], { completed: r.completed, is_owner: true })
            await qc.invalidateQueries({ queryKey: ['setup'] })
            setSetupSkipped(false)
            try { localStorage.removeItem(TOUR_KEY) } catch { /* ignore */ }
            nav('/', { replace: true })
            setTimeout(startTour, 400)
          }} />}
        </div>
      )}
      <div className="mt-6 flex items-center justify-between border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button type="button" className="btn-ghost text-xs" onClick={() => { setSetupSkipped(true); nav('/') }} title={t('setup.skipHint')} data-testid="setup-skip">
          {t('setup.skip')}
        </button>
        <div className="flex gap-2">
          {i > 0 && <button type="button" className="btn-outline" onClick={() => setStep(i - 1)} data-testid="setup-prev">{t('setup.prev')}</button>}
          {key !== 'done' && key !== 'password' && (
            <button type="button" className="btn-primary" disabled={!canNext} onClick={() => setStep(i + 1)} data-testid="setup-next">{t('setup.next')}</button>
          )}
          {key === 'password' && (pwSaved || !s?.admin.default_password) && (
            <button type="button" className="btn-primary" onClick={() => setStep(i + 1)} data-testid="setup-next">{t('setup.next')}</button>
          )}
        </div>
      </div>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-start justify-center p-4 sm:p-8">
      <div className="card w-full max-w-2xl p-6" data-testid="setup-wizard">{children}</div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1 text-sm">
      <dt className="text-zinc-600 dark:text-zinc-400">{label}</dt>
      <dd className="col-span-2 break-all">{children}</dd>
    </div>
  )
}

function HermesStep({ s, onRefresh, busy }: { s: SetupStatus; onRefresh: () => void; busy: boolean }) {
  const { t } = useTranslation()
  const h = s.hermes
  return (
    <div>
      <h2 className="mb-2 font-medium">{t('setup.hermes.title')}</h2>
      {h.installed ? (
        <p className="mb-2 text-sm text-emerald-700 dark:text-emerald-300" data-testid="hermes-ok">
          {h.version ? t('setup.hermes.installed', { version: h.version }) : t('setup.hermes.installedNoVersion')}
        </p>
      ) : (
        <div className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200" data-testid="hermes-missing">
          <p className="font-medium">{t('setup.hermes.missing')}</p>
          <p className="mt-1">{t('setup.hermes.missingHelp')}</p>
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{t('setup.hermes.installCmd')}</p>
          <pre className="mt-1 overflow-x-auto rounded bg-zinc-900 p-2 text-xs text-zinc-100"><code>{h.install_cmd}</code></pre>
          <a className="mt-2 inline-block text-xs underline" href={h.docs_url} target="_blank" rel="noreferrer">{t('setup.hermes.docs')}</a>
        </div>
      )}
      <dl>
        <Row label={t('setup.hermes.bin')}><code className="text-xs">{h.bin}</code></Row>
        <Row label={t('setup.hermes.home')}><code className="text-xs">{h.home}</code>{!h.home_exists && <span className="ml-2 text-xs text-amber-700">{t('setup.hermes.homeMissing')}</span>}</Row>
        <Row label={t('setup.hermes.profiles')}>{s.profiles.count}{s.profiles.names.length > 0 && <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-400">{s.profiles.names.join(', ')}</span>}</Row>
        <Row label={t('setup.hermes.gateway')}>{s.gateway.running ? t('setup.hermes.gwRunning', { pid: s.gateway.pid ?? '?' }) : t('setup.hermes.gwStopped')}</Row>
      </dl>
      <button type="button" className="btn-outline mt-3 text-xs" onClick={onRefresh} disabled={busy} data-testid="setup-refresh">{t('setup.refresh')}</button>
    </div>
  )
}

function ApiStep({ s, onChanged }: { s: SetupStatus; onChanged: () => void }) {
  const { t } = useTranslation()
  const [job, setJob] = useState<SetupJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [backup, setBackup] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const open = s.api.key_configured && s.api.reachable
  const stop = () => { if (timer.current) { window.clearInterval(timer.current); timer.current = null } }
  useEffect(() => stop, [])

  const poll = () => {
    stop()
    timer.current = window.setInterval(async () => {
      try {
        const r = await setupApi.progress()
        setJob(r.job)
        if (r.job?.done) { stop(); onChanged() }
      } catch (e) { stop(); setError((e as Error).message) }
    }, 1200)
  }
  const m = useMutation({
    mutationFn: () => setupApi.enableApi(),
    onMutate: () => { setError(null); setJob(null) },
    onSuccess: (r) => {
      setBackup(r.backup ?? null)
      if (r.status === 'configured') { onChanged(); return }
      setJob(r.job)
      if (r.job && !r.job.done) poll()
      else onChanged()
    },
    onError: (e) => setError((e as Error).message),
  })
  const busy = m.isPending || (!!job && !job.done)
  return (
    <div>
      <h2 className="mb-2 font-medium">{t('setup.api.title')}</h2>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">{t('setup.api.why', { path: s.api.env_path })}</p>
      {open ? (
        <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" data-testid="api-open">
          {t('setup.api.alreadyOpen', { version: s.api.version || '' })}
        </p>
      ) : (
        <div>
          {s.api.auth_failed ? (
            <p className="mb-2 text-sm text-rose-700 dark:text-rose-300" data-testid="api-key-wrong">{t('setup.api.keyWrong')}</p>
          ) : s.api.key_configured && <p className="mb-2 text-sm text-amber-700 dark:text-amber-300">{t('setup.api.keySetButDown')}</p>}
          {!s.hermes.home_exists && <p className="mb-2 text-sm text-rose-700">{t('setup.api.envHint')}</p>}
          <button type="button" className="btn-primary" disabled={busy || !s.hermes.home_exists} onClick={() => m.mutate()} data-testid="api-open-btn">
            {busy ? t('setup.api.running', { elapsed: job?.elapsed ?? 0 }) : job && !job.ok ? t('setup.api.retry') : t('setup.api.open')}
          </button>
          {s.dry_run && <span className="ml-2 text-xs text-zinc-600 dark:text-zinc-400">{t('setup.api.dryRun')}</span>}
        </div>
      )}
      {job && (
        <ol className="mt-3 space-y-1 text-sm" data-testid="api-job">
          {job.steps.map((st) => (
            <li key={st.name} className="flex items-start gap-2">
              <span className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${st.status === 'ok' ? 'bg-emerald-500' : st.status === 'failed' ? 'bg-rose-500' : st.status === 'running' ? 'animate-pulse bg-indigo-500' : 'bg-zinc-400'}`} />
              <span className="shrink-0 whitespace-nowrap">{t(`setup.api.phase.${st.name}`)}</span>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">{t(`setup.api.phaseStatus.${st.status}`)}{st.detail ? ` · ${st.detail}` : ''}</span>
            </li>
          ))}
          {job.done && job.ok && <li className="text-emerald-700 dark:text-emerald-300" data-testid="api-success">{t('setup.api.success')}{job.dry_run ? ` ${t('setup.api.dryRun')}` : ''}</li>}
          {job.done && job.ok === false && (
            <li className="rounded-md bg-rose-50 p-3 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200" data-testid="api-failed">
              <p>{t('setup.api.failed')} {job.error}</p>
              <p className="mt-2 text-xs">{t('setup.api.manual')}</p>
              <pre className="mt-1 overflow-x-auto rounded bg-zinc-900 p-2 text-xs text-zinc-100"><code>{job.manual_cmd}</code></pre>
              {job.log_tail && (<><p className="mt-2 text-xs">{t('setup.api.logTail')}</p><pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-900 p-2 text-xs text-zinc-100">{job.log_tail}</pre></>)}
            </li>
          )}
        </ol>
      )}
      {backup && <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{t('setup.api.backup')}: <code>{backup}</code></p>}
      {error && <div role="alert" className="mt-3 rounded-md bg-rose-50 p-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>}
    </div>
  )
}

function AgentsStep() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['agents'], queryFn: api.agents.list })
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.agents.update(id, { enabled }),
    onMutate: ({ id, enabled }) => {  // 樂觀更新：勾了立刻變
      qc.setQueryData<Agent[]>(['agents'], (old) => (old ?? []).map((a) => (a.id === id ? { ...a, enabled } : a)))
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  })
  const [local, setLocal] = useState<Record<string, boolean>>({})  // 勾選當下就反映，不等伺服器
  const agents = useMemo(() => (q.data ?? []).map((a) => (a.id in local ? { ...a, enabled: local[a.id] } : a)), [q.data, local])
  const enabled = useMemo(() => agents.filter((a) => a.enabled).length, [agents])
  const onToggle = (a: Agent, enabled: boolean) => {
    setLocal((m) => ({ ...m, [a.id]: enabled }))
    toggle.mutate({ id: a.id, enabled })
  }
  return (
    <div>
      <h2 className="mb-2 font-medium">{t('setup.agents.title')}</h2>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">{t('setup.agents.why')}</p>
      {q.isLoading && <p className="text-sm text-zinc-600 dark:text-zinc-400">…</p>}
      {q.data && agents.length === 0 && <p className="text-sm text-amber-700">{t('setup.agents.none')}</p>}
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="setup-agents">
        {agents.map((a: Agent) => (
          <li key={a.id} className="flex min-w-0 items-center justify-between gap-2 py-2 text-sm">
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
              <input type="checkbox" className="shrink-0" checked={a.enabled} onChange={(e) => onToggle(a, e.target.checked)} aria-label={a.name} data-testid={`agent-toggle-${a.profile}`} />
              <span className="min-w-0 truncate font-medium" title={a.name}>{a.name}</span>
              <code className="id-text shrink text-zinc-600 dark:text-zinc-400" title={a.profile}>{a.profile}</code>
              {a.model && <span className="hidden shrink-0 whitespace-nowrap text-xs text-zinc-600 sm:inline dark:text-zinc-400">{a.model}</span>}
            </label>
            <span className={`shrink-0 whitespace-nowrap text-xs ${a.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-zinc-600 dark:text-zinc-400'}`}>{a.enabled ? t('setup.agents.enabled') : t('setup.agents.disabled')}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400" data-testid="agents-enabled-count">{t('setup.agents.enabledCount', { n: enabled })}</p>
      {q.data && agents.length > 0 && enabled === 0 && <p className="mt-1 text-xs text-amber-700">{t('setup.agents.noneEnabledWarn')}</p>}
    </div>
  )
}

function PasswordStep({ s, saved, onSaved, onSkip }: { s: SetupStatus; saved: boolean; onSaved: () => void; onSkip: () => void }) {
  const { t } = useTranslation()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [confirmSkip, setConfirmSkip] = useState(false)
  const m = useMutation({ mutationFn: (p: string) => setupApi.adminPassword(p), onSuccess: () => { setErr(null); onSaved() }, onError: (e) => setErr((e as Error).message) })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (pw !== pw2) { setErr(t('setup.password.mismatch')); return }
    m.mutate(pw)
  }
  const needs = s.admin.default_password && !saved
  return (
    <div>
      <h2 className="mb-2 font-medium">{t('setup.password.title')}</h2>
      {!needs ? (
        <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" data-testid="password-ok">
          {saved ? t('setup.password.saved') : t('setup.password.already')}
        </p>
      ) : (
        <form onSubmit={submit}>
          <p className="mb-3 text-sm text-amber-700 dark:text-amber-300">{t('setup.password.why')}</p>
          <label className="mb-2 block text-sm">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">{t('setup.password.new')}</span>
            <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required data-testid="pw-new" />
          </label>
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-zinc-600 dark:text-zinc-400">{t('setup.password.confirm')}</span>
            <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={8} required data-testid="pw-confirm" />
          </label>
          {err && <div role="alert" className="mb-3 rounded-md bg-rose-50 p-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{err}</div>}
          <div className="flex items-center gap-2">
            <button type="submit" className="btn-primary" disabled={m.isPending} data-testid="pw-save">{t('setup.password.save')}</button>
            {!confirmSkip ? (
              <button type="button" className="btn-ghost text-xs" onClick={() => setConfirmSkip(true)} data-testid="pw-skip">{t('setup.skip')}</button>
            ) : (
              <span className="flex items-center gap-2 text-xs text-rose-700" data-testid="pw-skip-warn">
                {t('setup.password.skipWarn')}
                <button type="button" className="btn-outline text-xs" onClick={onSkip} data-testid="pw-skip-confirm">{t('setup.password.skipAnyway')}</button>
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  )
}

function DoneStep({ s, pwSkipped, onGo }: { s: SetupStatus; pwSkipped: boolean; onGo: () => Promise<void> }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: api.agents.list })
  const enabled = (agentsQ.data ?? []).filter((a) => a.enabled).length
  const apiOk = s.api.key_configured && (s.api.reachable || s.dry_run)
  const pwOk = !s.admin.default_password && !pwSkipped
  const Item = ({ label, ok, note }: { label: string; ok: boolean; note?: string }) => (
    <li className="flex items-center gap-2 text-sm">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      <span>{label}</span>
      <span className="text-xs text-zinc-600 dark:text-zinc-400">{ok ? t('setup.done.ok') : t('setup.done.warn')}{note ? ` · ${note}` : ''}</span>
    </li>
  )
  return (
    <div>
      <h2 className="mb-2 font-medium">{t('setup.done.title')}</h2>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">{t('setup.done.summary')}</p>
      <ul className="space-y-1" data-testid="setup-summary">
        <Item label={t('setup.done.hermes')} ok={s.hermes.installed} note={s.hermes.version} />
        <Item label={t('setup.done.api')} ok={apiOk} />
        <Item label={t('setup.done.agents')} ok={enabled > 0} note={t('setup.agents.enabledCount', { n: enabled })} />
        <Item label={t('setup.done.password')} ok={pwOk} />
      </ul>
      <button type="button" className="btn-primary mt-4" disabled={busy} onClick={async () => { setBusy(true); try { await onGo() } finally { setBusy(false) } }} data-testid="setup-finish">
        {t('setup.done.go')}
      </button>
    </div>
  )
}
