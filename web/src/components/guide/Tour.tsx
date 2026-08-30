// 首次導覽：自寫輕量 spotlight（零外連），第一次登入自動開；localStorage `mhc.tour.done`
import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import '../../guide/i18n'

export const TOUR_KEY = 'mhc.tour.done'
export const TOUR_EVENT = 'mhc:tour:start'

/** 步驟：key 對應 guide.tour.steps.<key>；selector 指到有 data-tour 的真實元素 */
export const TOUR_STEPS: { key: string; selector: string }[] = [
  { key: 'sidebar', selector: '[data-tour="sidebar"]' },
  { key: 'workbench', selector: '[data-tour="nav-workbench"]' },
  { key: 'agents', selector: '[data-tour="nav-agents"]' },
  { key: 'workflows', selector: '[data-tour="nav-workflows"]' },
  { key: 'inbox', selector: '[data-tour="nav-inbox"], [data-tour="inbox"]' },
  { key: 'limits', selector: '[data-tour="nav-limits"]' },
]

export function isTourDone(): boolean {
  try { return window.localStorage.getItem(TOUR_KEY) === '1' } catch { return true }
}
export function markTourDone() {
  try { window.localStorage.setItem(TOUR_KEY, '1') } catch { /* ignore */ }
}
/** 任何地方都能重開導覽（使用者選單「重看導覽」） */
export function startTour() {
  window.dispatchEvent(new CustomEvent(TOUR_EVENT))
}

type Rect = { top: number; left: number; width: number; height: number }
const PAD = 6

export function Tour({ autoStart = true }: { autoStart?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(() => autoStart && !isTourDone())
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)

  useEffect(() => {
    const h = () => { setI(0); setOpen(true) }
    window.addEventListener(TOUR_EVENT, h)
    return () => window.removeEventListener(TOUR_EVENT, h)
  }, [])

  const measure = useCallback(() => {
    if (!open) return
    const el = document.querySelector<HTMLElement>(TOUR_STEPS[i].selector)
    if (!el) { setRect(null); return }
    el.scrollIntoView?.({ block: 'nearest' })
    const r = el.getBoundingClientRect()
    setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 })
  }, [open, i])
  useLayoutEffect(measure, [measure])
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, measure])

  const finish = (done: boolean) => { if (done) markTourDone(); else markTourDone(); setOpen(false) }
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false)
      if (e.key === 'ArrowRight' && i < TOUR_STEPS.length - 1) setI(i + 1)
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  if (!open) return null
  const step = TOUR_STEPS[i]
  const last = i === TOUR_STEPS.length - 1
  // popover 位置：目標右側；放不下就置中
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const W = 340
  let pop: CSSProperties = { top: '50%', left: '50%', transform: 'translate(-50%,-50%)' }
  if (rect) {
    const right = rect.left + rect.width + 12
    if (right + W < vw) pop = { top: Math.min(Math.max(rect.top, 12), vh - 220), left: right }
    else pop = { top: Math.min(rect.top + rect.height + 12, vh - 220), left: Math.max(12, Math.min(rect.left, vw - W - 12)) }
  }
  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={t('guide.tour.aria')} data-testid="tour" data-step={step.key}>
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-lg ring-2 ring-indigo-400 transition-all duration-200"
          style={{ ...rect, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
          data-testid="tour-spotlight"
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}
      <div className="card absolute w-[340px] max-w-[calc(100vw-24px)] p-4 shadow-2xl" style={pop} data-testid="tour-popover">
        <div className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('guide.tour.stepOf', { i: i + 1, n: TOUR_STEPS.length })}</div>
        <div className="mt-1 text-base font-semibold">{t(`guide.tour.steps.${step.key}.title`)}</div>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{t(`guide.tour.steps.${step.key}.body`)}</p>
        <div className="mt-4 flex items-center gap-1">
          <div className="flex gap-1" aria-hidden>
            {TOUR_STEPS.map((s, k) => <span key={s.key} className={`h-1.5 w-1.5 rounded-full ${k === i ? 'bg-indigo-500' : 'bg-zinc-300 dark:bg-zinc-700'}`} />)}
          </div>
          <span className="ml-auto" />
          <button type="button" className="btn-ghost text-xs" onClick={() => finish(false)} data-testid="tour-skip">{t('guide.tour.skip')}</button>
          {i > 0 && <button type="button" className="btn-outline text-xs" onClick={() => setI(i - 1)} data-testid="tour-prev">{t('guide.tour.prev')}</button>}
          {last ? (
            <button type="button" className="btn-primary text-xs" onClick={() => finish(true)} data-testid="tour-done">{t('guide.tour.done')}</button>
          ) : (
            <button type="button" className="btn-primary text-xs" onClick={() => setI(i + 1)} data-testid="tour-next">{t('guide.tour.next')}</button>
          )}
        </div>
      </div>
    </div>
  )
}
