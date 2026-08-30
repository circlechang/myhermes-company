import { expect, type Page, type TestInfo } from '@playwright/test'
import path from 'node:path'

export const SCREEN_DIR = path.resolve(process.cwd(), '../docs/qa/screens')
export const USER = process.env.E2E_USER ?? 'admin'
export const PASS = process.env.E2E_PASS ?? 'admin'

export interface Collector { errors: string[]; badResponses: string[]; pending404?: number }

/** 掛上 console error / 失敗請求收集器（忽略已知無害噪音） */
export function collect(page: Page): Collector {
  const c: Collector = { errors: [], badResponses: [] }
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (/favicon|Download the React DevTools|net::ERR_ABORTED/.test(text)) return
    if (/status of 404/.test(text) && c.badResponses.length === 0) { c.pending404 = (c.pending404 ?? 0) + 1; return }
    c.errors.push(text)
  })
  page.on('pageerror', (e) => c.errors.push(`pageerror: ${e.message}`))
  page.on('response', (r) => {
    const u = r.url()
    if (!/\/api\//.test(u)) return
    if (r.status() >= 400 && r.status() !== 401) c.badResponses.push(`${r.status()} ${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, '')}`)
  })
  return c
}

/** 既有 e2e 不測導覽：先標記看過，避免首次導覽遮罩擋住點擊 */
export async function skipTour(page: Page) {
  // 導覽已看過＋設定精靈「稍後再說」：8700 正式版的 owner 若沒完成精靈，登入會被 SetupGate 導到 /setup（round3 發現）；
  // 精靈本身由 setup.spec.ts 對暫存 server 驗，其他 spec 一律跳過閘門
  await page.addInitScript(() => {
    try { localStorage.setItem('mhc.tour.done', '1') } catch { /* ignore */ }
    try { sessionStorage.setItem('mhc.setup.skip', '1') } catch { /* ignore */ }
  })
}

export async function login(page: Page) {
  await skipTour(page)
  await page.goto('/login')
  await page.getByLabel(/使用者|帳號|username/i).first().fill(USER)
  await page.getByLabel(/密碼|password/i).first().fill(PASS)
  await page.getByRole('button', { name: /登入|sign in|log in/i }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SCREEN_DIR, `${name}.png`), fullPage: false })
}

/** 找出畫面上像 i18n key 的文字（例：`nav.foo`, `kanban.card.title`） */
export async function i18nLeaks(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>()
    // 只看「介面文字」容器（按鈕、連結、標籤、標題、表頭、選項），避免把日誌內容／檔名當成漏翻譯
    const UI = new Set(['A', 'BUTTON', 'LABEL', 'H1', 'H2', 'H3', 'H4', 'TH', 'OPTION', 'LEGEND', 'SUMMARY', 'DT'])
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const re = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+){1,}$/
    while (walker.nextNode()) {
      const el = walker.currentNode.parentElement
      if (!el || !UI.has(el.tagName)) continue
      if (el.closest('pre, code, [data-testid="terminal-host"]')) continue
      const t = (walker.currentNode.textContent ?? '').trim()
      if (t && t.length < 60 && re.test(t) && !/^\d/.test(t) && !/\.(md|json|yaml|yml|py|ts|tsx|txt|png|db|log|env|csv|html)$/i.test(t) && !/\.log(\.|$)/.test(t) && !/^(v?\d)/.test(t) && !/^(localhost|127)/.test(t))
        out.add(t)
    }
    return [...out]
  })
}

export function noise(c: Collector) {
  return { errors: c.errors.filter((e) => !/WebSocket/.test(e) || true), bad: c.badResponses }
}

export function attachIssues(info: TestInfo, c: Collector, leaks: string[]) {
  info.annotations.push({ type: 'console', description: JSON.stringify(c.errors) })
  info.annotations.push({ type: 'bad', description: JSON.stringify(c.badResponses) })
  info.annotations.push({ type: 'i18n', description: JSON.stringify(leaks) })
}

/** 用 API 拿 token（給需要先建資料的測試用） */
export async function apiToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const r = await request.post('/auth/login', { data: { username: USER, password: PASS } })
  const j = (await r.json()) as { token: string }
  return j.token
}

/** 在瀏覽器裡把 token 寫進 localStorage，跳過登入畫面 */
export async function loginFast(page: Page, token: string) {
  await skipTour(page)
  await page.goto('/login')
  await page.evaluate((t) => localStorage.setItem('mhc.token', t), token)
  await page.goto('/')
  await expect(page).not.toHaveURL(/\/login/)
}
