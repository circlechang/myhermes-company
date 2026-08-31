// 快照檢視：唯讀畫布 + 節點對話 + 證據回放（時間軸滑桿）
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { ErrorBox, Loading } from '../../components/QueryState'
import { CollapsiblePanel } from '../../components/layout/index'
import { wfApi } from './api'
import { Canvas } from './Canvas'
import { ConversationModal } from './Conversation'
import { DoneRounds, NodeHints, NodeOutputPreview, SpillViewer } from './NodeExtras'
import { describeEvent, replayTo } from './runState'
import { StatusBadge } from './RunPanel'

const fmt = (s?: string | null) => (s ? new Date(s).toLocaleTimeString() : '—')

export function RunPage() {
  const { runId = '' } = useParams()
  const { t } = useTranslation()
  const q = useQuery({ queryKey: ['workflow-runs', runId], queryFn: () => wfApi.runDetail(runId), refetchInterval: (r) => (r.state.data && ['running', 'waiting_approval', 'pending'].includes(r.state.data.status) ? 2000 : false) })
  const [step, setStep] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [convo, setConvo] = useState<string | null>(null)
  const d = q.data
  const nodeIds = useMemo(() => d?.snapshot.nodes.map((n) => n.id) ?? [], [d])
  const total = d?.events.length ?? 0
  const cur = step ?? total
  const replay = useMemo(() => (d ? replayTo(d.events, nodeIds, cur) : { nodes: {}, edges: {} }), [d, nodeIds, cur])
  const nodeStatus = useMemo(() => Object.fromEntries(Object.entries(replay.nodes).map(([k, v]) => [k, { status: v }])), [replay])
  const onSelect = useCallback((s: { node?: { id: string } }) => setSelected(s.node?.id ?? null), [])
  const onDbl = useCallback((nid: string) => { const sid = d?.node_states[nid]?.session_id; if (sid) setConvo(sid) }, [d])
  const snapNodes = useMemo(() => d?.snapshot.nodes.map((n) => (n.agent_id && !n.profile && d.node_states[n.id]?.profile ? { ...n, profile: d.node_states[n.id].profile } : n)) ?? [], [d])
  if (q.isLoading) return <Loading />
  if (q.error || !d) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />
  const st = selected ? d.node_states[selected] : undefined
  const selNode = selected ? d.snapshot.nodes.find((n) => n.id === selected) : undefined
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800">
        <Link to={`/workflows/${d.workflow_id}`} className="btn-ghost !px-2">← {d.workflow_name}</Link>
        <StatusBadge s={d.status} />
        <code className="whitespace-nowrap font-mono text-xs text-zinc-600 dark:text-zinc-400">{d.id}</code>
        <span className="text-xs text-zinc-600 dark:text-zinc-400">{d.trigger} · v{d.snapshot.version ?? '?'} · {new Date(d.created_at).toLocaleString()}</span>
        {d.parent_run_id && <Link className="whitespace-nowrap text-xs text-indigo-700 dark:text-indigo-400" to={`/workflows/runs/${d.parent_run_id}`}>parent {d.parent_run_id}</Link>}
        <span className="ml-auto whitespace-nowrap text-xs text-zinc-600 dark:text-zinc-400">{t('wf.panel.usage')}: {d.usage.total_tokens ?? 0} tok · ${Number(d.usage.cost_usd ?? 0).toFixed(4)}</span>
      </div>
      {d.error && <div className="bg-rose-50 px-3 py-1 text-xs text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{d.error}</div>}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Canvas key={d.id} readOnly initial={{ nodes: snapNodes, edges: d.snapshot.edges, viewport: d.snapshot.viewport }} nodeStatus={nodeStatus} edgeDecisions={replay.edges} onSelect={onSelect} onNodeDoubleClick={onDbl} />
          </div>
          <div className="flex items-center gap-2 border-t border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800" data-testid="replay-bar">
            <span className="font-semibold">{t('wf.panel.replay')}</span>
            <input type="range" min={0} max={total} value={cur} onChange={(e) => setStep(Number(e.target.value))} className="flex-1" aria-label={t('wf.panel.step')} />
            <span className="w-16 text-right">{cur} / {total}</span>
            <button className="btn-ghost !px-1 !py-0" onClick={() => setStep(Math.max(0, cur - 1))}>◀</button>
            <button className="btn-ghost !px-1 !py-0" onClick={() => setStep(Math.min(total, cur + 1))}>▶</button>
            <button className="btn-ghost !px-1 !py-0" onClick={() => setStep(null)}>⏭</button>
          </div>
        </div>
        <CollapsiblePanel id="wf.runPanel" side="right" title={t('panels.runPanel')} icon="SlidersHorizontal" defaultWidth={380} min={260} max={560}
                          bodyClassName="flex min-h-0 flex-col overflow-hidden text-sm">
          <div className="shrink-0 border-b border-zinc-200 p-3 dark:border-zinc-800">
            {!selNode && <div className="text-xs text-zinc-600 dark:text-zinc-400">點節點看輸出，雙擊開對話。</div>}
            {selNode && (
              <div className="space-y-1">
                <div className="flex items-center gap-2"><span className="font-semibold">{selNode.title}</span><StatusBadge s={st?.status} />{st?.attempt ? <span className="text-[10px] text-zinc-600 dark:text-zinc-400">×{st.attempt}</span> : null}</div>
                <div className="text-[11px] text-zinc-600 dark:text-zinc-400">{fmt(st?.started_at)} → {fmt(st?.finished_at)}{st?.usage?.total_tokens ? ` · ${st.usage.total_tokens} tok` : ''}{st?.profile ? ` · ${String(st.profile)}` : ''}</div>
                {st?.error && <div className="text-xs text-rose-600 dark:text-rose-400">{st.error}</div>}
                {st && <NodeHints state={st} />}
                {st && <SpillViewer runId={d.id} nodeId={selNode.id} state={st} />}
                {st && <DoneRounds state={st} />}
                {st?.output && <NodeOutputPreview text={st.output} title={selNode.title || selNode.id} className="max-h-72" />}
                {st?.session_id && <button className="btn-outline !py-0.5 text-xs" onClick={() => setConvo(st.session_id!)}>{t('wf.panel.conversation')}</button>}
              </div>
            )}
          </div>
          <div className="panel-title">{t('wf.panel.events')}</div>
          <ol className="min-h-0 flex-1 overflow-auto px-3 pb-3 text-xs" data-testid="event-list">
            {d.events.map((ev, i) => (
              <li key={ev.seq} className={`flex gap-2 border-l-2 py-0.5 pl-2 ${i < cur ? 'border-indigo-400' : 'border-zinc-200 text-zinc-600 dark:text-zinc-400 dark:border-zinc-800'}`} onClick={() => setStep(i + 1)}>
                <span className="w-20 shrink-0 whitespace-nowrap text-zinc-600 dark:text-zinc-400">{fmt(ev.ts)}</span>
                <span className="min-w-0">{describeEvent(ev)}</span>
              </li>
            ))}
          </ol>
        </CollapsiblePanel>
      </div>
      {convo && <ConversationModal sessionId={convo} onClose={() => setConvo(null)} />}
    </div>
  )
}
