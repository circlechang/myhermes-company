// 站內一鍵更新：按鈕 → 確認 → 進度 → 成功／失敗兩條路徑。
// 重點是「輪詢期間伺服器一定會離線」——斷線要顯示「重啟中…」，不能當成錯誤。
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '../modules/registry' // 註冊模組 i18n
import { setFetchImpl } from '../api/client'
import { renderApp, setupMocks } from './utils'
import { StudioUpdateCard, type StudioUpdateInfo, type UpdateJob } from '../modules/admin'

function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
function fail(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } })
}

const server = {
  online: true,
  version: '0.1.0',
  job: null as UpdateJob | null,
  startError: null as { status: number; code: string; message: string } | null,
  calls: [] as string[],
}

function install() {
  server.online = true
  server.version = '0.1.0'
  server.job = null
  server.startError = null
  server.calls = []
  setupMocks({ loggedIn: true })
  setFetchImpl(((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0]
    server.calls.push(`${init.method ?? 'GET'} ${path}`)
    // 伺服器正在重啟：fetch 直接失敗，跟真實情況一樣
    if (!server.online) return Promise.reject(new TypeError('Failed to fetch'))
    if (path === '/admin/update/start') {
      if (server.startError) return Promise.resolve(fail(server.startError.status, server.startError.code, server.startError.message))
      server.job = { job_id: 'up_test', phase: 'downloading', from: '0.1.0', to: '0.2.0', log: '/home/logs/update-1.log' }
      return Promise.resolve(ok({ job_id: 'up_test', status: 'starting', phase: 'downloading', log: '/home/logs/update-1.log', from: '0.1.0', to: '0.2.0', wheel: 'myhermescompany-0.2.0-py3-none-any.whl' }))
    }
    if (path === '/admin/update/status') {
      return Promise.resolve(ok({ job: server.job, current: server.version, status_file: '/home/update-status.json', editable: false, editable_reason: null, install_hint: null }))
    }
    if (path === '/version/studio') return Promise.resolve(ok({ studio: { version: server.version }, ...base }))
    return Promise.resolve(ok({}))
  }) as typeof fetch)
}

const base: StudioUpdateInfo = {
  studio_latest: '0.2.0',
  studio_update_available: true,
  studio_release: { tag: 'v0.2.0', url: 'https://github.com/circlechang/myhermes-company/releases/tag/v0.2.0' },
  studio_repo: 'circlechang/myhermes-company',
  studio_update_cmd: 'myhermescompany update',
  studio_update_check_enabled: true,
  studio_editable_install: false,
  studio_editable_reason: null,
}

const card = (extra: Partial<StudioUpdateInfo> = {}) =>
  <StudioUpdateCard d={{ ...base, ...extra, studio: { version: '0.1.0' } }} />

// 輪詢是 2 秒一次；waitFor 給到 8 秒才夠跑完兩三輪
const POLL = { timeout: 8000, interval: 100 }

describe('一鍵更新：確認對話框', () => {
  beforeEach(install)

  it('按主按鈕先出確認對話框，還沒打任何更新 API', async () => {
    renderApp(card())
    await userEvent.click(screen.getByTestId('mhc-update-btn'))
    const dlg = await screen.findByTestId('mhc-update-confirm')
    expect(dlg).toHaveTextContent('要現在更新到 v0.2.0 嗎？')
    expect(dlg).toHaveTextContent('離線')
    expect(dlg).toHaveTextContent('不要關閉瀏覽器')
    expect(server.calls.some((c) => c.includes('/admin/update/start'))).toBe(false)
  })

  it('取消就回到原本的樣子，不會發動更新', async () => {
    renderApp(card())
    await userEvent.click(screen.getByTestId('mhc-update-btn'))
    await userEvent.click(screen.getByTestId('mhc-update-confirm-cancel'))
    expect(screen.queryByTestId('mhc-update-confirm')).toBeNull()
    expect(screen.getByTestId('mhc-update-btn')).toBeInTheDocument()
    expect(server.calls.some((c) => c.includes('/admin/update/start'))).toBe(false)
  })

  it('可編輯安裝不給一鍵更新，改叫人 git pull', async () => {
    renderApp(card({ studio_editable_install: true, studio_editable_reason: 'pip install -e /repo' }))
    expect(screen.queryByTestId('mhc-update-btn')).toBeNull()
    expect(screen.getByTestId('mhc-update-editable')).toHaveTextContent('git pull')
    expect(screen.getByTestId('mhc-update-editable')).toHaveTextContent('pip install -e /repo')
  })
})

