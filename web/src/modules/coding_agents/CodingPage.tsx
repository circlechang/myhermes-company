import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAuth } from '../../auth/AuthContext'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { PageHeader } from '../../components/PageHeader'
import { codingApi, type AgentId, type AgentInfo, type AgentSetting, type CodingSession } from './api'
import { DiffView } from './DiffView'
import { useCodingSocket } from './socket'
import { addUserMessage, applyEvent, emptyState, fromMessages, type CodingEvent, type CodingState, type Item } from './state'

// 若同事的終端模組存在（web/src/modules/terminal），可在這裡換成其元件；撰寫時尚不存在，先用日誌視圖。

const fmtJson = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))

function ItemView({ it }: { it: Item }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (it.kind === 'text') {
    return (
      <div className={`rounded-md px-3 py-2 text-sm ${it.role === 'user' ? 'bg-indigo-50 dark:bg-indigo-950/30' : 'bg-white dark:bg-zinc-900'}`}>
        <div className="mb-1 text-[10px] uppercase text-zinc-600 dark:text-zinc-400">{it.role === 'user' ? t('coding.you') : t('coding.agent')}{it.streaming ? ' …' : ''}</div>
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.content}</ReactMarkdown>
        </div>
      </div>
    )
  }
  if (it.kind === 'tool') {
    return (
      <div className={`rounded-md border px-3 py-1.5 text-xs dark:border-zinc-700 ${it.error ? 'border-rose-300' : 'border-zinc-200'}`}>
        <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
          <span className={`h-2 w-2 rounded-full ${it.status === 'running' ? 'animate-pulse bg-amber-500' : it.error ? 'bg-rose-500' : 'bg-emerald-500'}`} />
          <code className="font-medium">{it.name}</code>
          <span className="text-zinc-600 dark:text-zinc-400">{it.status === 'running' ? t('coding.toolRunning') : t('coding.toolDone')}</span>
          <span className="ml-auto text-zinc-600 dark:text-zinc-400">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="mt-1 grid gap-1">
            {it.args !== undefined && <pre className="max-h-40 overflow-auto rounded bg-zinc-100 p-2 dark:bg-zinc-800">{fmtJson(it.args)}</pre>}
            {it.result !== undefined && <pre className="max-h-60 overflow-auto rounded bg-zinc-100 p-2 dark:bg-zinc-800">{fmtJson(it.result)}</pre>}
          </div>
        )}
      </div>
    )
  }
  if (it.kind === 'log') return <div className="px-3 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{it.stream === 'stderr' ? '⚠ ' : ''}{it.text}</div>
  return (
    <div className={`rounded-md px-3 py-1.5 text-xs ${it.level === 'error' ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200' : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'}`}>
      {it.level === 'info' && it.text === 'cancelled' ? t('coding.cancelled') : it.text}
    </div>
  )
}

function AgentCard({ a, selected, onSelect, onSettings, onInstall, canInstall }: {
  a: AgentInfo; selected: boolean; onSelect: () => void; onSettings: () => void; onInstall: () => void; canInstall: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className={`card p-3 ${selected ? 'ring-2 ring-indigo-500' : ''}`} data-testid={`agent-card-${a.id}`}>
      <button type="button" className="w-full text-left" onClick={onSelect}>
        <div className="flex items-center gap-2">
          <span className="font-medium">{a.name}</span>
          <span className={`ml-auto rounded px-1.5 text-[10px] ${a.installed ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'}`}>
            {a.installed ? t('coding.installed') : t('coding.notInstalled')}
          </span>
        </div>
        <div className="truncate text-xs text-zinc-600 dark:text-zinc-400">{a.installed ? `v${a.version} · ${a.path}` : a.install_cmd}</div>
        <div className="mt-1 text-[11px] text-zinc-600 dark:text-zinc-400">
          {t('coding.apiMode')}: {a.settings.api_mode === 'hermes' ? t('coding.apiModeHermes') : t('coding.apiModeDirect')}
          {a.settings.model ? ` · ${a.settings.model}` : ''}
        </div>
      </button>
      <div className="mt-2 flex gap-1">
        <button className="btn-outline text-xs" onClick={onSettings}>{t('coding.settings')}</button>
        {!a.installed && canInstall && (
          <button className="btn-primary text-xs" onClick={onInstall} disabled={!a.npm_available} title={a.npm_available ? '' : t('coding.npmMissing')}>
            {t('coding.install')}
          </button>
        )}
      </div>
    </div>
  )
}

