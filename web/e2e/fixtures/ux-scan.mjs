// 全站版面掃描：node ux-scan.mjs before|after [--dark]
//   → docs/qa/ux/<phase>/<route>-<w>.png + docs/qa/ux/<phase>.json
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8700'
const phase = process.argv[2] ?? 'before'
const DARK = process.argv.includes('--dark')
// repo 根＝本檔的 ../../../..（web/e2e/fixtures → web/e2e → web → repo）
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const OUT = path.resolve(ROOT, 'docs/qa/ux', phase)
const SFX = DARK ? '-dark' : ''
fs.mkdirSync(OUT, { recursive: true })
// 極端測試資料（ux-seed.mjs）已清掉時仍要能跑：沒有 state 就跳過那幾條 seed 路由
let st = {}
try { st = JSON.parse(fs.readFileSync(new URL('./ux-seed.state.json', import.meta.url), 'utf8')) } catch { console.log('(no ux-seed.state.json — 跳過 seed 專屬路由)') }
const WIDTHS = process.env.UX_WIDTHS ? process.env.UX_WIDTHS.split(',').map(Number) : [1440, 1024, 768, 390]

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.E2E_USER ?? 'admin', password: process.env.E2E_PASS }) })
if (!login.ok) { console.error('login failed', login.status); process.exit(1) }
const { token } = await login.json()
const H = { Authorization: `Bearer ${token}` }
const runs = await (await fetch(`${BASE}/api/workflow-runs?limit=1`, { headers: H })).json().catch(() => [])
const runId = Array.isArray(runs) && runs[0] ? runs[0].id : (runs?.items?.[0]?.id ?? runs?.runs?.[0]?.id)

const ONLY = process.env.UX_ROUTES ? new Set(process.env.UX_ROUTES.split(',')) : null
const routes = [
  '/', '/agents', '/profiles', '/models', '/channels', '/cron', '/usage', '/kanban', '/workflows', '/workflows/approvals',
  '/groupchat', '/files', '/skills', '/theme', '/logs', '/admin', '/coding', '/voice', '/settings',
  '/setup', '/search', '/inbox', '/events', '/soul-history', '/limits', '/compat', '/packs', '/packs/content-pipeline',
  ...(st.workflow ? [`/workflows/${st.workflow}`] : []), ...(runId ? [`/workflows/runs/${runId}`] : []),
  '/admin#terminal', '/admin#mcp', '/admin#plugins',
].filter((r) => !ONLY || ONLY.has(r))

