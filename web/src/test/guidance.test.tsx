import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { EmptyState } from '../components/EmptyState'
import { TOUR_KEY, TOUR_STEPS } from '../components/guide/Tour'
import { allNav } from '../components/nav/navConfig'
import { helpFor } from '../help'
import { renderApp, setupMocks } from './utils'

// Node 25 內建 localStorage 會蓋掉 jsdom 的；用記憶體版（同 layout.test.tsx）
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

describe('首次導覽（Tour）', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    window.localStorage.removeItem(TOUR_KEY)
  })

  it('第一次登入自動出現，跳過後寫 mhc.tour.done 且不再出現', async () => {
    const { unmount } = renderApp(<App />, { route: '/' })
    const tour = await screen.findByTestId('tour')
    expect(tour.dataset.step).toBe('sidebar')
    expect(within(tour).getByText('側欄分五群')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByTestId('tour-skip'))
    expect(screen.queryByTestId('tour')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('1')
    unmount()
    renderApp(<App />, { route: '/' })
    await screen.findByTestId('sidebar')
    expect(screen.queryByTestId('tour')).not.toBeInTheDocument()
  })

  it('每一步都可走完，最後一步是「完成」，每步都對到真實元素', async () => {
    renderApp(<App />, { route: '/' })
    const user = userEvent.setup()
    const tour = await screen.findByTestId('tour')
    for (let i = 0; i < TOUR_STEPS.length; i++) {
      expect(tour.dataset.step).toBe(TOUR_STEPS[i].key)
      expect(document.querySelector(TOUR_STEPS[i].selector)).not.toBeNull()
      expect(screen.getByText(`第 ${i + 1} 步，共 ${TOUR_STEPS.length} 步`)).toBeInTheDocument()
      if (i < TOUR_STEPS.length - 1) await user.click(screen.getByTestId('tour-next'))
    }
    await user.click(screen.getByTestId('tour-done'))
    expect(screen.queryByTestId('tour')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(TOUR_KEY)).toBe('1')
  })

  it('已看過時不出現；使用者選單「重看導覽」可再開', async () => {
    window.localStorage.setItem(TOUR_KEY, '1')
    renderApp(<App />, { route: '/kanban' })
    const user = userEvent.setup()
    await screen.findByTestId('sidebar')
    expect(screen.queryByTestId('tour')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('user-menu-button'))
    await user.click(screen.getByTestId('replay-tour'))
    expect((await screen.findByTestId('tour')).dataset.step).toBe('sidebar')
  })
})

describe('「？」說明抽屜', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    window.localStorage.setItem(TOUR_KEY, '1')
  })

  it('內容依當前路由切換（工作臺 → 看板 → 工作流）', async () => {
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    await screen.findByTestId('sidebar')
    await user.click(screen.getByTestId('help-button'))
    expect(await screen.findByTestId('help-title')).toHaveTextContent('工作臺')
    expect(screen.getByText('這頁做什麼')).toBeInTheDocument()
    expect(screen.getByText('常見問題')).toBeInTheDocument()
    await user.click(screen.getByTestId('help-close'))
    expect(screen.queryByTestId('help-drawer')).not.toBeInTheDocument()
    await user.click(within(screen.getByTestId('sidebar')).getByRole('link', { name: '看板' }))
    await user.click(screen.getByTestId('help-button'))
    expect(await screen.findByTestId('help-title')).toHaveTextContent('看板')
    // 相關頁連結可導頁並關閉抽屜；/inbox 已併進「今天」（路由直接轉過去），所以說明標題是「今天」
    await user.click(within(screen.getByTestId('help-drawer')).getByRole('link', { name: '收件匣' }))
    expect(screen.queryByTestId('help-drawer')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('help-button'))
    expect(await screen.findByTestId('help-title')).toHaveTextContent('今天')
  })

  it('helpFor：側欄每一條路由都有說明；子路徑用最長前綴', () => {
    for (const it of allNav) expect(helpFor(it.to)?.path, it.to).toBeDefined()
    expect(helpFor('/workflows/abc')?.path).toBe('/workflows')
    expect(helpFor('/workflows/approvals')?.path).toBe('/workflows/approvals')
    expect(helpFor('/workflows/runs/xyz')?.path).toBe('/workflows/runs')
    expect(helpFor('/workbench', 'en')?.title).toBe('Workbench')
    expect(helpFor('/today')?.title).toBe('今天')
    expect(helpFor('/nope')).toBeUndefined()
  })
})

describe('空狀態卡（EmptyState）', () => {
  it('渲染標題／說明／主要按鈕，按鈕觸發動作', () => {
    const onClick = vi.fn()
    renderApp(<EmptyState title="還沒有對話" body="選好員工後開一個新對話" action={{ label: '＋ 建立新對話', onClick }} />)
    expect(screen.getByTestId('empty-state')).toHaveTextContent('還沒有對話')
    expect(screen.getByText('選好員工後開一個新對話')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('empty-state-action'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('action.to 時是連結', () => {
    renderApp(<EmptyState title="空" action={{ label: '前往', to: '/workflows' }} />)
    expect(screen.getByTestId('empty-state-action')).toHaveAttribute('href', '/workflows')
  })

  it('工作臺沒選對話時顯示空狀態卡', async () => {
    setupMocks({ loggedIn: true })
    window.localStorage.setItem(TOUR_KEY, '1')
    renderApp(<App />, { route: '/workbench' })
    expect(await screen.findByTestId('empty-sessions')).toHaveTextContent('還沒有對話')
  })
})
