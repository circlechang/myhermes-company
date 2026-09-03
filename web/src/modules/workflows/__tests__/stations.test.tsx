// 「怎麼跑」分頁：一步一行預設收起、點開才編輯、三種動作、插一步、狀態籤、收起也能就地「可以／退回」、範本
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import type { ReactElement } from 'react'
import '../../../i18n'
import type { Agent } from '../../../api/types'
import { setFetchImpl, setToken } from '../../../api/client'
import { MOCK_TOKEN, mockFetch } from '../../../mock/fetch'
import { setEngineerMode } from '../../../prefs/engineerMode'
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
  setEngineerMode(false)
})
const render = (ui: ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

const agents: Agent[] = [
  { id: 'a1', name: '小編', title: '內容', profile: 'default', enabled: true },
  { id: 'a2', name: '阿研', title: '研究', profile: 'research', enabled: true },
  { id: 'a4', name: '工程師', title: '寫程式', profile: '', enabled: true, runtime: 'claude-code', runtime_name: 'Claude Code', workspace: '/repo' },
]
const node = (id: string, extra: Partial<WfNode> = {}): WfNode => ({ id, kind: 'hermes', title: id, agent_id: 'a1', prompt: `${id} 的指令`, ...extra })
const graph = (): Graph => ({
  nodes: [node('n1', { title: '找題材', prompt: '找出今天三個熱點\n每個附來源' }), { id: 'n2', kind: 'gate', title: '等我看' }, node('n3', { title: '寫成文章' })],
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
const lastGraph = (p: ReturnType<typeof props>) => vi.mocked(p.onChange).mock.calls.at(-1)![0] as Graph

describe('一步一行（閱讀模式）', () => {
  it('預設全部收起：一行＝序號 · 誰 · 做什麼（指令第一行），沒有表單', () => {
    render(<StationsView {...props()} />)
    const row = screen.getByTestId('station-n1')
    expect(row).toHaveAttribute('data-expanded', '0')
    expect(within(row).getByTestId('station-n1-seq')).toHaveTextContent('①')
    expect(within(row).getByTestId('station-n1-summary')).toHaveTextContent('小編 · 找出今天三個熱點')
    expect(within(row).getByTestId('station-n1-summary')).not.toHaveTextContent('每個附來源')
    expect(within(row).queryByTestId('station-n1-prompt')).toBeNull()
    expect(within(row).queryByTestId('station-n1-title')).toBeNull()
    // 等我看那一步：「你」；狀態籤都在
    expect(screen.getByTestId('station-n2-summary')).toHaveTextContent('你')
    expect(screen.getByTestId('station-n2-status')).toHaveTextContent('未跑')
    // 步與步之間只剩線＋插一步，沒有「帶著：文字輸出」
    expect(screen.getByTestId('link-after-n1')).not.toHaveTextContent('帶著')
  })

  it('點那一行才展開表單，只有「誰做／做什麼」；一次只開一張，shift 可以多開', async () => {
    const user = userEvent.setup()
    render(<StationsView {...props()} />)
    await user.click(screen.getByTestId('station-n1-row'))
    const card = screen.getByTestId('station-n1')
    expect(card).toHaveAttribute('data-expanded', '1')
    expect(within(card).getByTestId('station-n1-title')).toHaveValue('找題材')
    expect(within(card).getByTestId('station-n1-agent')).toHaveValue('a1')
    expect(within(card).getByTestId('station-n1-prompt')).toHaveValue('找出今天三個熱點\n每個附來源')
    // 工程師模式關著：完成條件、產出、模型這些都不出現
    expect(within(card).queryByTestId('station-n1-done')).toBeNull()
    expect(within(card).queryByTestId('station-n1-engineer')).toBeNull()
    // 手風琴：點第三步，第一步收起
    await user.click(screen.getByTestId('station-n3-row'))
    expect(screen.getByTestId('station-n1')).toHaveAttribute('data-expanded', '0')
    expect(screen.getByTestId('station-n3')).toHaveAttribute('data-expanded', '1')
    // shift 點：兩張都開
    await user.keyboard('{Shift>}')
    await user.click(screen.getByTestId('station-n1-row'))
    await user.keyboard('{/Shift}')
    expect(screen.getByTestId('station-n1')).toHaveAttribute('data-expanded', '1')
    expect(screen.getByTestId('station-n3')).toHaveAttribute('data-expanded', '1')
    // 再點一次就收起
    await user.click(screen.getByTestId('station-n1-row'))
    expect(screen.getByTestId('station-n1')).toHaveAttribute('data-expanded', '0')
  })

  it('等我看那一步展開後只有名稱可改，還有一句白話', async () => {
    render(<StationsView {...props()} />)
    await userEvent.click(screen.getByTestId('station-n2-row'))
    const card = screen.getByTestId('station-n2')
    expect(within(card).getByTestId('station-n2-title')).toHaveValue('等我看')
    expect(within(card).queryByTestId('station-n2-prompt')).toBeNull()
    expect(within(card).queryByTestId('station-n2-agent')).toBeNull()
    expect(card).toHaveTextContent('停在這裡等你看')
  })

  it('工程師模式開了才有「工程師選項」：做完自己檢查、產出、模型等收在裡面', async () => {
    setEngineerMode(true)
    render(<StationsView {...props()} />)
    await userEvent.click(screen.getByTestId('station-n1-row'))
    const eng = screen.getByTestId('station-n1-engineer')
    expect(eng).toHaveTextContent('工程師選項')
    expect(within(eng).getByTestId('station-n1-produces')).toHaveTextContent('文字輸出')
    expect(within(eng).getByLabelText('做完自己檢查，沒過就重跑')).toBeInTheDocument()
    expect(within(eng).getByLabelText(/模型/)).toBeInTheDocument()
  })

  it('介面上不出現 node／edge／gate／閘門／工作流／站 這類字', () => {
    const { container } = render(<StationsView {...props()} />)
    const text = container.textContent ?? ''
    for (const bad of ['閘門', '節點', 'DAG', '工作流', '審批', '核准']) expect(text, bad).not.toContain(bad)
  })
})

describe('編輯', () => {
  it('改指令就吐出新的圖（自動存由外層接手，不放儲存按鈕）', async () => {
    const p = props()
    render(<StationsView {...p} />)
    expect(screen.queryByRole('button', { name: /^儲存$/ })).toBeNull()
    await userEvent.click(screen.getByTestId('station-n3-row'))
    await userEvent.type(screen.getByTestId('station-n3-prompt'), '!')
    expect(p.onChange).toHaveBeenCalled()
    expect(lastGraph(p).nodes.find((x) => x.id === 'n3')!.prompt).toBe('n3 的指令!')
  })

  it('換 AI 員工會一起帶上 profile', async () => {
    const p = props()
    render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('station-n1-row'))
    await userEvent.selectOptions(screen.getByTestId('station-n1-agent'), 'a2')
    expect(lastGraph(p).nodes.find((x) => x.id === 'n1')).toMatchObject({ agent_id: 'a2', profile: 'research', kind: 'hermes' })
  })

  it('挑到會寫程式的員工，這一步自動變成「跑程式」（tool 跟著 runtime）；挑回 Hermes 員工就變回來', async () => {
    const p = props()
    const { rerender } = render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('station-n1-row'))
    await userEvent.selectOptions(screen.getByTestId('station-n1-agent'), 'a4')
    const g1 = lastGraph(p)
    expect(g1.nodes.find((x) => x.id === 'n1')).toMatchObject({ agent_id: 'a4', kind: 'coding-agent', tool: 'claude-code', cwd: '/repo' })
    // 用新的圖重畫：那一行的「誰」是工程師，下拉還在，再挑回小編
    rerender(<QueryClientProvider client={new QueryClient()}><StationsView {...p} graph={g1} /></QueryClientProvider>)
    expect(screen.getByTestId('station-n1-summary')).toHaveTextContent('工程師')
    await userEvent.selectOptions(screen.getByTestId('station-n1-agent'), 'a1')
    const g2 = lastGraph(p)
    expect(g2.nodes.find((x) => x.id === 'n1')).toMatchObject({ agent_id: 'a1', kind: 'hermes' })
    expect(g2.nodes.find((x) => x.id === 'n1')!.tool).toBeUndefined()
  })
})

describe('加一步：只有三種動作', () => {
  it('選單只有 請員工做／等我看／送出去 三項；工程師模式才多出分岔與迴圈', async () => {
    const p = props()
    const { unmount } = render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('add-station'))
    const menu = screen.getByTestId('add-station-menu')
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(3)
    expect(within(menu).getByText('請員工做')).toBeInTheDocument()
    expect(within(menu).getByText('等我看')).toBeInTheDocument()
    expect(within(menu).getByText('送出去')).toBeInTheDocument()
    expect(within(menu).queryByText('看情況分岔')).toBeNull()
    expect(within(menu).queryByText(/跑程式/)).toBeNull()
    unmount()
    setEngineerMode(true)
    render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('add-station'))
    const menu2 = screen.getByTestId('add-station-menu')
    expect(within(menu2).getAllByRole('menuitem')).toHaveLength(5)
    expect(within(menu2).getByText('看情況分岔')).toBeInTheDocument()
    expect(within(menu2).getByText('重複直到⋯')).toBeInTheDocument()
  })

  it('在兩步之間插一步：新的那一步直接展開', async () => {
    const p = props()
    render(<StationsView {...p} />)
    await userEvent.click(within(screen.getByTestId('link-after-n1')).getByRole('button', { name: /插一步/ }))
    expect(within(screen.getByTestId('insert-after-n1-menu')).getByText(/停在這裡等你看/)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('insert-after-n1-hermes'))
    const g = lastGraph(p)
    expect(g.nodes).toHaveLength(4)
    expect(g.edges.some((e) => e.source === 'n1' && e.target === 'n2')).toBe(false)
  })

  it('底部「＋ 加一步」接在最後面', async () => {
    const p = props()
    render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('add-station'))
    await userEvent.click(screen.getByTestId('add-station-delivery'))
    const g = lastGraph(p)
    expect(g.nodes).toHaveLength(4)
    expect(g.edges.some((e) => e.source === 'n3')).toBe(true)
  })

  it('沒有步驟時給空狀態與「加第一步」', () => {
    render(<StationsView {...props({ graph: { nodes: [], edges: [] } })} />)
    expect(screen.getByTestId('empty-stations')).toHaveTextContent('這條流程還沒有步驟')
    expect(screen.getByTestId('add-first-station')).toBeInTheDocument()
  })
})

