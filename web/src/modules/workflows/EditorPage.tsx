// 流程頁：兩個分頁。「最近一次」（跑過就預設落這裡）是唯讀時間軸；「怎麼跑」是一步一張卡＋底部「什麼時候跑／最多花多少」。
// 一個主動作（跑一次），儲存自動做。畫布、逐步回放、歷史都收在 ⋯ 且只有工程師模式看得到。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAgents } from '../../api/hooks'
import { EmptyState } from '../../components/EmptyState'
import { CollapsiblePanel } from '../../components/layout/index'
import { ErrorBox, Loading } from '../../components/QueryState'
import { isEngineerMode, useEngineerMode } from '../../prefs/engineerMode'
import { exampleWorkflow } from './template'
import { wfApi } from './api'
import { Canvas, type CanvasHandle } from './Canvas'
import { ConversationModal } from './Conversation'
import { FlowSettingsBar } from './FlowSettingsBar'
import { NODE_KINDS, validate } from './graph'
import { LastRunView } from './LastRunView'
import { NodePanel } from './NodePanel'
import { applyWsEvent, emptyRun, fromDetail, isTerminal, type LiveRun } from './runState'
import { RunPanel, StatusBadge } from './RunPanel'
import { useWorkflowSocket } from './socket'
import { OutputRail, StationsView, orderStations, relayout, type Graph } from './stations'
import { ReviewPane } from './ReviewPane'
import { shortTime } from './time'
import type { Budget, NodeKind, WfEdge, WfNode, WfWsEvent, Workflow } from './types'

