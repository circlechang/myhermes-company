// SPEC 專屬：收件匣頁、成本護欄頁（fake fetch）
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '../modules/registry' // 註冊模組 i18n
import { setFetchImpl } from '../api/client'
import { mockFetch } from '../mock/fetch'
import { renderApp, setupMocks } from './utils'
import { InboxPage } from '../modules/inbox'
import { LimitsPage, type UsageLimit } from '../modules/limits'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const calls: { method: string; path: string; body?: any }[] = []
function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const inboxItems = [
  { id: 'wf:wa_1', kind: 'workflow_gate', ref_id: 'wa_1', title: '日報／閘門', detail: '### 熱點\n三個熱點', agent: '', created_at: '2026-08-29T01:00:00', link: '/workflows/wf_1/runs/wr_1', actions: ['approve', 'reject', 'goto'], api: { approve: '/workflow-approvals/wa_1/approve', reject: '/workflow-approvals/wa_1/reject' } },
  { id: 'chat:pa_1', kind: 'chat_approval', ref_id: 'pa_1', title: 'rm -rf x', detail: '{"tool":"terminal"}', agent: 'default', created_at: '2026-08-29T02:00:00', link: '/?session=s_1', actions: ['once', 'session', 'always', 'deny', 'goto'], api: { resolve: '/inbox/approvals/pa_1/resolve' } },
  { id: 'kanban:t_blk', kind: 'kanban_blocked', ref_id: 't_blk', ref: 'kanban:t_blk', title: '卡住的卡', detail: 'Task has been blocked for 709h', agent: 'researcher', created_at: null, link: '/kanban?task=t_blk', actions: ['goto', 'done'], api: { done: '/inbox/done' } },
]
let items = [...inboxItems]
let limits: UsageLimit[] = [
  { id: 'ul_1', scope: 'agent', agent_id: 'ag_1', daily_tokens: 100000, daily_usd: 0, enabled: true, action: 'disable', last_triggered_on: '', disabled_agents: [], created_at: '2026-08-29T00:00:00', updated_at: '2026-08-29T00:00:00',
    agent: { id: 'ag_1', name: 'Researcher', profile: 'default', enabled: true }, today: { tokens: 85000, usd: 0.12, runs: 9, tokens_pct: 85, usd_pct: null, exceeded: false, triggered_today: false } },
  { id: 'ul_2', scope: 'company', agent_id: '', daily_tokens: 0, daily_usd: 1, enabled: true, action: 'disable', last_triggered_on: '2026-08-29', disabled_agents: ['ag_1'], created_at: '2026-08-29T00:00:00', updated_at: '2026-08-29T00:00:00',
    agent: null, today: { tokens: 120000, usd: 1.3, runs: 12, tokens_pct: null, usd_pct: 130, exceeded: true, triggered_today: true } },
]

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '')
  const method = (init.method ?? 'GET').toUpperCase()
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ method, path, body })
  const p = path.split('?')[0]
  if (p === '/inbox') {
    const by: Record<string, number> = {}
    for (const it of items) by[it.kind] = (by[it.kind] ?? 0) + 1
    return Promise.resolve(ok({ items, count: items.length, by_kind: by, warnings: [] }))
  }
  if (p === '/inbox/count') return Promise.resolve(ok({ count: items.length, by_kind: {} }))
  if (p === '/workflow-approvals/wa_1/approve' || p === '/workflow-approvals/wa_1/reject') {
    items = items.filter((x) => x.id !== 'wf:wa_1')
    return Promise.resolve(ok({ ok: true }))
  }
  if (p === '/inbox/approvals/pa_1/resolve') {
    items = items.filter((x) => x.id !== 'chat:pa_1')
    return Promise.resolve(ok({ ok: true, forwarded: true }))
  }
  if (p === '/inbox/done') {
    items = items.filter((x) => x.ref !== body.ref)
    return Promise.resolve(ok({ ok: true }))
  }
  if (p === '/limits' && method === 'GET') return Promise.resolve(ok(limits))
  if (p === '/limits' && method === 'POST') {
    limits = [...limits, { ...limits[0], id: 'ul_3', agent_id: body.agent_id, daily_tokens: body.daily_tokens, daily_usd: body.daily_usd, action: body.action, scope: body.scope, agent: { id: 'ag_2', name: 'Writer', profile: 'writer', enabled: true }, today: { tokens: 0, usd: 0, runs: 0, tokens_pct: 0, usd_pct: null, exceeded: false, triggered_today: false } }]
    return Promise.resolve(ok(limits[limits.length - 1], 201))
  }
  if (p === '/limits/today') return Promise.resolve(ok({ date: '2026-08-29', company: { tokens: 120000, usd: 1.3, runs: 12 }, agents: [{ agent_id: 'ag_1', name: 'Researcher', profile: 'default', enabled: false, model: 'gpt-x', tokens: 85000, usd: 0.12, runs: 9 }] }))
  if (p === '/limits/ul_2/reset') {
    limits = limits.map((l) => (l.id === 'ul_2' ? { ...l, last_triggered_on: '', disabled_agents: [], today: { ...l.today, triggered_today: false } } : l))
    return Promise.resolve(ok({ ok: true, re_enabled: ['ag_1'] }))
  }
  if (p === '/limits/check') return Promise.resolve(ok({ fired: [] }))
  if (p === '/agents') return Promise.resolve(ok([{ id: 'ag_1', name: 'Researcher', profile: 'default', enabled: true }, { id: 'ag_2', name: 'Writer', profile: 'writer', enabled: true }]))
  return mockFetch(input, init)
}

