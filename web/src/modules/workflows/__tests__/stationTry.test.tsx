// 卡片就地三件事：試跑這一步、這一步的產出、等你看時就地「可以／退回」（不用離開流程頁）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../../../i18n'
import type { Agent } from '../../../api/types'
import { setFetchImpl, setToken } from '../../../api/client'
import { MOCK_TOKEN, mockFetch, resetMockState } from '../../../mock/fetch'
import { MockWebSocket } from '../../../mock/MockWebSocket'
import { EditorPage } from '../EditorPage'
import { en, zhTW } from '../i18n'
import { applyWsEvent, emptyRun, fromDetail } from '../runState'
import { setWorkflowWebSocketImpl } from '../socket'
import { StationsView } from '../stations'
import { mkEdge, type Graph } from '../stations/stationGraph'
import type { RunDetail, WfNode } from '../types'

i18n.addResourceBundle('zh-TW', 'translation', zhTW, true, true)
i18n.addResourceBundle('en', 'translation', en, true, true)

type Call = { method: string; path: string; body: unknown }
let calls: Call[] = []
/** 攔在 mockFetch 前面：記錄每次呼叫，並讓測試蓋掉特定路徑的回應 */
let overrides: Record<string, (c: Call) => unknown> = {}
/** 最近一次試跑回的 run_id（MockWebSocket 不知道 run，測試要用它來推事件） */
let lastTryRunId = ''
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  resetMockState()
  calls = []
  overrides = {}
  lastTryRunId = ''
  localStorage.clear()
  MockWebSocket.instances.length = 0
  setWorkflowWebSocketImpl(MockWebSocket as unknown as typeof WebSocket)
  setToken(MOCK_TOKEN)
  setFetchImpl((async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    const c: Call = { method: (init.method ?? 'GET').toUpperCase(), path: new URL(url, 'http://localhost').pathname.replace(/^\/api/, ''), body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const key = `${c.method} ${c.path}`
    if (overrides[key]) return ok(overrides[key](c))
    const res = await mockFetch(input, init)
    if (c.method === 'POST' && /\/nodes\/[^/]+\/try$/.test(c.path)) lastTryRunId = ((await res.clone().json()) as { run_id: string }).run_id
    return res
  }) as unknown as typeof fetch)
})

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const render = (ui: ReactElement) => rtlRender(<QueryClientProvider client={qc()}>{ui}</QueryClientProvider>)
const mountEditor = () =>
  rtlRender(
    <QueryClientProvider client={qc()}>
      <MemoryRouter initialEntries={['/workflows/w1']}>
        <Routes><Route path="/workflows/:id" element={<EditorPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

const agents: Agent[] = [{ id: 'a1', name: '小編', title: '內容', profile: 'default', enabled: true }]
const node = (id: string, extra: Partial<WfNode> = {}): WfNode => ({ id, kind: 'hermes', title: id, agent_id: 'a1', prompt: `${id} 的指令`, ...extra })
const graph = (): Graph => ({
  nodes: [node('n1', { title: '找題材' }), { id: 'n2', kind: 'gate', title: '等我看' }, node('n3', { title: '寫成文章' })],
  edges: [mkEdge('n1', 'n2'), mkEdge('n2', 'n3')],
})
const props = (over: Partial<React.ComponentProps<typeof StationsView>> = {}) => ({
  graph: graph(), agents, running: false, busy: false,
  onChange: vi.fn(), onRerun: vi.fn(), onTry: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), onAdvanced: vi.fn(),
  ...over,
})
const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
  id: 'wr_1', workflow_id: 'w1', workflow_name: '線', status: 'completed', trigger: 'manual', usage: {}, error: '', created_by: 'm1', parent_run_id: '',
  created_at: '2026-09-01T00:00:00Z', snapshot: { nodes: graph().nodes, edges: graph().edges }, events: [], edge_decisions: {}, input: {}, approvals: [],
  node_states: { n1: { status: 'completed', output: '三個題材：A、B、C' }, n2: { status: 'pending' }, n3: { status: 'reused', output: '一篇文章' } },
  ...over,
})
const ws = () => MockWebSocket.instances.at(-1)!

