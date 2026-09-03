// 流程頁：跑過就落在「最近一次」、「怎麼跑」是一步一行、頂欄只剩 4 個控制項、改東西自動存、⋯ 只有工程師才有畫布
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../../../i18n'
import { setFetchImpl, setToken } from '../../../api/client'
import { MOCK_TOKEN, mockFetch, resetMockState, state } from '../../../mock/fetch'
import { MockWebSocket } from '../../../mock/MockWebSocket'
import { setEngineerMode } from '../../../prefs/engineerMode'
import { EditorPage } from '../EditorPage'
import { en, zhTW } from '../i18n'
import { setWorkflowWebSocketImpl } from '../socket'

i18n.addResourceBundle('zh-TW', 'translation', zhTW, true, true)
i18n.addResourceBundle('en', 'translation', en, true, true)

let calls: { method: string; path: string; body: unknown }[] = []
beforeEach(() => {
  resetMockState()
  calls = []
  localStorage.clear()
  setEngineerMode(false)
  setWorkflowWebSocketImpl(MockWebSocket as unknown as typeof WebSocket)
  setToken(MOCK_TOKEN)
  setFetchImpl(((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ method: (init.method ?? 'GET').toUpperCase(), path: new URL(url, 'http://localhost').pathname.replace(/^\/api/, ''), body: init.body ? JSON.parse(String(init.body)) : undefined })
    return mockFetch(input, init)
  }) as unknown as typeof fetch)
})

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/workflows/w1']}>
        <Routes><Route path="/workflows/:id" element={<EditorPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

const patches = () => calls.filter((c) => c.method === 'PATCH' && c.path === '/workflows/w1')

describe('EditorPage：兩個分頁', () => {
  it('跑過的流程一進來是「最近一次」；「怎麼跑」才是一步一行，而且不是畫布', async () => {
    const user = userEvent.setup()
    mount()
    expect(await screen.findByTestId('last-run-view')).toBeInTheDocument()
    expect(screen.getByTestId('tab-last')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('stations-view')).toBeNull()
    await user.click(screen.getByTestId('tab-how'))
    expect(await screen.findByTestId('stations-view')).toBeInTheDocument()
    expect(screen.queryByTestId('canvas-toolbar')).toBeNull()
    expect(screen.getByTestId('station-n1-summary')).toHaveTextContent('研究員 · 找出今天三個熱點')
    // 底部那一行：什麼時候跑／最多花多少
    const bar = screen.getByTestId('flow-settings-bar')
    await waitFor(() => expect(within(bar).getByTestId('bar-when')).toHaveTextContent('每天 08:00'))
    expect(within(bar).getByTestId('bar-budget')).toHaveTextContent('$1')
    await user.click(within(bar).getByTestId('bar-when'))
    expect(within(screen.getByTestId('bar-when-panel')).getByTestId('schedule-sc1')).toHaveTextContent('每天 08:00')
    await user.click(within(bar).getByTestId('bar-budget'))
    expect(within(screen.getByTestId('bar-budget-panel')).getByLabelText('成本上限（USD）')).toHaveValue(1)
  })

  it('localStorage 記的是畫布，但工程師模式關著就強制回流程視圖', async () => {
    localStorage.setItem('mhc.wf.view', 'canvas')
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByTestId('tab-how'))
    expect(await screen.findByTestId('stations-view')).toBeInTheDocument()
    expect(screen.queryByTestId('canvas-toolbar')).toBeNull()
  })

  it('頂欄只剩：回清單、名稱、已儲存、⋯、跑一次（沒有儲存鈕、沒有一排加節點鈕）', async () => {
    mount()
    const bar = await screen.findByTestId('wf-topbar')
    expect(within(bar).getByLabelText('名稱')).toBeInTheDocument()
    expect(within(bar).getByTestId('save-state')).toHaveTextContent('已儲存')
    expect(within(bar).getByTestId('wf-more')).toBeInTheDocument()
    expect(within(bar).getByTestId('wf-run')).toHaveTextContent('跑一次')
    expect(within(bar).queryByRole('button', { name: /^儲存$|^執行$/ })).toBeNull()
    expect(within(bar).queryByRole('button', { name: /自動排版|縮放至全圖|匯出 JSON/ })).toBeNull()
    // 主動作只有一顆：頂欄裡只有「跑一次」是 btn-primary
    expect(bar.querySelectorAll('.btn-primary')).toHaveLength(1)
  })

  it('改這一步的名稱不用按儲存：停手約 1 秒自己 PATCH 上去', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByTestId('tab-how'))
    await user.click(await screen.findByTestId('station-n1-row'))
    const title = screen.getByTestId('station-n1-title')
    await user.clear(title)
    await user.type(title, '找題材')
    expect(screen.getByTestId('save-state')).toHaveTextContent('儲存中')
    await waitFor(() => expect(patches().length).toBeGreaterThan(0), { timeout: 4000 })
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('已儲存'), { timeout: 4000 })
    const body = patches().at(-1)!.body as { nodes: { id: string; title: string }[] }
    expect(body.nodes.find((n) => n.id === 'n1')!.title).toBe('找題材')
    expect(state.workflows[0].nodes[0].title).toBe('找題材')
  }, 15_000)

  it('⋯ 平常只有匯出；工程師模式才有畫布／逐步回放／之前跑過的，畫布切得過去也回得來', async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByTestId('last-run-view')
    await user.click(screen.getByTestId('wf-more'))
    let menu = screen.getByTestId('wf-more-menu')
    expect(within(menu).getByText('匯出 JSON')).toBeInTheDocument()
    expect(within(menu).queryByTestId('menu-advanced')).toBeNull()
    expect(within(menu).queryByText('畫布')).toBeNull()
    expect(within(menu).queryByText('逐步回放')).toBeNull()
    expect(within(menu).queryByText('自動排版')).toBeNull()
    await user.keyboard('{Escape}')
    // 開工程師模式
    setEngineerMode(true)
    await user.click(screen.getByTestId('wf-more'))
    menu = await screen.findByTestId('wf-more-menu')
    expect(within(menu).getByTestId('menu-advanced')).toHaveTextContent('畫布')
    expect(within(menu).getByTestId('menu-replay')).toHaveAttribute('href', '/workflows/runs/wr1')
    expect(within(menu).getByTestId('menu-history')).toHaveTextContent('之前跑過的')
    await user.click(within(menu).getByTestId('menu-advanced'))
    expect(await screen.findByTestId('canvas-toolbar')).toBeInTheDocument()
    expect(screen.queryByTestId('stations-view')).toBeNull()
    await user.click(screen.getByTestId('canvas-back'))
    expect(await screen.findByTestId('stations-view')).toBeInTheDocument()
  }, 15_000)
})
