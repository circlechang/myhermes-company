import { validate } from '../graph'
import { insertAfter, isLinear, mkEdge, moveStation, orderStations, patchStation, removeStation, relayout, type Graph } from '../stations/stationGraph'
import { buildTemplate } from '../templates'
import type { WfNode } from '../types'

const n = (id: string, extra: Partial<WfNode> = {}): WfNode => ({ id, kind: 'hermes', title: id, agent_id: 'a1', prompt: 'p', ...extra })
const line = (): Graph => ({
  nodes: [n('a'), { id: 'g', kind: 'gate', title: '等我確認' }, n('c')],
  edges: [mkEdge('a', 'g'), mkEdge('g', 'c')],
})

describe('stationGraph：把圖攤成一條線', () => {
  it('依連線順序排站，序號從 1 開始', () => {
    const st = orderStations(line())
    expect(st.map((s) => s.node.id)).toEqual(['a', 'g', 'c'])
    expect(st.map((s) => s.seq)).toEqual([1, 2, 3])
    expect(st.every((s) => !s.branches)).toBe(true)
  })
  it('位置亂放也照連線排，不照陣列順序', () => {
    const g: Graph = { nodes: [n('c', { position: { x: 0, y: 300 } }), n('a', { position: { x: 0, y: 0 } }), n('b', { position: { x: 0, y: 150 } })], edges: [mkEdge('a', 'b'), mkEdge('b', 'c')] }
    expect(orderStations(g).map((s) => s.node.id)).toEqual(['a', 'b', 'c'])
  })
  it('有分岔的站會被標記，整條線就不是直線', () => {
    const g: Graph = {
      nodes: [n('a'), { id: 'q', kind: 'condition', title: '看情況分岔', mode: 'rule', rule: { op: 'contains', value: 'x' } }, n('y'), n('z')],
      edges: [mkEdge('a', 'q'), mkEdge('q', 'y', 'true'), mkEdge('q', 'z', 'false')],
    }
    const st = orderStations(g)
    expect(st.find((s) => s.node.id === 'q')!.branches).toBe(true)
    expect(isLinear(g)).toBe(false)
    expect(isLinear(line())).toBe(true)
  })
  it('插一站：上一站 → 新站 → 原本的下一站', () => {
    const { graph, id } = insertAfter(line(), 'a', 'hermes', { hermes: 'AI 員工' })
    expect(orderStations(graph).map((s) => s.node.id)).toEqual(['a', id, 'g', 'c'])
    expect(graph.edges.some((e) => e.source === 'a' && e.target === 'g')).toBe(false)
    expect(graph.nodes).toHaveLength(4)
  })
  it('插在最前面：新站變第 1 站', () => {
    const { graph, id } = insertAfter(line(), null, 'hermes')
    expect(orderStations(graph)[0].node.id).toBe(id)
  })
  it('刪一站：上一站直接接到下一站', () => {
    const g = removeStation(line(), 'g')
    expect(orderStations(g).map((s) => s.node.id)).toEqual(['a', 'c'])
    expect(g.edges.some((e) => e.source === 'a' && e.target === 'c')).toBe(true)
  })
  it('換順序：整條線照新順序重接', () => {
    const g = moveStation(line(), 2, 0)
    expect(orderStations(g).map((s) => s.node.id)).toEqual(['c', 'a', 'g'])
    expect(validate(g.nodes, g.edges)).toEqual([])
  })
  it('換順序超出範圍就原封不動', () => {
    const g = line()
    expect(moveStation(g, 0, 9)).toBe(g)
    expect(moveStation(g, 1, 1)).toBe(g)
  })
  it('改一站只動那一站', () => {
    const g = patchStation(line(), 'a', { prompt: '新指令' })
    expect(g.nodes.find((x) => x.id === 'a')!.prompt).toBe('新指令')
    expect(g.nodes.find((x) => x.id === 'c')!.prompt).toBe('p')
  })
  it('結構動過會重新排版，畫布切回去不會疊在一起', () => {
    const { graph } = insertAfter(line(), 'a', 'gate')
    const ys = graph.nodes.map((x) => x.position!.y)
    expect(new Set(ys).size).toBe(graph.nodes.length)
    expect(relayout(graph).nodes.every((x) => x.position)).toBe(true)
  })
  it('每個範本都是後端收得下的合法工作流', () => {
    for (const key of ['content', 'research', 'spec', 'blank']) {
      const tpl = buildTemplate(key, [{ id: 'a1', name: '小編', profile: 'default', enabled: true }])
      expect(validate(tpl.nodes, tpl.edges), key).toEqual([])
      expect(isLinear({ nodes: tpl.nodes, edges: tpl.edges }), key).toBe(true)
    }
    expect(buildTemplate('spec', []).nodes).toHaveLength(4)
    expect(buildTemplate('content', []).nodes.map((x) => x.kind)).toEqual(['hermes', 'gate', 'hermes'])
  })
})
