import { test, expect } from '@playwright/test'
import path from 'node:path'
import { apiToken, collect, USER } from './helpers'

// 使用者引導：新帳號首次登入看到導覽並走完；「？」抽屜依路由；空狀態卡
const DIR = path.resolve(process.cwd(), '../docs/qa/guidance')

test('guidance: 新帳號首次登入 → 導覽走完 → 不再出現；？抽屜；空狀態', async ({ page, request }) => {
  test.setTimeout(180_000)
  const admin = await apiToken(request)
  const H = { Authorization: `Bearer ${admin}` }
  const username = `e2e_tour_${Date.now()}`
  const created = await request.post('/members', { headers: H, data: { username, password: 'e2e-pass-1234', role: 'admin' } })
  expect(created.status()).toBe(201)
  const memberId = ((await created.json()) as { id: string }).id

  try {
    const c = collect(page)
    // 全新瀏覽器情境：localStorage 沒有 mhc.tour.done
    await page.goto('/login')
    await page.getByLabel(/使用者|帳號|username/i).first().fill(username)
    await page.getByLabel(/密碼|password/i).first().fill('e2e-pass-1234')
    await page.getByRole('button', { name: /登入|sign in|log in/i }).click()
    await expect(page).not.toHaveURL(/\/login/)

    const tour = page.getByTestId('tour')
    await expect(tour).toBeVisible()
    await expect(tour).toHaveAttribute('data-step', 'sidebar')
    await expect(page.getByTestId('tour-spotlight')).toBeVisible()
    await page.screenshot({ path: path.join(DIR, 'tour.png') })

    const steps = ['sidebar', 'workbench', 'agents', 'workflows', 'inbox', 'limits']
    for (let i = 0; i < steps.length; i++) {
      await expect(tour).toHaveAttribute('data-step', steps[i])
      await expect(page.getByText(`第 ${i + 1} 步，共 ${steps.length} 步`)).toBeVisible()
      if (i < steps.length - 1) await page.getByTestId('tour-next').click()
    }
    await page.getByTestId('tour-done').click()
    await expect(tour).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('mhc.tour.done'))).toBe('1')
    await page.reload()
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(tour).toHaveCount(0)

    // 空狀態：工作臺沒選對話
    await expect(page.getByTestId('empty-sessions')).toBeVisible()
    await page.screenshot({ path: path.join(DIR, 'empty-state.png') })

    // ？抽屜依路由
    await page.getByTestId('help-button').click()
    await expect(page.getByTestId('help-title')).toHaveText('工作臺')
    await page.getByTestId('help-close').click()
    await page.getByTestId('sidebar').getByRole('link', { name: '工作流' }).click()
    await expect(page).toHaveURL(/\/workflows$/)
    await page.getByTestId('help-button').click()
    await expect(page.getByTestId('help-title')).toHaveText('工作流')
    await page.screenshot({ path: path.join(DIR, 'help-drawer.png') })
    await page.getByTestId('help-close').click()

    // 使用者選單「重看導覽」
    await page.getByTestId('user-menu-button').click()
    await page.getByTestId('replay-tour').click()
    await expect(tour).toBeVisible()
    await page.getByTestId('tour-skip').click()
    await expect(tour).toHaveCount(0)

    expect(c.errors, JSON.stringify(c.errors)).toEqual([])
  } finally {
    await request.delete(`/members/${memberId}`, { headers: H })
  }
  expect(USER).toBeTruthy()
})