beforeEach(() => {
  setupMocks({ loggedIn: true })
  setFetchImpl(fakeFetch as typeof fetch)
  calls.length = 0
  items = [...inboxItems]
})

describe('InboxPage', () => {
  it('聚合顯示三種待辦與計數；種類篩選', async () => {
    renderApp(<InboxPage />, { route: '/inbox' })
    expect(await screen.findByText('日報／閘門')).toBeInTheDocument()
    expect(screen.getByText('rm -rf x')).toBeInTheDocument()
    expect(screen.getByText('卡住的卡')).toBeInTheDocument()
    expect(screen.getByTestId('filter-kanban_blocked')).toHaveTextContent('看板卡住 1')
    await userEvent.click(screen.getByTestId('filter-chat_approval'))
    expect(screen.queryByText('日報／閘門')).not.toBeInTheDocument()
    expect(screen.getByText('rm -rf x')).toBeInTheDocument()
  })
  it('工作流閘門：退回附意見 → 打 reject API 並從清單消失', async () => {
    renderApp(<InboxPage />, { route: '/inbox' })
    const card = within(await screen.findByTestId('inbox-wf:wa_1'))
    await userEvent.type(card.getByLabelText('意見'), '再短一點')
    await userEvent.click(card.getByRole('button', { name: '退回' }))
    await waitFor(() => expect(screen.queryByTestId('inbox-wf:wa_1')).not.toBeInTheDocument())
    const c = calls.find((x) => x.path === '/workflow-approvals/wa_1/reject')
    expect(c?.method).toBe('POST')
    expect(c?.body).toEqual({ comment: '再短一點' })
  })
  it('危險指令：四段式決定 → resolve API', async () => {
    renderApp(<InboxPage />, { route: '/inbox' })
    const card = within(await screen.findByTestId('inbox-chat:pa_1'))
    await userEvent.click(card.getByRole('button', { name: '本次對話允許' }))
    await waitFor(() => expect(screen.queryByTestId('inbox-chat:pa_1')).not.toBeInTheDocument())
    expect(calls.find((x) => x.path === '/inbox/approvals/pa_1/resolve')?.body).toEqual({ decision: 'session' })
  })
  it('看板卡住：已處理 → /inbox/done 帶 ref', async () => {
    renderApp(<InboxPage />, { route: '/inbox' })
    const card = within(await screen.findByTestId('inbox-kanban:t_blk'))
    await userEvent.click(card.getByRole('button', { name: '已處理' }))
    await waitFor(() => expect(screen.queryByTestId('inbox-kanban:t_blk')).not.toBeInTheDocument())
    expect(calls.find((x) => x.path === '/inbox/done')?.body).toEqual({ ref: 'kanban:t_blk' })
  })
})

describe('LimitsPage', () => {
  it('顯示上限、今日進度條與超額狀態', async () => {
    renderApp(<LimitsPage />, { route: '/limits' })
    expect(within(await screen.findByTestId('limit-ul_1')).getByText('Researcher (default)')).toBeInTheDocument()
    const bar = screen.getByTestId('bar-tokens-ul_1')
    expect(bar).toHaveTextContent('85%')
    expect(within(bar).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '85')
    const row2 = within(screen.getByTestId('limit-ul_2'))
    expect(row2.getByText('已超額')).toBeInTheDocument()
    expect(row2.getByTestId('bar-usd-ul_2')).toHaveTextContent('130%')
    expect(screen.getByTestId('today-default')).toHaveTextContent('員工已停用')
  })
  it('重設並重新啟用 → reset API', async () => {
    renderApp(<LimitsPage />, { route: '/limits' })
    const row2 = within(await screen.findByTestId('limit-ul_2'))
    await userEvent.click(row2.getByRole('button', { name: '重設並重新啟用' }))
    await waitFor(() => expect(calls.some((x) => x.path === '/limits/ul_2/reset' && x.method === 'POST')).toBe(true))
    await waitFor(() => expect(within(screen.getByTestId('limit-ul_2')).queryByRole('button', { name: '重設並重新啟用' })).not.toBeInTheDocument())
  })
  it('新增上限：選員工＋tokens → POST /limits', async () => {
    renderApp(<LimitsPage />, { route: '/limits' })
    await screen.findByTestId('limit-ul_1')
    const add = screen.getByRole('button', { name: '新增' })
    expect(add).toBeDisabled()
    await userEvent.selectOptions(screen.getByLabelText('AI 員工', { selector: 'select' }), 'ag_2')
    await userEvent.type(screen.getByLabelText('每日 tokens 上限'), '50000')
    expect(add).toBeEnabled()
    await userEvent.click(add)
    await waitFor(() => expect(calls.find((x) => x.path === '/limits' && x.method === 'POST')?.body).toEqual({ scope: 'agent', agent_id: 'ag_2', daily_tokens: 50000, daily_usd: 0, action: 'disable' }))
    expect(within(await screen.findByTestId('limit-ul_3')).getByText('Writer (writer)')).toBeInTheDocument()
  })
})
