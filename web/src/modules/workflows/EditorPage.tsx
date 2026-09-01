// 工作流編輯：預設是「生產線」視圖（stations/），畫布降為第三層「進階檢視」。
// 一個主動作（執行），儲存自動做；編輯與執行同一個畫面。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAgents } from '../../api/hooks'
import { EmptyState } from '../../components/EmptyState'
import { CollapsiblePanel } from '../../components/layout/index'
import { ErrorBox, Loading } from '../../components/QueryState'
import { exampleWorkflow } from './template'
import { wfApi } from './api'
import { Canvas, type CanvasHandle } from './Canvas'
import { ConversationModal } from './Conversation'
import { NODE_KINDS, validate } from './graph'
import { NodePanel } from './NodePanel'
import { applyWsEvent, emptyRun, fromDetail, isTerminal, type LiveRun } from './runState'
import { RunPanel, StatusBadge } from './RunPanel'
import { useWorkflowSocket } from './socket'
import { OutputRail, StationsView, orderStations, relayout, type Graph } from './stations'
import type { Budget, NodeKind, WfEdge, WfNode, WfWsEvent, Workflow } from './types'

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleString() : '—')
const VIEW_KEY = 'mhc.wf.view'
type View = 'stations' | 'canvas'

const readView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'canvas' ? 'canvas' : 'stations'
  } catch {
    return 'stations'
  }
}

