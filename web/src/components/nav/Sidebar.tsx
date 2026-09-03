import { useRef } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { NavGroup, NavItem } from '../../modules/registry'
import { PanelResizer } from '../layout/PanelResizer'
import { usePanelState } from '../layout/panelState'
import { iconFor } from './icons'

export const NAV_PANEL_ID = 'nav'
export const NAV_DEFAULT_WIDTH = 224
export const NAV_MIN_WIDTH = 180
export const NAV_MAX_WIDTH = 360

interface Props {
  groups: { group: NavGroup; items: NavItem[] }[]
  expanded: boolean
  onToggle?: () => void
  /** 手機抽屜模式：永遠顯示文字，點連結後關閉 */
  drawer?: boolean
  onNavigate?: () => void
}

export function Sidebar({ groups, expanded, onToggle, drawer = false, onNavigate }: Props) {
  const { t } = useTranslation()
  const wide = drawer || expanded
  const Toggle = iconFor(expanded ? 'PanelLeftClose' : 'PanelLeftOpen')
  const navRef = useRef<HTMLElement | null>(null)
  const [panel, patchPanel] = usePanelState(NAV_PANEL_ID, NAV_DEFAULT_WIDTH, NAV_MIN_WIDTH, NAV_MAX_WIDTH)
  // 抽屜與收合狀態不吃自訂寬度（抽屜自己滿版、收合是固定窄條）
  const resizable = wide && !drawer
  const title = t('nav.sidebar')
  return (
    <nav
      ref={navRef}
      aria-label={title}
      data-testid="sidebar"
      data-tour="sidebar"
      data-expanded={wide ? 'true' : 'false'}
      style={resizable ? { width: panel.width } : undefined}
      className={`relative flex h-full flex-col border-r border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-900 ${
        resizable ? 'shrink-0' : wide ? 'w-56' : 'w-14'
      }`}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {groups.map((g) => (
          <section key={g.group} data-testid={`nav-group-${g.group}`} className="mb-2">
            {/* 「今天」只有一項：不畫群標題，直接是最上面的入口 */}
            {g.group === 'today' ? null : wide ? (
              <h2 className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{t(`nav.group.${g.group}`)}</h2>
            ) : (
              <div className="mx-3 my-2 border-t border-zinc-200 dark:border-zinc-800" aria-hidden />
            )}
            <ul>
              {g.items.map((it) => {
                const Icon = iconFor(it.icon)
                const label = t(`nav.${it.key}`)
                return (
                  <li key={it.to}>
                    <NavLink
                      to={it.to}
                      end={it.to === '/'}
                      title={wide ? undefined : label}
                      aria-label={label}
                      data-tour={`nav-${it.key}`}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        `mx-2 my-0.5 flex items-center gap-3 rounded-md px-2 py-1.5 ${wide ? '' : 'justify-center'} ${
                          isActive
                            ? 'bg-zinc-200 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50'
                            : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                        }`
                      }
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      {wide && <span className="truncate">{label}</span>}
                    </NavLink>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      {!drawer && onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-label={t(expanded ? 'nav.collapse' : 'nav.expand')}
          aria-expanded={expanded}
          data-testid="sidebar-toggle"
          className={`m-2 flex shrink-0 items-center gap-3 rounded-md border-t border-zinc-200 px-2 py-1.5 text-zinc-600 dark:text-zinc-400 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 ${wide ? '' : 'justify-center'}`}
        >
          <Toggle className="h-4 w-4" aria-hidden />
          {wide && <span>{t('nav.collapse')}</span>}
        </button>
      )}
      {resizable && (
        <PanelResizer
          side="left"
          width={panel.width}
          min={NAV_MIN_WIDTH}
          max={NAV_MAX_WIDTH}
          label={t('panel.resize', { title })}
          data-testid="sidebar-resizer"
          onPreview={(w) => {
            if (navRef.current) navRef.current.style.width = `${w}px`
          }}
          onWidth={(w) => patchPanel({ width: w })}
          onCollapse={onToggle}
          onReset={() => patchPanel({ width: NAV_DEFAULT_WIDTH })}
        />
      )}
    </nav>
  )
}
