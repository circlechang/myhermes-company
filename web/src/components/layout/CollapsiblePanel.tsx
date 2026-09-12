import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { iconFor } from '../nav/icons'
import { useIsMobile, useNarrowerThan } from '../nav/useNavState'
import { PanelResizer } from './PanelResizer'
import { usePanelState, useFocusMode } from './panelState'

const ChevronLeft = iconFor('ChevronLeft')
const ChevronRight = iconFor('ChevronRight')
const CloseIcon = iconFor('X')

/**
 * 手機（<768px）怎麼擺這個面板：
 * - sheet：主區不留位置，右下角一顆藥丸鈕，點開變全螢幕的頁（有自己的標題列＋✕）
 * - inline：直接當主內容鋪滿（清單優先的頁面：沒選東西時清單就是整頁）
 * - hidden：手機不畫（桌面才有意義的資訊欄）
 */
export type PanelMobileMode = 'sheet' | 'inline' | 'hidden'

export interface CollapsiblePanelProps {
  /** localStorage 鍵：mhc.panel.<id>，每頁自己一組，別跨頁重用 */
  id: string
  side: 'left' | 'right'
  /** 面板標題：收合時會直排顯示在把手上，也是 aria 文字的主詞 */
  title: string
  defaultWidth?: number
  min?: number
  max?: number
  /** lucide 圖示名稱（見 nav/icons.ts），收合時顯示在把手上 */
  icon?: string
  children: ReactNode
  /** 額外類別：加在 <aside> 上（背景、padding 之類） */
  className?: string
  /** 內容區的類別（預設 overflow-auto；自己傳的話要自帶 overflow） */
  bodyClassName?: string
  /** 第一次進來（還沒有 localStorage）時預設收合 */
  defaultCollapsed?: boolean
  /** 標題列上的額外動作 */
  actions?: ReactNode
  /**
   * 視窗窄於這個寬度就自動改成「窄把手＋抽屜」，不再佔掉主區。
   * 預設沿用改版前的斷點：左欄 768（md）、右欄 1024（lg）。
   */
  expandFrom?: number
  /** 手機模式（預設 sheet）；桌面與平板不受影響 */
  mobileMode?: PanelMobileMode
  /** sheet 模式：一掛上來就先打開（例如有一步等你看） */
  defaultOpenOnMobile?: boolean
  /** sheet 模式受控開關：頁面自己記狀態（切分頁重掛時不會又彈出來） */
  mobileOpen?: boolean
  onMobileOpenChange?: (open: boolean) => void
  'data-testid'?: string
}