function SettingsPanel({ agent, initial, onClose }: { agent: AgentId; initial: AgentSetting; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [form, setForm] = useState<AgentSetting>(initial)
  const [browse, setBrowse] = useState<string | null>(null)
  const fsQ = useQuery({ queryKey: ['coding-fs', browse], queryFn: () => codingApi.fs(browse ?? undefined), enabled: browse !== null })
  const proxyQ = useQuery({ queryKey: ['coding-proxy'], queryFn: codingApi.proxyInfo, enabled: form.api_mode === 'hermes' })
  const save = useMutation({
    mutationFn: () => codingApi.saveSetting(agent, form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['coding-agents'] })
      onClose()
    },
  })
  const extra = form.extra as Record<string, string | number | boolean | undefined>
  const setExtra = (k: string, v: unknown) => setForm({ ...form, extra: { ...form.extra, [k]: v } })
  return (
    <div className="card mb-3 p-3 text-sm" data-testid="settings-panel">
      <div className="mb-2 font-medium">{t('coding.settingsFor', { agent })}</div>
      <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('coding.workspace')}</label>
      <div className="flex gap-1">
        <input className="input" aria-label={t('coding.workspace')} value={form.workspace} onChange={(e) => setForm({ ...form, workspace: e.target.value })} />
        <button className="btn-outline" onClick={() => setBrowse(form.workspace || '')}>{t('coding.browse')}</button>
      </div>
      {browse !== null && fsQ.data && (
        <div className="mt-1 max-h-40 overflow-auto rounded border border-zinc-200 p-1 text-xs dark:border-zinc-700">
          <div className="mb-1 flex items-center gap-2">
            <code className="truncate">{fsQ.data.path}</code>
            {fsQ.data.parent && <button className="btn-ghost text-xs" onClick={() => setBrowse(fsQ.data!.parent!)}>↑</button>}
            <button className="btn-primary ml-auto text-xs" onClick={() => { setForm({ ...form, workspace: fsQ.data!.path }); setBrowse(null) }}>{t('coding.useThis')}</button>
          </div>
          {fsQ.data.dirs.map((d) => (
            <button key={d.path} type="button" className="block w-full truncate rounded px-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => setBrowse(d.path)}>
              {d.is_git ? '● ' : '○ '}{d.name}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('coding.model')}</label>
          <input className="input" aria-label={t('coding.model')} value={form.model} placeholder={t('coding.modelHint')} onChange={(e) => setForm({ ...form, model: e.target.value })} />
        </div>
        <div>
          <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('coding.apiMode')}</label>
          <select className="input" aria-label={t('coding.apiMode')} value={form.api_mode} onChange={(e) => setForm({ ...form, api_mode: e.target.value as 'direct' | 'hermes' })}>
            <option value="direct">{t('coding.apiModeDirect')}</option>
            <option value="hermes">{t('coding.apiModeHermes')}</option>
          </select>
        </div>
        {form.api_mode === 'hermes' && (
          <div>
            <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('coding.hermesProfile')}</label>
            <input className="input" value={form.hermes_profile} placeholder="default" onChange={(e) => setForm({ ...form, hermes_profile: e.target.value })} />
          </div>
        )}
        {agent === 'claude' && (
          <>
            <div>
              <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('coding.permissionMode')}</label>
              <select className="input" value={String(extra.permission_mode ?? 'acceptEdits')} onChange={(e) => setExtra('permission_mode', e.target.value)}>
                {['default', 'acceptEdits', 'plan', 'bypassPermissions'].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('coding.maxTurns')}</label>
              <input className="input" type="number" min={1} value={String(extra.max_turns ?? '')} onChange={(e) => setExtra('max_turns', e.target.value ? Number(e.target.value) : undefined)} />
            </div>
            <div>
              <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('coding.maxBudget')}</label>
              <input className="input" type="number" step="0.1" min={0} value={String(extra.max_budget_usd ?? '')} onChange={(e) => setExtra('max_budget_usd', e.target.value ? Number(e.target.value) : undefined)} />
            </div>
          </>
        )}
        {agent === 'codex' && (
          <div>
            <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('coding.sandbox')}</label>
            <select className="input" value={String(extra.sandbox ?? 'workspace-write')} onChange={(e) => setExtra('sandbox', e.target.value)}>
              {['read-only', 'workspace-write', 'danger-full-access'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
      </div>
      {form.api_mode === 'hermes' && proxyQ.data && (
        <div className="mt-2 rounded bg-zinc-100 p-2 text-[11px] dark:bg-zinc-800">
          <div className="mb-1 text-zinc-600 dark:text-zinc-400">{t('coding.proxyHint')}</div>
          <pre className="overflow-auto">{agent === 'codex' ? proxyQ.data.codex_config_snippet : Object.entries(proxyQ.data.claude_env).map(([k, v]) => `${k}=${v}`).join('\n')}</pre>
        </div>
      )}
      {save.error && <ErrorBox error={save.error} />}
      <div className="mt-2 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>{t('common.save')}</button>
      </div>
    </div>
  )
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(f)
  })
}

