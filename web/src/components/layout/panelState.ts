import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** 每個面板一組狀態（收合＋寬度），存 localStorage 的 mhc.panel.<id>，每頁獨立記憶 */
export const PANEL_PREFIX = 'mhc.panel.'
/** 專注模式：一鍵收起所有側欄（含主導覽） */
export const FOCUS_KEY = 'mhc.focus'

export interface PanelState {
  collapsed: boolean
  width: number
}

export const panelKey = (id: string) => `${PANEL_PREFIX}${id}`

export function clampWidth(w: number, min: number, max: number): number {
  if (!Number.isFinite(w)) return min
  return Math.max(min, Math.min(max, Math.round(w)))
}

export function readPanel(id: string, fallback: PanelState, min: number, max: number): PanelState {
  try {
    const raw = window.localStorage.getItem(panelKey(id))
    if (!raw) return fallback
    const v = JSON.parse(raw) as Partial<PanelState>
    return {
      collapsed: typeof v.collapsed === 'boolean' ? v.collapsed : fallback.collapsed,
      width: clampWidth(typeof v.width === 'number' ? v.width : fallback.width, min, max),
    }
  } catch {
    return fallback
  }
}

export function writePanel(id: string, s: PanelState): void {
  try {
    window.localStorage.setItem(panelKey(id), JSON.stringify(s))
  } catch {
    /* ignore（無痕模式／被封鎖時只是不記憶，不該壞畫面） */
  }
}

/** 面板狀態：初值讀 localStorage，之後每次變更都寫回去 */
export function usePanelState(id: string, defaultWidth: number, min: number, max: number, defaultCollapsed = false) {
  const init = (): PanelState => readPanel(id, { collapsed: defaultCollapsed, width: clampWidth(defaultWidth, min, max) }, min, max)
  const [state, setState] = useState<PanelState>(init)
  // 換 id（同一個元件被不同頁面重用）時重讀
  const lastId = useRef(id)
  useEffect(() => {
    if (lastId.current === id) return
    lastId.current = id
    setState(init())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const patch = useCallback(
    (p: Partial<PanelState>) => {
      setState((prev) => {
        const next: PanelState = {
          collapsed: p.collapsed ?? prev.collapsed,
          width: clampWidth(p.width ?? prev.width, min, max),
        }
        if (next.collapsed === prev.collapsed && next.width === prev.width) return prev
        writePanel(id, next)
        return next
      })
    },
    [id, min, max],
  )
  return [state, patch] as const
}

// ---- 專注模式（全域小 store，讓主導覽與所有面板同步）------------------------

let focusOn = false
let focusRead = false
const listeners = new Set<() => void>()

function loadFocus(): boolean {
  try {
    return window.localStorage.getItem(FOCUS_KEY) === '1'
  } catch {
    return false
  }
}

export function isFocusMode(): boolean {
  if (!focusRead) {
    focusRead = true
    focusOn = loadFocus()
  }
  return focusOn
}

export function setFocusMode(v: boolean): void {
  focusRead = true
  if (focusOn === v) return
  focusOn = v
  try {
    window.localStorage.setItem(FOCUS_KEY, v ? '1' : '0')
  } catch {
    /* ignore */
  }
  for (const l of [...listeners]) l()
}

export function toggleFocusMode(): void {
  setFocusMode(!isFocusMode())
}

/** 測試用：把 store 打回未讀狀態，下一次讀取會重新看 localStorage */
export function resetFocusMode(): void {
  focusRead = false
  focusOn = false
  for (const l of [...listeners]) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useFocusMode(): boolean {
  return useSyncExternalStore(subscribe, isFocusMode, () => false)
}

/** ⌘. ／ Ctrl+. ：任何頁面都能一鍵收起／還原所有側欄 */
export const FOCUS_HOTKEY_HINT = '⌘.'
export function isFocusHotkey(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === '.' || e.code === 'Period')
}