export function CollapsiblePanel({
  id,
  side,
  title,
  defaultWidth = 260,
  min = 180,
  max = 520,
  icon,
  children,
  className = '',
  bodyClassName = 'overflow-auto',
  defaultCollapsed = false,
  actions,
  expandFrom,
  mobileMode = 'sheet',
  defaultOpenOnMobile = false,
  mobileOpen: mobileOpenProp,
  onMobileOpenChange,
  'data-testid': testId,
}: CollapsiblePanelProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const narrow = useNarrowerThan(expandFrom ?? (side === 'right' ? 1024 : 768))
  // 平板／窄視窗（不是手機）：面板不佔主區，改成窄把手＋抽屜
  const mobile = isMobile || narrow
  const focus = useFocusMode()
  const [state, patch] = usePanelState(id, defaultWidth, min, max, defaultCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  // 手機 sheet 的開關：受控（mobileOpen 有傳）就聽頁面的，否則自己記
  const [sheetOpenLocal, setSheetOpenLocal] = useState(defaultOpenOnMobile)
  const sheetOpen = mobileOpenProp ?? sheetOpenLocal
  const setSheetOpen = (v: boolean) => {
    if (mobileOpenProp === undefined) setSheetOpenLocal(v)
    onMobileOpenChange?.(v)
  }
  const asideRef = useRef<HTMLElement | null>(null)

  // 專注模式開著時，手機抽屜也一起關掉；切回桌面同理
  useEffect(() => {
    if (focus) setMobileOpen(false)
  }, [focus])
  useEffect(() => {
    if (!mobile) setMobileOpen(false)
  }, [mobile])

  const collapsed = focus || state.collapsed
  const Icon = iconFor(icon ?? (side === 'left' ? 'PanelLeftOpen' : 'PanelRightOpen'))
  const border = side === 'left' ? 'border-r' : 'border-l'
  const expandLabel = t('panel.expand', { title })
  const collapseLabel = t('panel.collapse', { title })

  const header = (
    <div className="flex h-8 shrink-0 items-center gap-1 px-2">
      {side === 'right' && (
        <CollapseBtn id={id} side={side} label={collapseLabel} onClick={() => (mobile ? setMobileOpen(false) : patch({ collapsed: true }))} />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400" title={title}>
        {title}
      </span>
      {actions}
      {side === 'left' && (
        <CollapseBtn id={id} side={side} label={collapseLabel} onClick={() => (mobile ? setMobileOpen(false) : patch({ collapsed: true }))} />
      )}
    </div>
  )

  const body = (
    <div id={`panel-body-${id}`} className={`min-h-0 min-w-0 flex-1 ${bodyClassName}`}>
      {children}
    </div>
  )

  // ---- 手機：絕不畫直排文字的窄條（390px 上那條看不懂也點不到）------------
  if (isMobile) {
    if (mobileMode === 'hidden') return null
    if (mobileMode === 'inline') {
      return (
        <aside
          data-testid={testId}
          data-panel={id}
          data-collapsed="false"
          data-mobile="inline"
          aria-label={title}
          className={`flex min-h-0 min-w-0 flex-1 flex-col ${className}`}
        >
          {body}
        </aside>
      )
    }
    const closeLabel = t('panels.closeSheet', { title })
    const open = sheetOpen && !focus
    return (
      <>
        {/* 右下角藥丸：面板的入口，永遠在（sheet 蓋住時看不到，但關掉就回來） */}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-expanded={open}
          aria-controls={`panel-body-${id}`}
          data-testid={`panel-open-${id}`}
          className="fixed right-4 z-30 flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <Icon className="h-4 w-4" aria-hidden />
          <span className="max-w-[40vw] truncate">{title}</span>
        </button>
        {open && (
          <div
            role="dialog"
            aria-label={title}
            data-testid={`panel-sheet-${id}`}
            data-panel={id}
            data-collapsed="false"
            data-mobile="sheet"
            className={`fixed inset-0 z-40 flex flex-col bg-white dark:bg-zinc-900 ${className}`}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={title}>{title}</span>
              {actions}
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label={closeLabel}
                title={closeLabel}
                data-testid={`panel-close-${id}`}
                className="shrink-0 rounded p-1 text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <CloseIcon className="h-5 w-5" aria-hidden />
              </button>
            </div>
            {body}
          </div>
        )}
      </>
    )
  }

  /** 收合後的把手：一條窄邊，圖示＋箭頭＋直排標題，看得到也點得到（不是藏起來找不到） */
  const rail = (
    <aside
      data-testid={testId}
      data-panel={id}
      data-collapsed="true"
      aria-label={title}
      className={`flex w-9 shrink-0 flex-col items-center gap-2 border-zinc-200 bg-zinc-50 py-2 dark:border-zinc-800 dark:bg-zinc-900/40 ${border} ${className}`}
    >
      <button
        type="button"
        onClick={() => (mobile ? setMobileOpen(true) : patch({ collapsed: false }))}
        aria-label={expandLabel}
        title={expandLabel}
        aria-expanded={false}
        aria-controls={`panel-body-${id}`}
        data-testid={`panel-expand-${id}`}
        className="flex flex-col items-center gap-1 rounded p-1 text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <Icon className="h-4 w-4" aria-hidden />
        {side === 'left' ? <ChevronRight className="h-3 w-3" aria-hidden /> : <ChevronLeft className="h-3 w-3" aria-hidden />}
      </button>
      <span aria-hidden className="min-h-0 flex-1 overflow-hidden text-xs font-medium tracking-wide text-zinc-600 [writing-mode:vertical-rl] dark:text-zinc-400">
        {title}
      </span>
    </aside>
  )

  // ---- 平板／窄螢幕：窄把手 ＋ 抽屜，沒有拖曳把手 ------------------------
  if (mobile) {
    return (
      <>
        {rail}
        {mobileOpen && !focus && (
          <div className="fixed inset-0 z-40 flex" data-testid={`panel-drawer-${id}`}>
            <button
              type="button"
              className="absolute inset-0 bg-black/40"
              aria-label={t('common.close')}
              data-testid={`panel-drawer-backdrop-${id}`}
              onClick={() => setMobileOpen(false)}
            />
            <aside
              data-panel={id}
              data-collapsed="false"
              data-drawer="true"
              aria-label={title}
              className={`relative flex h-full w-[85vw] max-w-sm flex-col bg-white shadow-xl dark:bg-zinc-900 ${side === 'left' ? '' : 'ml-auto'} ${className}`}
            >
              {header}
              {body}
            </aside>
          </div>
        )}
      </>
    )
  }

  // ---- 桌面 ---------------------------------------------------------------
  if (collapsed) return rail

  return (
    <aside
      ref={asideRef}
      data-testid={testId}
      data-panel={id}
      data-collapsed="false"
      aria-label={title}
      style={{ width: state.width }}
      className={`relative flex min-h-0 shrink-0 flex-col border-zinc-200 dark:border-zinc-800 ${border} ${className}`}
    >
      {header}
      {body}
      <PanelResizer
        side={side}
        width={state.width}
        min={min}
        max={max}
        label={t('panel.resize', { title })}
        data-testid={`panel-resizer-${id}`}
        onPreview={(w) => {
          // 拖曳期間直接改 style，避免每一格 pointermove 都 re-render＋寫 localStorage
          if (asideRef.current) asideRef.current.style.width = `${w}px`
        }}
        onWidth={(w) => patch({ width: w })}
        onCollapse={() => patch({ collapsed: true })}
        onReset={() => patch({ width: defaultWidth })}
      />
    </aside>
  )
}

function CollapseBtn({ id, side, label, onClick }: { id: string; side: 'left' | 'right'; label: string; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-expanded
      aria-controls={`panel-body-${id}`}
      data-testid={`panel-collapse-${id}`}
      className="shrink-0 rounded p-0.5 text-zinc-600 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  )
}
