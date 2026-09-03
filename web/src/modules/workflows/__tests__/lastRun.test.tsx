// 「最近一次」分頁與清單卡：頭一行的時間與花費、一步一行的狀態與產出第一行、WS 更新；清單卡的參與者鏈與「上次」
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../../../i18n'
import { setFetchImpl, setToken } from '../../../api/client'
import { MOCK_TOKEN, mockFetch, resetMockState } from '../../../mock/fetch'
import { MockWebSocket } from '../../../mock/MockWebSocket'
import { WorkflowsPage } from '../../../pages/WorkflowsPage'
import { setEngineerMode } from '../../../prefs/engineerMode'
import { EditorPage } from '../EditorPage'
import { en, zhTW } from '../i18n'
import { setWorkflowWebSocketImpl } from '../socket'
import { describeCron, durationText, firstLine, shortTime } from '../time'

i18n.addResourceBundle('zh-TW', 'translation', zhTW, true, true)
i18n.addResourceBundle('en', 'translation', en, true, true)

type Call = { method: string; path: string; body: unknown }
let calls: Call[] = []
let overrides: Record<string, (c: Call) => unknown> = {}
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  resetMockState()
  calls = []
  overrides = {}
  localStorage.clear()
  setEngineerMode(false)
  MockWebSocket.instances.length = 0
  setWorkflowWebSocketImpl(MockWebSocket as unknown as typeof WebSocket)
  setToken(MOCK_TOKEN)
  setFetchImpl(((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    const c: Call = { method: (init.method ?? 'GET').toUpperCase(), path: new URL(url, 'http://localhost').pathname.replace(/^\/api/, ''), body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const key = `${c.method} ${c.path}`
    if (overrides[key]) return Promise.resolve(ok(overrides[key](c)))
    return mockFetch(input, init)
  }) as unknown as typeof fetch)
})