describe('這一步的產出（就地）', () => {
  it('展開後，載回來的輸出直接長在「這一步的產出」裡，附狀態籤；試跑鈕在收起的那一行就有', async () => {
    const user = userEvent.setup()
    render(<StationsView {...props({ live: fromDetail(detail()) })} />)
    // 收著：試跑鈕只長在 AI 員工那一步，等我看那一步沒有
    expect(screen.getByTestId('station-n1-try')).toBeInTheDocument()
    expect(screen.queryByTestId('station-n2-try')).toBeNull()
    await user.click(screen.getByTestId('station-n1-row'))
    const block = screen.getByTestId('station-n1-output')
    expect(within(block).getByTestId('station-n1-chip')).toHaveTextContent('完成')
    expect(within(block).getByTestId('station-n1-output-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(within(block).getByTestId('station-n1-result')).toBeInTheDocument()
    expect(await within(block).findByText(/三個題材：A、B、C/)).toBeInTheDocument()
    // 沿用上次／未跑 各有自己的籤
    await user.keyboard('{Shift>}')
    await user.click(screen.getByTestId('station-n3-row'))
    await user.click(screen.getByTestId('station-n2-row'))
    await user.keyboard('{/Shift}')
    expect(screen.getByTestId('station-n3-chip')).toHaveTextContent('沿用上次')
    expect(screen.getByTestId('station-n2-chip')).toHaveTextContent('未跑')
  })

  it('沒跑過也看得到區塊（收合），按展開顯示「還沒有產出」', async () => {
    render(<StationsView {...props()} />)
    await userEvent.click(screen.getByTestId('station-n1-row'))
    const block = screen.getByTestId('station-n1-output')
    expect(within(block).getByTestId('station-n1-output-toggle')).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(within(block).getByTestId('station-n1-output-toggle'))
    expect(block).toHaveTextContent('還沒有產出')
  })

  it('試跑的結果優先顯示、標「試跑」，正式跑的狀態燈不受影響', async () => {
    const live = fromDetail(detail())
    let tr = emptyRun('wr_try_1', ['n1'])
    tr = applyWsEvent(tr, { type: 'node.status', run_id: 'wr_try_1', node_id: 'n1', status: 'running' })
    tr = applyWsEvent(tr, { type: 'node.delta', run_id: 'wr_try_1', node_id: 'n1', delta: '正在想題材' })
    render(<StationsView {...props({ live, tries: { n1: tr } })} />)
    expect(screen.getByTestId('station-n1-try')).toBeDisabled()
    expect(screen.getByTestId('station-n1-try')).toHaveTextContent('試跑中')
    await userEvent.click(screen.getByTestId('station-n1-row'))
    const block = screen.getByTestId('station-n1-output')
    expect(block).toHaveAttribute('data-try', '1')
    expect(within(block).getByTestId('station-n1-chip')).toHaveTextContent('進行中')
    expect(within(block).getByTestId('station-n1-stream')).toHaveTextContent('正在想題材')
    expect(screen.getByTestId('station-n1-status')).toHaveTextContent('完成')
  })

  it('從收起的那一行按試跑，卡片自己展開', async () => {
    const p = props()
    render(<StationsView {...p} />)
    await userEvent.click(screen.getByTestId('station-n1-try'))
    expect(p.onTry).toHaveBeenCalledWith('n1')
    expect(screen.getByTestId('station-n1')).toHaveAttribute('data-expanded', '1')
  })
})

describe('試跑這一步（EditorPage）', () => {
  it('按下去打 POST /workflows/w1/nodes/n1/try，WS 事件依 run_id 流進那一步的產出', async () => {
    const user = userEvent.setup()
    mountEditor()
    // w1 跑過一次 → 預設在「最近一次」；改設定要切到「怎麼跑」
    await user.click(await screen.findByTestId('tab-how'))
    await screen.findByTestId('stations-view')
    await user.click(screen.getByTestId('station-n1-try'))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/workflows/w1/nodes/n1/try')).toBe(true))
    const block = screen.getByTestId('station-n1-output')
    await waitFor(() => expect(screen.getByTestId('station-n1-try')).toBeDisabled())
    expect(within(block).getByTestId('station-n1-chip')).toHaveTextContent('進行中')
    // 拿到 run_id 後，WS 串流用同一個 run_id 推進來
    await waitFor(() => expect(lastTryRunId).not.toBe(''))
    const tryId = lastTryRunId
    const sock = ws()
    await act(async () => {
      sock.emit({ type: 'node.delta', run_id: tryId, node_id: 'n1', delta: '想到三個' } as never)
    })
    expect(within(block).getByTestId('station-n1-stream')).toHaveTextContent('想到三個')
    await act(async () => {
      sock.emit({ type: 'node.status', run_id: tryId, node_id: 'n1', status: 'completed', output: '題材一、二、三' } as never)
      sock.emit({ type: 'run.status', run_id: tryId, status: 'completed' } as never)
    })
    expect(within(block).getByTestId('station-n1-chip')).toHaveTextContent('完成')
    expect(screen.getByTestId('station-n1-try')).toBeEnabled()
    expect(await within(block).findByText(/題材一、二、三/)).toBeInTheDocument()
    // 不相干 run 的事件不會污染這一步
    await act(async () => { sock.emit({ type: 'node.status', run_id: 'wr_other', node_id: 'n1', status: 'failed', error: 'x' } as never) })
    expect(within(block).getByTestId('station-n1-chip')).toHaveTextContent('完成')
  }, 15_000)
})

describe('等你看（就地決定）', () => {
  it('上一次停在等你看：最近一次那一行有「可以／退回」；怎麼跑分頁頂端有「第 2 步等你看」，展開卡片附意見打 approve', async () => {
    const user = userEvent.setup()
    const longPayload = '三個題材：'.padEnd(400, '甲')
    overrides['GET /workflows/w1/runs'] = () => [{ id: 'wr_1', workflow_id: 'w1', status: 'waiting_approval', trigger: 'manual', created_at: '2026-09-01T00:00:00Z' }]
    overrides['GET /workflow-runs/wr_1'] = () => detail({
      status: 'waiting_approval',
      node_states: { n1: { status: 'completed', output: '三個題材' }, n2: { status: 'waiting_approval', approval_id: 'wa_1' }, n3: { status: 'pending' } },
      approvals: [{ id: 'wa_1', run_id: 'wr_1', workflow_id: 'w1', workflow_name: '線', node_id: 'n2', node_title: '等我看', status: 'pending', payload: longPayload, comment: '', decided_by: '', created_at: '2026-09-01T00:00:00Z' }],
    })
    mountEditor()
    // 最近一次：那一行標等你看，按鈕就在行內
    const lastRow = await screen.findByTestId('last-row-n2')
    expect(lastRow).toHaveAttribute('data-status', 'waiting_approval')
    expect(within(lastRow).getByTestId('last-approve-n2')).toHaveTextContent('可以')
    expect(within(lastRow).getByTestId('last-reject-n2')).toHaveTextContent('退回')
    expect(screen.getByTestId('review-pane')).toBeInTheDocument()
    // 怎麼跑：橫幅＋收著的那一行也有按鈕
    await user.click(screen.getByTestId('tab-how'))
    const banner = await screen.findByTestId('editor-waiting-banner')
    expect(banner).toHaveTextContent('第 2 步等你看')
    const card = screen.getByTestId('station-n2')
    card.scrollIntoView = vi.fn()
    await user.click(banner)
    expect(card.scrollIntoView).toHaveBeenCalled()
    expect(within(card).getByTestId('station-n2-inline-approval')).toBeInTheDocument()
    // 右欄的閱讀欄：全文不截斷、有自己的意見框與按鈕；卡片裡只剩一行摘要指向右欄
    const pane = screen.getByTestId('review-pane')
    expect(pane).toHaveAttribute('data-approval-id', 'wa_1')
    await waitFor(() => expect(within(pane).getByTestId('review-body')).toHaveTextContent(longPayload))
    await user.click(screen.getByTestId('station-n2-row'))
    const box = screen.getByTestId('station-n2-approval')
    expect(within(box).getByTestId('station-n2-payload').textContent!.length).toBeLessThan(longPayload.length)
    expect(within(box).getByText(/全文在右欄/)).toBeInTheDocument()
    await user.type(within(pane).getByTestId('review-comment'), '可以')
    await user.click(within(pane).getByTestId('review-approve'))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/workflow-approvals/wa_1/approve' && (c.body as { comment: string }).comment === '可以')).toBe(true))
    // 決定後 WS 推回來：決定區消失、狀態更新、橫幅收掉
    await act(async () => {
      ws().emit({ type: 'approval.decided', run_id: 'wr_1', node_id: 'n2', approval_id: 'wa_1', decision: 'approve' } as never)
      ws().emit({ type: 'node.status', run_id: 'wr_1', node_id: 'n2', status: 'completed', output: '可以' } as never)
    })
    expect(screen.queryByTestId('station-n2-approval')).toBeNull()
    expect(screen.queryByTestId('editor-waiting-banner')).toBeNull()
    expect(screen.queryByTestId('review-pane')).toBeNull()
    expect(screen.getByTestId('station-n2-status')).toHaveTextContent('完成')
  }, 15_000)
})
