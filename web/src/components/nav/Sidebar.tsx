import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { NavGroup, NavItem } from '../../modules/registry'
import { iconFor } from './icons'

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
  return (
    <nav
      aria-label={t('nav.sidebar')}
      data-testid="sidebar"
      data-tour="sidebar"
      data-expanded={wide ? 'true' : 'false'}
      className={`flex h-full flex-col border-r border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-900 ${wide ? 'w-56' : 'w-14'} transition-[width] duration-150`}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {groups.map((g) => (
          <section key={g.group} data-testid={`nav-group-${g.group}`} className="mb-2">
            {wide ? (
              <h2 className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{t(`nav.group.${g.group}`)}</h2>
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
    </nav>
  )
}