const mount = (route: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/workflows" element={<WorkflowsPage />} />
          <Route path="/workflows/:id" element={<EditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

describe('時間講成人話', () => {
  it('shortTime／durationText／describeCron／firstLine', () => {
    const now = new Date(2026, 8, 2, 12, 0, 0)
    expect(shortTime(new Date(2026, 8, 2, 8, 0).toISOString(), now)).toBe('今天 08:00')
    expect(shortTime(new Date(2026, 8, 3, 8, 0).toISOString(), now)).toBe('明天 08:00')
    expect(shortTime(new Date(2026, 8, 1, 21, 30).toISOString(), now)).toBe('昨天 21:30')
    expect(shortTime(new Date(2026, 7, 31, 9, 0).toISOString(), now)).toBe('週一 09:00')
    expect(shortTime(new Date(2026, 6, 1, 9, 0).toISOString(), now)).toBe('7/1 09:00')
    expect(durationText('2026-09-02T00:00:00Z', '2026-09-02T00:00:40Z')).toBe('40 秒')
    expect(durationText('2026-09-02T00:00:00Z', '2026-09-02T00:03:10Z')).toBe('3 分鐘')
    expect(durationText('2026-09-02T00:00:00Z', '2026-09-02T01:05:00Z')).toBe('1 小時 5 分')
    expect(durationText(undefined, '2026-09-02T00:00:00Z')).toBeNull()
    expect(describeCron('0 8 * * *')).toBe('每天 08:00')
    expect(describeCron('30 9 * * 1-5')).toBe('週一到週五 09:30')
    expect(describeCron('0 7 * * 1,4')).toBe('每週一、週四 07:00')
    expect(describeCron('*/5 * * * *')).toBe('*/5 * * * *')
    expect(firstLine('\n\n  一、PPWR 新規\n二、其他', 80)).toBe('一、PPWR 新規')
    expect(firstLine('x'.repeat(100), 80)).toHaveLength(81)
  })
})

describe('最近一次', () => {
  it('頭一行：今天 08:00 開始 · 08:04 完成 · $0.41；一步一行：誰、做什麼、花多久、產出第一行、你選了、已送出', async () => {
    mount('/workflows/w1')
    const head = await screen.findByTestId('last-run-header')
    expect(head).toHaveTextContent('今天 08:00 開始')
    expect(head).toHaveTextContent('08:04 完成')
    expect(within(head).getByTestId('last-run-cost')).toHaveTextContent('$0.41')
    const r1 = screen.getByTestId('last-row-n1')
    expect(r1).toHaveTextContent('①')
    expect(r1).toHaveTextContent('研究員')
    expect(r1).toHaveTextContent('找出今天三個熱點')
    expect(within(r1).getByTestId('last-status-n1')).toHaveTextContent('✓ 3 分鐘')
    expect(within(r1).getByTestId('last-output-n1')).toHaveTextContent('「一、PPWR 授權代表新規')
    expect(within(r1).getByTestId('last-output-n1')).not.toHaveTextContent('二、')
    const r2 = screen.getByTestId('last-row-n2')
    expect(r2).toHaveTextContent('你')
    expect(within(r2).getByTestId('last-status-n2')).toHaveTextContent('你選了：可以（08:02）')
    expect(within(screen.getByTestId('last-status-n3')).getByText(/✓ 2 分鐘/)).toBeInTheDocument()
    const r4 = screen.getByTestId('last-row-n4')
    expect(r4).toHaveTextContent('送到 LINE · 行銷組')
    expect(within(r4).getByTestId('last-status-n4')).toHaveTextContent('✓ 已送出')
    // 看完整產出：把右欄的內容攤在底下
    await userEvent.setup().click(screen.getByTestId('last-run-full-output'))
    expect(await screen.findByTestId('last-run-output')).toBeInTheDocument()
    expect(screen.getByTestId('last-run-history-toggle')).toHaveTextContent('只跑過這一次')
  })

  it('失敗那一行標 ⚠ 錯誤第一行；之前跑過的 N 次可以切換載入', async () => {
    const user = userEvent.setup()
    const base = { workflow_id: 'w1', workflow_name: '線', trigger: 'manual', usage: {}, error: '', created_by: 'm1', parent_run_id: '' }
    overrides['GET /workflows/w1/runs'] = () => [
      { ...base, id: 'wr_2', status: 'failed', error: 'LINE 投遞失敗：channel 未設定', created_at: '2026-09-02T01:00:00Z', usage: { cost_usd: 0.2 } },
      { ...base, id: 'wr_1', status: 'completed', created_at: '2026-09-01T01:00:00Z', usage: { cost_usd: 0.41 } },
    ]
    const nodes = [
      { id: 'n1', kind: 'hermes', title: '找熱點', agent_id: 'a2', prompt: '找出今天三個熱點' },
      { id: 'n2', kind: 'delivery', title: '送到 LINE', channel: 'line', to: '行銷組' },
    ]
    const edges = [{ source: 'n1', target: 'n2' }]
    overrides['GET /workflow-runs/wr_2'] = () => ({ ...base, id: 'wr_2', status: 'failed', error: 'n2: LINE 投遞失敗', created_at: '2026-09-02T01:00:00Z', started_at: '2026-09-02T01:00:00Z', finished_at: '2026-09-02T01:01:00Z', usage: { cost_usd: 0.2 }, snapshot: { nodes, edges }, events: [], edge_decisions: {}, input: {}, approvals: [],
      node_states: { n1: { status: 'completed', output: '三個熱點' }, n2: { status: 'failed', error: 'LINE 投遞失敗：channel 未設定\n詳細堆疊…' } } })
    overrides['GET /workflow-runs/wr_1'] = () => ({ ...base, id: 'wr_1', status: 'completed', created_at: '2026-09-01T01:00:00Z', started_at: '2026-09-01T01:00:00Z', finished_at: '2026-09-01T01:02:00Z', usage: { cost_usd: 0.41 }, snapshot: { nodes, edges }, events: [], edge_decisions: {}, input: {}, approvals: [],
      node_states: { n1: { status: 'completed', output: '三個熱點' }, n2: { status: 'completed', delivery: { channel: 'line' } } } })
    mount('/workflows/w1')
    const view = await screen.findByTestId('last-run-view')
    expect(view).toHaveAttribute('data-run', 'wr_2')
    expect(within(screen.getByTestId('last-status-n4')).getByText(/還沒到/)).toBeInTheDocument() // w1 的第 4 步這次沒跑到
    // 失敗的是這次快照裡的 n2；流程現在的 n2 是「等我看」，狀態照 node_states 顯示
    expect(within(screen.getByTestId('last-status-n2')).getByText(/⚠ LINE 投遞失敗：channel 未設定/)).toBeInTheDocument()
    expect(screen.getByTestId('last-status-n2')).not.toHaveTextContent('詳細堆疊')
    await user.click(screen.getByTestId('last-run-history-toggle'))
    expect(screen.getByTestId('last-run-history-toggle')).toHaveTextContent('之前跑過的 2 次')
    const hist = screen.getByTestId('last-run-history')
    expect(within(hist).getByTestId('last-run-pick-wr_2')).toHaveTextContent('現在看的')
    await user.click(within(hist).getByTestId('last-run-pick-wr_1'))
    await waitFor(() => expect(screen.getByTestId('last-run-view')).toHaveAttribute('data-run', 'wr_1'))
    expect(within(screen.getByTestId('last-run-header')).getByTestId('last-run-cost')).toHaveTextContent('$0.41')
    expect(within(screen.getByTestId('last-status-n2')).getByText(/✓/)).toBeInTheDocument()
  }, 15_000)

  it('跑到一半：WS 事件即時更新那一行', async () => {
    mount('/workflows/w1')
    await screen.findByTestId('last-run-view')
    const sock = MockWebSocket.instances.at(-1)!
    await act(async () => {
      sock.emit({ type: 'run.status', run_id: 'wr1', status: 'running' } as never)
      sock.emit({ type: 'node.status', run_id: 'wr1', node_id: 'n3', status: 'running' } as never)
      sock.emit({ type: 'node.delta', run_id: 'wr1', node_id: 'n3', delta: '正在寫貼文' } as never)
    })
    expect(screen.getByTestId('last-run-header')).toHaveTextContent('還在跑')
    expect(screen.getByTestId('last-status-n3')).toHaveTextContent('進行中')
    expect(screen.getByTestId('last-output-n3')).toHaveTextContent('正在寫貼文')
    await act(async () => {
      sock.emit({ type: 'node.status', run_id: 'wr1', node_id: 'n3', status: 'failed', error: 'model 逾時\n堆疊' } as never)
      sock.emit({ type: 'run.status', run_id: 'wr1', status: 'failed', error: 'n3: model 逾時' } as never)
    })
    expect(screen.getByTestId('last-status-n3')).toHaveTextContent('⚠ model 逾時')
    expect(screen.getByTestId('last-run-header')).toHaveTextContent('失敗')
  })

  it('沒跑過的流程：空狀態＋「現在跑一次」，跑起來切到最近一次', async () => {
    const user = userEvent.setup()
    overrides['GET /workflows/w1/runs'] = () => []
    mount('/workflows/w1')
    // 沒跑過 → 預設在「怎麼跑」
    expect(await screen.findByTestId('stations-view')).toBeInTheDocument()
    await user.click(screen.getByTestId('tab-last'))
    expect(await screen.findByTestId('last-run-empty')).toHaveTextContent('還沒跑過')
    await user.click(screen.getByTestId('wf-run'))
    expect(await screen.findByTestId('last-run-view')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/workflows/w1/run')).toBe(true)
    expect(screen.getByTestId('last-status-n1')).toHaveTextContent('還沒到')
  })
})

describe('清單卡', () => {
  it('每張卡：名字、參與者鏈、上次（時間＋狀態＋花費）、下次、跑一次／打開；沒有「等你確認」按鈕', async () => {
    const user = userEvent.setup()
    mount('/workflows')
    const card = await screen.findByTestId('wf-card-w1')
    expect(card).toHaveTextContent('每日熱點內容產線')
    expect(await within(card).findByTestId('wf-card-w1-chain')).toHaveTextContent('研究員 → 你 → 小編 → LINE')
    await within(card).findByText(/✓ 完成/)
    expect(within(card).getByTestId('wf-card-w1-last')).toHaveTextContent('上次：今天 08:00 ✓ 完成（花 $0.41）')
    expect(within(card).getByTestId('wf-card-w1-next')).toHaveTextContent('下次：明天 08:00')
    expect(within(card).getByTestId('wf-card-w1-open')).toHaveAttribute('href', '/workflows/w1')
    // 舊清單頁頂端的「等你確認」按鈕已拿掉；卡片上的「上次：… 等你看」連到那條流程是正常的，只擋整顆按鈕
    expect(screen.queryByRole('link', { name: /^等你確認$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^等你確認$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /匯入 JSON/ })).toBeNull()
    // ⋯ 收著匯入／勾選刪除／工作區篩選
    await user.click(screen.getByTestId('wf-list-more'))
    const menu = screen.getByTestId('wf-list-more-menu')
    expect(within(menu).getByTestId('menu-import')).toHaveTextContent('匯入 JSON')
    expect(within(menu).getByTestId('menu-select')).toHaveTextContent('勾選並刪除')
    expect(within(menu).getByLabelText('工作區（profile）')).toBeInTheDocument()
    await user.click(within(menu).getByTestId('menu-select'))
    expect(screen.getByTestId('batch-delete')).toBeDisabled()
    await user.click(within(screen.getByTestId('wf-card-w1')).getByLabelText('select 每日熱點內容產線'))
    expect(screen.getByTestId('batch-delete')).toHaveTextContent('（1）')
    // 跑一次：打 POST 後進流程頁
    await user.click(within(screen.getByTestId('wf-card-w1')).getByTestId('wf-card-w1-run'))
    expect(await screen.findByTestId('wf-topbar')).toBeInTheDocument()
    expect(calls.some((c) => c.method === 'POST' && c.path === '/workflows/w1/run')).toBe(true)
  }, 15_000)

  it('上次失敗：標 ⚠ 失敗（第 N 步：錯誤第一行）', async () => {
    const base = { workflow_id: 'w1', workflow_name: '線', trigger: 'cron', usage: {}, error: 'n4: LINE 投遞失敗', created_by: 'm1', parent_run_id: '' }
    overrides['GET /workflows/w1/runs'] = () => [{ ...base, id: 'wr_9', status: 'failed', created_at: '2026-09-02T01:00:00Z', finished_at: '2026-09-02T01:01:00Z' }]
    overrides['GET /workflow-runs/wr_9'] = () => ({ ...base, id: 'wr_9', status: 'failed', created_at: '2026-09-02T01:00:00Z', snapshot: { nodes: [
      { id: 'n1', kind: 'hermes', title: '找熱點', agent_id: 'a2', prompt: 'x' }, { id: 'n2', kind: 'gate', title: '等我看' }, { id: 'n3', kind: 'hermes', title: '寫貼文', agent_id: 'a1', prompt: 'y' }, { id: 'n4', kind: 'delivery', title: '送到 LINE', channel: 'line', to: '行銷組' },
    ], edges: [{ source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' }, { source: 'n3', target: 'n4' }] }, events: [], edge_decisions: {}, input: {}, approvals: [],
      node_states: { n1: { status: 'completed' }, n2: { status: 'completed' }, n3: { status: 'completed' }, n4: { status: 'failed', error: 'LINE 投遞失敗：channel 未設定\n堆疊' } } })
    mount('/workflows')
    const card = await screen.findByTestId('wf-card-w1')
    await within(card).findByText(/第 4 步/)
    expect(within(card).getByTestId('wf-card-w1-last')).toHaveTextContent('⚠ 失敗（第 4 步：LINE 投遞失敗：channel 未設定）')
  })
})
