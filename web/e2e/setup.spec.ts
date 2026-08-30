import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { collect } from './helpers'

// 首次設定精靈：對「暫存 MHC_HOME＋暫存 HERMES_HOME＋MHC_SETUP_DRY_RUN=1」起的 server 跑（不要對 8700 正式版跑）
//   E2E_BASE_URL=http://127.0.0.1:8791 E2E_HERMES_HOME=<tmp hermes> npx playwright test e2e/setup.spec.ts
const HERMES_HOME = process.env.E2E_HERMES_HOME
const DIR = path.resolve(process.cwd(), '../docs/qa/setup')

test.skip(!HERMES_HOME, '需要 E2E_HERMES_HOME（暫存 Hermes 目錄）才跑，避免動到真實 ~/.hermes')

test('setup: owner 首登 → /setup → 開門（dry-run）→ 員工 → 密碼 → 完成 → 工作臺＋導覽', async ({ page, request }) => {
  test.setTimeout(180_000)
  fs.mkdirSync(DIR, { recursive: true })
  const envPath = path.join(HERMES_HOME!, '.env')
  const before = fs.readFileSync(envPath, 'utf8')
  expect(before).not.toContain('API_SERVER_KEY')
  const c = collect(page)

  await page.goto('/login')
  await page.getByLabel(/使用者|帳號|username/i).first().fill('admin')
  await page.getByLabel(/密碼|password/i).first().fill('admin')
  await page.getByRole('button', { name: /登入|sign in|log in/i }).click()
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByTestId('setup-wizard')).toBeVisible()
  // 偵測到 key 未設 → 直接停在第 ② 步；退回第 ① 步看偵測結果
  await expect(page.getByTestId('setup-panel-api')).toBeVisible()
  await page.getByTestId('setup-prev').click()
  await expect(page.getByTestId('hermes-ok')).toContainText('Hermes')
  await page.screenshot({ path: path.join(DIR, '1-hermes.png') })
  await page.getByTestId('setup-next').click()

  // ② 開門（dry-run：寫 key、不重啟 gateway）
  await expect(page.getByTestId('setup-next')).toBeDisabled()
  await page.getByTestId('api-open-btn').click()
  await expect(page.getByTestId('api-success')).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: path.join(DIR, '2-api.png') })
  const after = fs.readFileSync(envPath, 'utf8')
  const lines = after.split('\n').filter(Boolean)
  expect(lines.slice(0, 2)).toEqual(before.split('\n').filter(Boolean))
  expect(lines[2]).toMatch(/^API_SERVER_KEY=\S{32,}$/)
  const key = lines[2].split('=')[1]
  expect(await page.content()).not.toContain(key) // 畫面上絕不出現 key
  expect(fs.readdirSync(HERMES_HOME!).some((f) => f.startsWith('.env.bak-'))).toBe(true)
  await expect(page.getByTestId('setup-next')).toBeEnabled()
  await page.getByTestId('setup-next').click()

  // ③ 員工：暫存 home 有 default + writer；勾 writer
  await expect(page.getByTestId('setup-panel-agents')).toBeVisible()
  await page.getByTestId('agent-toggle-writer').check()
  await expect(page.getByTestId('agents-enabled-count')).toContainText('2')
  await page.screenshot({ path: path.join(DIR, '3-agents.png') })
  await page.getByTestId('setup-next').click()

  // ④ 密碼
  await page.getByTestId('pw-new').fill('e2e-strong-pass-1')
  await page.getByTestId('pw-confirm').fill('e2e-strong-pass-1')
  await page.getByTestId('pw-save').click()
  await expect(page.getByTestId('password-ok')).toBeVisible()
  await page.screenshot({ path: path.join(DIR, '4-password.png') })
  await page.getByTestId('setup-next').click()

  // ⑤ 完成 → 工作臺 → 導覽
  await expect(page.getByTestId('setup-summary')).not.toContainText('未處理')
  await page.screenshot({ path: path.join(DIR, '5-done.png') })
  await page.getByTestId('setup-finish').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('tour')).toBeVisible()
  await page.screenshot({ path: path.join(DIR, '6-tour.png') })

  // 後端狀態：completed、密碼已改、再登入不再導向
  const login = await request.post('/api/auth/login', { data: { username: 'admin', password: 'e2e-strong-pass-1' } })
  expect(login.status()).toBe(200)
  const tok = ((await login.json()) as { token: string }).token
  const st = await request.get('/api/setup/state', { headers: { Authorization: `Bearer ${tok}` } })
  expect(await st.json()).toEqual({ completed: true, is_owner: true })
  await page.getByTestId('tour-skip').click()
  await page.goto('/settings')
  await expect(page.getByTestId('settings-rerun-setup')).toBeVisible()
  await page.getByTestId('settings-rerun-setup').click()
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByTestId('setup-wizard')).toBeVisible()
  expect(c.errors, JSON.stringify(c.errors)).toEqual([])
})
