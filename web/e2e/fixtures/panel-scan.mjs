// 可收合面板掃描：每頁在四個寬度、亮／暗各拍「展開」與「收合」兩張，並量主區寬度／橫向捲動
//   E2E_BASE_URL=http://127.0.0.1:8742 E2E_PASS=admin node panel-scan.mjs [--dark]
//   → docs/qa/panels/<route>-<w>[-dark]-{expanded,collapsed}.png ＋ docs/qa/panels/report[-dark].json
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8742'
const DARK = process.argv.includes('--dark')
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const OUT = path.resolve(ROOT, 'docs/qa/panels')
const SFX = DARK ? '-dark' : ''
fs.mkdirSync(OUT, { recursive: true })

const WIDTHS = process.env.PANEL_WIDTHS ? process.env.PANEL_WIDTHS.split(',').map(Number) : [1440, 1024, 768, 390]
const ONLY = process.env.PANEL_ROUTES ? new Set(process.env.PANEL_ROUTES.split(',')) : null

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.E2E_USER ?? 'admin', password: process.env.E2E_PASS ?? 'admin' }),
})
if (!login.ok) { console.error('login failed', login.status); process.exit(1) }
const { token } = await login.json()

const extra = (process.env.PANEL_EXTRA_ROUTES ?? '').split(',').filter(Boolean)
const routes = [
  '/', '/agents', '/files', '/skills', '/coding', '/groupchat', '/kanban', '/workflows', '/events', '/search', '/logs', '/packs/content-pipeline',
  ...extra,
].filter((r) => !ONLY || ONLY.has(r))

const slug = (r) => (r === '/' ? 'workbench' : r.replace(/^\//, '').replace(/\//g, '_'))

/** 量：主區寬度、面板數、有沒有橫向捲動、收合後把手看不看得見 */
const MEASURE = () => {
  const de = document.documentElement
  const work = document.querySelector('[data-work-area]') || document.querySelector('main')
  const panels = [...document.querySelectorAll('[data-panel]')]
  const nav = document.querySelector('[data-testid="sidebar"]')
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  return {
    pageHScroll: de.scrollWidth > de.clientWidth + 1,
    bodyHScroll: document.body.scrollWidth > document.body.clientWidth + 1,
    workWidth: work ? Math.round(work.getBoundingClientRect().width) : null,
    navWidth: nav ? Math.round(nav.getBoundingClientRect().width) : null,
    panels: panels.map((p) => ({
      id: p.getAttribute('data-panel'),
      collapsed: p.getAttribute('data-collapsed') === 'true',
      width: Math.round(p.getBoundingClientRect().width),
    })),
    // 收合後每個面板都要留一個看得見的展開鈕
    handlesVisible: [...document.querySelectorAll('[data-testid^="panel-expand-"]')].filter(visible).length,
    handlesTotal: document.querySelectorAll('[data-testid^="panel-expand-"]').length,
    resizers: [...document.querySelectorAll('[role="separator"][aria-orientation="vertical"]')].filter(visible).length,
  }
}

const browser = await chromium.launch()
const report = []

for (const width of WIDTHS) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    locale: 'zh-TW',
    colorScheme: DARK ? 'dark' : 'light',
    baseURL: BASE,
  })
  await ctx.addInitScript(
    ([tok, dark]) => {
      try {
        localStorage.setItem('mhc.token', tok)
        localStorage.setItem('mhc.tour.done', '1')
        localStorage.setItem('mhc.theme', JSON.stringify({ mode: dark ? 'dark' : 'light' }))
        localStorage.removeItem('mhc.focus')
        for (const k of Object.keys(localStorage)) if (k.startsWith('mhc.panel.')) localStorage.removeItem(k)
      } catch { /* ignore */ }
      try { sessionStorage.setItem('mhc.setup.skip', '1') } catch { /* ignore */ }
    },
    [token, DARK],
  )
  const page = await ctx.newPage()

  for (const route of routes) {
    const name = `${slug(route)}-${width}${SFX}`
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1200)
      if (DARK) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
      else await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
      await page.waitForTimeout(300)

      const expanded = await page.evaluate(MEASURE)
      await page.screenshot({ path: path.join(OUT, `${name}-expanded.png`) })

      // 收合：頁面上所有面板 ＋ 主導覽（等同專注模式）
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true, cancelable: true }))
      })
      await page.waitForTimeout(500)
      const collapsed = await page.evaluate(MEASURE)
      await page.screenshot({ path: path.join(OUT, `${name}-collapsed.png`) })

      // 還原，免得影響下一條路由
      await page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true, cancelable: true }))
      })

      report.push({ route, width, dark: DARK, expanded, collapsed, gained: collapsed.workWidth - expanded.workWidth })
      console.log(
        `${name}  work ${expanded.workWidth}→${collapsed.workWidth} (+${collapsed.workWidth - expanded.workWidth})  ` +
        `panels ${expanded.panels.length}  handles ${collapsed.handlesVisible}/${collapsed.handlesTotal}  ` +
        `hscroll ${collapsed.pageHScroll || collapsed.bodyHScroll ? 'YES' : 'no'}  resizers ${expanded.resizers}`,
      )
    } catch (e) {
      console.log(`${name}  ERROR ${String(e).slice(0, 120)}`)
      report.push({ route, width, dark: DARK, error: String(e).slice(0, 200) })
    }
  }
  await ctx.close()
}
await browser.close()
fs.writeFileSync(path.join(OUT, `report${SFX}.json`), JSON.stringify(report, null, 2))
console.log(`\n→ ${OUT}/report${SFX}.json`)
