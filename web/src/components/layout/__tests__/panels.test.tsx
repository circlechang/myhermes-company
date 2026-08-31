import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollapsiblePanel } from '../CollapsiblePanel'
import { PanelGroup, WorkArea } from '../WorkArea'
import { clampWidth, isFocusHotkey, panelKey, readPanel, resetFocusMode, setFocusMode, toggleFocusMode } from '../panelState'
import '../../../i18n'

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

function Demo({ id = 'test.left', side = 'left', defaultWidth = 260, min = 180, max = 520 }: { id?: string; side?: 'left' | 'right'; defaultWidth?: number; min?: number; max?: number }) {
  return (
    <PanelGroup>
      <CollapsiblePanel id={id} side={side} title="測試面板" defaultWidth={defaultWidth} min={min} max={max} data-testid="p">
        <div data-testid="panel-content">內容</div>
      </CollapsiblePanel>
      <WorkArea data-testid="work">主區</WorkArea>
    </PanelGroup>
  )
}

/** 拖曳把手：pointerdown → pointermove → pointerup */
function drag(el: HTMLElement, fromX: number, toX: number) {
  fireEvent.pointerDown(el, { button: 0, clientX: fromX, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: toX, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: toX, pointerId: 1 })
}

beforeEach(() => {
  window.localStorage.clear()
  resetFocusMode()
  setMobile(false)
})
afterEach(cleanup)

describe('CollapsiblePanel：收合與持久化', () => {
  it('預設展開；收合後主區留下明顯的展開把手，狀態寫進 mhc.panel.<id>', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    const panel = screen.getByTestId('p')
    expect(panel.dataset.collapsed).toBe('false')
    expect(panel).toHaveStyle({ width: '260px' })
    expect(screen.getByTestId('panel-content')).toBeInTheDocument()

    await user.click(screen.getByTestId('panel-collapse-test.left'))
    // 收合後：面板變窄條，內容不見，但把手（展開鈕）還在畫面上
    expect(screen.getByTestId('p').dataset.collapsed).toBe('true')
    expect(screen.queryByTestId('panel-content')).not.toBeInTheDocument()
    const handle = screen.getByTestId('panel-expand-test.left')
    expect(handle).toBeVisible()
    expect(handle).toHaveAttribute('aria-label', '展開測試面板')
    expect(JSON.parse(window.localStorage.getItem(panelKey('test.left'))!)).toMatchObject({ collapsed: true })

    await user.click(handle)
    expect(screen.getByTestId('p').dataset.collapsed).toBe('false')
    expect(JSON.parse(window.localStorage.getItem(panelKey('test.left'))!)).toMatchObject({ collapsed: false })
  })

  it('重新掛載沿用 localStorage 的收合與寬度（每頁獨立記憶）', () => {
    window.localStorage.setItem(panelKey('test.left'), JSON.stringify({ collapsed: false, width: 333 }))
    window.localStorage.setItem(panelKey('other.left'), JSON.stringify({ collapsed: true, width: 200 }))
    render(<Demo />)
    expect(screen.getByTestId('p')).toHaveStyle({ width: '333px' })
    cleanup()
    render(<Demo id="other.left" />)
    expect(screen.getByTestId('p').dataset.collapsed).toBe('true')
  })

  it('壞掉的 localStorage 值退回預設，不炸畫面', () => {
    window.localStorage.setItem(panelKey('test.left'), '{ not json')
    render(<Demo />)
    expect(screen.getByTestId('p')).toHaveStyle({ width: '260px' })
    expect(readPanel('nope', { collapsed: false, width: 200 }, 100, 300)).toEqual({ collapsed: false, width: 200 })
  })
})

