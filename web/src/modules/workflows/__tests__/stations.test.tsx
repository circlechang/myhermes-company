// 生產線視圖：站卡片渲染、直接編輯、插站、新增選單、狀態燈、就地核准、範本選擇
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import type { ReactElement } from 'react'
import '../../../i18n'
import type { Agent } from '../../../api/types'
import { setFetchImpl, setToken } from '../../../api/client'
import { MOCK_TOKEN, mockFetch } from '../../../mock/fetch'
import { en, zhTW } from '../i18n'
import { applyWsEvent, emptyRun } from '../runState'
import { StationsView } from '../stations'
import { mkEdge, type Graph } from '../stations/stationGraph'
import { TemplatePicker } from '../templates/TemplatePicker'
import type { WfNode } from '../types'

i18n.addResourceBundle('zh-TW', 'translation', zhTW, true, true)
i18n.addResourceBundle('en', 'translation', en, true, true)

beforeEach(() => {
  setFetchImpl(mockFetch as typeof fetch)
  setToken(MOCK_TOKEN)
})
const render = (ui: ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

const agents: Agent[] = [
  { id: 'a1', name: '小編', title: '內容', profile: 'default', enabled: true },
  { id: 'a2', name: '阿研', title: '研究', profile: 'research', enabled: true },
]
const node = (id: string, extra: Partial<WfNode> = {}): WfNode => ({ id, kind: 'hermes', title: id, agent_id: 'a1', prompt: `${id} 的指令`, ...extra })
const graph = (): Graph => ({
  nodes: [node('n1', { title: '找題材' }), { id: 'n2', kind: 'gate', title: '等我確認' }, node('n3', { title: '寫成文章' })],
  edges: [mkEdge('n1', 'n2'), mkEdge('n2', 'n3')],
})
const props = (over: Partial<React.ComponentProps<typeof StationsView>> = {}) => ({
  graph: graph(),
  agents,
  running: false,
  busy: false,
  onChange: vi.fn(),
  onRerun: vi.fn(),
  onApprove: vi.fn(),
  onReject: vi.fn(),
  onAdvanced: vi.fn(),
  ...over,
})

describe('生產線視圖', () => {
  it('每張站卡回答四件事：序號、誰做、做什麼、產出', () => {
    render(<StationsView {...props()} />)
    const card = screen.getByTestId('station-n1')
    expect(within(card).getByTestId('station-n1-seq')).toHaveTextContent('第 1 站')
    expect(within(card).getByTestId('station-n1-title')).toHaveValue('找題材')
    expect(within(card).getByTestId('station-n1-agent')).toHaveValue('a1')
    expect(within(card).getByTestId('station-n1-prompt')).toHaveValue('n1 的指令')
    expect(within(card).getByTestId('station-n1-output')).toHaveTextContent('文字輸出')
    // 等我確認的站：沒有指令欄，改成一句白話
    expect(within(screen.getByTestId('station-n2')).queryByTestId('station-n2-prompt')).toBeNull()
    expect(screen.getByTestId('station-n2')).toHaveTextContent('停在這裡等你按核准')
    // 站與站之間：帶著什麼過去
    expect(screen.getByTestId('link-after-n1')).toHaveTextContent('帶著：文字輸出')
  })

  it('介面上不出現 node／edge／gate／閘門這類字', () => {
    const { container } = render(<StationsView {...props()} />)
    const text = container.textContent ?? ''
    for (const bad of ['閘門', '節點', 'DAG']) expect(text, bad).not.toContain(bad)
  })

  it('改指令就吐出新的圖（自動存由外層接手，不放儲存按鈕）', async () => {
    const p = props()
    render(<StationsView {...p} />)
    expect(screen.queryByRole('button', { name: /^儲存$/ })).toBeNull()
    await userEvent.type(screen.getByTestId('station-n1-prompt'), '!')
    expect(p.onChange).toHaveBeenCalled()
    const g = vi.mocked(p.onChange).mock.calls.at(-1)![0] as Graph
    expect(g.nodes.find((x) => x.id === 'n1')!.prompt).toBe('n1 的指令!')
  })

  it('換 AI 員工會一起帶上 profile', async () => {
    const p = props()
    render(<StationsView {...p} />)
    await userEvent.selectOptions(screen.getByTestId('station-n1-agent'), 'a2')
    const g = vi.mocked(p.onChange).mock.calls.at(-1)![0] as Graph
    expect(g.nodes.find((x) => x.id === 'n1')).toMatchObject({ agent_id: 'a2', profile: 'research' })
  })

  it('在兩站之間插一站：選單是白話說明，不是六顆按鈕', async () => {
    const p = props()
    render(<StationsView {...p} />)
    await userEvent.click(within(screen.getByTestId('link-after-n1')).getByRole('button', { name: /插一站/ }))
    const menu = screen.getByTestId('insert-after-n1-menu')
    expect(within(menu).getByText('等我確認')).toBeInTheDocument()
    expect(within(menu).getByText(/停在這裡等你按核准/)).toBeInTheDocument()
    expect(within(menu).getByText('重複直到⋯')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('insert-after-n1-hermes'))
    const g = vi.mocked(p.onChange).mock.calls.at(-1)![0] as Graph
    expect(g.nodes).toHaveLength(4)
    expect(g.edges.some((e) => e.source === 'n1' && e.target === 'n2')).toBe(false)
  })

  it('底部「＋ 新增一站」接在最後面', async () => {
    const p = props()
    render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('add-station'))
    await userEvent.click(screen.getByTestId('add-station-delivery'))
    const g = vi.mocked(p.onChange).mock.calls.at(-1)![0] as Graph
    expect(g.nodes).toHaveLength(4)
    expect(g.edges.some((e) => e.source === 'n3')).toBe(true)
  })

  it('沒有站時給空狀態與「新增第一站」', () => {
    render(<StationsView {...props({ graph: { nodes: [], edges: [] } })} />)
    expect(screen.getByTestId('empty-stations')).toHaveTextContent('這條線還沒有站')
    expect(screen.getByTestId('add-first-station')).toBeInTheDocument()
  })

  it('執行態：站別即時變色，等你確認的那張浮起來', () => {
    let live = emptyRun('wr_1', ['n1', 'n2', 'n3'])
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'n1', status: 'completed', output: '三個題材' })
    live = applyWsEvent(live, { type: 'approval.request', run_id: 'wr_1', node_id: 'n2', approval_id: 'wa_1', payload: '三個題材' })
    render(<StationsView {...props({ live, running: true })} />)
    expect(screen.getByTestId('station-n1')).toHaveAttribute('data-light', 'completed')
    expect(screen.getByTestId('station-n1-status')).toHaveTextContent('完成')
    expect(screen.getByTestId('station-n2')).toHaveAttribute('data-light', 'waiting_approval')
    expect(screen.getByTestId('station-n2-status')).toHaveTextContent('等你確認')
    expect(screen.getByTestId('station-n3')).toHaveAttribute('data-light', 'pending')
    expect(screen.getByTestId('station-n3-status')).toHaveTextContent('未跑')
    // 產出長在該站底下
    expect(screen.getByTestId('station-n1-result')).toBeInTheDocument()
  })

  it('等你確認的站就地給核准／退回，不用跳到別的面板', async () => {
    let live = emptyRun('wr_1', ['n1', 'n2', 'n3'])
    live = applyWsEvent(live, { type: 'approval.request', run_id: 'wr_1', node_id: 'n2', approval_id: 'wa_1', payload: '上一站的結果' })
    const p = props({ live, running: true })
    render(<StationsView {...p} />)
    const box = screen.getByTestId('station-n2-approval')
    await userEvent.type(within(box).getByLabelText(/意見/), '可以')
    await userEvent.click(screen.getByTestId('station-n2-approve'))
    expect(p.onApprove).toHaveBeenCalledWith('wa_1', '可以')
    await userEvent.click(screen.getByTestId('station-n2-reject'))
    expect(p.onReject).toHaveBeenCalledWith('wa_1', '可以')
  })

  it('跑完可以重跑這一站', async () => {
    let live = emptyRun('wr_1', ['n1', 'n2', 'n3'])
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'n1', status: 'completed', output: 'x' })
    live = applyWsEvent(live, { type: 'run.status', run_id: 'wr_1', status: 'completed' })
    const p = props({ live, running: false })
    render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('station-n1-rerun'))
    expect(p.onRerun).toHaveBeenCalledWith('n1')
  })

  it('直線可以拖曳排序；有分支就鎖住並指去進階檢視', () => {
    render(<StationsView {...props()} />)
    expect(screen.getByTestId('station-n1-drag')).toHaveAttribute('title', '拖曳排序')

    const branchy: Graph = {
      nodes: [node('n1'), { id: 'q', kind: 'condition', title: '看情況分岔', mode: 'rule', rule: { op: 'contains', value: 'x' } }, node('y'), node('z')],
      edges: [mkEdge('n1', 'q'), mkEdge('q', 'y', 'true'), mkEdge('q', 'z', 'false')],
    }
    const p = props({ graph: branchy })
    rtlRender(<QueryClientProvider client={new QueryClient()}><StationsView {...p} /></QueryClientProvider>)
    const drag = screen.getAllByTestId('station-n1-drag').at(-1)!
    expect(drag).toHaveAttribute('title', expect.stringContaining('進階檢視'))
    expect(screen.getByTestId('station-q-branch')).toHaveTextContent('這站有分支')
  })
})

describe('範本選擇', () => {
  it('四個範本，選一個就建立', async () => {
    const onCreate = vi.fn()
    render(<TemplatePicker onCreate={onCreate} onCancel={vi.fn()} />)
    for (const k of ['content', 'research', 'spec', 'blank']) expect(screen.getByTestId(`template-${k}`)).toBeInTheDocument()
    expect(screen.getByTestId('template-content')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByTestId('template-research'))
    expect(screen.getByTestId('template-research')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.type(screen.getByLabelText('這條線叫什麼'), '週報線')
    await userEvent.click(screen.getByTestId('template-create'))
    expect(onCreate).toHaveBeenCalledWith('research', '週報線')
  })
  it('範本卡上看得到流程有哪幾站', () => {
    render(<TemplatePicker onCreate={vi.fn()} onCancel={vi.fn()} />)
    const card = screen.getByTestId('template-content')
    expect(card).toHaveTextContent('找題材')
    expect(card).toHaveTextContent('等我確認')
    expect(card).toHaveTextContent('寫成文章')
  })
})
