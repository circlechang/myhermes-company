import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../App'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { renderApp, setupMocks } from '../../test/utils'
import { failuresByModule, isJobRunning, type Report, type ReportItem } from './index'

const item = (o: Partial<ReportItem>): ReportItem => ({ id: 'x', status: 'pass', reason: '', ms: 1, kind: 'endpoint', risk: 'low', label: 'x', critical: false, affects: [], note: '', detail: {}, ...o })
const report: Report = {
  hermes: { version: '0.20.5', cli_version: '0.20.5', date: '2026.8.19', api_url: 'http://127.0.0.1:8642', home: '/h', profile: 'default' },
  mode: { sandbox: false, writes: false }, started_at: '2026-08-29T10:00:00Z', finished_at: '2026-08-29T10:01:00Z', duration_ms: 60000,
  summary: { pass: 2, fail: 1, skip: 1, total: 4, verdict: 'partial', failed_ids: ['gw.jobs.list'], affected_modules: [{ module: 'cron', failed: ['gw.jobs.list'] }] },
  items: [
    item({ id: 'gw.health', label: 'GET /v1/health', critical: true, affects: ['hermes_status'] }),
    item({ id: 'gw.jobs.list', label: 'GET /api/jobs', status: 'fail', reason: 'HTTP 404：Not Found', affects: ['cron'] }),
    item({ id: 'cli.profile.list', label: 'hermes profile list', kind: 'cli', risk: 'high', affects: ['agents', 'profiles'] }),
    item({ id: 'file.env', label: '.env', kind: 'file', risk: 'high', status: 'skip', reason: '不存在', affects: ['channels'] }),
  ],
  cleanups: [], run_id: 'cr_1',
}

let jobPolls = 0
const state = { status: { schedule: { enabled: true, weekday: 5, hour: 22, minute: 0, last_run: null as string | null }, tested: { tag: 'v2026.8.19', version: '0.20.5', at: '2026-08-29T10:00:00Z' }, latest_seen: { tag: 'v2026.8.27', at: '2026-08-29T10:00:00Z' }, current: { version: '0.20.5', checked_at: '2026-08-29T10:01:00Z', verdict: 'partial', run_id: 'cr_1' }, last_precheck: null, running: [] as unknown[] } }

function compatMock(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const u = new URL(typeof input === 'string' ? input : (input as Request).url, 'http://localhost')
  const path = u.pathname.replace(/^\/api/, '')
  const method = (init?.method ?? 'GET').toUpperCase()
  const ok = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  if (path === '/compat/status') return ok(state.status)
  if (path === '/compat/capabilities') return ok({ source: { finished_at: '2026-08-29T10:01:00Z', verdict: 'partial', hermes_version: '0.20.5' }, modules: [
    { module: 'chat', description: '', status: 'available', missing: [], degraded: [] },
    { module: 'cron', description: '', status: 'degraded', missing: [], degraded: ['gw.jobs.list'] },
    { module: 'hermes_status', description: '', status: 'unavailable', missing: ['gw.health'], degraded: [] },
  ] })
  if (path === '/compat/runs') return ok([{ id: 'cr_1', kind: 'check', want: '', tag: '', version: '0.20.5', status: 'done', verdict: 'partial', summary: report.summary, error: '', log_path: '', triggered_by: 'manual', created_at: '2026-08-29T10:01:00Z', finished_at: null }])
  if (path === '/compat/runs/cr_1') return ok({ id: 'cr_1', kind: 'check', verdict: 'partial', status: 'done', summary: report.summary, report })
  if (path === '/compat/check' && method === 'POST') return ok(report)
  if (path === '/compat/precheck' && method === 'POST') { jobPolls = 0; return ok({ id: 'pc_1', want: 'latest', status: 'queued', tag: '', version: '', progress: [], error: '', log_path: '', started_at: '', finished_at: '', summary: null }) }
  if (path === '/compat/precheck/pc_1') {
    jobPolls++
    const done = jobPolls >= 2
    return ok({ id: 'pc_1', want: 'latest', status: done ? 'done' : 'installing', tag: 'v2026.8.27', version: '0.21.0',
      progress: [{ ts: '2026-08-29T10:00:00Z', step: 'cloning', msg: 'git clone' }, ...(done ? [{ ts: '2026-08-29T10:01:00Z', step: 'done', msg: 'compatible' }] : [])],
      error: '', log_path: '', started_at: '', finished_at: '', summary: done ? { ...report.summary, verdict: 'compatible', fail: 0, affected_modules: [] } : null,
      report: done ? { ...report, mode: { sandbox: true, writes: true }, summary: { ...report.summary, verdict: 'compatible', fail: 0, affected_modules: [] }, items: report.items.filter((i) => i.status !== 'fail') } : null })
  }
  if (path === '/compat/check-latest' && method === 'POST') return ok({ result: 'noop:v2026.8.27' })
  if (path === '/compat/schedule' && method === 'PATCH') { const b = JSON.parse(String(init?.body)); state.status.schedule = { ...state.status.schedule, ...b }; return ok(state.status.schedule) }
  return mockFetch(input, init)
}

