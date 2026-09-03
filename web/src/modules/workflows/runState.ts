// 純函式：把 /ws/workflows 事件疊到 run 狀態上（執行面板用）
import type { NodeState, RunDetail, RunStatus, WfWsEvent } from './types'

export interface LiveRun {
  runId: string
  status: RunStatus
  nodes: Record<string, NodeState & { streaming?: string; tool?: string }>
  pendingApprovals: Record<string, { approval_id: string; payload: string }>
  error?: string
  usage?: RunDetail['usage']
  log: { ts: string; text: string }[]
  /** 「最近一次」分頁的頭一行要講幾點開始、幾點完成；WS 進來時用事件時間補 */
  startedAt?: string | null
  finishedAt?: string | null
  createdAt?: string | null
  trigger?: string
}

export const TERMINAL: RunStatus[] = ['completed', 'failed', 'stopped', 'timeout', 'budget_exceeded', 'needs_attention']
export const isTerminal = (s?: string) => !!s && (TERMINAL as string[]).includes(s)

export function emptyRun(runId: string, nodeIds: string[] = []): LiveRun {
  return { runId, status: 'pending', nodes: Object.fromEntries(nodeIds.map((n) => [n, { status: 'pending' }])), pendingApprovals: {}, log: [] }
}

export function fromDetail(d: RunDetail): LiveRun {
  const live = emptyRun(d.id, d.snapshot.nodes.map((n) => n.id))
  live.status = d.status
  live.error = d.error
  live.usage = d.usage
  live.startedAt = d.started_at ?? d.created_at
  live.finishedAt = d.finished_at
  live.createdAt = d.created_at
  live.trigger = d.trigger
  for (const [k, v] of Object.entries(d.node_states)) live.nodes[k] = { ...v }
  for (const a of d.approvals) if (a.status === 'pending') live.pendingApprovals[a.node_id] = { approval_id: a.id, payload: a.payload }
  return live
}

const MAX_STREAM = 4000

export function applyWsEvent(s: LiveRun, ev: WfWsEvent): LiveRun {
  if (ev.run_id && ev.run_id !== s.runId) return s
  const ts = ev.ts ?? new Date().toISOString()
  const nodes = { ...s.nodes }
  const cur = (id: string) => nodes[id] ?? { status: 'pending' as const }
  switch (ev.type) {
    case 'run.status':
      return {
        ...s,
        status: ev.status as RunStatus,
        error: ev.error || s.error,
        usage: ev.usage ?? s.usage,
        startedAt: s.startedAt ?? (ev.status === 'running' ? ts : s.startedAt),
        finishedAt: isTerminal(ev.status) ? ts : s.finishedAt,
        log: [...s.log, { ts, text: `run ${ev.status}${ev.error ? `：${ev.error}` : ''}` }],
      }
    case 'node.status': {
      const id = ev.node_id!
      const prev = cur(id)
      const ended = ev.status === 'completed' || ev.status === 'failed' || ev.status === 'reused' || ev.status === 'skipped'
      nodes[id] = {
        ...prev,
        status: ev.status as NodeState['status'],
        attempt: ev.attempt ?? prev.attempt,
        output: ev.output ?? prev.output,
        error: ev.error ?? prev.error,
        usage: ev.usage ?? prev.usage,
        reason: ev.reason,
        streaming: ev.status === 'running' ? '' : prev.streaming,
        // 每步花多久：後端事件沒帶時間就用收到的時間
        started_at: ev.status === 'running' ? ts : prev.started_at,
        finished_at: ended ? ts : prev.finished_at,
      }
      const approvals = { ...s.pendingApprovals }
      if (ev.status !== 'waiting_approval') delete approvals[id]
      return { ...s, nodes, pendingApprovals: approvals, log: [...s.log, { ts, text: `${id} → ${ev.status}${ev.reason ? `（${ev.reason}）` : ''}` }] }
    }
    case 'node.delta': {
      const id = ev.node_id!
      const prev = cur(id)
      const streaming = ((prev.streaming ?? '') + (ev.delta ?? '')).slice(-MAX_STREAM)
      nodes[id] = { ...prev, streaming }
      return { ...s, nodes }
    }
    case 'node.tool': {
      const id = ev.node_id!
      nodes[id] = { ...cur(id), tool: ev.status === 'started' ? ev.name : undefined }
      return { ...s, nodes }
    }
    case 'approval.request': {
      const id = ev.node_id!
      nodes[id] = { ...cur(id), status: 'waiting_approval', approval_id: ev.approval_id }
      return { ...s, nodes, pendingApprovals: { ...s.pendingApprovals, [id]: { approval_id: ev.approval_id!, payload: ev.payload ?? '' } }, log: [...s.log, { ts, text: `${id} 等待審批` }] }
    }
    case 'approval.decided': {
      const approvals = { ...s.pendingApprovals }
      delete approvals[ev.node_id!]
      return { ...s, pendingApprovals: approvals, log: [...s.log, { ts, text: `${ev.node_id} 審批：${ev.decision === 'approve' ? '核准' : '退回'}${ev.comment ? `（${ev.comment}）` : ''}` }] }
    }
    case 'node.done_check': {
      const id = ev.node_id!
      const prev = cur(id)
      const rounds = [...(prev.done_rounds ?? []).filter((r) => r.round !== ev.round), { round: ev.round ?? 1, status: ev.status as 'complete' | 'continue' | 'blocked', evidence: ev.evidence ?? '', next: '' }]
      nodes[id] = { ...prev, done_rounds: rounds }
      return { ...s, nodes, log: [...s.log, { ts, text: `${id} 自檢第 ${ev.round} 輪：${ev.status}` }] }
    }
    default:
      return s
  }
}

