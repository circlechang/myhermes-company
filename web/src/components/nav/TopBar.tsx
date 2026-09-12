import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IS_MOCK, request } from '../../api/client'
import { moduleRoutes } from '../../modules/registry'
import { applyTheme, loadCachedTheme, THEME_DEFAULTS } from '../../modules/theme'
import { LangSwitch } from '../LangSwitch'
import { toggleFocusMode, useFocusMode } from '../layout/panelState'
import { HelpDrawer } from '../guide/HelpDrawer'
import { startTour, Tour } from '../guide/Tour'
import '../../guide/i18n'
import { iconFor } from './icons'

const SearchIcon = iconFor('Search')
const InboxIcon = iconFor('Inbox')
const MenuIcon = iconFor('Menu')
const LogOutIcon = iconFor('LogOut')
const SunIcon = iconFor('Sun')
const MoonIcon = iconFor('Moon')
const HelpIcon = iconFor('HelpCircle')
const TourIcon = iconFor('Compass')
const UpIcon = iconFor('ArrowUpCircle')
const FocusOnIcon = iconFor('Maximize2')
const FocusOffIcon = iconFor('Minimize2')

/** 觸發聊天模組既有的 Ctrl/⌘+K 監聽（WorkbenchPage 掛在 window keydown） */
export function openGlobalSearch() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))
}

export const INBOX_EVENT = 'mhc:inbox'
const hasInboxRoute = moduleRoutes.some((r) => r.path === '/inbox')

/** 收件匣數字：/inbox 模組存在就打 /inbox/count；任何人也可 dispatch CustomEvent(INBOX_EVENT,{detail:{count}}) */
function useInboxCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const h = (e: Event) => {
      const c = Number((e as CustomEvent<{ count?: number }>).detail?.count ?? 0)
      setCount(Number.isFinite(c) ? c : 0)
    }
    window.addEventListener(INBOX_EVENT, h)
    if (hasInboxRoute) {
      request<{ count?: number }>('/inbox/count')
        .then((r) => setCount(Number(r?.count ?? 0) || 0))
        .catch(() => {})
    }
    return () => window.removeEventListener(INBOX_EVENT, h)
  }, [])
  return count
}

/** MyHermesCompany 有沒有新版：打輕量的 /version/studio（不呼叫 hermes CLI，伺服器端快取 6 小時）。
 *  徽章連到「管理 → 版本」，實際更新在那裡按（站內一鍵，或照提示用 CLI）。 */
