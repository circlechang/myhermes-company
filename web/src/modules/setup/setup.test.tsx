import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../App'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { renderApp, setupMocks } from '../../test/utils'
import { SETUP_SKIP_KEY } from './api'
import type { SetupJob, SetupStatus } from './api'

interface Scenario { completed: boolean; keyConfigured: boolean; reachable: boolean; installed: boolean; defaultPw: boolean }
const calls: { method: string; path: string; body?: unknown }[] = []
let sc: Scenario
let job: SetupJob | null = null

function statusOf(s: Scenario): SetupStatus {
  return {
    completed: s.completed,
    hermes: { installed: s.installed, bin: '/home/u/.local/bin/hermes', version: s.installed ? '0.20.5' : '', error: '', home: '/home/u/.hermes', home_exists: true, install_cmd: 'curl -fsSL https://example/install.sh | bash', docs_url: 'https://example/docs' },
    api: { key_configured: s.keyConfigured, key_source: s.keyConfigured ? 'env_file' : 'none', studio_key_loaded: s.keyConfigured, url: 'http://127.0.0.1:8642', env_path: '/home/u/.hermes/.env', reachable: s.reachable, version: s.reachable ? '0.20.5' : '', error: '' },
    gateway: { ok: true, running: s.reachable, pid: s.reachable ? 42 : null, supervised: false, stale_service: false, profiles: [], raw_tail: '' },
    profiles: { count: 3, names: ['default', 'editor', 'researcher'] },
    admin: { default_password: s.defaultPw, username: 'admin' },
    next_step: !s.installed ? 'install' : !(s.keyConfigured && s.reachable) ? 'api' : s.defaultPw ? 'password' : 'agents',
    dry_run: true,
  }
}

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

async function setupFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const path = url.replace(/^\/api/, '')
  const method = (init.method ?? 'GET').toUpperCase()
  if (path.startsWith('/setup')) {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    if (path === '/setup/state') return ok({ completed: sc.completed, is_owner: true })
    if (path === '/setup/status') return ok(statusOf(sc))
    if (path === '/setup/enable-api') {
      if (sc.keyConfigured && sc.reachable) return ok({ status: 'configured', changed: false, reachable: true, job: null })
      job = { id: 'j1', dry_run: true, done: false, ok: null, phase: 'gateway', error: '', log_tail: '', elapsed: 0.2, manual_cmd: 'hermes gateway restart',
        steps: [{ name: 'write_key', status: 'ok', detail: '已寫入 /home/u/.hermes/.env' }, { name: 'gateway', status: 'running', detail: '' }] }
      return ok({ status: 'written', changed: true, backup: '/home/u/.hermes/.env.bak-20260829-120000', reachable: false, job })
    }
    if (path === '/setup/enable-api/progress') {
      if (job && !job.done) {
        job = { ...job, done: true, ok: true, phase: 'health', steps: [job.steps[0], { name: 'gateway', status: 'skipped', detail: 'dry-run' }, { name: 'health', status: 'skipped', detail: 'dry-run' }] }
        sc = { ...sc, keyConfigured: true, reachable: true }
      }
      return ok({ job })
    }
    if (path === '/setup/admin-password') {
      if (String(body.password).length < 8) return ok({ error: { code: 'weak_password', message: '密碼至少 8 碼' } }, 400)
      sc = { ...sc, defaultPw: false }
      return ok({ ok: true, default_password: false })
    }
    if (path === '/setup/complete') { sc = { ...sc, completed: true }; return ok({ ok: true, completed: true }) }
  }
  return mockFetch(input, init)
}

