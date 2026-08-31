import type { ReactNode } from 'react'

/** 面板列：左面板 ＋ WorkArea ＋ 右面板，橫向排。高度吃滿父層。 */
export function PanelGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex h-full min-h-0 w-full ${className}`}>{children}</div>
}

/**
 * 中間主區：永遠 min-w-0，側欄再寬也不會被擠到 0 或撐出橫向捲動。
 * 捲動由呼叫端決定（`className="overflow-auto"`），因為有些頁面自己管內部捲動。
 */
export function WorkArea({ children, className = '', 'data-testid': testId }: { children: ReactNode; className?: string; 'data-testid'?: string }) {
  return (
    <section data-testid={testId} data-work-area className={`flex min-h-0 min-w-0 flex-1 flex-col ${className}`}>
      {children}
    </section>
  )
}
