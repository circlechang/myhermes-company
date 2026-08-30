// 站內新版提示：TopBar 徽章 ＋ 管理頁「版本」卡。站內只給指令，不做一鍵更新。
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '../modules/registry' // 註冊模組 i18n
import { setFetchImpl } from '../api/client'
import { mockFetch } from '../mock/fetch'
import { renderApp, setupMocks } from './utils'
import { TopBar } from '../components/nav/TopBar'
import { AdminPage } from '../modules/admin'

const calls: string[] = []
function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

interface StudioVersion {
  studio: { version: string }
  studio_latest: string | null
  studio_update_available: boolean | null
  studio_release: { tag: string; url: string } | null
  studio_repo: string
  studio_update_cmd: string
  studio_update_check_enabled: boolean
}

const upToDate: StudioVersion = {
  studio: { version: '0.1.0' },
  studio_latest: '0.1.0',
  studio_update_available: false,
  studio_release: { tag: 'v0.1.0', url: 'https://github.com/circlechang/myhermes-company/releases/tag/v0.1.0' },
  studio_repo: 'circlechang/myhermes-company',
  studio_update_cmd: 'myhermescompany update',
  studio_update_check_enabled: true,
}
const hasUpdate: StudioVersion = {
  ...upToDate,
  studio_latest: '0.2.0',
  studio_update_available: true,
  studio_release: { tag: 'v0.2.0', url: 'https://github.com/circlechang/myhermes-company/releases/tag/v0.2.0' },
}
const disabled: StudioVersion = {
  ...upToDate,
  studio_latest: null,
  studio_update_available: null,
  studio_release: null,
  studio_update_check_enabled: false,
}

function install(studio: StudioVersion | 'boom') {
  calls.length = 0
  setupMocks({ loggedIn: true })
  setFetchImpl(((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '')
    calls.push(path)
    const p = path.split('?')[0]
    if (p === '/version/studio') {
      return studio === 'boom' ? Promise.resolve(ok({ error: { code: 'x', message: 'down' } }, 502)) : Promise.resolve(ok(studio))
    }
    if (p === '/version') {
      return Promise.resolve(ok({
        hermes: { version: '0.20.5', date: '2026.8.19', behind: 3 },
        latest: { tag: 'v0.21.0', url: 'https://github.com/x' },
        update_check_enabled: true,
        update_available: true,
        repo: 'NousResearch/hermes-agent',
        ...(studio === 'boom' ? disabled : studio),
      }))
    }
    if (p === '/inbox/count') return Promise.resolve(ok({ count: 0 }))
    return mockFetch(input, init)
  }) as typeof fetch)
}

const bar = () => <TopBar title="工作臺" username="admin" onLogout={() => {}} mobile={false} />

describe('TopBar 新版提示', () => {
  it('有新版時顯示徽章，寫出版號與更新指令，連到管理頁', async () => {
    install(hasUpdate)
    renderApp(bar())
    const hint = await screen.findByTestId('update-hint')
    expect(hint).toHaveTextContent('有新版 v0.2.0')
    expect(hint.getAttribute('title')).toContain('myhermescompany update')
    expect(hint.getAttribute('href')).toBe('/admin')
  })

  it('已是最新版就不顯示', async () => {
    install(upToDate)
    renderApp(bar())
    await waitFor(() => expect(calls).toContain('/version/studio'))
    expect(screen.queryByTestId('update-hint')).toBeNull()
  })

  it('檢查關閉（MHC_UPDATE_CHECK=0）時不顯示', async () => {
    install(disabled)
    renderApp(bar())
    await waitFor(() => expect(calls).toContain('/version/studio'))
    expect(screen.queryByTestId('update-hint')).toBeNull()
  })

  it('端點壞掉時安靜略過，不擋住 TopBar', async () => {
    install('boom')
    renderApp(bar())
    await waitFor(() => expect(calls).toContain('/version/studio'))
    expect(screen.queryByTestId('update-hint')).toBeNull()
    expect(screen.getByTestId('page-title')).toHaveTextContent('工作臺')
  })

  it('不打 hermes 版本端點（TopBar 只用輕量的 /version/studio）', async () => {
    install(hasUpdate)
    renderApp(bar())
    await screen.findByTestId('update-hint')
    expect(calls.some((c) => c.split('?')[0] === '/version')).toBe(false)
  })
})

describe('管理頁 版本分頁', () => {
  it('顯示最新版、指令，且沒有一鍵更新按鈕', async () => {
    install(hasUpdate)
    renderApp(<AdminPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '版本' }))
    expect(await screen.findByTestId('mhc-update-badge')).toHaveTextContent('有新版 v0.2.0')
    expect(screen.getByTestId('mhc-update-cmd')).toHaveTextContent('myhermescompany update')
    expect(screen.getByTestId('mhc-latest-tag')).toHaveTextContent('v0.2.0')
    expect(screen.queryByRole('button', { name: /更新|update/i })).toBeNull()
  })

  it('已是最新版顯示「已是最新」，不出現指令', async () => {
    install(upToDate)
    renderApp(<AdminPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '版本' }))
    await screen.findByTestId('mhc-update-card')
    expect(screen.queryByTestId('mhc-update-badge')).toBeNull()
    expect(screen.queryByTestId('mhc-update-cmd')).toBeNull()
    expect(screen.getAllByText('已是最新').length).toBeGreaterThan(0)
  })

  it('檢查關閉時說明已關閉', async () => {
    install(disabled)
    renderApp(<AdminPage />)
    await userEvent.click(await screen.findByRole('tab', { name: '版本' }))
    expect(await screen.findByText(/MHC_UPDATE_CHECK=0/)).toBeInTheDocument()
  })
})
