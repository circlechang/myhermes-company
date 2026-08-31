// 面板掃描的補拍：只有互動後才出現的面板（群聊房間設定、Skills 三個分頁）與手機抽屜
//   E2E_BASE_URL=http://127.0.0.1:8742 E2E_PASS=admin node panel-extras.mjs
//   → docs/qa/panels/{groupchat-settings,skills-<tab>}-1440[-dark]-expanded.png、<page>-390-drawer.png
import { chromium } from '@playwright/test'
import path from 'node:path'

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8742'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
const OUT = path.resolve(ROOT, 'docs/qa/panels')

const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.E2E_USER ?? 'admin', password: process.env.E2E_PASS ?? 'admin' }),
})
if (!r.ok) { console.error('login failed', r.status); process.exit(1) }
const { token } = await r.json()
const rooms = await (await fetch(`${BASE}/api/groupchat/rooms`, { headers: { Authorization: `Bearer ${token}` } })).json()
const room = Array.isArray(rooms) ? rooms[0]?.id : rooms?.items?.[0]?.id

const init = ([t, d]) => {
  try {
    localStorage.setItem('mhc.token', t)
    localStorage.setItem('mhc.tour.done', '1')
    localStorage.setItem('mhc.theme', JSON.stringify({ mode: d ? 'dark' : 'light' }))
    localStorage.removeItem('mhc.focus')
    for (const k of Object.keys(localStorage)) if (k.startsWith('mhc.panel.')) localStorage.removeItem(k)
  } catch { /* ignore */ }
  try { sessionStorage.setItem('mhc.setup.skip', '1') } catch { /* ignore */ }
}

const b = await chromium.launch()

// ---- 桌面：互動後才出現的面板 ----
for (const dark of [false, true]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW', baseURL: BASE, colorScheme: dark ? 'dark' : 'light' })
  await ctx.addInitScript(init, [token, dark])
  const p = await ctx.newPage()
  const sfx = dark ? '-dark' : ''
  if (room) {
    await p.goto(`/groupchat?room=${room}`)
    await p.waitForTimeout(4000)
    await p.getByRole('button', { name: '房間設定' }).click()
    await p.waitForTimeout(600)
    await p.screenshot({ path: `${OUT}/groupchat-settings-1440${sfx}-expanded.png` })
    console.log('groupchat settings panels =', await p.locator('[data-panel]').count())
  } else {
    console.log('(沒有群聊房間，跳過房間設定面板)')
  }
  await p.goto('/skills')
  await p.waitForTimeout(4000)
  for (const [tab, name] of [['Bundles', 'bundles'], ['記憶', 'memory'], ['Journey', 'journey']]) {
    await p.getByRole('tab', { name: tab }).first().click()
    await p.waitForTimeout(4000)
    await p.screenshot({ path: `${OUT}/skills-${name}-1440${sfx}-expanded.png` })
    console.log('skills', name, 'panels =', await p.locator('[data-panel]').count())
  }
  await ctx.close()
}

// ---- 手機：把手點開變抽屜 ----
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-TW', baseURL: BASE })
  await ctx.addInitScript(init, [token, false])
  const p = await ctx.newPage()
  for (const [route, id, name] of [['/files', 'files.tree', 'files'], ['/events', 'events.filters', 'events'], ['/groupchat', 'groupchat.rooms', 'groupchat']]) {
    await p.goto(route)
    await p.waitForTimeout(2000)
    await p.click(`[data-testid="panel-expand-${id}"]`)
    await p.waitForTimeout(600)
    console.log(route, 'drawer =', await p.locator(`[data-testid="panel-drawer-${id}"]`).count())
    await p.screenshot({ path: `${OUT}/${name}-390-drawer.png` })
  }
  await ctx.close()
}
await b.close()