export function EditorPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation()
  const nav = useNavigate()
  const qc = useQueryClient()
  const wfQ = useQuery({ queryKey: ['workflows', id], queryFn: () => wfApi.get(id), enabled: !!id })
  const agents = useAgents()
  const env = useQuery({ queryKey: ['workflow-env'], queryFn: wfApi.env, staleTime: 60_000 })
  const runsQ = useQuery({ queryKey: ['workflows', id, 'runs'], queryFn: () => wfApi.runs(id), enabled: !!id })
  const schedQ = useQuery({ queryKey: ['workflows', id, 'schedules'], queryFn: () => wfApi.schedules(id), enabled: !!id })
  const hooksQ = useQuery({ queryKey: ['workflows', id, 'webhooks'], queryFn: () => wfApi.webhooks(id), enabled: !!id })
  const canvas = useRef<CanvasHandle>(null)
  const [sel, setSel] = useState<{ node?: WfNode; edge?: WfEdge }>({})
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [meta, setMeta] = useState<{ name: string; profile: string; budget: Budget } | null>(null)
  const [live, setLive] = useState<LiveRun | undefined>()
  const [convo, setConvo] = useState<string | null>(null)
  const [tab, setTab] = useState<'node' | 'run' | 'trigger'>('node')
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [nodeCount, setNodeCount] = useState<number | null>(null)
  // 生產線／進階檢視：同一時間只掛一個，切過去時把圖交接給對方
  const [view, setView] = useState<View>(readView)
  const [graph, setGraphState] = useState<Graph | null>(null)
  const [canvasKey, setCanvasKey] = useState(0)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<Workflow['viewport']>(undefined)

  useEffect(() => {
    if (wfQ.data && !meta) {
      setMeta({ name: wfQ.data.name, profile: wfQ.data.profile ?? '', budget: wfQ.data.budget ?? {} })
      setNodeCount(wfQ.data.nodes.length)
      setGraphState({ nodes: wfQ.data.nodes, edges: wfQ.data.edges })
      viewportRef.current = wfQ.data.viewport
    }
  }, [wfQ.data, meta])
  // 接上最近一筆執行：還在跑的要續看，跑完的也要載回來（重新整理後產出仍留在站卡上）
  useEffect(() => {
    const latest = runsQ.data?.[0]
    if (latest && !live) wfApi.runDetail(latest.id).then((d) => setLive(fromDetail(d))).catch(() => {})
  }, [runsQ.data, live])
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view) } catch { /* ignore */ }
  }, [view])
  useEffect(() => {
    if (!menu) return
    const off = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [menu])

  const onWs = useCallback((ev: WfWsEvent) => {
    setLive((cur) => (cur && ev.run_id === cur.runId ? applyWsEvent(cur, ev) : cur))
    if (ev.type === 'run.status' && isTerminal(ev.status)) qc.invalidateQueries({ queryKey: ['workflows', id, 'runs'] })
  }, [id, qc])
  useWorkflowSocket(onWs, !!id)

  /** 目前這張圖的真相：進階檢視時在 Canvas 裡，生產線時在 state 裡。 */
  const readGraph = useCallback((): { nodes: WfNode[]; edges: WfEdge[]; viewport?: Workflow['viewport'] } => {
    if (view === 'canvas' && canvas.current) {
      const g = canvas.current.getGraph()
      viewportRef.current = g.viewport
      return g
    }
    return { nodes: graph?.nodes ?? [], edges: graph?.edges ?? [], viewport: viewportRef.current }
  }, [view, graph])

  const setGraph = useCallback((g: Graph) => {
    setGraphState(g)
    setNodeCount(g.nodes.length)
    setDirty(true)
  }, [])

  const save = useMutation({
    mutationFn: async () => {
      const g = readGraph()
      const errs = validate(g.nodes, g.edges)
      setErrors(errs)
      if (errs.length) throw new Error(errs.join('; '))
      return wfApi.update(id, { nodes: g.nodes, edges: g.edges, viewport: g.viewport, name: meta?.name, profile: meta?.profile, budget: meta?.budget })
    },
    onSuccess: (w: Workflow) => {
      setDirty(false)
      qc.setQueryData(['workflows', id], w)
      qc.invalidateQueries({ queryKey: ['workflows'] })
    },
  })
  // 自動存（像 Google Docs）：改完停手約 1 秒就存，不放儲存按鈕
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!dirty || !meta) return
    const timer = setTimeout(() => {
      if (!saveRef.current.isPending) saveRef.current.mutate()
    }, 900)
    return () => clearTimeout(timer)
  }, [dirty, meta, graph])

  const run = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync()
      const r = await wfApi.run(id)
      const g = readGraph()
      setLive(emptyRun(r.run_id, g.nodes.map((n) => n.id)))
      if (view === 'canvas') setTab('run')
      return r
    },
  })
  const stop = useMutation({ mutationFn: () => wfApi.stop(live!.runId) })
  const rerun = useMutation({
    mutationFn: async ({ from, force }: { from?: string; force?: boolean }) => {
      const r = await wfApi.rerun(live!.runId, from, force)
      const d = await wfApi.runDetail(r.run_id)
      setLive(fromDetail(d))
      if (view === 'canvas') setTab('run')
    },
  })
  const decide = useMutation({
    mutationFn: ({ ap, ok, comment }: { ap: string; ok: boolean; comment: string }) => (ok ? wfApi.approve(ap, comment) : wfApi.reject(ap, comment)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-approvals'] }),
  })
  const addSchedule = useMutation({ mutationFn: () => wfApi.createSchedule(id, cron), onSuccess: () => schedQ.refetch() })
  const patchSchedule = useMutation({ mutationFn: ({ sid, enabled }: { sid: string; enabled: boolean }) => wfApi.patchSchedule(sid, { enabled }), onSuccess: () => schedQ.refetch() })
  const delSchedule = useMutation({ mutationFn: (sid: string) => wfApi.deleteSchedule(sid), onSuccess: () => schedQ.refetch() })
  const addHook = useMutation({ mutationFn: () => wfApi.createWebhook(id), onSuccess: () => hooksQ.refetch() })
  const delHook = useMutation({ mutationFn: (w: string) => wfApi.deleteWebhook(w), onSuccess: () => hooksQ.refetch() })

  const onSelect = useCallback((s: { node?: WfNode; edge?: WfEdge }) => {
    setSel(s)
    if (s.node || s.edge) setTab('node')
  }, [])
  // 顯示用：節點沒存 profile 時，從 AI 員工清單補上（畫布副標題用）
  const initialGraph = useMemo(() => {
    const g = graph
    if (!g) return undefined
    const byId = new Map((agents.data ?? []).map((a) => [a.id, a]))
    // viewport 故意不帶：Canvas 看到沒有 viewport 就會 fitView，從生產線切過來才不會有一半在畫面外
    return { nodes: g.nodes.map((n) => (n.agent_id && !n.profile && byId.get(n.agent_id) ? { ...n, profile: byId.get(n.agent_id)!.profile } : n)), edges: g.edges, viewport: undefined }
  }, [graph, agents.data])

  const nodeStatus = useMemo(() => (live ? Object.fromEntries(Object.entries(live.nodes).map(([k, v]) => [k, { status: v.status, streaming: v.streaming }])) : undefined), [live])
  const titles = useMemo(() => Object.fromEntries(NODE_KINDS.map((k) => [k, t(`wf.kinds.${k}`)])), [t])
  const stations = useMemo(() => (graph ? orderStations(graph) : []), [graph])

  const goAdvanced = useCallback(() => {
    setMenu(false)
    if (view === 'canvas') return
    setCanvasKey((k) => k + 1)
    setView('canvas')
  }, [view])
  const goStations = useCallback(() => {
    setMenu(false)
    if (view === 'stations') return
    if (canvas.current) {
      const g = canvas.current.getGraph()
      viewportRef.current = g.viewport
      setGraphState({ nodes: g.nodes, edges: g.edges })
    }
    setView('stations')
  }, [view])

  const exportJson = async () => {
    setMenu(false)
    const data = await wfApi.export(id)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${meta?.name ?? 'workflow'}.workflow.json`
    a.click()
  }
  const autoLayoutNow = () => {
    setMenu(false)
    if (view === 'canvas') { canvas.current?.autoLayout(); setDirty(true); return }
    if (graph) setGraph(relayout(graph))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save.mutate() }
      if ((e.metaKey || e.ctrlKey) && e.key === 'd' && view === 'canvas') { e.preventDefault(); canvas.current?.duplicateSelected() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, view])

  if (wfQ.isLoading || !meta || !graph) return <Loading />
  if (wfQ.error) return <ErrorBox error={wfQ.error} onRetry={() => wfQ.refetch()} />
  const wf = wfQ.data!
  const busy = save.isPending || run.isPending || stop.isPending || rerun.isPending || decide.isPending
  const running = !!live && !isTerminal(live.status)
  const saveLabel = save.isPending || dirty
    ? t('wf.station.saving')
    : errors.length
      ? t('wf.station.savePending')
      : save.error
        ? t('wf.station.saveFailed')
        : t('wf.station.saved')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 頂欄只留：回清單／名稱／已儲存／⋯／執行。其餘（加站、排版、縮放、匯出、儲存）都收起來了。 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800" data-testid="wf-topbar">
        <Link to="/workflows" className="btn-ghost !px-2" aria-label={t('wf.backToList')}>←</Link>
        <input className="input !w-full sm:!w-56 md:!w-80" title={meta.name} value={meta.name} onChange={(e) => { setMeta({ ...meta, name: e.target.value }); setDirty(true) }} aria-label={t('wf.name')} />
        <span className={`whitespace-nowrap text-xs ${errors.length || save.error ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-600 dark:text-zinc-400'}`} data-testid="save-state">{saveLabel}</span>
        <span className="ml-auto flex items-center gap-1">
          <div className="relative" ref={menuRef}>
            <button className="btn-outline !px-2 !py-1" aria-haspopup="menu" aria-expanded={menu} aria-label={t('wf.station.more')} data-testid="wf-more" onClick={() => setMenu((v) => !v)}>⋯</button>
            {menu && (
              <div role="menu" data-testid="wf-more-menu" className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                <div className="px-3 py-1 text-xs text-zinc-600 dark:text-zinc-400">v{wf.version ?? 1} · {fmt(wf.updated_at)}</div>
                <button role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" data-testid="menu-advanced" onClick={() => (view === 'canvas' ? goStations() : goAdvanced())}>
                  {view === 'canvas' ? t('wf.station.backToStations') : t('wf.station.advanced')}
                </button>
                <button role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={autoLayoutNow}>{t('wf.autoLayout')}</button>
                {view === 'canvas' && <button role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => { setMenu(false); canvas.current?.fitView() }}>{t('wf.fit')}</button>}
                <button role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={exportJson}>{t('wf.export')}</button>
                <button role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" data-testid="menu-trigger" onClick={() => { goAdvanced(); setTab('trigger') }}>{t('wf.trigger.title')}</button>
                <button role="menuitem" className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => { goAdvanced(); setTab('run') }}>{t('wf.history')}</button>
              </div>
            )}
          </div>
          {running ? (
            <button className="btn-danger !py-1" disabled={busy} onClick={() => stop.mutate()}>■ {t('wf.stop')}</button>
          ) : (
            <button className="btn-primary !py-1" disabled={busy} data-testid="wf-run" onClick={() => run.mutate()}>▶ {t('wf.run')}</button>
          )}
        </span>
      </div>
      {errors.length > 0 && (
        <div className="border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200" data-testid="validation-errors">
          <div className="font-medium">{t('wf.validationTitle')}</div>
          <ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {(save.error && !errors.length) || run.error || rerun.error || decide.error ? <div className="bg-rose-50 px-3 py-1 text-xs text-rose-800 dark:bg-rose-950/40">{String((save.error ?? run.error ?? rerun.error ?? decide.error as Error)?.message)}</div> : null}
      <div className="flex min-h-0 flex-1">
        {view === 'stations' ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            <StationsView
              graph={graph}
              agents={agents.data ?? []}
              env={env.data}
              live={live}
              running={running}
              busy={busy}
              onChange={setGraph}
              onRerun={(from) => rerun.mutate({ from })}
              onApprove={(ap, c) => decide.mutate({ ap, ok: true, comment: c })}
              onReject={(ap, c) => decide.mutate({ ap, ok: false, comment: c })}
              onOpenConversation={setConvo}
              onAdvanced={goAdvanced}
            />
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-1 border-b border-zinc-200 px-2 py-1.5 text-xs dark:border-zinc-800" data-testid="canvas-toolbar">
              <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{t('wf.addNode')}:</span>
              {NODE_KINDS.map((k) => (
                <button key={k} className="btn-outline !px-2 !py-0.5 text-xs" onClick={() => { canvas.current?.addNode(k as NodeKind, titles); setDirty(true); setNodeCount((c) => (c ?? 0) + 1) }}>{t(`wf.station.kinds.${k}`)}</button>
              ))}
              <button className="btn-ghost ml-auto !px-2 !py-0.5 text-xs" data-testid="canvas-back" onClick={goStations}>← {t('wf.station.backToStations')}</button>
            </div>
            <div className="relative min-h-0 flex-1">
            {nodeCount === 0 && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                <div className="card pointer-events-auto shadow-lg">
                  <EmptyState
                    testId="empty-canvas"
                    title={t('guide.empty.canvas.title')}
                    body={t('guide.empty.canvas.body')}
                    action={{ label: t('guide.empty.canvas.action'), onClick: () => { const ex = exampleWorkflow(agents.data ?? []); canvas.current?.setGraph(ex); setDirty(true); setNodeCount(ex.nodes.length) } }}
                    secondary={t('guide.empty.canvas.addHint')}
                  />
                </div>
              </div>
            )}
            <Canvas
              key={canvasKey}
              ref={canvas}
              initial={initialGraph ?? { nodes: wf.nodes, edges: wf.edges, viewport: wf.viewport }}
              nodeStatus={nodeStatus}
              onSelect={onSelect}
              onChange={() => { setDirty(true); setNodeCount(canvas.current?.getGraph().nodes.length ?? null) }}
              onNodeDoubleClick={(nid) => { const sid = live?.nodes[nid]?.session_id; if (sid) setConvo(sid) }}
            />
            </div>
          </div>
        )}
        {view === 'stations' ? (
          <CollapsiblePanel id="wf.outputRail" side="right" title={t('wf.station.railTitle')} icon="FileText" defaultWidth={340} min={260} max={560}
                            bodyClassName="flex min-h-0 flex-col overflow-hidden">
            <OutputRail stations={stations} live={live} />
          </CollapsiblePanel>
        ) : (
        <CollapsiblePanel id="wf.editorPanel" side="right" title={t('panels.nodePanel')} icon="SlidersHorizontal" defaultWidth={360} min={260} max={560}
                          bodyClassName="flex min-h-0 flex-col overflow-hidden">
          <div className="flex shrink-0 border-b border-zinc-200 text-xs dark:border-zinc-800">
            {(['node', 'run', 'trigger'] as const).map((k) => (
              <button key={k} className={`flex-1 whitespace-nowrap px-2 py-2 ${tab === k ? 'border-b-2 border-indigo-500 font-semibold' : 'text-zinc-600 dark:text-zinc-400'}`} onClick={() => setTab(k)}>
                {k === 'node' ? t('wf.nodes', '節點') : k === 'run' ? t('wf.panel.run') : t('wf.trigger.title')}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {tab === 'node' && (
              <NodePanel
                node={sel.node}
                edge={sel.edge}
                agents={agents.data ?? []}
                env={env.data}
                onNode={(nid, patch) => { canvas.current?.updateNode(nid, patch); setSel((s) => (s.node?.id === nid ? { node: { ...s.node, ...patch } } : s)) }}
                onEdge={(eid, patch) => { canvas.current?.updateEdge(eid, patch); setSel((s) => (s.edge ? { edge: { ...s.edge, ...patch } } : s)) }}
                onDuplicate={() => canvas.current?.duplicateSelected()}
                onDelete={() => { canvas.current?.deleteSelected(); setSel({}) }}
              />
            )}
            {tab === 'run' && (
              <div className="flex h-full flex-col">
                <RunPanel
                  nodes={graph.nodes}
                  live={live}
                  busy={busy}
                  canRun
                  onRun={() => run.mutate()}
                  onStop={() => stop.mutate()}
                  onRerun={(from, force) => rerun.mutate({ from, force })}
                  onApprove={(ap, c) => decide.mutate({ ap, ok: true, comment: c })}
                  onReject={(ap, c) => decide.mutate({ ap, ok: false, comment: c })}
                  onOpenConversation={setConvo}
                  onOpenSnapshot={(rid) => nav(`/workflows/runs/${rid}`)}
                />
                <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
                  <div className="panel-title !px-0">{t('wf.history')}</div>
                  <ul className="max-h-48 space-y-1 overflow-auto text-xs">
                    {runsQ.data?.map((r) => (
                      <li key={r.id} className="flex min-w-0 items-center gap-2">
                        <StatusBadge s={r.status} />
                        <span className="min-w-0 truncate text-zinc-600 dark:text-zinc-400" title={r.trigger}>{r.trigger}</span>
                        <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{fmt(r.created_at)}</span>
                        <span className="ml-auto flex shrink-0 gap-1">
                          <button className="btn-ghost !px-1 !py-0" onClick={() => wfApi.runDetail(r.id).then((d) => { setLive(fromDetail(d)) })}>載入</button>
                          <Link className="btn-ghost !px-1 !py-0" to={`/workflows/runs/${r.id}`}>{t('wf.panel.replay')}</Link>
                        </span>
                      </li>
                    ))}
                    {runsQ.data?.length === 0 && <li className="text-zinc-600 dark:text-zinc-400">{t('wf.panel.noRun')}</li>}
                  </ul>
                </div>
              </div>
            )}
            {tab === 'trigger' && (
              <div className="space-y-4 p-3 text-sm">
                <div>
                  <div className="panel-title !px-0">{t('wf.profile')}</div>
                  <select className="input" value={meta.profile} onChange={(e) => { setMeta({ ...meta, profile: e.target.value }); setDirty(true) }}>
                    <option value="">{t('wf.allProfiles')}</option>
                    {[...new Set((agents.data ?? []).map((a) => a.profile))].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div>
                  <div className="panel-title !px-0">{t('wf.budget.title')}</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {(['max_tokens', 'max_cost_usd', 'deadline_seconds'] as const).map((k) => (
                      <label key={k}>
                        <span className="block text-zinc-600 dark:text-zinc-400">{t(`wf.budget.${k === 'max_tokens' ? 'maxTokens' : k === 'max_cost_usd' ? 'maxCost' : 'deadline'}`)}</span>
                        <input className="input" type="number" min={0} step={k === 'max_cost_usd' ? 0.01 : 1} value={meta.budget[k] ?? ''} onChange={(e) => { setMeta({ ...meta, budget: { ...meta.budget, [k]: e.target.value === '' ? undefined : Number(e.target.value) } }); setDirty(true) }} />
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="panel-title !px-0">{t('wf.trigger.schedule')}</div>
                  <div className="flex gap-1">
                    <input className="input font-mono" value={cron} onChange={(e) => setCron(e.target.value)} aria-label="cron" />
                    <button className="btn-outline whitespace-nowrap !py-1 text-xs" disabled={addSchedule.isPending} onClick={() => addSchedule.mutate()}>{t('wf.trigger.addSchedule')}</button>
                  </div>
                  <div className="text-2xs text-zinc-600 dark:text-zinc-400">{t('wf.trigger.cronHint')}</div>
                  {addSchedule.error && <div className="text-xs text-rose-600 dark:text-rose-400">{(addSchedule.error as Error).message}</div>}
                  <ul className="mt-1 space-y-1 text-xs">
                    {schedQ.data?.map((s) => (
                      <li key={s.id} className="flex items-center gap-2">
                        <code>{s.cron}</code>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={s.enabled} onChange={(e) => patchSchedule.mutate({ sid: s.id, enabled: e.target.checked })} />{t('wf.trigger.enabled')}</label>
                        <span className="text-zinc-600 dark:text-zinc-400">{t('wf.trigger.next')} {fmt(s.next_run_at)}</span>
                        <button className="btn-ghost ml-auto !px-1 !py-0" onClick={() => delSchedule.mutate(s.id)}>✕</button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="panel-title !px-0">{t('wf.trigger.webhook')}</div>
                  <button className="btn-outline !py-1 text-xs" onClick={() => addHook.mutate()}>{t('wf.trigger.addWebhook')}</button>
                  <ul className="mt-1 space-y-1 text-xs">
                    {hooksQ.data?.map((w) => (
                      <li key={w.id} className="flex items-center gap-2">
                        <code className="truncate">POST {location.origin}/api{w.path}</code>
                        <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{w.hits} {t('wf.trigger.hits')}</span>
                        <button className="btn-ghost ml-auto !px-1 !py-0" onClick={() => delHook.mutate(w.id)}>✕</button>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-1 text-2xs text-zinc-600 dark:text-zinc-400">body: {'{"text": "..."}'} 或任意 JSON，會當作第一站的 [外部輸入]</div>
                </div>
                {env.data && (
                  <div className="text-xs text-zinc-600 dark:text-zinc-400">
                    coding agents: {Object.entries(env.data.coding_tools).map(([k, v]) => `${k}${v.installed ? ' ✓' : ' ✗'}`).join('、')} · LINE {env.data.line_configured ? '✓' : '✗'}
                  </div>
                )}
              </div>
            )}
          </div>
        </CollapsiblePanel>
        )}
      </div>
      {convo && <ConversationModal sessionId={convo} onClose={() => setConvo(null)} />}
    </div>
  )
}