describe('相容性（modules/compat）', () => {
  beforeEach(() => { setupMocks({ loggedIn: true }); setFetchImpl(compatMock as typeof fetch) })

  it('純函式：失敗項依模組分組、任務進行中判斷', () => {
    const by = failuresByModule(report.items)
    expect(Object.keys(by)).toEqual(['cron'])
    expect(by.cron[0].id).toBe('gw.jobs.list')
    expect(isJobRunning('installing')).toBe(true)
    expect(isJobRunning('done')).toBe(false)
    expect(isJobRunning('timeout')).toBe(false)
  })

  it('頁面：版本卡、能力狀態、歷史與可展開的報告（失敗項自動展開＋受影響功能）', async () => {
    renderApp(<App />, { route: '/compat' })
    const user = userEvent.setup()
    expect(await screen.findByTestId('card-current')).toHaveTextContent('0.20.5')
    expect(screen.getByTestId('card-tested')).toHaveTextContent('v2026.8.19 (0.20.5)')
    expect(screen.getByTestId('card-latest')).toHaveTextContent('v2026.8.27')
    expect(await screen.findByTestId('cap-cron')).toHaveTextContent('cron · 部分')
    expect(screen.getByTestId('cap-hermes_status')).toHaveTextContent('不可用')
    expect(screen.getByTestId('cap-chat')).toHaveTextContent('可用')
    expect(await screen.findByTestId('run-cr_1')).toHaveTextContent('契約測試')
    await user.click(within(screen.getByTestId('run-cr_1')).getByRole('button', { name: '看報告' }))
    const table = await screen.findByTestId('report-table')
    expect(within(table).getByTestId('affected')).toHaveTextContent('cron')
    expect(within(table).getByTestId('detail-gw.jobs.list')).toHaveTextContent('HTTP 404')
    expect(within(table).getByTestId('detail-gw.jobs.list')).toHaveTextContent('受影響模組')
    expect(within(table).queryByTestId('detail-gw.health')).toBeNull()
    await user.click(within(table).getByTestId('item-gw.health'))
    expect(within(table).getByTestId('detail-gw.health')).toBeInTheDocument()
    await user.click(within(table).getByRole('button', { name: '只看失敗' }))
    expect(within(table).queryByTestId('item-gw.health')).toBeNull()
    expect(within(table).getByTestId('item-gw.jobs.list')).toBeInTheDocument()
  })

  it('預檢：按鈕→輪詢進度→完成後顯示相容報告；立即檢查回傳結果；排程可儲存', async () => {
    renderApp(<App />, { route: '/compat' })
    const user = userEvent.setup()
    await screen.findByTestId('card-current')
    await user.click(screen.getByRole('button', { name: '檢查最新版相容性' }))
    const panel = await screen.findByTestId('precheck-panel')
    await waitFor(() => expect(within(panel).getByTestId('precheck-status')).toHaveTextContent('完成'), { timeout: 8000 })
    expect(within(panel).getAllByTestId('verdict')[0]).toHaveTextContent('相容')
    expect(within(panel).getByTestId('report-table')).toHaveTextContent('沙盒')
    await user.click(screen.getByRole('button', { name: '立即檢查' }))
    expect(await screen.findByTestId('latest-result')).toHaveTextContent('noop:v2026.8.27')
    await user.click(screen.getByLabelText('啟用'))
    await user.selectOptions(screen.getByLabelText('星期'), '0')
    await user.click(within(screen.getByTestId('schedule')).getByRole('button', { name: '儲存' }))
    await waitFor(() => expect(state.status.schedule.enabled).toBe(false))
    expect(state.status.schedule.weekday).toBe(0)
  })
})
