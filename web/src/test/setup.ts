import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/dom'
import '../i18n'

// findBy／waitFor 預設 1 秒，全套並行時不夠；放寬到 4 秒（只影響等待上限，不拖慢通過的測試）
configure({ asyncUtilTimeout: 4000 })

// React Flow（工作流畫布）在 jsdom 需要 ResizeObserver / DOMMatrixReadOnly
if (typeof globalThis.ResizeObserver === 'undefined') {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
}
if (typeof (globalThis as unknown as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly === 'undefined') {
  ;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; constructor(_t?: string) {} }
}

// Node 25 內建的 localStorage 會蓋掉 jsdom 的，沒有 --localstorage-file 就丟
// "Cannot initialize local storage without a `--localstorage-file` path"。
// 全域換成記憶體版，讓所有測試都能用 localStorage/sessionStorage。
function memStorage(): Storage {
  let m = new Map<string, string>()
  return {
    get length() { return m.size },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => { m = new Map() },
  } as Storage
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: memStorage() })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, { configurable: true, writable: true, value: (globalThis as never as Record<string, Storage>)[name] })
  }
}

// jsdom 沒有 PointerEvent：面板拖曳把手的測試要拿得到 button / clientX / pointerId
if (typeof (globalThis as unknown as { PointerEvent?: unknown }).PointerEvent === 'undefined') {
  class PE extends MouseEvent {
    pointerId: number
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
    }
  }
  ;(globalThis as unknown as { PointerEvent: unknown }).PointerEvent = PE
  if (typeof window !== 'undefined') (window as unknown as { PointerEvent: unknown }).PointerEvent = PE
}
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
}