const VIEW_KEY = 'mhc.wf.view'
type View = 'stations' | 'canvas'
type Tab = 'last' | 'how'

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
  const engineer = useEngineerMode()
  const wfQ = useQuery({ queryKey: ['workflows', id], queryFn: () => wfApi.get(id), enabled: !!id })
  const agents = useAgents()
  const env = useQuery({ queryKey: ['workflow-env'], queryFn: wfApi.env, staleTime: 60_000 })
  const runsQ = useQuery({ queryKey: ['workflows', id, 'runs'], queryFn: () => wfApi.runs(id), enabled: !!id })
  const canvas = useRef<CanvasHandle>(null)
  const [sel, setSel] = useState<{ node?: WfNode; edge?: WfEdge }>({})
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [meta, setMeta] = useState<{ name: string; profile: string; budget: Budget } | null>(null)
  const [live, setLive] = useState<LiveRun | undefined>()
  const [loadingRun, setLoadingRun] = useState(false)
  // 試跑這一步：每步一個獨立的 LiveRun（node_id → run）。正式跑的 `live` 不動，
  // WS 事件依 run_id 分流：對得上 live 的疊到 live，對得上某步試跑的疊到那一步。
  const [tries, setTries] = useState<Record<string, LiveRun>>({})
  const [convo, setConvo] = useState<string | null>(null)
  const [panelTab, setPanelTab] = useState<'node' | 'run'>('node')
  const [nodeCount, setNodeCount] = useState<number | null>(null)
  // 最近一次／怎麼跑：跑過至少一次才預設落在「最近一次」，所以要等 runs 回來才決定
  const [tab, setTab] = useState<Tab | null>(null)
  // 流程／畫布：同一時間只掛一個，切過去時把圖交接給對方
  const [view, setView] = useState<View>(() => (readView() === 'canvas' && isEngineerMode() ? 'canvas' : 'stations'))
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
  useEffect(() => {
    if (tab !== null) return
    if (runsQ.data) setTab(runsQ.data.length ? 'last' : 'how')
    else if (runsQ.error) setTab('how')
  }, [runsQ.data, runsQ.error, tab])
  // 接上最近一筆：還在跑的要續看，跑完的也要載回來（重新整理後產出仍留在卡上）
  useEffect(() => {
    const latest = runsQ.data?.[0]
    if (!latest || live) return
    setLoadingRun(true)
    wfApi.runDetail(latest.id).then((d) => setLive(fromDetail(d))).catch(() => {}).finally(() => setLoadingRun(false))
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
    setTries((cur) => {
      const hit = Object.entries(cur).find(([, r]) => r.runId === ev.run_id)
      return hit ? { ...cur, [hit[0]]: applyWsEvent(hit[1], ev) } : cur
    })
    if (ev.type === 'run.status' && isTerminal(ev.status)) qc.invalidateQueries({ queryKey: ['workflows', id, 'runs'] })
  }, [id, qc])
  useWorkflowSocket(onWs, !!id)

  /** 目前這張圖的真相：畫布時在 Canvas 裡，流程視圖時在 state 裡。 */
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
      setTries({}) // 正式跑起來，卡片回到看正式跑的產出
      setLive(emptyRun(r.run_id, g.nodes.map((n) => n.id)))
      if (view === 'canvas') setPanelTab('run')
      else setTab('last') // 跑起來就切到「最近一次」看進度
      return r
    },
  })
  const stop = useMutation({ mutationFn: () => wfApi.stop(live!.runId) })
  const rerun = useMutation({
    mutationFn: async ({ from, force }: { from?: string; force?: boolean }) => {
      const r = await wfApi.rerun(live!.runId, from, force)
      const d = await wfApi.runDetail(r.run_id)
      setTries({})
      setLive(fromDetail(d))
      if (view === 'canvas') setPanelTab('run')
    },
  })
  const tryNode = useMutation({
    mutationFn: async (nodeId: string) => {
      if (dirty) await save.mutateAsync() // 試的是最新指令，不是上次存的
      const r = await wfApi.tryNode(id, nodeId)
      const seed = emptyRun(r.run_id, [nodeId])
      seed.status = 'running'
      seed.nodes[nodeId] = { status: 'running' }
      setTries((cur) => ({ ...cur, [nodeId]: seed }))
      return r
    },
  })
  const decide = useMutation({
    mutationFn: ({ ap, ok, comment }: { ap: string; ok: boolean; comment: string }) => (ok ? wfApi.approve(ap, comment) : wfApi.reject(ap, comment)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-approvals'] }),
  })
  const loadRun = useMutation({
    mutationFn: async (runId: string) => {
      const d = await wfApi.runDetail(runId)
      setTries({})
      setLive(fromDetail(d))
    },
  })

  const onSelect = useCallback((s: { node?: WfNode; edge?: WfEdge }) => {
    setSel(s)
    if (s.node || s.edge) setPanelTab('node')
  }, [])
  // 顯示用：節點沒存 profile 時，從 AI 員工清單補上（畫布副標題用）
  const initialGraph = useMemo(() => {
    const g = graph
    if (!g) return undefined
    const byId = new Map((agents.data ?? []).map((a) => [a.id, a]))
    // viewport 故意不帶：Canvas 看到沒有 viewport 就會 fitView，從流程視圖切過來才不會有一半在畫面外
    return { nodes: g.nodes.map((n) => (n.agent_id && !n.profile && byId.get(n.agent_id) ? { ...n, profile: byId.get(n.agent_id)!.profile } : n)), edges: g.edges, viewport: undefined }
  }, [graph, agents.data])

  const nodeStatus = useMemo(() => (live ? Object.fromEntries(Object.entries(live.nodes).map(([k, v]) => [k, { status: v.status, streaming: v.streaming }])) : undefined), [live])
  const titles = useMemo(() => Object.fromEntries(NODE_KINDS.map((k) => [k, t(`wf.kinds.${k}`)])), [t])
  const stations = useMemo(() => (graph ? orderStations(graph) : []), [graph])
  const profiles = useMemo(() => [...new Set((agents.data ?? []).map((a) => a.profile))], [agents.data])
  // 等你看的那一步（依步序取第一個）：頂端浮一條「第 N 步等你看 ↓」
  const waiting = useMemo(() => (live ? stations.find((s) => live.pendingApprovals[s.node.id]) : undefined), [live, stations])
  const scrollToWaiting = useCallback(() => {
    if (!waiting) return
    document.querySelector(`[data-testid="station-${waiting.node.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [waiting])

  const goAdvanced = useCallback(() => {
    setMenu(false)
    if (view === 'canvas') return
    setCanvasKey((k) => k + 1)
    setView('canvas')
    setTab('how')
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
  // 工程師模式關掉，畫布就收起來（localStorage 記的是 canvas 也一樣）
  useEffect(() => {
    if (!engineer && view === 'canvas') goStations()
  }, [engineer, view, goStations])

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

  if (wfQ.isLoading || !meta || !graph || tab === null) return <Loading />
  if (wfQ.error) return <ErrorBox error={wfQ.error} onRetry={() => wfQ.refetch()} />
  const wf = wfQ.data!
  const busy = save.isPending || run.isPending || stop.isPending || rerun.isPending || decide.isPending
  // 有一步在等你看 → 右欄變成閱讀欄（全文、可拉寬），兩個分頁都掛，決定完自動換回產出欄
  const waitingApproval = waiting && live ? live.pendingApprovals[waiting.node.id] : undefined
  const reviewRail = waiting && waitingApproval ? (() => {
    const idx = stations.findIndex((s) => s.node.id === waiting.node.id)
    const prev = idx > 0 ? stations[idx - 1] : undefined
    return (
      <CollapsiblePanel id="wf.reviewRail" side="right" title={t('wf.station.reviewTitle')} icon="Eye" defaultWidth={520} min={320} max={960}
                        bodyClassName="flex min-h-0 flex-col overflow-hidden">
        <ReviewPane
          seq={waiting.seq}
          title={waiting.node.title && waiting.node.title !== t('wf.station.kinds.gate') ? waiting.node.title : ''}
          fromTitle={prev ? (prev.node.title || prev.node.id) : undefined}
          approvalId={waitingApproval.approval_id}
          payload={waitingApproval.payload}
          busy={busy}
          onApprove={(ap, c) => decide.mutate({ ap, ok: true, comment: c })}
          onReject={(ap, c) => decide.mutate({ ap, ok: false, comment: c })}
        />
      </CollapsiblePanel>
    )
  })() : null
  const running = !!live && !isTerminal(live.status)
  const saveLabel = save.isPending || dirty
    ? t('wf.station.saving')
    : errors.length
      ? t('wf.station.savePending')
      : save.error
        ? t('wf.station.saveFailed')
        : t('wf.station.saved')
  const menuItem = 'block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800'
  const tabBtn = (k: Tab) => `px-3 py-1.5 text-sm ${tab === k ? 'border-b-2 border-indigo-500 font-semibold' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'}`

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 頂欄只留：回清單／名稱／已儲存／⋯／跑一次 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800" data-testid="wf-topbar">
        <Link to="/workflows" className="btn-ghost !px-2" aria-label={t('wf.backToList')}>←</Link>
        <input className="input !w-full sm:!w-56 md:!w-80" title={meta.name} value={meta.name} onChange={(e) => { setMeta({ ...meta, name: e.target.value }); setDirty(true) }} aria-label={t('wf.name')} />
        <span className={`whitespace-nowrap text-xs ${errors.length || save.error ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-600 dark:text-zinc-400'}`} data-testid="save-state">{saveLabel}</span>
        <span className="ml-auto flex items-center gap-1">
          <div className="relative" ref={menuRef}>
            <button className="btn-outline !px-2 !py-1" aria-haspopup="menu" aria-expanded={menu} aria-label={t('wf.station.more')} data-testid="wf-more" onClick={() => setMenu((v) => !v)}>⋯</button>
            {menu && (
              <div role="menu" data-testid="wf-more-menu" className="absolute right-0 z-30 mt-1 w-56 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                <div className="px-3 py-1 text-xs text-zinc-600 dark:text-zinc-400">v{wf.version ?? 1} · {shortTime(wf.updated_at)}</div>
                <button role="menuitem" className={menuItem} data-testid="menu-export" onClick={exportJson}>{t('wf.export')}</button>
                {engineer && (
                  <>
                    <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                    <button role="menuitem" className={menuItem} data-testid="menu-advanced" onClick={() => (view === 'canvas' ? goStations() : goAdvanced())}>
                      {view === 'canvas' ? t('wf.station.backToStations') : t('wf.station.advanced')}
                    </button>
                    <button role="menuitem" className={menuItem} onClick={autoLayoutNow}>{t('wf.autoLayout')}</button>
                    {view === 'canvas' && <button role="menuitem" className={menuItem} onClick={() => { setMenu(false); canvas.current?.fitView() }}>{t('wf.fit')}</button>}
                    {live && <Link role="menuitem" className={menuItem} data-testid="menu-replay" to={`/workflows/runs/${live.runId}`} onClick={() => setMenu(false)}>{t('wf.panel.replay')}</Link>}
                    <button role="menuitem" className={menuItem} data-testid="menu-history" onClick={() => { goAdvanced(); setPanelTab('run') }}>{t('wf.history')}</button>
                  </>
                )}
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
      <div className="flex items-center border-b border-zinc-200 px-2 dark:border-zinc-800" role="tablist" data-testid="wf-tabs">
        <button role="tab" aria-selected={tab === 'last'} className={tabBtn('last')} data-testid="tab-last" onClick={() => setTab('last')}>{t('wf.tabs.last')}</button>
        <button role="tab" aria-selected={tab === 'how'} className={tabBtn('how')} data-testid="tab-how" onClick={() => setTab('how')}>{t('wf.tabs.how')}</button>
      </div>
      {errors.length > 0 && (
        <div className="border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200" data-testid="validation-errors">
          <div className="font-medium">{t('wf.validationTitle')}</div>
          <ul className="list-disc pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {(save.error && !errors.length) || run.error || rerun.error || decide.error || tryNode.error || loadRun.error ? <div className="bg-rose-50 px-3 py-1 text-xs text-rose-800 dark:bg-rose-950/40">{String((save.error ?? run.error ?? rerun.error ?? decide.error ?? tryNode.error ?? loadRun.error as Error)?.message)}</div> : null}

      {tab === 'last' ? (
        <div className="flex min-h-0 flex-1" role="tabpanel">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <LastRunView
            stations={stations}
            agents={agents.data ?? []}
            live={live}
            runs={runsQ.data}
            busy={busy || loadRun.isPending}
            loading={loadingRun || (runsQ.isPending && !live)}
            onLoadRun={(rid) => loadRun.mutate(rid)}
            onApprove={(ap, c) => decide.mutate({ ap, ok: true, comment: c })}
            onReject={(ap, c) => decide.mutate({ ap, ok: false, comment: c })}
            onRun={() => run.mutate()}
            onGoHow={() => setTab('how')}
          />
        </div>
        {reviewRail}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
          <div className="flex min-h-0 flex-1">
            {view === 'stations' ? (
              <div className="relative min-h-0 min-w-0 flex-1 overflow-auto">
                {waiting && (
                  <button
                    type="button"
                    className="sticky top-0 z-20 flex w-full items-center justify-center gap-1 border-b border-amber-300 bg-amber-50/95 px-3 py-1.5 text-xs font-medium text-amber-900 backdrop-blur hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/80 dark:text-amber-100"
                    data-testid="editor-waiting-banner"
                    onClick={scrollToWaiting}
                  >
                    {t('wf.station.waitingBanner', { n: waiting.seq })}
                  </button>
                )}
                <StationsView
                  graph={graph}
                  agents={agents.data ?? []}
                  env={env.data}
                  live={live}
                  tries={tries}
                  running={running}
                  busy={busy}
                  onChange={setGraph}
                  onRerun={(from) => rerun.mutate({ from })}
                  onTry={(nid) => tryNode.mutate(nid)}
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
              reviewRail ?? (
              <CollapsiblePanel id="wf.outputRail" side="right" title={t('wf.station.railTitle')} icon="FileText" defaultWidth={340} min={260} max={560}
                                bodyClassName="flex min-h-0 flex-col overflow-hidden">
                <OutputRail stations={stations} live={live} />
              </CollapsiblePanel>
              )
            ) : (
              <CollapsiblePanel id="wf.editorPanel" side="right" title={t('panels.nodePanel')} icon="SlidersHorizontal" defaultWidth={360} min={260} max={560}
                                bodyClassName="flex min-h-0 flex-col overflow-hidden">
                <div className="flex shrink-0 border-b border-zinc-200 text-xs dark:border-zinc-800">
                  {(['node', 'run'] as const).map((k) => (
                    <button key={k} className={`flex-1 whitespace-nowrap px-2 py-2 ${panelTab === k ? 'border-b-2 border-indigo-500 font-semibold' : 'text-zinc-600 dark:text-zinc-400'}`} onClick={() => setPanelTab(k)}>
                      {k === 'node' ? t('wf.nodes') : t('wf.panel.run')}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {panelTab === 'node' && (
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
                  {panelTab === 'run' && (
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
                              <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{shortTime(r.created_at)}</span>
                              <span className="ml-auto flex shrink-0 gap-1">
                                <button className="btn-ghost !px-1 !py-0" onClick={() => loadRun.mutate(r.id)}>載入</button>
                                <Link className="btn-ghost !px-1 !py-0" to={`/workflows/runs/${r.id}`}>{t('wf.panel.replay')}</Link>
                              </span>
                            </li>
                          ))}
                          {runsQ.data?.length === 0 && <li className="text-zinc-600 dark:text-zinc-400">{t('wf.panel.noRun')}</li>}
                        </ul>
                      </div>
                    </div>
                  )}
                </div>
              </CollapsiblePanel>
            )}
          </div>
          <FlowSettingsBar
            workflowId={id}
            budget={meta.budget}
            onBudget={(b) => { setMeta({ ...meta, budget: b }); setDirty(true) }}
            profile={meta.profile}
            profiles={profiles}
            onProfile={(p) => { setMeta({ ...meta, profile: p }); setDirty(true) }}
            env={env.data}
          />
        </div>
      )}
      {convo && <ConversationModal sessionId={convo} onClose={() => setConvo(null)} />}
    </div>
  )
}

