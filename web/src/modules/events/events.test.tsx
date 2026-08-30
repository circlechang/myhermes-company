import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { renderApp, setupMocks } from '../../test/utils'
import '../registry' // 註冊模組 i18n
import { EventsPage } from './index'
import { SearchPage } from './search'

const okJ = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const calls: string[] = []
const ev = (id: string, seq: number, kind: string, causes: string[] = []) => ({
  id, seq, ts: '2026-08-29T01:00:00', kind, source: 'workflow', subject: `run:${id}`, agent: '', member_id: '', company_id: 'c1',
  payload: { workflow_name: '每週貼文' }, decision: '', delivery: '', causes,
})
const E1 = ev('ev_1', 1, 'workflow.run.started')
const E2 = ev('ev_2', 2, 'approval.requested', ['ev_1'])
const E3 = ev('ev_3', 3, 'approval.decided', ['ev_2'])

async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const u = new URL(url, 'http://localhost')
  const path = decodeURIComponent(u.pathname).replace(/^\/api/, '')
  calls.push(path + u.search)
  if (path === '/search') {
    const q = u.searchParams.get('q')
    const scope = u.searchParams.get('scope') ?? 'all'
    if (q !== '文案') return okJ({ items: [], total: 0, q, scopes: [scope] })
    const items = [
      { scope: 'chat', ref: 'msg_1', company_id: 'c1', agent: 'default', member_id: 'm1', ts: '2026-08-29T01:00:00', title: '貼文討論', snippet: '幫我寫一段文案給新品', score: 1.2, link: '/?session=s1&message=msg_1', meta: {} },
      { scope: 'events', ref: 'ev_9', company_id: 'c1', agent: '', member_id: '', ts: '2026-08-29T02:00:00', title: 'workflow.run', snippet: '每週貼文：熱點 → 閘門 → 文案', score: 0.9, link: '/events?subject=run:wr_1&event=ev_9', meta: {} },
    ].filter((i) => scope === 'all' || i.scope === scope)
    return okJ({ items, total: items.length, q, scopes: [scope] })
  }
  if (path === '/events/facets') return okJ({ sources: [], kinds: [], agents: [], members: [] })
  if (path === '/events/ev_3/chain') return okJ({ event: E3, upstream: [{ ...E2, effect: 'ev_3' }, { ...E1, effect: 'ev_2' }], downstream: [], truncated: false })
  if (path === '/events') return okJ({ items: [E3, E2, E1], total: 3, limit: 50, offset: 0 })
  return mockFetch(input, init)
}

beforeEach(() => {
  setupMocks({ loggedIn: true })
  calls.length = 0
  setFetchImpl(fakeFetch as typeof fetch)
})

describe('SearchPage', () => {
  it('searches on submit, shows scope tabs and links, and filters by scope', async () => {
    const user = userEvent.setup()
    renderApp(<SearchPage />, { route: '/search' })
    await user.type(screen.getByRole('textbox', { name: /搜尋內容/ }), '文案{Enter}')
    await waitFor(() => expect(screen.getByTestId('hit-chat-msg_1')).toBeInTheDocument())
    expect(screen.getByTestId('hit-events-ev_9')).toBeInTheDocument()
    expect(calls.some((c) => c.startsWith('/search?') && c.includes('q=') && decodeURIComponent(c).includes('文案'))).toBe(true)
    // 命中字標粗、連結指到搜尋結果的 link
    expect(screen.getAllByText('文案', { selector: 'mark' }).length).toBeGreaterThan(0)
    const links = screen.getAllByRole('link', { name: /開啟/ })
    expect(links[0]).toHaveAttribute('href', '/?session=s1&message=msg_1')
    // scope 分頁
    await user.click(screen.getByTestId('scope-events'))
    await waitFor(() => expect(screen.queryByTestId('hit-chat-msg_1')).not.toBeInTheDocument())
    expect(screen.getByTestId('hit-events-ev_9')).toBeInTheDocument()
    expect(calls.some((c) => c.includes('scope=events'))).toBe(true)
  })

  it('reads ?q= from the URL and shows empty state when nothing matches', async () => {
    renderApp(<SearchPage />, { route: '/search?q=沒有的東西' })
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeInTheDocument())
  })
})

describe('EventsPage chain', () => {
  it('shows seq and expands the causal chain from /events/{id}/chain', async () => {
    const user = userEvent.setup()
    renderApp(<EventsPage />, { route: '/events' })
    await waitFor(() => expect(screen.getByTestId('event-ev_3')).toBeInTheDocument())
    expect(screen.getByText('#3')).toBeInTheDocument()
    const btn = screen.getByTestId('chain-btn-ev_3')
    expect(btn.textContent).toContain('(1)')
    await user.click(btn)
    await waitFor(() => expect(screen.getByTestId('chain-of-ev_3')).toBeInTheDocument())
    expect(screen.getByTestId('chain-ev_2')).toBeInTheDocument()
    expect(screen.getByTestId('chain-ev_1')).toBeInTheDocument()
    expect(calls).toContain('/events/ev_3/chain')
  })

  it('honours ?subject= and ?event= from a search link (auto-opens the chain)', async () => {
    renderApp(<EventsPage />, { route: '/events?subject=run:ev_3&event=ev_3' })
    await waitFor(() => expect(screen.getByTestId('chain-of-ev_3')).toBeInTheDocument())
    expect(calls.some((c) => c.startsWith('/events?') && decodeURIComponent(c).includes('subject=run:ev_3'))).toBe(true)
  })
})