export function CodingPage() {
  const { t } = useTranslation()
  const { member } = useAuth()
  const qc = useQueryClient()
  const [agent, setAgent] = useState<AgentId>('claude')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [settingsFor, setSettingsFor] = useState<AgentId | null>(null)
  const [tab, setTab] = useState<'output' | 'diff'>('output')
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [newWs, setNewWs] = useState('')
  const [installJob, setInstallJob] = useState<string | null>(null)
  const [state, setState] = useState<CodingState>(emptyState())
  const stateRef = useRef(state)
  stateRef.current = state
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const agentsQ = useQuery({ queryKey: ['coding-agents'], queryFn: codingApi.agents })
  const sessionsQ = useQuery({ queryKey: ['coding-sessions', agent], queryFn: () => codingApi.sessions(agent) })
  const msgsQ = useQuery({ queryKey: ['coding-messages', sessionId], queryFn: () => codingApi.messages(sessionId!), enabled: !!sessionId })
  const runsQ = useQuery({ queryKey: ['coding-runs', sessionId], queryFn: () => codingApi.runs(sessionId!), enabled: !!sessionId })
  const jobQ = useQuery({
    queryKey: ['coding-install', installJob], queryFn: () => codingApi.installJob(installJob!), enabled: !!installJob,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  })
  useEffect(() => {
    if (jobQ.data && jobQ.data.status !== 'running') qc.invalidateQueries({ queryKey: ['coding-agents'] })
  }, [jobQ.data, qc])

  // 只在「切到某個 session」時用伺服器的訊息／runs 重建畫面一次；之後以 WS 串流的即時狀態為準。
  // （原本每次 msgs/runs 重抓都重建：run.completed 後 invalidate runs → 用舊的 msgs 快取覆蓋掉剛串流完的輸出，
  //   vitest 全套並行時就會偶發「Done: …」消失；真機上也會讓輸出閃掉一次。）
  const hydratedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!sessionId || !msgsQ.data || (runsQ.data === undefined && !runsQ.isError)) return
    if (hydratedFor.current === sessionId) return
    hydratedFor.current = sessionId
    const hist = fromMessages(msgsQ.data)
    if (stateRef.current.running) {
      // 歷史還沒載完使用者就開跑了：把歷史接在即時內容前面，不覆蓋
      setState((s) => ({ ...s, items: [...hist.items, ...s.items] }))
      return
    }
    const last = runsQ.data?.[runsQ.data.length - 1]
    setState({ ...hist, diff: last ? { before: last.diff_before, after: last.diff_after, files: last.files, is_git: !!(last.diff_before || last.diff_after || last.files.length) } : undefined, usage: last?.usage })
  }, [sessionId, msgsQ.data, runsQ.data, runsQ.isError])

  const onEvent = useCallback((ev: CodingEvent) => {
    if ('session_id' in ev && ev.session_id && ev.session_id !== sessionRef.current) return
    setState((s) => applyEvent(s, ev))
    if (ev.type === 'run.completed' || ev.type === 'run.failed' || ev.type === 'run.cancelled') {
      qc.invalidateQueries({ queryKey: ['coding-sessions'] })
      qc.invalidateQueries({ queryKey: ['coding-runs', sessionRef.current] })
      qc.invalidateQueries({ queryKey: ['coding-messages', sessionRef.current] })
      if (ev.type === 'run.completed' && ev.diff?.files.length) setTab('diff')
    }
  }, [qc])
  const { status: wsStatus, send } = useCodingSocket(onEvent)

  const createSession = useMutation({
    mutationFn: () => codingApi.createSession({ agent, workspace: newWs || undefined }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['coding-sessions'] })
      setSessionId(s.id)
      setState(emptyState())
      setTab('output')
    },
  })
  const removeSession = useMutation({
    mutationFn: (id: string) => codingApi.removeSession(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['coding-sessions'] })
      setSessionId(null)
    },
  })
  const install = useMutation({ mutationFn: (a: AgentId) => codingApi.install(a), onSuccess: (r) => setInstallJob(r.job_id) })

  const submit = () => {
    const text = input.trim()
    if (!sessionId || (!text && images.length === 0) || state.running) return
    setState((s) => addUserMessage(s, text + (images.length ? `\n${images.map((i) => `[圖片] ${i}`).join('\n')}` : '')))
    send({ type: 'run', session_id: sessionId, input: text, images })
    setInput('')
    setImages([])
    setTab('output')
  }
  const attach = async (files: FileList | null) => {
    if (!files || !sessionId) return
    for (const f of Array.from(files)) {
      const r = await codingApi.uploadImage(sessionId, f.name, await fileToBase64(f))
      setImages((xs) => [...xs, r.path])
    }
  }

  const session: CodingSession | undefined = sessionsQ.data?.find((s) => s.id === sessionId)
  const agentInfo = agentsQ.data?.find((a) => a.id === agent)
  const canInstall = member?.role === 'owner'
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' })
  }, [state.items.length])

  return (
    <div className="grid min-h-0 grid-cols-1 md:h-full md:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col overflow-auto border-r border-zinc-200 p-3 dark:border-zinc-800">
        <PageHeader title={t('coding.title')} subtitle={t('coding.subtitle')} />
        {agentsQ.isLoading && <Loading />}
        {agentsQ.error && <ErrorBox error={agentsQ.error} onRetry={() => agentsQ.refetch()} />}
        <div className="space-y-2">
          {agentsQ.data?.map((a) => (
            <AgentCard key={a.id} a={a} selected={a.id === agent} onSelect={() => { setAgent(a.id); setSessionId(null); setState(emptyState()) }}
              onSettings={() => setSettingsFor(a.id)} onInstall={() => install.mutate(a.id)} canInstall={canInstall} />
          ))}
        </div>
        {jobQ.data && (
          <div className="mt-2 rounded bg-zinc-100 p-2 text-[11px] dark:bg-zinc-800" data-testid="install-job">
            <div className="font-medium">{t('coding.installStatus')}: {jobQ.data.status}</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap">{jobQ.data.log.slice(-2000) || jobQ.data.command}</pre>
          </div>
        )}
        <div className="panel-title mt-4">{t('coding.sessions')}</div>
        <div className="mb-2 flex gap-1">
          <input className="input" aria-label={t('coding.workspace')} placeholder={agentInfo?.settings.workspace || t('coding.workspaceHint')} value={newWs} onChange={(e) => setNewWs(e.target.value)} />
          <button className="btn-primary whitespace-nowrap" onClick={() => createSession.mutate()} disabled={createSession.isPending}>{t('coding.newSession')}</button>
        </div>
        {createSession.error && <ErrorBox error={createSession.error} />}
        {sessionsQ.data?.length === 0 && <Empty text={t('coding.noSessions')} />}
        <ul className="space-y-1">
          {sessionsQ.data?.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => { setSessionId(s.id); setState(emptyState()) }}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${s.id === sessionId ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}>
                <div className="flex items-center gap-1">
                  {s.status === 'running' && <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />}
                  <span className="truncate">{s.title}</span>
                </div>
                <div className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">{s.workspace}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-0 flex-col">
        {settingsFor && agentsQ.data && (
          <div className="p-3 pb-0">
            <SettingsPanel agent={settingsFor} initial={agentsQ.data.find((a) => a.id === settingsFor)!.settings} onClose={() => setSettingsFor(null)} />
          </div>
        )}
        {!session ? (
          <Empty text={t('coding.noSession')} />
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
              <span className="font-medium">{session.title}</span>
              <code className="text-zinc-600 dark:text-zinc-400">{session.workspace}</code>
              {(state.externalSessionId || session.external_session_id) && <code className="text-zinc-600 dark:text-zinc-400" title={t('coding.externalId')}>{(state.externalSessionId || session.external_session_id).slice(0, 8)}</code>}
              <span className="ml-auto text-zinc-600 dark:text-zinc-400">{wsStatus === 'open' ? t('coding.wsConnected') : t('coding.wsDisconnected')}</span>
              <button className="btn-ghost text-xs" onClick={() => { if (confirm(t('coding.confirmDelete'))) removeSession.mutate(session.id) }}>{t('common.delete')}</button>
            </div>
            <div className="flex gap-1 border-b border-zinc-200 px-3 pt-1 text-sm dark:border-zinc-800">
              {(['output', 'diff'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={`rounded-t px-3 py-1 ${tab === k ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}>
                  {t(`coding.tab.${k}`)}{k === 'diff' && state.diff?.files.length ? ` (${state.diff.files.length})` : ''}
                </button>
              ))}
              {state.command && <code className="ml-auto self-center truncate text-[10px] text-zinc-600 dark:text-zinc-400" title={state.command}>{state.command}</code>}
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-zinc-50 dark:bg-zinc-950">
              {tab === 'output' ? (
                <div className="space-y-2 p-3" data-testid="output-view">
                  {msgsQ.isLoading && <Loading />}
                  {state.items.length === 0 && !msgsQ.isLoading && <Empty text={t('coding.emptyOutput')} />}
                  {state.items.map((it) => <ItemView key={it.id} it={it} />)}
                  {state.usage && !state.running && (
                    <div className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('coding.usage')}: {Object.entries(state.usage).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${v}`).join(' · ')}</div>
                  )}
                  <div ref={bottomRef} />
                </div>
              ) : (
                <DiffView diff={state.diff} />
              )}
            </div>
            <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
              {images.length > 0 && (
                <div className="mb-1 flex flex-wrap gap-1 text-[11px]">
                  {images.map((p) => (
                    <span key={p} className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                      🖼 {p.split('/').pop()} <button type="button" onClick={() => setImages((xs) => xs.filter((x) => x !== p))}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <textarea className="input min-h-[60px]" aria-label={t('coding.prompt')} placeholder={t('coding.promptHint')} value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} />
                <div className="flex flex-col gap-1">
                  {state.running ? (
                    <button className="btn-danger" onClick={() => state.runId && send({ type: 'stop', run_id: state.runId })}>{t('coding.stop')}</button>
                  ) : (
                    <button className="btn-primary" onClick={submit} disabled={!input.trim() && images.length === 0}>{t('coding.run')}</button>
                  )}
                  {agentInfo?.supports.images && (
                    <label className="btn-outline cursor-pointer text-xs">
                      {t('coding.attachImage')}
                      <input type="file" accept="image/*" multiple className="hidden" aria-label={t('coding.attachImage')} onChange={(e) => attach(e.target.files)} />
                    </label>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
