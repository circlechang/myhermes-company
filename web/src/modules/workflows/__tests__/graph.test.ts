import { autoLayout, defaultNode, duplicateNode, fromFlow, toFlow, validate } from '../graph'
import type { WfEdge, WfNode } from '../types'

const h = (id: string, extra: Partial<WfNode> = {}): WfNode => ({ id, kind: 'hermes', title: id, agent_id: 'a1', prompt: 'do', ...extra })
const e = (source: string, target: string, extra: Partial<WfEdge> = {}): WfEdge => ({ source, target, ...extra })

describe('workflow graph validate（鏡像後端規則）', () => {
  it('合法線性 / 單節點', () => {
    expect(validate([h('a'), { id: 'g', kind: 'gate', title: 'g' }, h('b')], [e('a', 'g'), e('g', 'b')])).toEqual([])
    expect(validate([h('a')], [])).toEqual([])
  })
  it.each<[WfNode[], WfEdge[], RegExp]>([
    [[], [], /至少要有 1/],
    [[h('a', { agent_id: undefined })], [], /AI 員工/],
    [[h('a', { prompt: ' ' })], [], /提示/],
    [[h('a'), h('b')], [e('a', 'b'), e('b', 'a')], /有環/],
    [[h('a'), h('b'), h('c')], [e('a', 'b')], /連通/],
    [[h('a')], [e('a', 'a')], /自迴圈/],
    [[h('a'), h('a')], [], /重複/],
    [[h('a'), h('b')], [e('a', 'b'), e('a', 'b')], /重複的邊/],
    [[h('a'), h('zz')], [e('a', 'nope')], /不存在/],
    [[{ id: 'c', kind: 'coding-agent', title: 'c', tool: 'codex', prompt: '' }], [], /指令/],
    [[{ id: 'c', kind: 'condition', title: 'c', mode: 'rule', rule: { op: 'contains', value: '' } }], [], /條件必須有 value/],
    [[{ id: 'c', kind: 'condition', title: 'c', mode: 'rule', rule: { op: 'json_path', value: 'x' } }], [], /json_path/],
    [[{ id: 'c', kind: 'condition', title: 'c', mode: 'ai', prompt: 'x' }], [], /AI 判斷必須指定/],
    [[{ id: 'L', kind: 'loop', title: 'L', max_iterations: 0 }], [], /1–100/],
    [[{ id: 'd', kind: 'delivery', title: 'd', channel: 'line', to: '' }], [], /LINE/],
    [[{ id: 'd', kind: 'delivery', title: 'd', channel: 'webhook', url: 'ftp://x' }], [], /http/],
    [[{ id: 'd', kind: 'delivery', title: 'd', channel: 'file', path: '' }], [], /path/],
    [[h('a'), h('b')], [e('a', 'b', { loop_back: true })], /必須接到迴圈/],
    [[h('a'), h('b')], [e('a', 'b', { sourceHandle: 'true' })], /出口 true 不合法/],
  ])('拒絕 %#', (nodes, edges, re) => {
    expect(validate(nodes, edges).join('; ')).toMatch(re)
  })
  it('迴圈：受控回邊合法；回邊來源在本體外不合法', () => {
    const L: WfNode = { id: 'L', kind: 'loop', title: 'L', max_iterations: 3 }
    const ok = [e('s', 'L'), e('L', 'body', { sourceHandle: 'body' }), e('body', 'L', { loop_back: true }), e('L', 'end', { sourceHandle: 'exit' })]
    expect(validate([h('s'), L, h('body'), h('end')], ok)).toEqual([])
    const bad = [e('s', 'L'), e('L', 'x', { sourceHandle: 'exit' }), e('x', 'L', { loop_back: true })]
    expect(validate([h('s'), L, h('x')], bad).join()).toMatch(/不在迴圈本體/)
  })
})

describe('autoLayout / flow 互轉 / 複製', () => {
  it('拓撲分層：同層水平、層間垂直，回邊不影響層級', () => {
    const L: WfNode = { id: 'L', kind: 'loop', title: 'L', max_iterations: 2 }
    const nodes = [h('a'), h('b'), h('c'), L, h('body')]
    const edges = [e('a', 'c'), e('b', 'c'), e('c', 'L'), e('L', 'body', { sourceHandle: 'body' }), e('body', 'L', { loop_back: true })]
    const pos = autoLayout(nodes, edges)
    expect(pos.a.y).toBe(pos.b.y)
    expect(pos.a.x).not.toBe(pos.b.x)
    expect(pos.c.y).toBeGreaterThan(pos.a.y)
    expect(pos.L.y).toBeGreaterThan(pos.c.y)
    expect(pos.body.y).toBeGreaterThan(pos.L.y)
  })
  it('toFlow/fromFlow 往返保留欄位、agent 別名正規化、回邊旗標', () => {
    const wf = { nodes: [{ ...h('a', { kind: 'agent' as const, position: { x: 10, y: 20 }, skills: ['x'] }) }, { id: 'L', kind: 'loop' as const, title: 'L', max_iterations: 2, position: { x: 0, y: 100 } }], edges: [e('a', 'L', { on: 'success' }), e('L', 'a', { loop_back: true, sourceHandle: 'body' })] }
    const f = toFlow(wf)
    expect(f.nodes[0].data.node.kind).toBe('hermes')
    expect(f.edges[1].data?.loop_back).toBe(true)
    const back = fromFlow(f.nodes, f.edges)
    expect(back.nodes[0]).toMatchObject({ id: 'a', kind: 'hermes', skills: ['x'], position: { x: 10, y: 20 } })
    expect(back.edges).toEqual([
      { id: 'a->L:output', source: 'a', target: 'L', sourceHandle: 'output', targetHandle: 'input', on: 'success' },
      { id: 'L->a:body', source: 'L', target: 'a', sourceHandle: 'body', targetHandle: 'input', on: 'always', loop_back: true },
    ])
  })
  it('沒有 position 時 toFlow 自動排版', () => {
    const f = toFlow({ nodes: [h('a'), h('b')], edges: [e('a', 'b')] })
    expect(f.nodes[1].position.y).toBeGreaterThan(f.nodes[0].position.y)
  })
  it('defaultNode 給每種節點合理預設；duplicateNode 換 id 與位移', () => {
    expect(defaultNode('condition').rule).toEqual({ op: 'contains', value: '' })
    expect(defaultNode('loop').max_iterations).toBe(3)
    expect(defaultNode('delivery').channel).toBe('file')
    const d = duplicateNode(h('a', { position: { x: 1, y: 2 } }))
    expect(d.id).not.toBe('a')
    expect(d.position).toEqual({ x: 41, y: 42 })
    expect(d.title).toContain('副本')
  })
})
