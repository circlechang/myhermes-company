import { test, expect } from '@playwright/test'
import { collect, login, shot } from './helpers'

test('kanban: 建卡 → 拖到另一欄 → 封存', async ({ page }) => {
  await login(page)
  const c = collect(page)
  await page.goto('/kanban')
  const title = `E2E 卡片 ${Date.now()}`
  await page.getByRole('button', { name: /新增卡片/ }).click()
  await page.getByLabel('標題').fill(title)
  await page.getByRole('button', { name: '建立' }).click()
  const card = page.locator('[data-testid^="card-"]', { hasText: title }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await shot(page, 'kanban-created')

  // 拖到「就緒」欄（dnd-kit PointerSensor，距離門檻 4px → 分段移動）
  const handle = card.getByRole('button', { name: `拖拉 ${title}` })
  const target = page.getByTestId('col-ready')
  const h = (await handle.boundingBox())!
  const tb = (await target.boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + 10, h.y + 10, { steps: 5 })
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 80, { steps: 15 })
  await page.mouse.up()
  await expect(target.locator('[data-testid^="card-"]', { hasText: title })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('move-error')).toHaveCount(0)
  await shot(page, 'kanban-dragged')

  // 封存
  await page.locator('[data-testid^="card-"]').getByRole('button', { name: title, exact: true }).first().click()
  await expect(page.getByTestId('card-drawer')).toBeVisible()
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: '封存' }).click()
  await expect(page.getByTestId('card-drawer')).toBeHidden({ timeout: 20_000 })
  await expect(page.locator('[data-testid^="card-"]', { hasText: title })).toHaveCount(0)
  await shot(page, 'kanban-archived')
  expect(c.errors).toEqual([])
  expect(c.badResponses).toEqual([])
})
