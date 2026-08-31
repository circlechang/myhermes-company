// 生產線視圖的純函式：把節點圖攤成「一條線上的站」，以及插站／刪站／換順序。
// 只讀 graph.ts 既有的工具（不改它），輸出仍然是後端認得的 { nodes, edges }。
import { autoLayout, defaultNode, edgeKey, normKind } from '../graph'
import type { NodeKind, WfEdge, WfNode } from '../types'

export interface Graph {
  nodes: WfNode[]
  edges: WfEdge[]
}

export interface Station {
  node: WfNode
  kind: NodeKind
  /** 1 起算的站號（畫面上顯示的序號） */
  seq: number
  /** 這站有分支：出口不只一個、或有人從別條線接進來、或本身是分岔／迴圈 */
  branches: boolean
  incoming: number
  outgoing: number
}

const forward = (e: WfEdge) => !e.loop_back

export function mkEdge(source: string, target: string, handle = 'output', on: WfEdge['on'] = 'always'): WfEdge {
  return { id: `${source}->${target}:${handle}`, source, target, sourceHandle: handle, targetHandle: 'input', on }
}

/** 拓撲排序（忽略回邊），同層用 position.y → position.x → 原順序決定先後。有環時把剩下的接在後面。 */
export function orderStations(g: Graph): Station[] {
  const at = new Map(g.nodes.map((n, i) => [n.id, i]))
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]))
  const out = new Map<string, string[]>()
  const inCount = new Map(g.nodes.map((n) => [n.id, 0]))
  const outCount = new Map(g.nodes.map((n) => [n.id, 0]))
  let hasLoopBack = false
  for (const e of g.edges) {
    if (!at.has(e.source) || !at.has(e.target)) continue
    outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1)
    inCount.set(e.target, (inCount.get(e.target) ?? 0) + 1)
    if (!forward(e)) {
      hasLoopBack = true
      continue
    }
    out.set(e.source, [...(out.get(e.source) ?? []), e.target])
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }
  const rank = (id: string) => {
    const n = g.nodes[at.get(id)!]
    return [n.position?.y ?? 0, n.position?.x ?? 0, at.get(id)!] as const
  }
  const cmp = (a: string, b: string) => {
    const ra = rank(a)
    const rb = rank(b)
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2]
  }
  const ready = g.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const seen = new Set<string>()
  const order: string[] = []
  while (ready.length) {
    ready.sort(cmp)
    const id = ready.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
    for (const tgt of out.get(id) ?? []) {
      indeg.set(tgt, (indeg.get(tgt) ?? 0) - 1)
      if ((indeg.get(tgt) ?? 0) === 0) ready.push(tgt)
    }
  }
  for (const n of g.nodes) if (!seen.has(n.id)) order.push(n.id)
  return order.map((id, i) => {
    const node = g.nodes[at.get(id)!]
    const kind = normKind(node.kind)
    const inC = inCount.get(id) ?? 0
    const outC = outCount.get(id) ?? 0
    return {
      node,
      kind,
      seq: i + 1,
      incoming: inC,
      outgoing: outC,
      branches: outC > 1 || inC > 1 || kind === 'condition' || kind === 'loop' || (hasLoopBack && g.edges.some((e) => !forward(e) && (e.source === id || e.target === id))),
    }
  })
}

/** 一條真正的直線：每站至多一進一出、沒有回邊、沒有分岔／迴圈站、而且全部連在一起。 */
export function isLinear(g: Graph): boolean {
  if (g.nodes.length === 0) return true
  const st = orderStations(g)
  if (st.some((s) => s.branches)) return false
  if (g.edges.some((e) => !forward(e))) return false
  const fwd = g.edges.filter((e) => forward(e))
  return fwd.length === g.nodes.length - 1
}

function withoutEdge(edges: WfEdge[], pred: (e: WfEdge) => boolean): WfEdge[] {
  return edges.filter((e) => !pred(e))
}

/** 位置重排：結構動過就重新排版，畫布切回去才不會疊在一起。 */
export function relayout(g: Graph): Graph {
  const pos = autoLayout(g.nodes, g.edges)
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position ?? { x: 0, y: 0 } })) }
}

/**
 * 在 afterId 這站的後面插一站；afterId 為 null＝插在最前面。
 * 原本 afterId → X 的那條線會改成 afterId → 新站 → X。
 */
export function insertAfter(g: Graph, afterId: string | null, kind: NodeKind, titles: Record<string, string> = {}): { graph: Graph; id: string } {
  const node = defaultNode(kind, { x: 0, y: 0 }, titles)
  if (!g.nodes.length) return { graph: relayout({ nodes: [node], edges: [] }), id: node.id }
  if (afterId === null) {
    const head = orderStations(g)[0]?.node.id
    const edges = head ? [...g.edges, mkEdge(node.id, head)] : [...g.edges]
    return { graph: relayout({ nodes: [node, ...g.nodes], edges }), id: node.id }
  }
  const next = g.edges.find((e) => e.source === afterId && forward(e))
  let edges = g.edges
  if (next) {
    edges = withoutEdge(edges, (e) => edgeKey(e) === edgeKey(next))
    edges = [...edges, mkEdge(afterId, node.id), mkEdge(node.id, next.target, 'output', next.on)]
  } else {
    edges = [...edges, mkEdge(afterId, node.id)]
  }
  const at = g.nodes.findIndex((n) => n.id === afterId)
  const nodes = [...g.nodes.slice(0, at + 1), node, ...g.nodes.slice(at + 1)]
  return { graph: relayout({ nodes, edges }), id: node.id }
}

/** 接在最後一站後面。 */
export function appendStation(g: Graph, kind: NodeKind, titles: Record<string, string> = {}): { graph: Graph; id: string } {
  const st = orderStations(g)
  const last = st.length ? st[st.length - 1].node.id : null
  return st.length ? insertAfter(g, last, kind, titles) : insertAfter(g, null, kind, titles)
}

/** 刪掉一站，並把它的上游直接接到下游（1 對 1 時最自然）。 */
export function removeStation(g: Graph, id: string): Graph {
  const preds = g.edges.filter((e) => e.target === id && forward(e)).map((e) => e.source)
  const succs = g.edges.filter((e) => e.source === id && forward(e))
  const kept = withoutEdge(g.edges, (e) => e.source === id || e.target === id)
  const bridged: WfEdge[] = []
  for (const p of preds)
    for (const s of succs) {
      const key = `${p}->${s.target}:output`
      if (!kept.some((e) => edgeKey(e) === key) && !bridged.some((e) => edgeKey(e) === key) && p !== s.target) bridged.push(mkEdge(p, s.target, 'output', s.on))
    }
  return relayout({ nodes: g.nodes.filter((n) => n.id !== id), edges: [...kept, ...bridged] })
}

/**
 * 換順序（只在直線時可用）：整條線照新順序重接。
 * 邊的 on 條件不保留（順序換了語意本來就變了），一律回到「一律」。
 */
export function moveStation(g: Graph, from: number, to: number): Graph {
  const st = orderStations(g)
  if (from === to || from < 0 || to < 0 || from >= st.length || to >= st.length) return g
  const ids = st.map((s) => s.node.id)
  const [moved] = ids.splice(from, 1)
  ids.splice(to, 0, moved)
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const nodes = ids.map((id) => byId.get(id)!)
  const edges = ids.slice(0, -1).map((id, i) => mkEdge(id, ids[i + 1]))
  return relayout({ nodes, edges })
}

/** 改一站的欄位。 */
export function patchStation(g: Graph, id: string, patch: Partial<WfNode>): Graph {
  return { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }
}