/** 證據回放：把事件時間軸重播到第 k 步，得到當時的節點狀態與邊決策 */
export function replayTo(events: RunDetail['events'], nodeIds: string[], step: number): { nodes: Record<string, string>; edges: Record<string, boolean> } {
  const nodes: Record<string, string> = Object.fromEntries(nodeIds.map((n) => [n, 'pending']))
  const edges: Record<string, boolean> = {}
  for (const ev of events.slice(0, step)) {
    if (ev.type === 'node.status' && ev.node_id) nodes[ev.node_id] = String(ev.status)
    else if (ev.type === 'approval.request' && ev.node_id) nodes[ev.node_id] = 'waiting_approval'
    else if (ev.type === 'edge.decision' && ev.edge) edges[ev.edge] = !!ev.taken
    else if (ev.type === 'loop.iteration') {
      // 迴圈重入：回邊的決策清掉（畫布上改回未決定）
      for (const k of Object.keys(edges)) if (k.endsWith(`:body`) || k.includes(`->${ev.node_id}:`)) delete edges[k]
    }
  }
  return { nodes, edges }
}

export function describeEvent(ev: RunDetail['events'][number]): string {
  switch (ev.type) {
    case 'run.status':
      return `執行 ${ev.status}${ev.error ? `：${ev.error}` : ''}`
    case 'node.status':
      return `節點 ${ev.node_id} → ${ev.status}${ev.reason ? `（${ev.reason}）` : ''}`
    case 'edge.decision':
      return `邊 ${ev.source} → ${ev.target}（${ev.handle !== 'output' ? ev.handle + '，' : ''}${ev.on}）${ev.taken ? '走' : '不走'}${ev.loop_back ? '［回邊］' : ''}`
    case 'approval.request':
      return `閘門 ${ev.node_id} 等待審批`
    case 'approval.decided':
      return `閘門 ${ev.node_id} ${ev.decision === 'approve' ? '核准' : '退回'}${ev.comment ? `：${ev.comment}` : ''}`
    case 'loop.iteration':
      return `迴圈 ${ev.node_id} 第 ${ev.iteration} 次重入`
    case 'tool.approval':
      return `節點 ${ev.node_id} 工具授權 ${String(ev.choice)}`
    case 'node.note':
      return `節點 ${ev.node_id}：${ev.note}`
    case 'run.rerun':
      return `從節點 ${String(ev.from_node)} 重跑（沿用 ${(ev.reused as string[] | undefined)?.length ?? 0} 個節點）`
    case 'run.recovered':
      return `伺服器重啟後恢復（閘門 ${((ev.resumed_gates as string[] | undefined) ?? []).join('、') || '無'} 從審批表重建）`
    case 'node.spill':
      return `節點 ${ev.node_id} 輸出 ${String(ev.bytes)} bytes 已溢出到 ${String(ev.path)}`
    case 'node.done_check':
      return `節點 ${ev.node_id} 自檢第 ${String(ev.round)} 輪：${String(ev.status)}${ev.evidence ? `（${String(ev.evidence).slice(0, 80)}）` : ''}${ev.warning ? `［${String(ev.warning)}］` : ''}`
    default:
      return ev.type
  }
}
