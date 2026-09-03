// 「＋ 加一步」：只有三種動作（請員工做／等我看／送出去），每一項一句白話說明。
// 分岔、迴圈是工程師的事，開了工程師模式才多出來。
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEngineerMode } from '../../../prefs/engineerMode'
import { ENGINEER_KINDS, STATION_KINDS } from './describe'
import type { NodeKind } from '../types'

export function AddStationMenu({
  onPick,
  label,
  testId = 'add-station',
  variant = 'outline',
}: {
  onPick: (kind: NodeKind) => void
  label?: string
  testId?: string
  variant?: 'outline' | 'ghost'
}) {
  const { t } = useTranslation()
  const engineer = useEngineerMode()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const kinds = engineer ? [...STATION_KINDS, ...ENGINEER_KINDS] : STATION_KINDS
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className={`relative inline-block ${open ? 'z-40' : ''}`} ref={box}>
      <button
        type="button"
        className={variant === 'ghost' ? 'btn-ghost !py-0.5 text-xs !text-inherit' : 'btn-outline'}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
      >
        {label ?? t('wf.station.addStation')}
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`${testId}-menu`}
          className="absolute left-0 z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div className="border-b border-zinc-200 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">{t('wf.station.pickKind')}</div>
          <ul>
            {kinds.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`${testId}-${k}`}
                  className="block w-full px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  onClick={() => { setOpen(false); onPick(k) }}
                >
                  <span className="block text-sm font-medium">{t(`wf.station.kinds.${k}`)}</span>
                  <span className="block text-xs text-zinc-600 dark:text-zinc-400">{t(`wf.station.kindHints.${k}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
