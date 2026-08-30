import { test, expect } from '@playwright/test'
import { apiToken, collect, login, shot } from './helpers'

test('groupchat: 開房 → @ 一位員工 → 收到回覆', async ({ page, request }) => {
  test.setTimeout(240_000)
  await login(page)
  const c = collect(page)
  await page.goto('/groupchat')
  await page.getByRole('button', { name: /新房間/ }).click()
  const form = page.getByTestId('create-room-form')
  const name = `E2E 房 ${Date.now()}`
  await form.getByLabel(/房間|名稱/).fill(name)
  await form.getByRole('checkbox').first().check()
  await form.getByRole('button', { name: '建立' }).click()
  await expect(page.getByTestId('room-list')).toContainText(name)
  const status = page.getByTestId('ws-status')
  await expect(status).toBeVisible({ timeout: 20_000 })
  const input = page.getByLabel('訊息')
  await input.fill('@default 一句話：你好')
  await expect(page.getByRole('button', { name: '送出' })).toBeEnabled({ timeout: 20_000 })
  await input.press('Enter')
  const list = page.getByTestId('message-list')
  await expect(list).toContainText('一句話：你好')
  await shot(page, 'groupchat-sent')
  // AI 回覆：訊息列表出現作者為 default 的訊息
  await expect(list.getByText(/^🤖\s*default$/).first()).toBeVisible({ timeout: 150_000 })
  await shot(page, 'groupchat-reply')
  expect(c.errors).toEqual([])
  expect(c.badResponses).toEqual([])

  // 清掉測試房間
  const token = await apiToken(request)
  const H = { Authorization: `Bearer ${token}` }
  const rooms = (await (await request.get('/groupchat/rooms', { headers: H })).json()) as { id: string; name: string }[]
  for (const r of rooms) if (/^E2E 房 /.test(r.name)) await request.delete(`/groupchat/rooms/${r.id}`, { headers: H })
})
