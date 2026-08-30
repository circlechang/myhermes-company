// 純函式：節點預設值、前端驗證（鏡像後端規則）、自動排版、React Flow 互轉
import type { Edge, Node } from '@xyflow/react'
import type { EdgeOn, NodeKind, Rule, WfEdge, WfNode, Workflow } from './types'

export const NODE_KINDS: NodeKind[] = ['hermes', 'coding-agent', 'gate', 'condition', 'loop', 'delivery']
export const CONDITION_OPS = ['contains', 'not_contains', 'regex', 'json_path', 'min_length', 'max_length', 'equals'] as const
export const NODE_W = 220
export const NODE_H = 88

let seq = 0
export const newId = (p = 'n') => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`

export function normKind(k: WfNode['kind']): NodeKind {
  return k === 'agent' ? 'hermes' : k
}

export function defaultNode(kind: NodeKind, position = { x: 80, y: 80 }, titles: Record<string, string> = {}): WfNode {
  const base: WfNode = { id: newId(), kind, title: titles[kind] ?? kind, position }
  switch (kind) {
    case 'hermes':
      return { ...base, prompt: '', skills: [], attachments: [] }
    case 'coding-agent':
      return { ...base, tool: 'claude-code', prompt: '', cwd: '' }
    case 'condition':
      return { ...base, mode: 'rule', rule: { op: 'contains', value: '' } }
    case 'loop':
      return { ...base, max_iterations: 3, until: null }
    case 'delivery':
      return { ...base, channel: 'file', path: 'out/{run_id}.md' }
    default:
      return base
  }
}

export function sourceHandles(kind: NodeKind): string[] {
  if (kind === 'condition') return ['true', 'false']
  if (kind === 'loop') return ['body', 'exit']
  return ['output']
}

export function edgeKey(e: WfEdge): string {
  return e.id ?? `${e.source}->${e.target}:${e.sourceHandle ?? 'output'}`
}

function checkRule(rule: Rule | null | undefined, where: string, errors: string[]) {
  if (!rule) return errors.push(`${where} 缺少條件規則`)
  if (!(CONDITION_OPS as readonly string[]).includes(rule.op)) return errors.push(`${where} 條件運算子不合法`)
  if (rule.op === 'min_length' || rule.op === 'max_length') {
    if (!Number.isInteger(Number(rule.value))) errors.push(`${where} 長度條件的 value 必須是整數`)
  } else if (rule.op === 'json_path') {
    if (!rule.path?.trim()) errors.push(`${where} json_path 條件必須有 path`)
  } else if (!String(rule.value ?? '').trim()) errors.push(`${where} 條件必須有 value`)
}

/** 回傳錯誤清單（空＝通過）。規則與後端 workflow_validate.py 一致。 */
export function validate(nodes: WfNode[], edges: WfEdge[]): string[] {
  const errors: string[] = []
  if (!nodes.length) return ['工作流至少要有 1 個節點']
  const ids = new Set<string>()
  const kinds: Record<string, NodeKind> = {}
  for (const n of nodes) {
    if (ids.has(n.id)) errors.push(`節點 id 重複: ${n.id}`)
    ids.add(n.id)
    const k = normKind(n.kind)
    kinds[n.id] = k
    const name = n.title || n.id
    if (k === 'hermes') {
      if (!n.agent_id && !n.profile) errors.push(`「${name}」必須指定 AI 員工`)
      if (!n.prompt?.trim()) errors.push(`「${name}」必須有提示`)
    } else if (k === 'coding-agent') {
      if (!n.tool) errors.push(`「${name}」必須選擇 coding agent`)
      if (!n.prompt?.trim()) errors.push(`「${name}」必須有指令`)
    } else if (k === 'condition') {
      if (n.mode === 'ai') {
        if (!n.agent_id) errors.push(`「${name}」AI 判斷必須指定 AI 員工`)
        if (!n.prompt?.trim()) errors.push(`「${name}」AI 判斷必須有判斷提示`)
      } else checkRule(n.rule, `「${name}」`, errors)
    } else if (k === 'loop') {
      const mx = Number(n.max_iterations)
      if (!(mx >= 1 && mx <= 100)) errors.push(`「${name}」次數上限必須介於 1–100`)
      if (n.until) checkRule(n.until, `「${name}」結束條件`, errors)
    } else if (k === 'delivery') {
      if (n.channel === 'line' && !n.to?.trim()) errors.push(`「${name}」LINE 投遞必須填 userId/groupId`)
      else if (n.channel === 'webhook' && !/^https?:\/\//.test(n.url ?? '')) errors.push(`「${name}」webhook url 必須是 http(s)`)
      else if (n.channel === 'file' && !n.path?.trim()) errors.push(`「${name}」檔案投遞必須填 path`)
      else if (!n.channel) errors.push(`「${name}」必須選擇投遞管道`)
    }
  }
  const adj: Record<string, string[]> = {}
  const und: Record<string, Set<string>> = {}
  const seen = new Set<string>()
  const backs: WfEdge[] = []
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) {
      errors.push(`邊指到不存在的節點: ${e.source} -> ${e.target}`)
      continue
    }
    if (e.source === e.target) {
      errors.push(`不可自迴圈: ${e.source}`)
      continue
    }
    const sh = e.sourceHandle ?? 'output'
    if (!sourceHandles(kinds[e.source]).includes(sh) && sh !== 'output') errors.push(`邊 ${e.source} -> ${e.target} 的出口 ${sh} 不合法`)
    const key = `${e.source}|${e.target}|${sh}`
    if (seen.has(key)) {
      errors.push(`重複的邊: ${e.source} -> ${e.target}`)
      continue
    }
    seen.add(key)
    if (e.loop_back && kinds[e.target] !== 'loop') errors.push(`回邊 ${e.source} -> ${e.target} 必須接到迴圈節點`)
    ;(und[e.source] ??= new Set()).add(e.target)
    ;(und[e.target] ??= new Set()).add(e.source)
    if (e.loop_back) backs.push(e)
    else (adj[e.source] ??= []).push(e.target)
  }
  if (errors.length) return errors
  // cycle check without loop_back
  const indeg: Record<string, number> = {}
  for (const id of ids) indeg[id] = 0
  for (const ts of Object.values(adj)) for (const t of ts) indeg[t]++
  const q = [...ids].filter((i) => indeg[i] === 0)
  let visited = 0
  while (q.length) {
    const n = q.shift()!
    visited++
    for (const t of adj[n] ?? []) if (--indeg[t] === 0) q.push(t)
  }
  if (visited !== ids.size) errors.push('工作流有環；迴圈請用 loop 節點並把回邊標記為回邊')
  // loop_back source inside loop body
  for (const b of backs) {
    const starts = edges.filter((e) => e.source === b.target && !e.loop_back && ['body', 'output'].includes(e.sourceHandle ?? 'output')).map((e) => e.target)
    const reach = new Set<string>()
    const st = [...starts]
    while (st.length) {
      const n = st.pop()!
      if (reach.has(n)) continue
      reach.add(n)
      st.push(...(adj[n] ?? []))
    }
    if (!reach.has(b.source)) errors.push(`回邊 ${b.source} -> ${b.target} 的來源不在迴圈本體內`)
  }
  if (ids.size > 1) {
    const [start] = ids
    const s = new Set([start])
    const st = [start]
    while (st.length) {
      const n = st.pop()!
      for (const m of und[n] ?? []) if (!s.has(m)) (s.add(m), st.push(m))
    }
    if (s.size !== ids.size) errors.push('工作流必須是單一連通圖（有孤立節點）')
  }
  return errors
}

/** 拓撲分層自動排版（忽略回邊）：同層水平排列、層間垂直。回傳新的 position。 */
export function autoLayout(nodes: WfNode[], edges: WfEdge[], gapX = 60, gapY = 70): Record<string, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id)
  const indeg: Record<string, number> = Object.fromEntries(ids.map((i) => [i, 0]))
  const adj: Record<string, string[]> = {}
  for (const e of edges) {
    if (e.loop_back || !(e.source in indeg) || !(e.target in indeg)) continue
    ;(adj[e.source] ??= []).push(e.target)
    indeg[e.target]++
  }
  const level: Record<string, number> = {}
  let frontier = ids.filter((i) => indeg[i] === 0)
  let depth = 0
  const remaining = new Set(ids)
  while (frontier.length) {
    const next: string[] = []
    for (const n of frontier) {
      level[n] = depth
      remaining.delete(n)
      for (const t of adj[n] ?? []) if (--indeg[t] === 0) next.push(t)
    }
    frontier = next
    depth++
  }
  for (const n of remaining) level[n] = depth // 有環時的兜底
  const byLevel: Record<number, string[]> = {}
  for (const id of ids) (byLevel[level[id]] ??= []).push(id)
  const out: Record<string, { x: number; y: number }> = {}
  const widest = Math.max(...Object.values(byLevel).map((l) => l.length))
  const totalW = widest * (NODE_W + gapX)
  for (const [lv, members] of Object.entries(byLevel)) {
    const rowW = members.length * (NODE_W + gapX)
    const offset = (totalW - rowW) / 2
    members.forEach((id, i) => {
      out[id] = { x: Math.round(offset + i * (NODE_W + gapX)), y: Number(lv) * (NODE_H + gapY) }
    })
  }
  return out
}

// ---- React Flow 互轉
export type FlowNode = Node<{ node: WfNode }, 'wf'>
export type FlowEdge = Edge<{ on: EdgeOn; loop_back: boolean }>

export function toFlow(wf: Pick<Workflow, 'nodes' | 'edges'>): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const pos = wf.nodes.some((n) => !n.position) ? autoLayout(wf.nodes, wf.edges) : {}
  return {
    nodes: wf.nodes.map((n) => ({ id: n.id, type: 'wf', position: n.position ?? pos[n.id] ?? { x: 0, y: 0 }, data: { node: { ...n, kind: normKind(n.kind) } } })),
    edges: wf.edges.map((e) => ({
      id: edgeKey(e),
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? 'output',
      targetHandle: 'input',
      data: { on: e.on ?? 'always', loop_back: !!e.loop_back },
      type: 'wf',
    })),
  }
}

export function fromFlow(nodes: FlowNode[], edges: FlowEdge[]): { nodes: WfNode[]; edges: WfEdge[] } {
  return {
    nodes: nodes.map((n) => ({ ...n.data.node, id: n.id, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? 'output',
      targetHandle: 'input',
      on: e.data?.on ?? 'always',
      ...(e.data?.loop_back ? { loop_back: true } : {}),
    })),
  }
}

/** 複製節點：新 id、位移、標題加「副本」 */
export function duplicateNode(n: WfNode): WfNode {
  return { ...structuredClone(n), id: newId(), title: `${n.title} 副本`, position: { x: (n.position?.x ?? 0) + 40, y: (n.position?.y ?? 0) + 40 } }
}
