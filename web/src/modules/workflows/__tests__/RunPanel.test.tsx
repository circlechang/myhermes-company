import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import '../../../i18n'
import i18n from 'i18next'
import { setFetchImpl, setToken } from '../../../api/client'
import { MOCK_TOKEN, mockFetch } from '../../../mock/fetch'
import { en, zhTW } from '../i18n'
import { RunPanel } from '../RunPanel'
import { applyWsEvent, emptyRun } from '../runState'
import type { WfNode } from '../types'

// 節點輸出改用共用預覽元件（走 react-query + /preview/inline），所以要有 QueryClient 與 mock fetch
beforeEach(() => {
  setFetchImpl(mockFetch as typeof fetch)
  setToken(MOCK_TOKEN)
})
const render = (ui: ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

i18n.addResourceBundle('zh-TW', 'translation', zhTW, true, true)
i18n.addResourceBundle('en', 'translation', en, true, true)

const nodes: WfNode[] = [
  { id: 'a', kind: 'hermes', title: '熱點', agent_id: 'x', prompt: 'p' },
  { id: 'g', kind: 'gate', title: '閘門' },
  { id: 'b', kind: 'hermes', title: '文案', agent_id: 'x', prompt: 'p' },
]
const handlers = () => ({ onRun: vi.fn(), onStop: vi.fn(), onRerun: vi.fn(), onApprove: vi.fn(), onReject: vi.fn(), onOpenConversation: vi.fn() })

describe('RunPanel', () => {
  it('還沒跑過：顯示跑一次按鈕與提示', async () => {
    const h = handlers()
    render(<RunPanel nodes={nodes} canRun {...h} />)
    expect(screen.getByText('還沒跑過')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /跑一次/ }))
    expect(h.onRun).toHaveBeenCalled()
  })
  it('執行中：節點狀態徽章、串流片段、停止按鈕', () => {
    let live = emptyRun('wr_1', ['a', 'g', 'b'])
    live = applyWsEvent(live, { type: 'run.status', run_id: 'wr_1', status: 'running' })
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'a', status: 'running', attempt: 2 })
    live = applyWsEvent(live, { type: 'node.delta', run_id: 'wr_1', node_id: 'a', delta: '三個熱點…' })
    const h = handlers()
    render(<RunPanel nodes={nodes} canRun live={live} {...h} />)
    const a = screen.getByTestId('run-node-a')
    expect(within(a).getByTestId('status-badge')).toHaveTextContent('進行中')
    expect(within(a).getByText('×2')).toBeInTheDocument()
    expect(within(a).getByText('三個熱點…')).toBeInTheDocument()
    expect(within(screen.getByTestId('run-node-b')).getByTestId('status-badge')).toHaveTextContent('還沒跑')
    expect(screen.getByRole('button', { name: /停止/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /再跑一次/ })).not.toBeInTheDocument()
  })
  it('等你看：顯示上游結果，可以／退回帶意見', async () => {
    let live = emptyRun('wr_1', ['a', 'g', 'b'])
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'a', status: 'completed', output: 'AAA' })
    live = applyWsEvent(live, { type: 'approval.request', run_id: 'wr_1', node_id: 'g', approval_id: 'wa_9', payload: '### 熱點\nAAA' })
    live = applyWsEvent(live, { type: 'run.status', run_id: 'wr_1', status: 'waiting_approval' })
    const h = handlers()
    render(<RunPanel nodes={nodes} canRun live={live} {...h} />)
    const box = screen.getByTestId('approval-g')
    expect(box).toHaveTextContent('AAA')
    await userEvent.type(within(box).getByLabelText(/意見/), '再短一點')
    await userEvent.click(within(box).getByRole('button', { name: '退回' }))
    expect(h.onReject).toHaveBeenCalledWith('wa_9', '再短一點')
    await userEvent.click(within(box).getByRole('button', { name: '可以' }))
    expect(h.onApprove).toHaveBeenCalledWith('wa_9', '再短一點')
  })
  it('結束後：重跑、從節點重跑、展開輸出並開對話', async () => {
    let live = emptyRun('wr_1', ['a', 'g', 'b'])
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'a', status: 'completed', output: '結果A' })
    live.nodes.a.session_id = 's_1'
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'b', status: 'failed', error: 'boom' })
    live = applyWsEvent(live, { type: 'run.status', run_id: 'wr_1', status: 'failed', error: 'b: boom', usage: { total_tokens: 9, cost_usd: 0.5 } })
    const h = handlers()
    render(<RunPanel nodes={nodes} canRun live={live} {...h} />)
    expect(screen.getAllByText('b: boom')[0]).toBeInTheDocument()
    expect(screen.getByText(/9 tok/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /再跑一次/ }))
    expect(h.onRerun).toHaveBeenCalledWith(undefined, false)
    const a = screen.getByTestId('run-node-a')
    await userEvent.click(within(a).getByTitle('從這步再跑'))
    expect(h.onRerun).toHaveBeenCalledWith('a', false)
    await userEvent.click(within(a).getByText('熱點'))
    expect(await within(a).findByText('結果A')).toBeInTheDocument()
    await userEvent.click(within(a).getByRole('button', { name: '開啟對話' }))
    expect(h.onOpenConversation).toHaveBeenCalledWith('s_1')
  })
})

describe('RunPanel harness 借鏡', () => {
  it('溢出輸出顯示「已溢出，查看完整」，自檢輪次與效果快取標示', () => {
    let live = emptyRun('wr_1', ['a', 'g', 'b'])
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'a', status: 'reused', reason: '效果快取：設定與上游輸出未變', output: 'AAA' })
    live = applyWsEvent(live, { type: 'node.done_check', run_id: 'wr_1', node_id: 'b', round: 1, status: 'continue', evidence: '缺結尾' })
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'b', status: 'completed', output: 'head…tail' })
    live.nodes.b.spill = { path: 'runs/wr_1/b.output.md', bytes: 50000, head_bytes: 4096, tail_bytes: 2048 }
    live = applyWsEvent(live, { type: 'run.status', run_id: 'wr_1', status: 'completed' })
    const h = handlers()
    render(<RunPanel nodes={nodes} canRun live={live} {...h} />)
    expect(within(screen.getByTestId('run-node-a')).getByTestId('reused-cache')).toBeInTheDocument()
    expect(within(screen.getByTestId('run-node-b')).getByText('已溢出，查看完整')).toBeInTheDocument()
    expect(within(screen.getByTestId('run-node-b')).getByTestId('done-rounds')).toHaveTextContent('continue')
  })
  it('強制全跑勾選後重跑帶 force', async () => {
    let live = emptyRun('wr_1', ['a', 'g', 'b'])
    live = applyWsEvent(live, { type: 'run.status', run_id: 'wr_1', status: 'needs_attention' })
    live = applyWsEvent(live, { type: 'node.status', run_id: 'wr_1', node_id: 'a', status: 'outcome_unknown' })
    const h = handlers()
    render(<RunPanel nodes={nodes} canRun live={live} {...h} />)
    expect(within(screen.getByTestId('run-node-a')).getByTestId('status-badge')).toHaveTextContent('結果未知')
    await userEvent.click(screen.getByLabelText(/強制全跑/))
    await userEvent.click(screen.getByRole('button', { name: /再跑一次/ }))
    expect(h.onRerun).toHaveBeenCalledWith(undefined, true)
  })
})
