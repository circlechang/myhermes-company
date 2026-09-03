import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../App'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { renderApp, setupMocks } from '../../test/utils'

describe('今天（/today）', () => {
  beforeEach(() => setupMocks({ loggedIn: true }))

  it('/ 轉到 /today，四張卡都在；側欄「今天」不畫群標題', async () => {
    renderApp(<App />, { route: '/' })
    expect(await screen.findByTestId('page-title')).toHaveTextContent('今天')
    for (const id of ['today-decide', 'today-problems', 'today-cost', 'today-done']) expect(screen.getByTestId(id)).toBeInTheDocument()
    const group = within(screen.getByTestId('sidebar')).getByTestId('nav-group-today')
    expect(within(group).queryByRole('heading')).not.toBeInTheDocument()
    expect(within(group).getByRole('link', { name: '今天' })).toHaveAttribute('href', '/today')
  })

  it('等你決定：列出收件匣項目、標題帶數字，核准會 POST 到 it.api.approve', async () => {
    const calls: string[] = []
    setFetchImpl(((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${typeof input === 'string' ? input : String(input)}`)
      return mockFetch(input, init)
    }) as typeof fetch)
    renderApp(<App />, { route: '/today' })
    const card = await screen.findByTestId('today-decide')
    expect(await within(card).findByText('選題要不要發：PPWR 授權代表新規')).toBeInTheDocument()
    expect(within(card).getByTestId('today-decide-count')).toHaveTextContent('1')
    await userEvent.setup().click(within(card).getByRole('button', { name: '核准' }))
    await waitFor(() => expect(calls.some((c) => c.startsWith('POST') && c.endsWith('/workflow-approvals/ap1/approve'))).toBe(true))
  })

  it('出問題的：失敗的 run 連到執行頁；完成的 run 出現在「今天完成了什麼」', async () => {
    renderApp(<App />, { route: '/today' })
    const problems = await screen.findByTestId('today-problems')
    const row = await within(problems).findByTestId('today-run-run1')
    expect(within(row).getByRole('link', { name: '熱點→貼文' })).toHaveAttribute('href', '/workflows/runs/run1')
    expect(row).toHaveTextContent('LINE 投遞失敗')
    const done = screen.getByTestId('today-done')
    expect(await within(done).findByTestId('today-done-run-run2')).toBeInTheDocument()
    expect(within(done).queryByTestId('today-done-empty')).not.toBeInTheDocument()
  })

  it('今天花了多少：公司金額、花最多的員工、護欄快到頂的橘字', async () => {
    renderApp(<App />, { route: '/today' })
    const cost = await screen.findByTestId('today-cost')
    expect(await within(cost).findByTestId('today-cost-usd')).toHaveTextContent('$0.6200')
    expect(within(cost).getByText('小編')).toBeInTheDocument()
    expect(await within(cost).findByTestId('today-cost-warn')).toBeInTheDocument()
  })
})
