import { screen, within, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { renderApp, setupMocks } from './utils'
import { SIDEBAR_KEY } from '../components/nav/useNavState'
import { NAV_PANEL_ID } from '../components/nav/Sidebar'
import { panelKey, resetFocusMode } from '../components/layout/panelState'
import { groupNav } from '../modules/registry'
import { activeNavItem, allNav } from '../components/nav/navConfig'
import { INBOX_EVENT } from '../components/nav/TopBar'
import { moduleRoutes } from '../modules/registry'

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

describe('版面：側欄分群', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    window.localStorage.clear()
    resetFocusMode()
    setMobile(false)
  })

  it('groupNav：沒指定 group 的放「設定」，群內依 order 排序，hidden 不進側欄', () => {
    const g = groupNav([
      { to: '/b', key: 'b', group: 'work', order: 20 },
      { to: '/x', key: 'x' },
      { to: '/h', key: 'h', group: 'work', hidden: true },
      { to: '/a', key: 'a', group: 'work', order: 10 },
    ])
    expect(g.map((x) => x.group)).toEqual(['work', 'settings'])
    expect(g[0].items.map((i) => i.key)).toEqual(['a', 'b'])
    expect(g[1].items[0].key).toBe('x')
  })

  it('五個群組都在側欄；只剩每天會用的連結，其他藏進「設定」', async () => {
    renderApp(<App />, { route: '/' })
    const sidebar = await screen.findByTestId('sidebar')
    for (const g of ['today', 'chat', 'work', 'agents', 'settings']) expect(within(sidebar).getByTestId(`nav-group-${g}`)).toBeInTheDocument()
    const hrefs = within(sidebar).getAllByRole('link').map((a) => a.getAttribute('href'))
    const visible = ['/today', '/workbench', '/doc-mode', '/groupchat', '/inbox', '/workflows', '/kanban', '/docs', '/packs', '/coding', '/agents', '/skills', '/models', '/settings']
    for (const p of visible) expect(hrefs).toContain(p)
    // 藏起來的：不進側欄，但頁標題仍解析得到，且會列在設定總覽
    const hidden = ['/profiles', '/channels', '/cron', '/files', '/usage', '/limits', '/theme', '/logs', '/voice', '/admin', '/compat', '/events', '/search', '/soul-history']
    for (const p of hidden) expect(hrefs).not.toContain(p)
    expect(hrefs).not.toContain('/')
    expect(hrefs).toHaveLength(visible.length)
    for (const p of hidden) expect(activeNavItem(p, allNav)?.hidden, p).toBe(true)
    expect(activeNavItem('/usage', allNav)?.key).toBe('usage')
    expect(activeNavItem('/workbench', allNav)?.key).toBe('workbench')
    expect(within(within(sidebar).getByTestId('nav-group-chat')).getByText('工作臺')).toBeInTheDocument()
    expect(within(within(sidebar).getByTestId('nav-group-settings')).getByRole('link', { name: '設定' })).toHaveAttribute('href', '/settings')
    // 「今天」是單一入口，不畫群標題
    expect(within(within(sidebar).getByTestId('nav-group-today')).queryByRole('heading')).not.toBeInTheDocument()
  })

  it('藏起來的頁面：頂欄標題仍正確，設定總覽有它的入口', async () => {
    renderApp(<App />, { route: '/usage' })
    expect(await screen.findByTestId('page-title')).toHaveTextContent('用量')
    expect(within(screen.getByTestId('sidebar')).queryByRole('link', { name: '用量' })).not.toBeInTheDocument()
    renderApp(<App />, { route: '/settings' })
    expect(await screen.findByTestId('settings-tile-usage')).toHaveAttribute('href', '/usage')
    expect(screen.getByTestId('settings-tile-channels')).toHaveAttribute('href', '/channels')
    expect(screen.getByTestId('settings-tile-profiles')).toHaveAttribute('href', '/profiles')
  })

  it('展開／收合記到 localStorage，收合後只剩圖示', async () => {
    renderApp(<App />, { route: '/kanban' })
    const user = userEvent.setup()
    const sidebar = await screen.findByTestId('sidebar')
    expect(sidebar.dataset.expanded).toBe('true')
    expect(within(sidebar).getByText('看板')).toBeInTheDocument()
    await user.click(screen.getByTestId('sidebar-toggle'))
    expect(sidebar.dataset.expanded).toBe('false')
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe('collapsed')
    expect(within(sidebar).queryByText('看板')).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('link', { name: '看板' })).toHaveAttribute('title', '看板')
    await user.click(screen.getByTestId('sidebar-toggle'))
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe('expanded')
  })

  it('重新載入時沿用 localStorage 的收合狀態', async () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'collapsed')
    renderApp(<App />, { route: '/' })
    expect((await screen.findByTestId('sidebar')).dataset.expanded).toBe('false')
  })

  it('主導覽可以拖曳調寬，寬度記到 mhc.panel.nav', async () => {
    renderApp(<App />, { route: '/kanban' })
    const sidebar = await screen.findByTestId('sidebar')
    expect(sidebar).toHaveStyle({ width: '224px' })
    const sep = screen.getByTestId('sidebar-resizer')
    expect(sep).toHaveAttribute('role', 'separator')
    fireEvent.pointerDown(sep, { button: 0, clientX: 224, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(sep, { clientX: 300, pointerId: 1 })
    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '300px' })
    expect(JSON.parse(window.localStorage.getItem(panelKey(NAV_PANEL_ID))!)).toMatchObject({ width: 300 })
    // 鍵盤也可以
    fireEvent.keyDown(screen.getByTestId('sidebar-resizer'), { key: 'ArrowLeft' })
    expect(screen.getByTestId('sidebar')).toHaveStyle({ width: '284px' })
  })

  it('專注模式：頂欄鈕與 ⌘. 都會收起主導覽，再按一次還原', async () => {
    const user = userEvent.setup()
    renderApp(<App />, { route: '/kanban' })
    const sidebar = await screen.findByTestId('sidebar')
    expect(sidebar.dataset.expanded).toBe('true')

    await user.click(screen.getByTestId('focus-toggle'))
    expect(screen.getByTestId('sidebar').dataset.expanded).toBe('false')
    expect(screen.getByTestId('focus-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(window.localStorage.getItem('mhc.focus')).toBe('1')
    // 主區的側欄（看板篩選）也一起收起來
    expect(screen.getByTestId('panel-expand-kanban.filters')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: '.', metaKey: true })
    expect(screen.getByTestId('sidebar').dataset.expanded).toBe('true')
    expect(screen.getByTestId('focus-toggle')).toHaveAttribute('aria-pressed', 'false')
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(screen.getByTestId('sidebar').dataset.expanded).toBe('false')
    // 專注模式不會覆寫使用者原本的側欄偏好
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull()
  })

  it('頂欄：當前頁標題、搜尋鈕派 Ctrl+K、收件匣 badge 可缺省', async () => {
    renderApp(<App />, { route: '/kanban' })
    expect(await screen.findByTestId('page-title')).toHaveTextContent('看板')
    expect(activeNavItem('/workflows/runs/abc', allNav)?.key).toBe('workflows')
    const seen: KeyboardEvent[] = []
    const h = (e: KeyboardEvent) => seen.push(e)
    window.addEventListener('keydown', h)
    fireEvent.click(screen.getByTestId('search-button'))
    window.removeEventListener('keydown', h)
    expect(seen.some((e) => e.key === 'k' && e.ctrlKey)).toBe(true)
    expect(screen.queryByTestId('inbox-badge')).not.toBeInTheDocument()
    window.dispatchEvent(new CustomEvent(INBOX_EVENT, { detail: { count: 3 } }))
    expect(await screen.findByTestId('inbox-badge')).toHaveTextContent('3')
    const hasInbox = moduleRoutes.some((r) => r.path === '/inbox')
    expect(screen.getByTestId('inbox-button')).toHaveAttribute('href', hasInbox ? '/inbox' : '/workflows/approvals')
  })

  it('主題切換寫 data-theme，使用者選單可登出', async () => {
    renderApp(<App />, { route: '/' })
    const user = userEvent.setup()
    await screen.findByTestId('sidebar')
    document.documentElement.removeAttribute('data-theme')
    await user.click(screen.getByTestId('theme-toggle'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    await user.click(screen.getByTestId('theme-toggle'))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    await user.click(screen.getByTestId('user-menu-button'))
    await user.click(screen.getByRole('menuitem', { name: /登出/ }))
    expect(await screen.findByRole('button', { name: '登入' })).toBeInTheDocument()
  })
})

describe('版面：手機抽屜', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    setMobile(true)
  })
  afterEach(() => setMobile(false))

  it('手機不顯示側欄，漢堡鍵打開抽屜、點連結後關閉', async () => {
    renderApp(<App />, { route: '/' })
    const user = userEvent.setup()
    expect(await screen.findByTestId('menu-button')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('menu-button'))
    const drawer = await screen.findByTestId('drawer')
    expect(within(drawer).getByTestId('sidebar').dataset.expanded).toBe('true')
    await user.click(within(drawer).getByRole('link', { name: '看板' }))
    await waitFor(() => expect(screen.queryByTestId('drawer')).not.toBeInTheDocument())
    expect(screen.getByTestId('page-title')).toHaveTextContent('看板')
    await user.click(screen.getByTestId('menu-button'))
    await user.click(await screen.findByTestId('drawer-backdrop'))
    await waitFor(() => expect(screen.queryByTestId('drawer')).not.toBeInTheDocument())
  })
})