describe('一鍵更新：成功', () => {
  beforeEach(install)

  it('確認 → 下載中 → 安裝中 → 斷線顯示重啟中 → 回來變新版 → 顯示已更新', async () => {
    renderApp(card())
    await userEvent.click(screen.getByTestId('mhc-update-btn'))
    await userEvent.click(screen.getByTestId('mhc-update-confirm-ok'))

    // 進度視圖立刻出現（POST 回來之後）
    const phase = await screen.findByTestId('mhc-update-phase')
    expect(screen.getByTestId('mhc-update-progress')).toHaveTextContent('v0.1.0 → v0.2.0')
    expect(phase).toHaveTextContent('下載中…')

    // 更新器往前走一步：狀態檔說在安裝
    server.job = { ...server.job, phase: 'installing' }
    await waitFor(() => expect(screen.getByTestId('mhc-update-phase')).toHaveTextContent('安裝中…'), POLL)

    // 伺服器關掉自己：輪詢失敗＝預期中的，要顯示「重啟中…」而不是錯誤
    server.online = false
    await waitFor(() => expect(screen.getByTestId('mhc-update-phase')).toHaveTextContent('重啟中…'), POLL)
    expect(screen.queryByTestId('mhc-update-failed')).toBeNull()

    // 新版起來了
    server.version = '0.2.0'
    server.job = { ...server.job, phase: 'done' }
    server.online = true
    const done = await waitFor(() => screen.getByTestId('mhc-update-done'), POLL)
    expect(done).toHaveTextContent('已更新到 v0.2.0')
    expect(screen.getByTestId('mhc-update-reload')).toHaveTextContent('重新整理頁面')
    expect(screen.queryByTestId('mhc-update-progress')).toBeNull()
  }, 30_000) // 輪詢是 2 秒一次，這條要跑完三個階段
})

describe('一鍵更新：失敗', () => {
  beforeEach(install)

  it('下載／驗證沒過（POST 就回錯）→ 直接顯示失敗與手動指令，沒有進度視圖', async () => {
    server.startError = { status: 422, code: 'bad_wheel', message: '下載到的檔案不是合法的 zip（wheel）' }
    renderApp(card())
    await userEvent.click(screen.getByTestId('mhc-update-btn'))
    await userEvent.click(screen.getByTestId('mhc-update-confirm-ok'))
    const box = await screen.findByTestId('mhc-update-failed')
    expect(box).toHaveTextContent('更新失敗')
    expect(screen.getByTestId('mhc-update-error')).toHaveTextContent('不是合法的 zip')
    expect(screen.getByTestId('mhc-update-cmd')).toHaveTextContent('myhermescompany update')
    expect(screen.queryByTestId('mhc-update-progress')).toBeNull()
  })

  it('更新器回報失敗（狀態檔 phase=failed）→ 顯示原因、log 路徑與手動指令', async () => {
    renderApp(card())
    await userEvent.click(screen.getByTestId('mhc-update-btn'))
    await userEvent.click(screen.getByTestId('mhc-update-confirm-ok'))
    await screen.findByTestId('mhc-update-progress')
    server.job = { ...server.job, phase: 'failed', error: 'ERROR: 沒有磁碟空間了', log: '/home/logs/update-1.log' }
    const box = await waitFor(() => screen.getByTestId('mhc-update-failed'), POLL)
    expect(box).toHaveTextContent('更新失敗')
    expect(screen.getByTestId('mhc-update-error')).toHaveTextContent('沒有磁碟空間')
    expect(screen.getByTestId('mhc-update-log')).toHaveTextContent('/home/logs/update-1.log')
    expect(screen.getByTestId('mhc-update-cmd')).toHaveTextContent('myhermescompany update')
  }, 15_000)

  it('失敗後可以退回版本資訊再試一次', async () => {
    server.startError = { status: 502, code: 'download_failed', message: '下載失敗：no route to host' }
    renderApp(card())
    await userEvent.click(screen.getByTestId('mhc-update-btn'))
    await userEvent.click(screen.getByTestId('mhc-update-confirm-ok'))
    await screen.findByTestId('mhc-update-failed')
    await userEvent.click(screen.getByTestId('mhc-update-back'))
    expect(screen.getByTestId('mhc-update-btn')).toBeInTheDocument()
  })
})
