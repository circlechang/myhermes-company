import { applyWsEvent, describeEvent, emptyRun, fromDetail, isTerminal, replayTo } from '../runState'
import type { RunDetail } from '../types'

const R = 'wr_1'

describe('runState reducer', () => {
  it('依 WS 事件更新節點狀態、串流、審批與 run 狀態', () => {
    let s = emptyRun(R, ['a', 'g', 'b'])
    s = applyWsEvent(s, { type: 'run.status', run_id: R, status: 'running' })
    s = applyWsEvent(s, { type: 'node.status', run_id: R, node_id: 'a', status: 'running', attempt: 1 })
    s = applyWsEvent(s, { type: 'node.delta', run_id: R, node_id: 'a', delta: '你' })
    s = applyWsEvent(s, { type: 'node.delta', run_id: R, node_id: 'a', delta: '好' })
    expect(s.nodes.a).toMatchObject({ status: 'running', streaming: '你好', attempt: 1 })
    s = applyWsEvent(s, { type: 'node.tool', run_id: R, node_id: 'a', name: 'web', status: 'started' })
    expect(s.nodes.a.tool).toBe('web')
    s = applyWsEvent(s, { type: 'node.status', run_id: R, node_id: 'a', status: 'completed', output: '結果', usage: { total_tokens: 3 } })
    expect(s.nodes.a).toMatchObject({ status: 'completed', output: '結果', usage: { total_tokens: 3 } })
    s = applyWsEvent(s, { type: 'approval.request', run_id: R, node_id: 'g', approval_id: 'wa_1', payload: '結果' })
    expect(s.nodes.g.status).toBe('waiting_approval')
    expect(s.pendingApprovals.g).toEqual({ approval_id: 'wa_1', payload: '結果' })
    s = applyWsEvent(s, { type: 'run.status', run_id: R, status: 'waiting_approval' })
    expect(isTerminal(s.status)).toBe(false)
    s = applyWsEvent(s, { type: 'approval.decided', run_id: R, node_id: 'g', decision: 'approve', comment: 'ok' })
    expect(s.pendingApprovals.g).toBeUndefined()
    s = applyWsEvent(s, { type: 'node.status', run_id: R, node_id: 'g', status: 'completed' })
    s = applyWsEvent(s, { type: 'run.status', run_id: R, status: 'completed', usage: { total_tokens: 6 } })
    expect(isTerminal(s.status)).toBe(true)
    expect(s.usage).toEqual({ total_tokens: 6 })
    expect(s.log.map((l) => l.text)).toContain('g 審批：核准（ok）')
  })
  it('忽略其他 run 的事件；退回時節點回到 pending 並清掉審批', () => {
    let s = emptyRun(R, ['a'])
    const other = applyWsEvent(s, { type: 'run.status', run_id: 'wr_other', status: 'failed' })
    expect(other).toBe(s)
    s = applyWsEvent(s, { type: 'approval.request', run_id: R, node_id: 'a', approval_id: 'x', payload: '' })
    s = applyWsEvent(s, { type: 'node.status', run_id: R, node_id: 'a', status: 'pending', reason: '閘門退回' })
    expect(s.pendingApprovals.a).toBeUndefined()
    expect(s.nodes.a.reason).toBe('閘門退回')
  })
  it('fromDetail 從快照還原；replayTo 依時間軸重播', () => {
    const d = {
      id: R, status: 'completed', error: '', usage: { total_tokens: 6 },
      snapshot: { nodes: [{ id: 'a', kind: 'hermes', title: 'a' }, { id: 'b', kind: 'hermes', title: 'b' }], edges: [{ id: 'a->b:output', source: 'a', target: 'b' }] },
      node_states: { a: { status: 'completed', output: 'x' }, b: { status: 'completed' } },
      approvals: [{ id: 'wa', node_id: 'b', status: 'pending', payload: 'p' }],
      events: [
        { seq: 0, ts: 't', type: 'run.status', status: 'running' },
        { seq: 1, ts: 't', type: 'node.status', node_id: 'a', status: 'running' },
        { seq: 2, ts: 't', type: 'node.status', node_id: 'a', status: 'completed' },
        { seq: 3, ts: 't', type: 'edge.decision', edge: 'a->b:output', source: 'a', target: 'b', on: 'always', handle: 'output', taken: true },
        { seq: 4, ts: 't', type: 'node.status', node_id: 'b', status: 'running' },
        { seq: 5, ts: 't', type: 'node.status', node_id: 'b', status: 'completed' },
        { seq: 6, ts: 't', type: 'run.status', status: 'completed' },
      ],
    } as unknown as RunDetail
    const live = fromDetail(d)
    expect(live.status).toBe('completed')
    expect(live.nodes.a.output).toBe('x')
    expect(live.pendingApprovals.b.approval_id).toBe('wa')
    expect(replayTo(d.events, ['a', 'b'], 2)).toEqual({ nodes: { a: 'running', b: 'pending' }, edges: {} })
    expect(replayTo(d.events, ['a', 'b'], 4)).toEqual({ nodes: { a: 'completed', b: 'pending' }, edges: { 'a->b:output': true } })
    expect(replayTo(d.events, ['a', 'b'], 7).nodes).toEqual({ a: 'completed', b: 'completed' })
    expect(describeEvent(d.events[3])).toBe('邊 a → b（always）走')
    expect(describeEvent({ seq: 0, ts: 't', type: 'approval.decided', node_id: 'g', decision: 'reject', comment: '重寫' })).toBe('閘門 g 退回：重寫')
    expect(describeEvent({ seq: 0, ts: 't', type: 'loop.iteration', node_id: 'L', iteration: 2 })).toBe('迴圈 L 第 2 次重入')
  })
})

describe('harness 借鏡：needs_attention / spill / done_check 事件', () => {
  it('needs_attention 是終態；node.done_check 疊到 done_rounds', () => {
    expect(isTerminal('needs_attention')).toBe(true)
    let live = emptyRun('wr_1', ['a'])
    live = applyWsEvent(live, { type: 'node.done_check', run_id: 'wr_1', node_id: 'a', round: 1, status: 'continue', evidence: '缺結尾' })
    live = applyWsEvent(live, { type: 'node.done_check', run_id: 'wr_1', node_id: 'a', round: 2, status: 'complete', evidence: 'ok' })
    expect(live.nodes.a.done_rounds?.map((r) => r.status)).toEqual(['continue', 'complete'])
    expect(live.log.at(-1)?.text).toContain('自檢第 2 輪')
  })
  it('describeEvent 認得 run.recovered / node.spill / node.done_check', () => {
    expect(describeEvent({ ts: '', seq: 0, type: 'run.recovered', resumed_gates: ['g'] })).toContain('g')
    expect(describeEvent({ ts: '', seq: 0, type: 'node.spill', node_id: 'a', bytes: 40000, path: 'runs/x/a.output.md' })).toContain('已溢出')
    expect(describeEvent({ ts: '', seq: 0, type: 'node.done_check', node_id: 'a', round: 1, status: 'blocked', evidence: '沒價格' })).toContain('blocked')
  })
})
