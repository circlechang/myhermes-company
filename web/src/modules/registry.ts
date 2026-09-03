// 模組自動註冊：src/modules/<name>/index.tsx 需 export default 一個 StudioModule。
// 多人並行開發只碰自己的模組目錄；App/Layout/i18n 由此聚合。
import type { ReactElement } from 'react'
import i18n from 'i18next'

/** 側欄分群：今天／對話／工作／員工／設定；沒指定或指錯的放 settings（老闆不需要看的都算設定） */
export type NavGroup = 'today' | 'chat' | 'work' | 'agents' | 'settings'
export const NAV_GROUPS: NavGroup[] = ['today', 'chat', 'work', 'agents', 'settings']
/** 沒指定 group 的退回這裡 */
export const NAV_FALLBACK_GROUP: NavGroup = 'settings'

export interface NavItem {
  to: string
  key: string
  order?: number
  /** lucide-react 圖示名稱（見 components/nav/icons.ts），未知名稱退回預設圖示 */
  icon?: string
  group?: NavGroup
  /** 隱藏項：不進側欄，但仍算頁標題（activeNavItem）並列在「設定」總覽裡 */
  hidden?: boolean
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

export function navGroupOf(it: NavItem): NavGroup {
  return it.group && NAV_GROUPS.includes(it.group) ? it.group : NAV_FALLBACK_GROUP
}
/** 只給設定總覽用：藏起來的項目 */
export function hiddenNav(items: NavItem[]): NavItem[] {
  return items.filter((it) => it.hidden).sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

/** 依 group 分組並依 order 排序；hidden 項不進側欄；空群組不出現 */
export function groupNav(items: NavItem[]): { group: NavGroup; items: NavItem[] }[] {
  const by = new Map<NavGroup, NavItem[]>()
  for (const it of items) {
    if (it.hidden) continue
    const g = navGroupOf(it)
    if (!by.has(g)) by.set(g, [])
    by.get(g)!.push(it)
  }
  return NAV_GROUPS.filter((g) => by.has(g)).map((g) => ({ group: g, items: by.get(g)!.sort((a, b) => (a.order ?? 100) - (b.order ?? 100)) }))
}
