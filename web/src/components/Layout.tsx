import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { Sidebar } from './nav/Sidebar'
import { TopBar } from './nav/TopBar'
import { activeNavItem, GO_KEYS, navGroups } from './nav/navConfig'
import { useIsMobile, useSidebarExpanded } from './nav/useNavState'
import { iconFor } from './nav/icons'

const CloseIcon = iconFor('X')

function isTypingTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null
  if (!n || !n.tagName) return false
  return n.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName)
}

export function Layout() {
  const { t } = useTranslation()
  const { member, logout } = useAuth()
  const loc = useLocation()
  const nav = useNavigate()
  const mobile = useIsMobile()
  const [expanded, toggleExpanded] = useSidebarExpanded()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const active = activeNavItem(loc.pathname)
  const title = active ? t(`nav.${active.key}`) : t('app.name')
  useEffect(() => {
    document.title = active ? `${title} · ${t('app.name')}` : t('app.name')
  }, [title, active, t])

  // 換頁／切回桌面時關閉抽屜
  useEffect(() => setDrawerOpen(false), [loc.pathname])
  useEffect(() => {
    if (!mobile) setDrawerOpen(false)
  }, [mobile])

  // 鍵盤：g 然後 w/a/k/f；Esc 關抽屜
  const pendingG = useRef<number | null>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false)
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return
      if (e.key === 'g') {
        if (pendingG.current) window.clearTimeout(pendingG.current)
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 1500)
        return
      }
      if (pendingG.current && GO_KEYS[e.key]) {
        window.clearTimeout(pendingG.current)
        pendingG.current = null
        e.preventDefault()
        nav(GO_KEYS[e.key])
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [nav])

  return (
    <div className="flex h-full flex-col">
      <TopBar title={title} username={member?.username} onLogout={logout} mobile={mobile} onOpenMenu={() => setDrawerOpen(true)} />
      <div className="flex min-h-0 flex-1">
        {!mobile && <Sidebar groups={navGroups} expanded={expanded} onToggle={toggleExpanded} />}
        {mobile && drawerOpen && (
          <div className="fixed inset-0 z-50 flex" data-testid="drawer">
            <button type="button" className="absolute inset-0 bg-black/40" aria-label={t('common.close')} onClick={() => setDrawerOpen(false)} data-testid="drawer-backdrop" />
            <div className="relative flex h-full flex-col shadow-xl">
              <Sidebar groups={navGroups} expanded drawer onNavigate={() => setDrawerOpen(false)} />
              <button
                type="button"
                className="btn-ghost absolute right-2 top-2 px-2"
                aria-label={t('common.close')}
                onClick={() => setDrawerOpen(false)}
                data-testid="drawer-close"
              >
                <CloseIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        )}
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