describe('首次設定精靈', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    setFetchImpl(setupFetch as typeof fetch)
    calls.length = 0
    job = null
    sc = { completed: false, keyConfigured: false, reachable: false, installed: true, defaultPw: true }
    try { window.sessionStorage.removeItem(SETUP_SKIP_KEY); window.localStorage.removeItem('mhc.tour.done') } catch { /* ignore */ }
  })

  it('owner 未完成設定 → 自動導到 /setup 並停在「開啟 API 門」', async () => {
    renderApp(<App />, { route: '/' })
    expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument()
    expect(await screen.findByTestId('setup-panel-api')).toBeInTheDocument()
    expect(screen.getByTestId('setup-step-api')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByTestId('setup-next')).toBeDisabled()
  })

  it('已完成設定就不導向', async () => {
    sc.completed = true
    renderApp(<App />, { route: '/' })
    expect(await screen.findByRole('link', { name: '工作臺' })).toBeInTheDocument()
    expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument()
  })

  it('沒裝 Hermes 時停在第 ① 步並顯示安裝指令', async () => {
    sc.installed = false
    renderApp(<App />, { route: '/setup' })
    expect(await screen.findByTestId('hermes-missing')).toHaveTextContent('curl -fsSL')
    expect(screen.getByRole('link', { name: '官方文件' })).toHaveAttribute('href', 'https://example/docs')
  })

  it('一鍵開門 → 進度 → 成功 → 員工 → 密碼 → 完成 → 回工作臺並記 complete', { timeout: 30000 }, async () => {
    const user = userEvent.setup()
    renderApp(<App />, { route: '/setup' })
    await user.click(await screen.findByTestId('api-open-btn'))
    expect(await screen.findByTestId('api-success', {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText(/備份檔/)).toHaveTextContent('.env.bak-')
    await waitFor(() => expect(screen.getByTestId('setup-next')).toBeEnabled())
    await user.click(screen.getByTestId('setup-next'))

    // ③ 員工：mock 有 3 位，客服未啟用 → 勾起來會打 PATCH
    const list = await screen.findByTestId('setup-agents')
    expect(await within(list).findAllByRole('checkbox')).toHaveLength(3)
    await user.click(within(list).getByLabelText('客服'))
    await waitFor(() => expect(screen.getByTestId('agents-enabled-count')).toHaveTextContent('已啟用 3 位'))
    await user.click(screen.getByTestId('setup-next'))

    // ④ 密碼：先試跳過會警告；再輸入不一致；最後成功
    expect(await screen.findByTestId('pw-new')).toBeInTheDocument()
    expect(screen.queryByTestId('setup-next')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('pw-skip'))
    expect(screen.getByTestId('pw-skip-warn')).toHaveTextContent('admin/admin')
    await user.type(screen.getByTestId('pw-new'), 'new-strong-pass-1')
    await user.type(screen.getByTestId('pw-confirm'), 'different-pass-1')
    await user.click(screen.getByTestId('pw-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('兩次輸入不一樣')
    await user.clear(screen.getByTestId('pw-confirm'))
    await user.type(screen.getByTestId('pw-confirm'), 'new-strong-pass-1')
    await user.click(screen.getByTestId('pw-save'))
    expect(await screen.findByTestId('password-ok')).toHaveTextContent('密碼已更新')
    expect(calls.find((c) => c.path === '/setup/admin-password')?.body).toEqual({ password: 'new-strong-pass-1' })
    await user.click(screen.getByTestId('setup-next'))

    // ⑤ 完成
    const summary = await screen.findByTestId('setup-summary')
    expect(within(summary).queryByText(/未處理/)).not.toBeInTheDocument()
    expect(within(summary).getAllByRole('listitem')).toHaveLength(4)
    let tourStarted = false
    window.addEventListener('mhc:tour:start', () => { tourStarted = true }, { once: true })
    await user.click(screen.getByTestId('setup-finish'))
    await waitFor(() => expect(calls.some((c) => c.path === '/setup/complete' && c.method === 'POST')).toBe(true))
    expect(await screen.findByRole('link', { name: '工作臺' })).toBeInTheDocument()
    await waitFor(() => expect(tourStarted).toBe(true))
  })

  it('API 門已開時第 ② 步直接顯示「已開啟」可下一步', async () => {
    sc = { ...sc, keyConfigured: true, reachable: true }
    const user = userEvent.setup()
    renderApp(<App />, { route: '/setup' })
    // 偵測結果是 password → 起始步是 agents；退回第 ② 步看
    expect(await screen.findByTestId('setup-panel-agents')).toBeInTheDocument()
    await user.click(screen.getByTestId('setup-prev'))
    expect(await screen.findByTestId('api-open')).toHaveTextContent('已經開著')
    expect(screen.queryByTestId('api-open-btn')).not.toBeInTheDocument()
    expect(screen.getByTestId('setup-next')).toBeEnabled()
  })

  it('「稍後再說」進工作臺，本次不再導向', async () => {
    const user = userEvent.setup()
    renderApp(<App />, { route: '/' })
    await user.click(await screen.findByTestId('setup-skip'))
    expect(await screen.findByRole('link', { name: '工作臺' })).toBeInTheDocument()
    expect(window.sessionStorage.getItem(SETUP_SKIP_KEY)).toBe('1')
  })
})
