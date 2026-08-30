import '@testing-library/jest-dom/vitest'
import '../i18n'

// React Flow（工作流畫布）在 jsdom 需要 ResizeObserver / DOMMatrixReadOnly
if (typeof globalThis.ResizeObserver === 'undefined') {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
}
if (typeof (globalThis as unknown as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly === 'undefined') {
  ;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; constructor(_t?: string) {} }
}
