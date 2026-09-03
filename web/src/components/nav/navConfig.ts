import type { NavItem } from '../../modules/registry'
import { moduleNav, groupNav } from '../../modules/registry'

/** App.tsx 內建頁面（非模組）的導覽項 */
export const baseNav: NavItem[] = [
  { to: '/workbench', key: 'workbench', group: 'chat', icon: 'LayoutDashboard', order: 10 },
  { to: '/workflows', key: 'workflows', group: 'work', icon: 'Workflow', order: 21 },
  { to: '/kanban', key: 'kanban', group: 'work', icon: 'KanbanSquare', order: 22 },
  { to: '/agents', key: 'agents', group: 'agents', icon: 'Bot', order: 30 },
  { to: '/settings', key: 'settings', group: 'settings', icon: 'Settings', order: 90 },
]

export const allNav: NavItem[] = [...baseNav, ...moduleNav]
export const navGroups = groupNav(allNav)

/** 目前路徑對應的導覽項（最長前綴匹配） */
export function activeNavItem(pathname: string, items: NavItem[] = allNav): NavItem | undefined {
  let best: NavItem | undefined
  for (const it of items) {
    const hit = it.to === '/' ? pathname === '/' : pathname === it.to || pathname.startsWith(it.to + '/')
    if (hit && (!best || it.to.length > best.to.length)) best = it
  }
  return best
}

/** g 之後的第二鍵 → 路徑 */
export const GO_KEYS: Record<string, string> = { t: '/today', w: '/workbench', a: '/agents', k: '/kanban', f: '/workflows' }