function UpdateHint() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<{ v: string; cmd: string; url?: string } | null>(null)
  useEffect(() => {
    if (IS_MOCK) return
    let alive = true
    request<{
      studio_latest: string | null
      studio_update_available: boolean | null
      studio_update_cmd: string
      studio_release: { tag: string; url: string } | null
    }>('/version/studio')
      .then((r) => {
        if (!alive || r?.studio_update_available !== true || !r.studio_latest) return
        setInfo({ v: r.studio_latest, cmd: r.studio_update_cmd || 'myhermescompany update', url: r.studio_release?.url })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  if (!info) return null
  const label = t('nav.updateAvailable', { v: info.v })
  return (
    <Link
      to="/admin"
      className="flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
      title={`${label}｜${t('nav.updateHow', { cmd: info.cmd })}`}
      data-testid="update-hint"
    >
      <UpIcon className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </Link>
  )
}

function effectiveDark(): boolean {
  const forced = document.documentElement.getAttribute('data-theme')
  if (forced === 'dark') return true
  if (forced === 'light') return false
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 亮／暗切換：走 theme 模組的 applyTheme（data-theme + 快取），並盡力同步到伺服器 */
function ThemeToggle({ asMenuItem = false }: { asMenuItem?: boolean }) {
  const { t } = useTranslation()
  const [dark, setDark] = useState(effectiveDark)
  const toggle = () => {
    const mode = dark ? 'light' : 'dark'
    const cur = loadCachedTheme() ?? THEME_DEFAULTS
    applyTheme({ ...cur, mode })
    setDark(!dark)
    request('/theme', { method: 'PUT', body: JSON.stringify({ settings: { mode } }) }).catch(() => {})
  }
  const Icon = dark ? SunIcon : MoonIcon
  if (asMenuItem) {
    return (
      <button type="button" role="menuitem" className="btn-ghost w-full justify-start" onClick={toggle} data-testid="theme-toggle">
        <Icon className="h-4 w-4" aria-hidden />
        {t('nav.toggleTheme')}
      </button>
    )
  }
  return (
    <button type="button" className="btn-ghost px-2" onClick={toggle} aria-label={t('nav.toggleTheme')} title={t('nav.toggleTheme')} data-testid="theme-toggle">
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  )
}

/** 專注模式：一鍵收起所有側欄（含主導覽）讓主區最大化；快捷鍵 ⌘. ／ Ctrl+. */
function FocusToggle({ asMenuItem = false }: { asMenuItem?: boolean }) {
  const { t } = useTranslation()
  const focus = useFocusMode()
  const Icon = focus ? FocusOffIcon : FocusOnIcon
  const label = focus ? t('panel.focusOff') : t('panel.focusOn')
  if (asMenuItem) {
    return (
      <button type="button" role="menuitem" className="btn-ghost w-full justify-start" onClick={() => toggleFocusMode()} aria-pressed={focus} data-testid="focus-toggle">
        <Icon className="h-4 w-4" aria-hidden />
        {label}
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`btn-ghost px-2 ${focus ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200' : ''}`}
      onClick={() => toggleFocusMode()}
      aria-label={label}
      aria-pressed={focus}
      title={`${label}（⌘. / Ctrl+.）`}
      data-testid="focus-toggle"
    >
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  )
}

interface Props {
  title: string
  username?: string
  onLogout: () => void
  onOpenMenu?: () => void
  mobile: boolean
}

export function TopBar({ title, username, onLogout, onOpenMenu, mobile }: Props) {
  const { t } = useTranslation()
  const inbox = useInboxCount()
  const [menuOpen, setMenuOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)
  const menuItem = 'btn-ghost w-full justify-start'
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-900">
      {mobile && (
        <button type="button" className="btn-ghost px-2" onClick={onOpenMenu} aria-label={t('nav.menu')} data-testid="menu-button">
          <MenuIcon className="h-5 w-5" aria-hidden />
        </button>
      )}
      <Link to="/today" className="flex items-center gap-2 font-semibold" aria-label={t('app.name')}>
        <img src="/logo.svg" alt="" className="h-6 w-6 rounded-md" aria-hidden />
        <span className={mobile ? 'sr-only' : ''}>{t('app.name')}</span>
      </Link>
      <span className="mx-1 hidden text-zinc-300 sm:inline dark:text-zinc-700" aria-hidden>
        /
      </span>
      <h1 className="min-w-0 truncate text-sm font-medium text-zinc-700 dark:text-zinc-200" data-testid="page-title">
        {title}
      </h1>
      <div className="ml-auto flex shrink-0 items-center gap-1 text-xs">
        {/* 手機只留：☰／logo／標題／收件匣／頭像。其餘全收進頭像選單，Mock 徽章直接不顯示（390px 會逐字換行） */}
        {IS_MOCK && !mobile && <span className="mr-1 whitespace-nowrap rounded bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('common.mockMode')}</span>}
        {!mobile && <UpdateHint />}
        {!mobile && (
          <button type="button" className="btn-ghost px-2" onClick={openGlobalSearch} aria-label={t('nav.search')} title={`${t('nav.search')} (Ctrl/⌘+K)`} data-testid="search-button">
            <SearchIcon className="h-4 w-4" aria-hidden />
            <span className="hidden text-zinc-600 dark:text-zinc-400 md:inline">⌘K</span>
          </button>
        )}
        <Link
          to={hasInboxRoute ? '/today' : '/workflows/approvals'}
          className="btn-ghost relative px-2"
          aria-label={t('nav.inbox')}
          title={t('nav.inbox')}
          data-testid="inbox-button"
          data-tour="inbox"
        >
          <InboxIcon className="h-4 w-4" aria-hidden />
          {inbox > 0 && (
            <span data-testid="inbox-badge" className="absolute -right-0.5 -top-0.5 min-w-[1rem] rounded-full bg-orange-500 px-1 text-center text-2xs font-semibold leading-4 text-white">
              {inbox > 99 ? '99+' : inbox}
            </span>
          )}
        </Link>
        {!mobile && (
          <>
            <button type="button" className="btn-ghost px-2" onClick={() => setHelpOpen((o) => !o)} aria-label={t('guide.help.open')} title={t('guide.help.open')} aria-expanded={helpOpen} data-testid="help-button">
              <HelpIcon className="h-4 w-4" aria-hidden />
            </button>
            <FocusToggle />
            <ThemeToggle />
          </>
        )}
        <div className="relative">
          <button
            type="button"
            className="btn-ghost px-2"
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('nav.userMenu')}
            data-testid="user-menu-button"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-orange-500 text-xs font-semibold uppercase text-white">
              {(username ?? '?').slice(0, 1)}
            </span>
          </button>
          {menuOpen && (
            <>
              {/* 手機沒有 mouseleave：點選單外任何地方就關 */}
              <button type="button" className="fixed inset-0 z-30 cursor-default" aria-label={t('common.close')} onClick={closeMenu} data-testid="user-menu-backdrop" tabIndex={-1} />
              <div role="menu" className="card absolute right-0 top-9 z-40 min-w-[12rem] p-1 shadow-lg" onMouseLeave={closeMenu} data-testid="user-menu">
                <div className="px-3 py-1.5 text-zinc-600 dark:text-zinc-400">{username}</div>
                {mobile && (
                  <>
                    <div className="px-1"><UpdateHint /></div>
                    <button type="button" role="menuitem" className={menuItem} onClick={() => { closeMenu(); openGlobalSearch() }} data-testid="search-button">
                      <SearchIcon className="h-4 w-4" aria-hidden />
                      {t('nav.search')}
                    </button>
                    <button type="button" role="menuitem" className={menuItem} onClick={() => { closeMenu(); setHelpOpen(true) }} data-testid="help-button">
                      <HelpIcon className="h-4 w-4" aria-hidden />
                      {t('guide.help.open')}
                    </button>
                    <FocusToggle asMenuItem />
                    <ThemeToggle asMenuItem />
                  </>
                )}
                {/* 語言不會一天切三次：桌面也一起收進來，頂欄少一個 <select> */}
                <label className="flex items-center justify-between gap-2 px-3 py-1.5 text-zinc-700 dark:text-zinc-300">
                  <span>{t('lang.switch')}</span>
                  <LangSwitch />
                </label>
                <button type="button" role="menuitem" className={menuItem} onClick={() => { closeMenu(); startTour() }} data-testid="replay-tour">
                  <TourIcon className="h-4 w-4" aria-hidden />
                  {t('guide.tour.replay')}
                </button>
                <button type="button" role="menuitem" className={menuItem} onClick={onLogout}>
                  <LogOutIcon className="h-4 w-4" aria-hidden />
                  {t('nav.logout')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Tour />
    </header>
  )
}
