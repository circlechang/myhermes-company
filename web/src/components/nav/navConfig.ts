import type { NavItem } from '../../modules/registry'
import { moduleNav, groupNav } from '../../modules/registry'

/** App.tsx 內建頁面（非模組）的導覽項 */
export const baseNav: NavItem[] = [
  { to: '/', key: 'workbench', group: 'work', icon: 'LayoutDashboard', order: 10 },
  { to: '/workflows', key: 'workflows', group: 'work', icon: 'Workflow', order: 30 },
  { to: '/kanban', key: 'kanban', group: 'work', icon: 'KanbanSquare', order: 40 },
  { to: '/agents', key: 'agents', group: 'agents', icon: 'Bot', order: 10 },
  { to: '/settings', key: 'settings', group: 'system', icon: 'Settings', order: 99 },
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
export const GO_KEYS: Record<string, string> = { w: '/', a: '/agents', k: '/kanban', f: '/workflows' }