const DETECT = () => {
  const issues = []
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0' }
  const desc = (el) => {
    const tid = el.getAttribute('data-testid')
    const cls = (el.className && typeof el.className === 'string') ? el.className.split(' ').filter(Boolean).slice(0, 4).join('.') : ''
    return `${el.tagName.toLowerCase()}${tid ? `[${tid}]` : ''}${cls ? '.' + cls : ''} "${(el.textContent || '').trim().slice(0, 40)}"`
  }
  const SKIP = '.react-flow, .cm-editor, .xterm, svg, pre, code, .sr-only, [data-testid="terminal-host"], .recharts-wrapper'

  const de = document.documentElement
  if (de.scrollWidth > de.clientWidth + 1) issues.push({ kind: 'page-hscroll', el: `html ${de.scrollWidth}>${de.clientWidth}` })
  if (document.body.scrollWidth > document.body.clientWidth + 1) issues.push({ kind: 'page-hscroll', el: `body ${document.body.scrollWidth}>${document.body.clientWidth}` })

  const scrollableX = (el) => { let p = el.parentElement; while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; p = p.parentElement } return false }
  const clamped = (cs) => cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')
  const all = [...document.querySelectorAll('body *')].filter((e) => !e.closest(SKIP))
  for (const el of all) {
    if (!vis(el)) continue
    const cs = getComputedStyle(el)
    const ox = cs.overflowX
    const scrollable = ox === 'auto' || ox === 'scroll'
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (hasText && el.children.length === 0) {
        if (!clamped(cs) && !scrollable && !scrollableX(el)) issues.push({ kind: 'text-clipped', el: desc(el), extra: `${el.scrollWidth}>${el.clientWidth} ws=${cs.whiteSpace} ow=${cs.overflowWrap}` })
      } else if (!scrollable && !clamped(cs) && !scrollableX(el)) {
        issues.push({ kind: 'container-overflow', el: desc(el), extra: `${el.scrollWidth}>${el.clientWidth} ox=${ox}` })
      }
    }
    if (el.tagName === 'BUTTON') {
      // 只看「純文字按鈕」：有 block/flex/grid 子元素的是刻意兩行版面，不算折行
      const stacked = clamped(cs) || [...el.children].some((c) => /block|flex|grid|list-item/.test(getComputedStyle(c).display))
      const lh = parseFloat(cs.lineHeight) || 20
      const inner = el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth)
      const txt = (el.textContent || '').trim()
      if (!stacked && inner > lh * 1.75 && txt.length > 0) issues.push({ kind: 'button-wrapped', el: desc(el), extra: `h=${Math.round(inner)} lh=${lh} ws=${cs.whiteSpace}` })
    }
    if (/(badge|rounded-full|chip|tag|pill)/.test(String(el.className)) && (el.tagName === 'SPAN' || el.tagName === 'DIV')) {
      const lh = parseFloat(cs.lineHeight) || 16
      const txt = (el.textContent || '').trim()
      if (txt && el.children.length === 0 && el.getBoundingClientRect().height > lh * 1.75) issues.push({ kind: 'badge-wrapped', el: desc(el), extra: `h=${Math.round(el.getBoundingClientRect().height)} lh=${lh}` })
    }
  }

  // 表格欄位擠成一字一行
  for (const td of document.querySelectorAll('th, td')) {
    if (!vis(td)) continue
    const t = (td.textContent || '').trim()
    const cs = getComputedStyle(td)
    if (cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre') continue // 明講不折行的欄位不可能被擠成一字一行
    const w = td.getBoundingClientRect().width
    // 量這一格「自己的文字」佔幾個行框（不是整列高度——同列別的格子換行會把整列撐高）
    let lines = 0
    try { const r = document.createRange(); r.selectNodeContents(td); lines = r.getClientRects().length } catch { lines = 0 }
    // 短字串卻被拆成 3 行以上＝欄位被擠成一字一行
    if (t.length >= 4 && t.length <= 40 && lines >= 3 && w < 100) issues.push({ kind: 'table-col-squeezed', el: desc(td), extra: `lines=${lines} w=${Math.round(w)} len=${t.length}` })
  }
  // 表格沒有 overflow-x 包裹且比容器寬
  for (const tb of document.querySelectorAll('table')) {
    if (!vis(tb)) continue
    let p = tb.parentElement, wrapped = false
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') { wrapped = true; break } }
    if (!wrapped && tb.getBoundingClientRect().width > (tb.parentElement?.clientWidth ?? 1e9) + 2) issues.push({ kind: 'table-unwrapped', el: desc(tb) })
  }

  // 卡片高度不齊（同一 grid 的直接子項）
  for (const g of document.querySelectorAll('div,ul,section')) {
    if (!vis(g)) continue
    const cs = getComputedStyle(g)
    if (cs.display !== 'grid') continue
    if (!/repeat|px|fr/.test(cs.gridTemplateColumns) || cs.gridTemplateColumns.split(' ').length < 2) continue
    const kids = [...g.children].filter(vis)
    if (kids.length < 2) continue
    const hs = kids.map((k) => Math.round(k.getBoundingClientRect().height))
    const min = Math.min(...hs), max = Math.max(...hs)
    if (max - min > 24 && min > 0) issues.push({ kind: 'card-height-uneven', el: desc(g), extra: `${min}~${max} n=${kids.length}` })
  }

  // 深色模式對比：文字節點的前景/背景對比 < 4.5（大字 < 3）
  const parseRGB = (s) => { const m = s.match(/\d+(\.\d+)?/g); return m ? m.slice(0, 3).map(Number) : null }
  const lum = (rgb) => { const a = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2] }
  const bgOf = (el) => {
    let p = el
    while (p && p !== document.documentElement) {
      const c = getComputedStyle(p).backgroundColor
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (m) { const parts = m[1].split(',').map((x) => parseFloat(x)); if (parts.length < 4 || parts[3] > 0.5) return parts.slice(0, 3) }
      p = p.parentElement
    }
    return getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [255, 255, 255]
  }
  for (const el of all) {
    if (!vis(el)) continue
    const txt = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('')
    if (txt.length < 2) continue
    const cs = getComputedStyle(el)
    const fg = parseRGB(cs.color); if (!fg) continue
    const alpha = parseFloat((cs.color.match(/rgba?\(([^)]+)\)/)?.[1] ?? '').split(',')[3] ?? '1')
    if (alpha < 0.5) continue
    const bg = bgOf(el)
    const L1 = lum(fg), L2 = lum(bg)
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700
    const need = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5
    if (ratio < need) issues.push({ kind: 'low-contrast', el: desc(el), extra: `${ratio.toFixed(2)}<${need} fg=${cs.color} size=${size}` })
  }

  const seen = new Set()
  return issues.filter((i) => { const k = i.kind + i.el; if (seen.has(k)) return false; seen.add(k); return true })
}

