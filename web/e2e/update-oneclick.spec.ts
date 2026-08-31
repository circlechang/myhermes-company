// 站內一鍵更新的真機端到端：**只在暫存環境跑**，因為它會真的把伺服器換版重啟。
//
//   E2E_UPDATE=1 E2E_BASE_URL=http://127.0.0.1:8745 npx playwright test e2e/update-oneclick.spec.ts
//
// 前置：用 wheel（非 editable）裝一個舊版起在該 port，MHC_HOME 指向暫存目錄。
// 8700 是 `pip install -e` 的開發安裝，會被伺服器擋掉（那條由 pytest／vitest 顧）。
import { test, expect } from '@playwright/test'
import path from 'node:path'
import { login } from './helpers'

const SHOT_DIR = path.resolve(process.cwd(), '../docs/qa/update')

test.skip(process.env.E2E_UPDATE !== '1', '需要暫存的舊版環境；設 E2E_UPDATE=1 才跑')

test('一鍵更新：確認 → 進度 → 伺服器換版重啟 → 顯示已更新', async ({ page }) => {
  test.setTimeout(300_000)
  await login(page)
  await page.goto('/admin')
  await page.getByRole('tab', { name: '版本' }).click()

  // 舊版在跑，且站內查得到新版
  const before = await page.getByTestId('mhc-update-badge').textContent({ timeout: 30_000 })
  expect(before).toMatch(/有新版 v\d+\.\d+\.\d+/)

  // 1) 主按鈕 → 確認對話框
  await page.getByTestId('mhc-update-btn').click()
  const dialog = page.getByTestId('mhc-update-confirm')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('離線')
  await expect(dialog).toContainText('不要關閉瀏覽器')
  await page.screenshot({ path: path.join(SHOT_DIR, 'confirm.png') })

  // 2) 開始更新 → 進度視圖
  await page.getByTestId('mhc-update-confirm-ok').click()
  await expect(page.getByTestId('mhc-update-progress')).toBeVisible({ timeout: 60_000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'running.png') })

  // 3) 伺服器離線又自己回來；版本變了就顯示已更新（不是錯誤畫面）
  await expect(page.getByTestId('mhc-update-done')).toBeVisible({ timeout: 240_000 })
  await expect(page.getByTestId('mhc-update-done')).toContainText(/已更新到 v\d+\.\d+\.\d+/)
  await expect(page.getByTestId('mhc-update-reload')).toBeVisible()
  await page.screenshot({ path: path.join(SHOT_DIR, 'done.png') })
})
