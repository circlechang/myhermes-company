import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../App'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { ENGINEER_KEY } from '../../prefs/engineerMode'
import { renderApp, setupMocks } from '../../test/utils'

describe('今天（/today）', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    localStorage.removeItem(ENGINEER_KEY)
    localStorage.removeItem('mhc.fxrate')
  })

  it('/ 轉到 /today，四張卡都在；側欄「今天」不畫群標題、沒有「收件匣」', async () => {
    renderApp(<App />, { route: '/' })
    expect(await screen.findByTestId('page-title')).toHaveTextContent('今天')
    for (const id of ['today-decide', 'today-problems', 'today-cost', 'today-done']) expect(screen.getByTestId(id)).toBeInTheDocument()
    const sidebar = screen.getByTestId('sidebar')
    const group = within(sidebar).getByTestId('nav-group-today')
    expect(within(group).queryByRole('heading')).not.toBeInTheDocument()
    expect(within(group).getByRole('link', { name: '今天' })).toHaveAttribute('href', '/today')
    expect(within(sidebar).queryByRole('link', { name: '收件匣' })).not.toBeInTheDocument()
  })

  it('/inbox 直接轉到 /today（頂欄 badge 的舊連結還是通）', async () => {
    renderApp(<App />, { route: '/inbox' })
    expect(await screen.findByTestId('page-title')).toHaveTextContent('今天')
    expect(await screen.findByTestId('today-decide')).toBeInTheDocument()
  })

  it('等你決定＝收件匣：種類 chip 只列有數字的、員工顯示名字不是 profile id、時間講人話、核准會 POST 到 it.api.approve', async () => {
    const calls: string[] = []
    setFetchImpl(((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`)
      return mockFetch(input, init)
    }) as typeof fetch)
    renderApp(<App />, { route: '/today' })
    const card = await screen.findByTestId('today-decide')
    expect(await within(card).findByText('選題要不要發：PPWR 授權代表新規')).toBeInTheDocument()
    expect(within(card).getByTestId('today-decide-count')).toHaveTextContent('1')
    // chip：全部 1＋流程等你看 1；其他種類數字是 0 就不畫
    expect(within(card).getByTestId('filter-all')).toHaveTextContent('全部 1')
    expect(within(card).getByTestId('filter-workflow_gate')).toHaveTextContent('流程等你看 1')
    expect(within(card).queryByTestId('filter-chat_approval')).not.toBeInTheDocument()
    // 員工名：researcher → 研究員（老闆模式不露 profile id）
    expect(await within(card).findByTestId('inbox-ib1-staff')).toHaveTextContent('研究員')
    expect(within(card).queryByText('researcher')).not.toBeInTheDocument()
    // 時間：2026-08-29 講人話（一週內「週六 09:30」、同年「8/29」、跨年「2026/08/29」），不是美式帶秒
    const when = within(card).getByTestId('inbox-ib1-when')
    expect(when).toHaveTextContent(/^(週[日一二三四五六] \d\d:\d\d|8\/29|2026\/08\/29)$/)
    expect(when).not.toHaveTextContent(/AM|PM|\d:\d\d:\d\d/)
    expect(within(card).getByTestId('inbox-refresh')).toBeInTheDocument()
    await userEvent.setup().click(within(card).getByRole('button', { name: '可以' }))
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/workflow-approvals/ap1/approve'))).toBe(true))
  })

  it('工程師模式：找不到員工的 profile id 才照原樣顯示', async () => {
    localStorage.setItem(ENGINEER_KEY, '1')
    setFetchImpl(((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.endsWith('/agents') && (init?.method ?? 'GET') === 'GET') return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      return mockFetch(input, init)
    }) as typeof fetch)
    renderApp(<App />, { route: '/today' })
    const card = await screen.findByTestId('today-decide')
    expect(await within(card).findByTestId('inbox-ib1-staff')).toHaveTextContent('researcher')
  })

  it('老闆模式：找不到員工就叫「AI 員工」', async () => {
    setFetchImpl(((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url.endsWith('/agents') && (init?.method ?? 'GET') === 'GET') return Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      return mockFetch(input, init)
    }) as typeof fetch)
    renderApp(<App />, { route: '/today' })
    const card = await screen.findByTestId('today-decide')
    expect(await within(card).findByTestId('inbox-ib1-staff')).toHaveTextContent('AI 員工')
  })

  it('出問題的：失敗的 run 連到流程頁；LINE 錯誤帶「去設定 →」到 /channels；完成的 run 出現在「今天完成了什麼」', async () => {
    renderApp(<App />, { route: '/today' })
    const problems = await screen.findByTestId('today-problems')
    const row = await within(problems).findByTestId('today-run-run1')
    expect(within(row).getByRole('link', { name: '熱點→貼文' })).toHaveAttribute('href', '/workflows/w1')
    expect(row).toHaveTextContent('LINE 投遞失敗')
    expect(within(row).getByTestId('today-run-run1-fix')).toHaveAttribute('href', '/channels')
    expect(within(row).getByTestId('today-run-run1-fix')).toHaveTextContent('去設定 →')
    expect(row).toHaveTextContent(/今天 \d\d:\d\d|\d+ 分鐘前|剛剛/)
    const done = screen.getByTestId('today-done')
    expect(await within(done).findByTestId('today-done-run-run2')).toBeInTheDocument()
    expect(within(done).queryByTestId('today-done-empty')).not.toBeInTheDocument()
  })

  it('今天花了多少：NT$ 大字、本月累計、萬 tokens、花最多的員工、護欄橘字；USD 只在工程師模式', async () => {
    renderApp(<App />, { route: '/today' })
    const cost = await screen.findByTestId('today-cost')
    // 0.62 USD × 32.5 = NT$20；18.83 USD × 32.5 = NT$612
    expect(await within(cost).findByTestId('today-cost-local')).toHaveTextContent('今天 NT$20')
    expect(await within(cost).findByTestId('today-cost-month')).toHaveTextContent('本月累計 NT$612')
    expect(cost).toHaveTextContent('18 萬 tokens')
    expect(cost).not.toHaveTextContent('$0.62')
    expect(within(cost).queryByTestId('today-cost-usd')).not.toBeInTheDocument()
    expect(within(cost).getByText('小編')).toBeInTheDocument()
    expect(await within(cost).findByTestId('today-cost-warn')).toBeInTheDocument()
  })

  it('匯率：點「匯率」展開輸入框，改成 30 後 NT$ 立刻重算並存 localStorage', async () => {
    renderApp(<App />, { route: '/today' })
    const cost = await screen.findByTestId('today-cost')
    await within(cost).findByTestId('today-cost-local')
    const user = userEvent.setup()
    await user.click(within(cost).getByTestId('today-fx-link'))
    const input = within(cost).getByTestId('today-fx-input')
    await user.clear(input)
    await user.type(input, '30{Enter}')
    expect(within(cost).getByTestId('today-cost-local')).toHaveTextContent('今天 NT$19')
    expect(localStorage.getItem('mhc.fxrate')).toBe('30')
  })

  it('工程師模式：NT$ 旁邊多一個美元數字', async () => {
    localStorage.setItem(ENGINEER_KEY, '1')
    renderApp(<App />, { route: '/today' })
    const cost = await screen.findByTestId('today-cost')
    expect(await within(cost).findByTestId('today-cost-usd')).toHaveTextContent('$0.62')
  })

  it('載入中是骨架不是一行字（文字留給讀屏器）', async () => {
    setFetchImpl((() => new Promise<Response>(() => {})) as unknown as typeof fetch)
    renderApp(<App />, { route: '/today' })
    const el = await screen.findAllByTestId('loading')
    expect(el[0]).toHaveAttribute('role', 'status')
    expect(el[0]).toHaveAttribute('aria-label', '載入中…')
    expect(el[0].querySelector('.animate-pulse')).not.toBeNull()
  })
})