const browser = await chromium.launch()
const report = {}
for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w < 500 ? 844 : 900 }, locale: 'zh-TW', colorScheme: DARK ? 'dark' : 'light', deviceScaleFactor: 1 })
  await ctx.addInitScript(() => { try { localStorage.setItem('mhc.tour.done', '1'); sessionStorage.setItem('mhc.setup.skip', '1') } catch {} })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login`)
  await page.evaluate((t) => localStorage.setItem('mhc.token', t), token)
  for (const r of routes) {
    const [pathPart, hash] = r.split('#')
    const name = (r === '/' ? 'workbench' : r.slice(1)).replace(/[\/#]/g, '_').replace(/wf_|wr_/g, '')
    try {
      await page.goto(`${BASE}${pathPart}`, { waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      if (hash) {
        await page.getByRole('tab', { name: new RegExp(hash === 'terminal' ? '終端|terminal' : hash === 'mcp' ? 'MCP' : '外掛|plugin', 'i') }).click().catch(() => {})
        await page.waitForTimeout(1200)
      }
      await page.waitForTimeout(700)
      const issues = await page.evaluate(DETECT)
      let drawerIssues = []
      if (w < 768) {
        const mb = page.getByTestId('menu-button')
        if (await mb.count()) {
          await mb.click(); await page.waitForTimeout(350)
          drawerIssues = (await page.evaluate(DETECT)).map((i) => ({ ...i, kind: 'drawer:' + i.kind }))
          await page.screenshot({ path: path.join(OUT, `${name}-${w}${SFX}-drawer.png`) })
          await page.keyboard.press('Escape'); await page.waitForTimeout(250)
        }
      }
      await page.screenshot({ path: path.join(OUT, `${name}-${w}${SFX}.png`), fullPage: false })
      report[`${r}@${w}`] = [...issues, ...drawerIssues.filter((d) => !issues.some((i) => i.el === d.el && 'drawer:' + i.kind === d.kind))]
      console.log(`${r}@${w}: ${report[`${r}@${w}`].length}`)
    } catch (e) {
      report[`${r}@${w}`] = [{ kind: 'error', el: String(e.message).slice(0, 200) }]
      console.log(`${r}@${w}: ERROR ${e.message.slice(0, 120)}`)
    }
  }
  await ctx.close()
}
await browser.close()
// UX_ROUTES 局部重掃時，合併回既有 JSON，不要蓋掉其他路由的結果
const outJson = path.join(OUT, '..', `${phase}${SFX}.json`)
let merged = report
if (ONLY && fs.existsSync(outJson)) { try { merged = { ...JSON.parse(fs.readFileSync(outJson, 'utf8')), ...report } } catch { /* ignore */ } }
fs.writeFileSync(outJson, JSON.stringify(merged, null, 2))
const tally = {}
for (const list of Object.values(merged)) for (const i of list) tally[i.kind] = (tally[i.kind] ?? 0) + 1
console.log('TOTAL', Object.values(merged).reduce((a, b) => a + b.length, 0), JSON.stringify(tally))
