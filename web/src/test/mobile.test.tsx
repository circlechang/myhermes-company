// 手機（390px）四條路：工作臺清單優先、AI 員工清單優先、流程頁「等你看」是 sheet、頂欄只剩五樣
import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { renderApp, setupMocks } from './utils'
import { resetFocusMode } from '../components/layout/panelState'
import { setEngineerMode } from '../prefs/engineerMode'

// Node 25 內建 localStorage 會蓋掉 jsdom 的，沒有 --localstorage-file 就丟 SecurityError；這裡用記憶體版
function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k) },
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
  } as Storage
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: memStorage() })

function setMobile(mobile: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: q.includes('max-width') ? mobile : false,
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  })
}

/** 直排文字的窄條：手機上一律不准出現 */
const noVerticalRail = () => expect(document.querySelector('[class*="writing-mode"]')).toBeNull()

describe('手機版（<768px）', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    window.localStorage.clear()
    resetFocusMode()
    setEngineerMode(false)
    setMobile(true)
  })
  afterEach(() => setMobile(false))

  it('工作臺：先看到對話清單，點一則進聊天室有「‹ 對話」，按了回清單', async () => {
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    const list = await screen.findByTestId('session-sidebar')
    expect(list).toBeVisible()
    expect(screen.getByTestId('sidebar-desktop').dataset.mobile).toBe('inline')
    noVerticalRail()
    expect(screen.queryByTestId('mobile-back')).not.toBeInTheDocument()
    expect(screen.queryByTestId('empty-sessions')).not.toBeInTheDocument()
    // 右欄「這個對話」手機不畫、也沒有藥丸
    expect(screen.queryByTestId('session-info')).not.toBeInTheDocument()
    expect(screen.queryByTestId('panel-open-workbench.right')).not.toBeInTheDocument()

    await user.click(await within(list).findByText('本週熱點選題'))
    await screen.findByTestId('message-list')
    const back = screen.getByTestId('mobile-back')
    expect(back).toHaveTextContent('對話')
    expect(screen.queryByTestId('session-sidebar')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText(/輸入訊息/)).toBeInTheDocument()
    noVerticalRail()

    await user.click(back)
    expect(await screen.findByTestId('session-sidebar')).toBeInTheDocument()
    expect(screen.queryByTestId('mobile-back')).not.toBeInTheDocument()
  })

  it('AI 員工：先看到清單，點一位進人事檔案有返回鍵；PROFILE 管理預設收著', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    const list = await screen.findByTestId('agents-list')
    expect(list).toBeVisible()
    noVerticalRail()
    expect(screen.queryByTestId('mobile-back')).not.toBeInTheDocument()
    expect(screen.queryByText('選一位員工')).not.toBeInTheDocument()
    expect(screen.getByTestId('profiles-panel')).not.toHaveAttribute('open')

    await user.click(await within(list).findByText('小編'))
    expect(await screen.findByTestId('dossier-stat-chat')).toBeInTheDocument()
    expect(screen.queryByTestId('agents-list')).not.toBeInTheDocument()
    const back = screen.getByTestId('mobile-back')
    expect(back).toHaveTextContent('員工')
    await user.click(back)
    expect(await screen.findByTestId('agents-list')).toBeInTheDocument()
    expect(screen.queryByTestId('dossier-stat-chat')).not.toBeInTheDocument()
  })

  it('流程頁：有一步等你看 → 閱讀欄是自動打開的 sheet，右下角有藥丸；橫幅改成開 sheet', async () => {
    renderApp(<App />, { route: '/workflows/w2' })
    const user = userEvent.setup()
    const sheet = await screen.findByTestId('panel-sheet-wf.reviewRail')
    expect(within(sheet).getByTestId('review-pane')).toBeInTheDocument()
    const pill = screen.getByTestId('panel-open-wf.reviewRail')
    expect(pill).toHaveTextContent('等你看')
    noVerticalRail()

    await user.click(screen.getByTestId('panel-close-wf.reviewRail'))
    expect(screen.queryByTestId('review-pane')).not.toBeInTheDocument()
    // 主區是「最近一次」時間軸，行內就有可以／退回
    expect(screen.getByTestId('last-row-p2')).toHaveAttribute('data-status', 'waiting_approval')

    // 切到「怎麼跑」：右欄重掛不會又彈出來；橫幅在手機上是開 sheet，不是捲動
    await user.click(screen.getByTestId('tab-how'))
    const banner = await screen.findByTestId('editor-waiting-banner')
    expect(screen.queryByTestId('panel-sheet-wf.reviewRail')).not.toBeInTheDocument()
    const card = screen.getByTestId('station-p2')
    card.scrollIntoView = vi.fn()
    await user.click(banner)
    expect(await screen.findByTestId('panel-sheet-wf.reviewRail')).toBeInTheDocument()
    expect(card.scrollIntoView).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('panel-close-wf.reviewRail'))
    // 換了分頁右欄是重掛的，藥丸要重抓
    await user.click(screen.getByTestId('panel-open-wf.reviewRail'))
    expect(await screen.findByTestId('review-pane')).toBeInTheDocument()
  })

  it('流程頁：沒有等你看時，產出欄是預設關著的 sheet', async () => {
    renderApp(<App />, { route: '/workflows/w1' })
    const user = userEvent.setup()
    await screen.findByTestId('last-run-view')
    await user.click(screen.getByTestId('tab-how'))
    const pill = await screen.findByTestId('panel-open-wf.outputRail')
    expect(screen.queryByTestId('panel-sheet-wf.outputRail')).not.toBeInTheDocument()
    noVerticalRail()
    await user.click(pill)
    expect(await screen.findByTestId('panel-sheet-wf.outputRail')).toBeInTheDocument()
  })

  it('頂欄：只剩 ☰／logo／標題／收件匣／頭像；語言、主題、專注、說明都在頭像選單裡', async () => {
    renderApp(<App />, { route: '/kanban' })
    const user = userEvent.setup()
    await screen.findByTestId('menu-button')
    const header = screen.getByRole('banner')
    expect(header.querySelector('select')).toBeNull()
    expect(screen.queryByText('Mock 模式')).not.toBeInTheDocument()
    expect(within(header).queryByTestId('theme-toggle')).not.toBeInTheDocument()
    expect(within(header).queryByTestId('focus-toggle')).not.toBeInTheDocument()
    expect(within(header).queryByTestId('help-button')).not.toBeInTheDocument()
    expect(within(header).queryByTestId('search-button')).not.toBeInTheDocument()
    expect(within(header).getByTestId('inbox-button')).toBeInTheDocument()
    expect(within(header).getByTestId('page-title')).toHaveTextContent('看板')
    expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('user-menu-button'))
    const menu = await screen.findByTestId('user-menu')
    expect(menu.querySelector('select')).not.toBeNull()
    expect(within(menu).getByTestId('theme-toggle')).toBeInTheDocument()
    expect(within(menu).getByTestId('focus-toggle')).toBeInTheDocument()
    expect(within(menu).getByTestId('help-button')).toBeInTheDocument()
    expect(within(menu).getByTestId('search-button')).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /登出/ })).toBeInTheDocument()
    // 點選單外面關掉
    await user.click(screen.getByTestId('user-menu-backdrop'))
    await waitFor(() => expect(screen.queryByTestId('user-menu')).not.toBeInTheDocument())
  })

  it('桌面頂欄：語言選單也收進頭像選單，其他鈕留在頂欄', async () => {
    setMobile(false)
    renderApp(<App />, { route: '/kanban' })
    const user = userEvent.setup()
    await screen.findByTestId('sidebar')
    const header = screen.getByRole('banner')
    expect(header.querySelector('select')).toBeNull()
    expect(within(header).getByTestId('theme-toggle')).toBeInTheDocument()
    expect(within(header).getByTestId('help-button')).toBeInTheDocument()
    await user.click(screen.getByTestId('user-menu-button'))
    expect((await screen.findByTestId('user-menu')).querySelector('select')).not.toBeNull()
  })
})
