import { pagesEn } from './pages.en'
import { pagesZhTW } from './pages.zh-TW'
import type { HelpPage } from './types'

export type { HelpPage } from './types'
export const HELP_PAGES: Record<string, HelpPage[]> = { 'zh-TW': pagesZhTW, en: pagesEn }

/** 依路由找說明：最長前綴匹配；'/' 只在精確匹配時命中 */
export function helpFor(pathname: string, lng = 'zh-TW'): HelpPage | undefined {
  const pages = HELP_PAGES[lng] ?? HELP_PAGES[lng.split('-')[0]] ?? pagesZhTW
  let best: HelpPage | undefined
  for (const pg of pages) {
    const hit = pg.path === '/' ? pathname === '/' : pathname === pg.path || pathname.startsWith(pg.path + '/')
    if (hit && (!best || pg.path.length > best.path.length)) best = pg
  }
  if (!best && lng !== 'zh-TW') return helpFor(pathname, 'zh-TW')
  return best
}