describe('CollapsiblePanel：拖曳改寬', () => {
  it('左側面板往右拖變寬，放開才寫 localStorage', () => {
    render(<Demo />)
    const sep = screen.getByTestId('panel-resizer-test.left')
    expect(sep).toHaveAttribute('role', 'separator')
    expect(sep).toHaveAttribute('aria-orientation', 'vertical')
    expect(sep).toHaveAttribute('aria-valuenow', '260')
    expect(sep).toHaveAttribute('aria-valuemin', '180')
    expect(sep).toHaveAttribute('aria-valuemax', '520')
    expect(sep.getAttribute('aria-label')).toContain('測試面板')

    // 拖曳中只改 style，不寫 storage
    fireEvent.pointerDown(sep, { button: 0, clientX: 300, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 380, pointerId: 1 })
    expect(screen.getByTestId('p')).toHaveStyle({ width: '340px' })
    expect(window.localStorage.getItem(panelKey('test.left'))).toBeNull()
    fireEvent.pointerUp(sep, { clientX: 380, pointerId: 1 })
    expect(JSON.parse(window.localStorage.getItem(panelKey('test.left'))!)).toMatchObject({ width: 340 })
    expect(screen.getByTestId('p')).toHaveStyle({ width: '340px' })
  })

  it('右側面板方向相反：往左拖才變寬', () => {
    render(<Demo id="test.right" side="right" defaultWidth={300} />)
    drag(screen.getByTestId('panel-resizer-test.right'), 900, 800)
    expect(screen.getByTestId('p')).toHaveStyle({ width: '400px' })
  })

  it('寬度夾在 min／max 之間', () => {
    render(<Demo />)
    const sep = screen.getByTestId('panel-resizer-test.left')
    drag(sep, 300, 1500) // 遠超過 max
    expect(screen.getByTestId('p')).toHaveStyle({ width: '520px' })
    drag(screen.getByTestId('panel-resizer-test.left'), 300, -900) // 遠低於 min
    expect(screen.getByTestId('p')).toHaveStyle({ width: '180px' })
    expect(clampWidth(NaN, 180, 520)).toBe(180)
  })

  it('鍵盤 ←/→ 也能調寬，Home/End 直接到底', () => {
    render(<Demo />)
    const sep = screen.getByTestId('panel-resizer-test.left')
    sep.focus()
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(screen.getByTestId('p')).toHaveStyle({ width: '276px' })
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(screen.getByTestId('p')).toHaveStyle({ width: '244px' })
    fireEvent.keyDown(sep, { key: 'End' })
    expect(sep).toHaveAttribute('aria-valuenow', '520')
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(sep).toHaveAttribute('aria-valuenow', '180')
  })

  it('右側面板的鍵盤方向也相反', () => {
    render(<Demo id="test.right" side="right" defaultWidth={300} />)
    const sep = screen.getByTestId('panel-resizer-test.right')
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(screen.getByTestId('p')).toHaveStyle({ width: '316px' })
  })
})

describe('專注模式', () => {
  it('打開就收起面板，關掉還原原本的展開狀態', () => {
    render(<Demo />)
    expect(screen.getByTestId('p').dataset.collapsed).toBe('false')
    act(() => toggleFocusMode())
    expect(screen.getByTestId('p').dataset.collapsed).toBe('true')
    // 專注模式不覆寫面板自己的記憶
    expect(window.localStorage.getItem(panelKey('test.left'))).toBeNull()
    act(() => toggleFocusMode())
    expect(screen.getByTestId('p').dataset.collapsed).toBe('false')
  })

  it('狀態記在 localStorage 的 mhc.focus', () => {
    setFocusMode(true)
    expect(window.localStorage.getItem('mhc.focus')).toBe('1')
    setFocusMode(false)
    expect(window.localStorage.getItem('mhc.focus')).toBe('0')
  })

  it('⌘. ／ Ctrl+. 認得出來，其他組合不認', () => {
    expect(isFocusHotkey(new KeyboardEvent('keydown', { key: '.', metaKey: true }))).toBe(true)
    expect(isFocusHotkey(new KeyboardEvent('keydown', { key: '.', ctrlKey: true }))).toBe(true)
    expect(isFocusHotkey(new KeyboardEvent('keydown', { key: '.' }))).toBe(false)
    expect(isFocusHotkey(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))).toBe(false)
    expect(isFocusHotkey(new KeyboardEvent('keydown', { key: '.', metaKey: true, shiftKey: true }))).toBe(false)
  })
})

describe('手機（<768px）改抽屜', () => {
  beforeEach(() => setMobile(true))
  afterEach(() => setMobile(false))

  it('平常只有窄把手、沒有拖曳把手；點開變抽屜，點遮罩關閉', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    expect(screen.getByTestId('p').dataset.collapsed).toBe('true')
    expect(screen.queryByTestId('panel-resizer-test.left')).not.toBeInTheDocument()
    expect(screen.queryByTestId('panel-drawer-test.left')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('panel-expand-test.left'))
    const drawer = await screen.findByTestId('panel-drawer-test.left')
    expect(drawer).toBeInTheDocument()
    expect(screen.getByTestId('panel-content')).toBeInTheDocument()
    // 抽屜裡一樣不給拖曳
    expect(screen.queryByTestId('panel-resizer-test.left')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('panel-drawer-backdrop-test.left'))
    expect(screen.queryByTestId('panel-drawer-test.left')).not.toBeInTheDocument()
  })

  it('專注模式下抽屜不會冒出來', async () => {
    const user = userEvent.setup()
    render(<Demo />)
    await user.click(screen.getByTestId('panel-expand-test.left'))
    expect(await screen.findByTestId('panel-drawer-test.left')).toBeInTheDocument()
    act(() => setFocusMode(true))
    expect(screen.queryByTestId('panel-drawer-test.left')).not.toBeInTheDocument()
  })
})

describe('WorkArea', () => {
  it('永遠 min-w-0，側欄再寬也擠不扁', () => {
    render(<Demo />)
    const work = screen.getByTestId('work')
    expect(work.className).toContain('min-w-0')
    expect(work.className).toContain('flex-1')
  })
})