describe('跑的時候', () => {
  it('狀態籤即時變：完成／等你看／未跑；等你看的那張浮起來', () => {
    let live = emptyRun('wr_1', ['n1', 'n2', 'n3'])
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'n1', status: 'completed', output: '三個題材' })
    live = applyWsEvent(live, { type: 'approval.request', run_id: 'wr_1', node_id: 'n2', approval_id: 'wa_1', payload: '三個題材' })
    render(<StationsView {...props({ live, running: true })} />)
    expect(screen.getByTestId('station-n1')).toHaveAttribute('data-light', 'completed')
    expect(screen.getByTestId('station-n1-status')).toHaveTextContent('完成')
    expect(screen.getByTestId('station-n2')).toHaveAttribute('data-light', 'waiting_approval')
    expect(screen.getByTestId('station-n2-status')).toHaveTextContent('等你看')
    expect(screen.getByTestId('station-n3')).toHaveAttribute('data-light', 'pending')
    expect(screen.getByTestId('station-n3-status')).toHaveTextContent('未跑')
  })

  it('等你看的那一步收著也能直接按「可以／退回」；展開後才有意見欄', async () => {
    let live = emptyRun('wr_1', ['n1', 'n2', 'n3'])
    live = applyWsEvent(live, { type: 'approval.request', run_id: 'wr_1', node_id: 'n2', approval_id: 'wa_1', payload: '上一步的結果' })
    const p = props({ live, running: true })
    render(<StationsView {...p} />)
    const inline = screen.getByTestId('station-n2-inline-approval')
    await userEvent.click(within(inline).getByTestId('station-n2-approve'))
    expect(p.onApprove).toHaveBeenCalledWith('wa_1', '')
    // 按鈕不會把卡片展開
    expect(screen.getByTestId('station-n2')).toHaveAttribute('data-expanded', '0')
    await userEvent.click(screen.getByTestId('station-n2-row'))
    const box = screen.getByTestId('station-n2-approval')
    expect(screen.queryByTestId('station-n2-inline-approval')).toBeNull()
    await userEvent.type(within(box).getByLabelText(/意見/), '再短一點')
    await userEvent.click(within(box).getByTestId('station-n2-reject'))
    expect(p.onReject).toHaveBeenCalledWith('wa_1', '再短一點')
  })

  it('跑完展開可以「從這步再跑」', async () => {
    let live = emptyRun('wr_1', ['n1', 'n2', 'n3'])
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'n1', status: 'completed', output: 'x' })
    live = applyWsEvent(live, { type: 'run.status', run_id: 'wr_1', status: 'completed' })
    const p = props({ live, running: false })
    render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('station-n1-row'))
    const btn = screen.getByTestId('station-n1-rerun')
    expect(btn).toHaveTextContent('從這步再跑')
    await userEvent.click(btn)
    expect(p.onRerun).toHaveBeenCalledWith('n1')
  })

  it('直線可以拖曳排序；有分支就鎖住並指去畫布', async () => {
    render(<StationsView {...props()} />)
    expect(screen.getByTestId('station-n1-drag')).toHaveAttribute('title', '拖曳排序')

    const branchy: Graph = {
      nodes: [node('n1'), { id: 'q', kind: 'condition', title: '看情況分岔', mode: 'rule', rule: { op: 'contains', value: 'x' } }, node('y'), node('z')],
      edges: [mkEdge('n1', 'q'), mkEdge('q', 'y', 'true'), mkEdge('q', 'z', 'false')],
    }
    const p = props({ graph: branchy })
    rtlRender(<QueryClientProvider client={new QueryClient()}><StationsView {...p} /></QueryClientProvider>)
    const drag = screen.getAllByTestId('station-n1-drag').at(-1)!
    expect(drag).toHaveAttribute('title', expect.stringContaining('畫布'))
    await userEvent.click(screen.getByTestId('station-q-row'))
    expect(screen.getByTestId('station-q-branch')).toHaveTextContent('這步有分支')
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
    await userEvent.type(screen.getByLabelText('這條流程叫什麼'), '週報線')
    await userEvent.click(screen.getByTestId('template-create'))
    expect(onCreate).toHaveBeenCalledWith('research', '週報線')
  })
  it('範本卡上看得到流程有哪幾步', () => {
    render(<TemplatePicker onCreate={vi.fn()} onCancel={vi.fn()} />)
    const card = screen.getByTestId('template-content')
    expect(card).toHaveTextContent('找題材')
    expect(card).toHaveTextContent('等我看')
    expect(card).toHaveTextContent('寫成文章')
  })
})
