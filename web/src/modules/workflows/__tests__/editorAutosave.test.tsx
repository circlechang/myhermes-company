// 編輯頁：預設進生產線視圖、頂欄只剩 4 個控制項、改東西自動存（沒有儲存按鈕）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../../../i18n'
import { setFetchImpl, setToken } from '../../../api/client'
import { MOCK_TOKEN, mockFetch, resetMockState, state } from '../../../mock/fetch'
import { MockWebSocket } from '../../../mock/MockWebSocket'
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

describe('EditorPage：生產線是預設視圖', () => {
  it('一進來就是生產線，不是畫布', async () => {
    mount()
    expect(await screen.findByTestId('stations-view')).toBeInTheDocument()
    expect(screen.queryByTestId('canvas-toolbar')).toBeNull()
    expect(screen.getByTestId('station-n1-title')).toHaveValue('抓熱點')
  })

  it('頂欄只剩：回清單、名稱、已儲存、⋯、執行（沒有儲存鈕、沒有一排加節點鈕）', async () => {
    mount()
    const bar = await screen.findByTestId('wf-topbar')
    expect(within(bar).getByLabelText('名稱')).toBeInTheDocument()
    expect(within(bar).getByTestId('save-state')).toHaveTextContent('已儲存')
    expect(within(bar).getByTestId('wf-more')).toBeInTheDocument()
    expect(within(bar).getByTestId('wf-run')).toHaveTextContent('執行')
    expect(within(bar).queryByRole('button', { name: /^儲存$/ })).toBeNull()
    expect(within(bar).queryByRole('button', { name: /自動排版|縮放至全圖|匯出 JSON/ })).toBeNull()
    // 主動作只有一顆：頂欄裡只有「執行」是 btn-primary
    expect(bar.querySelectorAll('.btn-primary')).toHaveLength(1)
  })

  it('改站名不用按儲存：停手約 1 秒自己 PATCH 上去', async () => {
    const user = userEvent.setup()
    mount()
    const title = await screen.findByTestId('station-n1-title')
    await user.clear(title)
    await user.type(title, '找題材')
    expect(screen.getByTestId('save-state')).toHaveTextContent('儲存中')
    await waitFor(() => expect(patches().length).toBeGreaterThan(0), { timeout: 4000 })
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('已儲存'), { timeout: 4000 })
    const body = patches().at(-1)!.body as { nodes: { id: string; title: string }[] }
    expect(body.nodes.find((n) => n.id === 'n1')!.title).toBe('找題材')
    expect(state.workflows[0].nodes[0].title).toBe('找題材')
  }, 15_000)

  it('⋯ 收著進階檢視／排版／匯出；進階檢視才出現畫布', async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByTestId('stations-view')
    await user.click(screen.getByTestId('wf-more'))
    const menu = screen.getByTestId('wf-more-menu')
    expect(within(menu).getByText('自動排版')).toBeInTheDocument()
    expect(within(menu).getByText('匯出 JSON')).toBeInTheDocument()
    await user.click(within(menu).getByTestId('menu-advanced'))
    expect(await screen.findByTestId('canvas-toolbar')).toBeInTheDocument()
    expect(screen.queryByTestId('stations-view')).toBeNull()
    // 回得去
    await user.click(screen.getByTestId('canvas-back'))
    expect(await screen.findByTestId('stations-view')).toBeInTheDocument()
  }, 15_000)
})
