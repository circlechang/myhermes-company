// 生產線視圖真機驗證：選範本 → 三站含「等我確認」→ 執行 → 就地核准 → 完成看到產出。
// 對暫存 MHC_HOME 的 server 跑（真 Hermes）：
//   E2E_BASE_URL=http://127.0.0.1:8743 npx playwright test e2e/workflow-ux.spec.ts
import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { apiToken, collect, loginFast } from './helpers'

const DIR = path.resolve(process.cwd(), '../docs/qa/workflow-ux')
const shot = async (page: Page, name: string) => {
  fs.mkdirSync(DIR, { recursive: true })
  await page.screenshot({ path: path.join(DIR, `${name}.png`), fullPage: false })
}
const SHORT = '只回覆一個字：好'

test('生產線：選範本 → 三站含等我確認 → 執行 → 就地核准 → 完成看到產出', async ({ page, request }) => {
  test.setTimeout(600_000)
  const token = await apiToken(request)
  await loginFast(page, token)
  const c = collect(page)

  // ① 建立＝先選範本
  await page.goto('/workflows')
  await page.getByTestId('new-workflow').click()
  await expect(page.getByTestId('template-picker')).toBeVisible()
  await page.getByTestId('template-content').click()
  await page.getByLabel('這條線叫什麼').fill(`UX 驗證線 ${Date.now()}`)
  await shot(page, '1-template-picker')
  await page.getByTestId('template-create').click()

  // ② 生產線視圖（未跑）
  await expect(page.getByTestId('stations-view')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('station-s1-title')).toHaveValue('找題材')
  await expect(page.getByTestId('station-s2-title')).toHaveValue('等我確認')
  await expect(page.getByTestId('station-s3-title')).toHaveValue('寫成文章')
  await expect(page.getByTestId('link-after-s1')).toContainText('帶著：')
  // 提示改短，真機才跑得完
  await page.getByTestId('station-s1-prompt').fill(SHORT)
  await page.getByTestId('station-s3-prompt').fill(SHORT)
  await expect(page.getByTestId('save-state')).toHaveText('已儲存', { timeout: 20_000 })
  await shot(page, '2-stations-idle')

  // ②b 加站選單：每一項一句白話，不是六顆並排的按鈕
  await page.getByTestId('link-after-s1').hover()
  await page.getByTestId('insert-after-s1').click()
  await expect(page.getByTestId('insert-after-s1-menu')).toBeVisible()
  await shot(page, '2b-insert-menu')
  await page.keyboard.press('Escape')

  // ③ 執行：同一個畫面亮起來
  await page.getByTestId('wf-run').click()
  await expect(page.getByTestId('station-s1')).toHaveAttribute('data-light', /running|completed/, { timeout: 60_000 })
  await shot(page, '3-running')

  // ④ 等我確認：那張卡就地給核准／退回
  await expect(page.getByTestId('station-s2')).toHaveAttribute('data-light', 'waiting_approval', { timeout: 300_000 })
  await expect(page.getByTestId('station-s2-status')).toHaveText('等你確認')
  await expect(page.getByTestId('station-s2-approval')).toBeVisible()
  await shot(page, '4-waiting-approval')

  // ⑤ 就地核准 → 跑完 → 產出長在那一站底下
  await page.getByTestId('station-s2-approve').click()
  await expect(page.getByTestId('station-s3')).toHaveAttribute('data-light', 'completed', { timeout: 300_000 })
  await expect(page.getByTestId('station-s3-result')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('output-rail')).toBeVisible()
  await page.getByTestId('station-s3').scrollIntoViewIfNeeded()
  await shot(page, '5-completed')

  // ⑥ 進階檢視（畫布）還在，功能沒少
  await page.getByTestId('wf-more').click()
  await page.getByTestId('menu-advanced').click()
  await expect(page.getByTestId('canvas-toolbar')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(3, { timeout: 20_000 })
  await shot(page, '6-advanced-canvas')
  await page.getByTestId('canvas-back').click()
  await expect(page.getByTestId('stations-view')).toBeVisible()

  // ⑦ 手機 390
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  await expect(page.getByTestId('station-s1-title')).toBeVisible()
  await shot(page, '7-mobile-390')
  await page.setViewportSize({ width: 1400, height: 900 })

  // ⑧ 暗色
  const url = page.url()
  await page.goto('/theme')
  await page.getByRole('radio', { name: '暗色' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.goto(url)
  await expect(page.getByTestId('stations-view')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('station-s3')).toHaveAttribute('data-light', 'completed', { timeout: 30_000 })
  await shot(page, '8-stations-dark')
  await page.getByTestId('wf-more').click()
  await shot(page, '9-more-menu-dark')
  await page.keyboard.press('Escape')

  expect(c.errors.filter((e) => !/NaN/.test(e)), 'console errors').toEqual([])
  expect(c.badResponses).toEqual([])
})
