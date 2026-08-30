// 模組自動註冊：src/modules/<name>/index.tsx 需 export default 一個 StudioModule。
// 多人並行開發只碰自己的模組目錄；App/Layout/i18n 由此聚合。
import type { ReactElement } from 'react'
import i18n from 'i18next'

/** 側欄分群；沒指定的放 other（「其他」） */
export type NavGroup = 'work' | 'agents' | 'connect' | 'system' | 'other'
export const NAV_GROUPS: NavGroup[] = ['work', 'agents', 'connect', 'system', 'other']

export interface NavItem {
  to: string
  key: string
  order?: number
  /** lucide-react 圖示名稱（見 components/nav/icons.ts），未知名稱退回預設圖示 */
  icon?: string
  group?: NavGroup
}

export interface StudioModule {
  name: string
  routes: { path: string; element: ReactElement }[]
  nav?: NavItem[]
  i18n?: Record<string, Record<string, unknown>> // { 'zh-TW': {...}, en: {...} }
}

const found = import.meta.glob('./*/index.tsx', { eager: true }) as Record<string, { default: StudioModule }>
export const modules: StudioModule[] = Object.values(found).map((m) => m.default).filter(Boolean)

for (const m of modules) {
  if (m.i18n) for (const [lng, res] of Object.entries(m.i18n)) i18n.addResourceBundle(lng, 'translation', res, true, true)
}
export const moduleRoutes = modules.flatMap((m) => m.routes)
export const moduleNav: NavItem[] = modules.flatMap((m) => m.nav ?? []).sort((a, b) => (a.order ?? 100) - (b.order ?? 100))

/** 依 group 分組並依 order 排序；空群組不出現 */
export function groupNav(items: NavItem[]): { group: NavGroup; items: NavItem[] }[] {
  const by = new Map<NavGroup, NavItem[]>()
  for (const it of items) {
    const g: NavGroup = it.group && NAV_GROUPS.includes(it.group) ? it.group : 'other'
    if (!by.has(g)) by.set(g, [])
    by.get(g)!.push(it)
  }
  return NAV_GROUPS.filter((g) => by.has(g)).map((g) => ({ group: g, items: by.get(g)!.sort((a, b) => (a.order ?? 100) - (b.order ?? 100)) }))
}
