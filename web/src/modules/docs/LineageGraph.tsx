// 血緣圖：從哪來、去了哪、經過哪些站。純 SVG 分層排版（不引入 d3，清楚就好）。
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Lineage, LineageEdge, LineageNode, LinkKind } from './api'

const KIND_COLOR: Record<LinkKind, string> = {
  derived: '#71717a', // 同一條線往下長
  split: '#0ea5e9', // 分岔成 N 份
  selected: '#16a34a', // 被挑中的那條
  merged: '#a855f7', // 收攏
}
const NODE_W = 168
const NODE_H = 54
const GAP_X = 56
const GAP_Y = 22

interface Placed extends LineageNode {
  x: number
  y: number
  level: number
}

/** 依邊做分層（沒有入邊的在最左邊）。
 *
 * 血緣圖**會有環**：一份 spec 分岔成 N 份草稿（split），被選中的那份又寫回同一份 spec（selected）。
 * 所以這裡用「每個節點只配一次層」的 BFS（最短路徑分層），不是最長路徑——否則環會讓層數一直往上加。 */
export function layout(nodes: LineageNode[], edges: LineageEdge[]): { placed: Placed[]; width: number; height: number } {
  const ids = new Set(nodes.map((n) => n.id))
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const e of edges) {
    if (!ids.has(e.from_doc_id) || !ids.has(e.to_doc_id)) continue
    incoming.set(e.to_doc_id, [...(incoming.get(e.to_doc_id) ?? []), e.from_doc_id])
    outgoing.set(e.from_doc_id, [...(outgoing.get(e.from_doc_id) ?? []), e.to_doc_id])
  }
  const level = new Map<string, number>()
  const noIncoming = nodes.filter((n) => (incoming.get(n.id) ?? []).length === 0)
  // 全部節點都有入邊（環）→ 用標記的根，再不然用最早建立的那個
  const starts = noIncoming.length ? noIncoming : [nodes.find((n) => n.is_root) ?? nodes[0]].filter(Boolean)
  const queue = starts.map((n) => n.id)
  for (const id of queue) level.set(id, 0)
  while (queue.length) {
    const id = queue.shift()!
    for (const next of outgoing.get(id) ?? []) {
      if (level.has(next)) continue // 只配一次 → 環不會把層數推爆
      level.set(next, (level.get(id) ?? 0) + 1)
      queue.push(next)
    }
  }
  // 連不到的節點（另一條血緣支線）接在後面
  for (const n of nodes) {
    if (level.has(n.id)) continue
    const from = (incoming.get(n.id) ?? []).map((p) => level.get(p)).filter((v): v is number => v !== undefined)
    level.set(n.id, from.length ? Math.max(...from) + 1 : 0)
  }
  const byLevel = new Map<number, LineageNode[]>()
  for (const n of nodes) {
    const lv = level.get(n.id) ?? 0
    byLevel.set(lv, [...(byLevel.get(lv) ?? []), n])
  }
  const placed: Placed[] = []
  let maxRows = 1
  for (const [lv, group] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    maxRows = Math.max(maxRows, group.length)
    group.forEach((n, i) => {
      placed.push({ ...n, level: lv, x: 12 + lv * (NODE_W + GAP_X), y: 12 + i * (NODE_H + GAP_Y) })
    })
  }
  const levels = byLevel.size
  return {
    placed,
    width: 24 + levels * NODE_W + Math.max(0, levels - 1) * GAP_X,
    height: 24 + maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y,
  }
}

export function LineageGraph({ data, onPick }: { data: Lineage; onPick?: (id: string) => void }) {
  const { t } = useTranslation()
  const { placed, width, height } = useMemo(() => layout(data.nodes, data.edges), [data])
  const pos = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed])
  if (!data.nodes.length) return <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">{t('docs.lineage.empty')}</div>
  return (
    <div className="overflow-auto" data-testid="lineage-graph">
      <svg width={Math.max(width, 320)} height={Math.max(height, 90)} role="img" aria-label={t('docs.lineage.title')}>
        <defs>
          {Object.entries(KIND_COLOR).map(([k, c]) => (
            <marker key={k} id={`arrow-${k}`} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L7,3 L0,6 z" fill={c} />
            </marker>
          ))}
        </defs>
        {data.edges.map((e) => {
          const a = pos.get(e.from_doc_id)
          const b = pos.get(e.to_doc_id)
          if (!a || !b) return null
          const x1 = a.x + NODE_W
          const y1 = a.y + NODE_H / 2
          const x2 = b.x
          const y2 = b.y + NODE_H / 2
          const mid = (x1 + x2) / 2
          return (
            <g key={e.id}>
              <path
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                fill="none"
                stroke={KIND_COLOR[e.kind] ?? '#71717a'}
                strokeWidth={e.kind === 'selected' ? 2.5 : 1.5}
                markerEnd={`url(#arrow-${e.kind})`}
                data-testid={`lineage-edge-${e.kind}`}
              />
              <text x={mid} y={(y1 + y2) / 2 - 4} textAnchor="middle" fontSize="10" fill={KIND_COLOR[e.kind] ?? '#71717a'}>
                {t(`docs.linkKind.${e.kind}`)}
              </text>
            </g>
          )
        })}
        {placed.map((n) => (
          <g
            key={n.id}
            transform={`translate(${n.x},${n.y})`}
            className="cursor-pointer"
            onClick={() => onPick?.(n.id)}
            data-testid={`lineage-node-${n.id}`}
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx="8"
              className={n.is_root ? 'fill-indigo-50 dark:fill-indigo-950' : 'fill-white dark:fill-zinc-900'}
              stroke={n.is_root ? '#6366f1' : '#d4d4d8'}
              strokeWidth={n.is_root ? 2 : 1}
            />
            <text x="10" y="20" fontSize="12" className="fill-zinc-900 dark:fill-zinc-100">
              {n.title.length > 16 ? `${n.title.slice(0, 15)}…` : n.title}
            </text>
            <text x="10" y="36" fontSize="10" className="fill-zinc-500 dark:fill-zinc-400">
              {n.stage || t(`docs.origin.${n.origin}`)} · v{n.latest_version ?? 0} · {n.chars} {t('docs.chars')}
            </text>
            <text x="10" y="48" fontSize="9" className="fill-zinc-400">
              {t(`docs.status.${n.status}`)}
            </text>
          </g>
        ))}
      </svg>
      <ul className="mt-1 flex flex-wrap gap-3 px-1 text-[11px] text-zinc-600 dark:text-zinc-400">
        {(Object.keys(KIND_COLOR) as LinkKind[]).map((k) => (
          <li key={k} className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-4" style={{ background: KIND_COLOR[k] }} />
            {t(`docs.linkKind.${k}`)}
          </li>
        ))}
      </ul>
    </div>
  )
}
