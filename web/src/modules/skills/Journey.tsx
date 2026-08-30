// Journey 關係圖：d3-force 版面 + SVG 繪製；分類篩選、點節點看詳情、依 mtime 時間軸回放。
import { useEffect, useMemo, useRef, useState } from 'react'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { fmtTime } from '../../components/admin2/Tabs'
import type { JourneyGraph, JourneyNode } from './api'

type SimNode = SimulationNodeDatum & JourneyNode
type SimLink = SimulationLinkDatum<SimNode> & { kind: string }

const COLORS: Record<string, string> = {
  skill: '#4f46e5',
  memory: '#059669',
  memory_entry: '#a7f3d0',
}

export function JourneyView({ graph, labels }: { graph: JourneyGraph; labels: { all: string; replay: string; play: string; pause: string; nodes: string; edges: string; showEntries: string } }) {
  const [category, setCategory] = useState('')
  const [showEntries, setShowEntries] = useState(false)
  const [reveal, setReveal] = useState(1) // 0..1 timeline
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<JourneyNode | null>(null)
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const svgRef = useRef<SVGSVGElement>(null)
  const size = { w: 900, h: 560 }

  const [t0, t1] = graph.time_range
  const cutoff = t0 + (t1 - t0) * reveal
  const visibleNodes = useMemo(
    () =>
      graph.nodes.filter((n) => (showEntries || n.kind !== 'memory_entry') && (!category || n.category === category) && n.timestamp <= cutoff + 1),
    [graph.nodes, showEntries, category, cutoff],
  )
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes])
  const visibleEdges = useMemo(() => graph.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)), [graph.edges, visibleIds])

  // layout is computed once per (graph, showEntries) for stability; filters only hide nodes
  useEffect(() => {
    const nodes: SimNode[] = graph.nodes.filter((n) => showEntries || n.kind !== 'memory_entry').map((n) => ({ ...n }))
    const ids = new Set(nodes.map((n) => n.id))
    const links: SimLink[] = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target, kind: e.kind }))
    const sim = forceSimulation(nodes)
      .force('link', forceLink<SimNode, SimLink>(links).id((d) => d.id).distance((l) => (l.kind === 'contains' ? 30 : 70)))
      .force('charge', forceManyBody().strength(-120))
      .force('center', forceCenter(size.w / 2, size.h / 2))
      .force('collide', forceCollide(14))
      .stop()
    for (let i = 0; i < 250; i++) sim.tick()
    const m = new Map<string, { x: number; y: number }>()
    for (const n of nodes) m.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 })
    setPositions(m)
  }, [graph, showEntries, size.w, size.h])

  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setReveal((r) => {
        if (r >= 1) {
          setPlaying(false)
          return 1
        }
        return Math.min(1, r + 0.02)
      })
    }, 120)
    return () => clearInterval(id)
  }, [playing])

  const pos = (id: string) => positions.get(id) ?? { x: size.w / 2, y: size.h / 2 }

  return (
    <div className="grid min-h-0 grid-cols-1 gap-3 lg:h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
      <div className="card flex min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 p-2 text-xs dark:border-zinc-800">
          <select aria-label="category" className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{labels.all}</option>
            {graph.categories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showEntries} onChange={(e) => setShowEntries(e.target.checked)} /> {labels.showEntries}
          </label>
          <span className="ml-auto text-zinc-600 dark:text-zinc-400">
            {labels.nodes} {visibleNodes.length} · {labels.edges} {visibleEdges.length}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <svg ref={svgRef} viewBox={`0 0 ${size.w} ${size.h}`} className="h-full w-full" data-testid="journey-svg">
            {visibleEdges.map((e, i) => {
              const a = pos(e.source)
              const b = pos(e.target)
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.kind === 'contains' ? '#d4d4d8' : '#a1a1aa'} strokeWidth={e.kind === 'wikilink' ? 1.8 : 1} strokeOpacity={0.7} />
            })}
            {visibleNodes.map((n) => {
              const p = pos(n.id)
              const r = n.kind === 'memory_entry' ? 3 : n.kind === 'memory' ? 9 : 7
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} onClick={() => setSelected(n)} className="cursor-pointer" data-testid={`node-${n.id}`}>
                  <circle r={r} fill={COLORS[n.kind]} stroke={selected?.id === n.id ? '#f59e0b' : n.enabled === false ? '#ef4444' : '#fff'} strokeWidth={selected?.id === n.id ? 3 : 1.2} />
                  {n.kind !== 'memory_entry' && (
                    <text x={r + 3} y={4} fontSize={10} fill="currentColor" opacity={0.85}>
                      {n.label.length > 24 ? n.label.slice(0, 24) + '…' : n.label}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </div>
        <div className="flex items-center gap-2 border-t border-zinc-200 p-2 text-xs dark:border-zinc-800">
          <button className="btn-outline" onClick={() => { if (reveal >= 1) setReveal(0); setPlaying((p) => !p) }}>
            {playing ? labels.pause : labels.play}
          </button>
          <span>{labels.replay}</span>
          <input type="range" min={0} max={1} step={0.01} value={reveal} onChange={(e) => setReveal(Number(e.target.value))} className="flex-1" aria-label="timeline" />
          <span className="w-36 text-right text-zinc-600 dark:text-zinc-400">{fmtTime(cutoff)}</span>
        </div>
      </div>
      <aside className="card overflow-auto p-3 text-sm">
        {selected ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-full" style={{ background: COLORS[selected.kind] }} />
              <span className="text-xs uppercase text-zinc-600 dark:text-zinc-400">{selected.kind}</span>
            </div>
            <div className="break-words font-medium">{selected.label}</div>
            <dl className="text-xs text-zinc-600 dark:text-zinc-400">
              <div>category: {selected.category}</div>
              {selected.source && <div>source: {selected.source}</div>}
              {selected.enabled !== undefined && <div>enabled: {String(selected.enabled)}</div>}
              <div>mtime: {fmtTime(selected.timestamp)}</div>
              {selected.path && <div className="break-all">path: {selected.path}</div>}
            </dl>
            {selected.text && <p className="whitespace-pre-wrap rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{selected.text}</p>}
            <div className="text-xs text-zinc-600 dark:text-zinc-400">
              links: {graph.edges.filter((e) => e.source === selected.id || e.target === selected.id).map((e) => (e.source === selected.id ? e.target : e.source)).join(', ') || '—'}
            </div>
          </div>
        ) : (
          <div className="text-zinc-600 dark:text-zinc-400">
            <div className="mb-2 flex flex-wrap gap-2 text-xs">
              {Object.entries(COLORS).map(([k, c]) => (
                <span key={k} className="flex items-center gap-1">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} /> {k}
                </span>
              ))}
            </div>
            {Object.entries(graph.stats).map(([k, v]) => (
              <div key={k} className="text-xs">
                {k}: {String(v)}
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}
