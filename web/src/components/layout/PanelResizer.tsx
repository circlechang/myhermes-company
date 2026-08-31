import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { clampWidth } from './panelState'

export interface PanelResizerProps {
  side: 'left' | 'right'
  width: number
  min: number
  max: number
  /** 拖曳結束／鍵盤調整後回報最終寬度 */
  onWidth: (w: number) => void
  /** 拖曳過程中即時套用（通常直接改 DOM style，避免每格 re-render） */
  onPreview?: (w: number) => void
  label: string
  onCollapse?: () => void
  onReset?: () => void
  'data-testid'?: string
}

const STEP = 16

/** 面板邊界拖曳把手：滑鼠拖、鍵盤 ←/→ 調寬，並回報 aria-valuenow */
export function PanelResizer({ side, width, min, max, onWidth, onPreview, label, onCollapse, onReset, 'data-testid': testId }: PanelResizerProps) {
  const drag = useRef<{ startX: number; startW: number; cur: number } | null>(null)

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (typeof e.button === 'number' && e.button > 0) return
    e.preventDefault()
    drag.current = { startX: e.clientX, startW: width, cur: width }
    try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* jsdom／舊瀏覽器沒有 pointer capture */ }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [width])

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      const delta = e.clientX - d.startX
      const next = clampWidth(side === 'left' ? d.startW + delta : d.startW - delta, min, max)
      d.cur = next
      e.currentTarget.setAttribute('aria-valuenow', String(next))
      onPreview?.(next)
    },
    [side, min, max, onPreview],
  )

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      drag.current = null
      try { e.currentTarget.releasePointerCapture?.(e.pointerId) } catch { /* 同上 */ }
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      onWidth(d.cur)
    },
    [onWidth],
  )

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft'
      const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight'
      if (e.key === grow) { e.preventDefault(); onWidth(clampWidth(width + STEP, min, max)) }
      else if (e.key === shrink) { e.preventDefault(); onWidth(clampWidth(width - STEP, min, max)) }
      else if (e.key === 'Home') { e.preventDefault(); onWidth(min) }
      else if (e.key === 'End') { e.preventDefault(); onWidth(max) }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCollapse?.() }
    },
    [side, width, min, max, onWidth, onCollapse],
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onReset?.()}
      className={`absolute inset-y-0 z-20 w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-indigo-400/60 focus:bg-indigo-500 focus:outline-none ${
        side === 'left' ? '-right-[3px]' : '-left-[3px]'
      }`}
    />
  )
}
