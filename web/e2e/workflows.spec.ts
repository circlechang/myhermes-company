import { test, expect } from '@playwright/test'
import { apiToken, collect, loginFast, shot } from './helpers'

test('workflows: 三站含等我確認 → 執行 → 就地核准 → 快照', async ({ page, request }) => {
  test.setTimeout(300_000)
  const token = await apiToken(request)
  const H = { Authorization: `Bearer ${token}` }
  const agents = (await (await request.get('/agents', { headers: H })).json()) as { id: string; profile: string }[]
  const ag = agents.find((a) => a.profile === 'default')!.id
  const name = `E2E 工作流 ${Date.now()}`
  const nodes = [
    { id: 'a', title: '第一步', kind: 'hermes', agent_id: ag, prompt: '只回覆一個字：好', position: { x: 0, y: 0 } },
    { id: 'g', title: '等我確認', kind: 'gate', position: { x: 250, y: 0 } },
    { id: 'b', title: '第二步', kind: 'hermes', agent_id: ag, prompt: '只回覆一個字：好', position: { x: 500, y: 0 } },
  ]
  const edges = [
    { id: 'a-g-output', source: 'a', target: 'g' },
    { id: 'g-b-output', source: 'g', target: 'b' },
  ]
  const created = await request.post('/workflows', { headers: H, data: { name, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } } })
  expect(created.status()).toBe(201)
  const wid = ((await created.json()) as { id: string }).id

  await loginFast(page, token)
  const c = collect(page)
  await page.goto('/workflows')
  await expect(page.getByText(name)).toBeVisible()
  await shot(page, 'workflows-list')
  await page.goto(`/workflows/${wid}`)
  await expect(page.getByLabel('名稱')).toHaveValue(name)
  // 預設是生產線視圖（畫布降為「⋯ → 進階檢視」）
  await expect(page.getByTestId('stations-view')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('station-a-title')).toHaveValue('第一步')
  await expect(page.getByTestId('station-g-title')).toHaveValue('等我確認')
  await shot(page, 'workflows-editor')

  await page.getByTestId('wf-run').click()
  // 等我確認：核准鈕就在那張站卡上，不用跳到別的面板
  await expect(page.getByTestId('station-g')).toHaveAttribute('data-light', 'waiting_approval', { timeout: 180_000 })
  await shot(page, 'workflows-waiting-approval')
  await page.getByTestId('station-g-approve').click()
  await expect(page.getByTestId('station-b')).toHaveAttribute('data-light', 'completed', { timeout: 180_000 })
  await expect(page.getByTestId('station-b-result')).toBeVisible({ timeout: 20_000 })
  await shot(page, 'workflows-completed')

  // 進階檢視：畫布與既有功能都還在
  await page.getByTestId('wf-more').click()
  await page.getByTestId('menu-advanced').click()
  await expect(page.locator('.react-flow__node')).toHaveCount(3, { timeout: 20_000 })
  await shot(page, 'workflows-advanced')

  const runs = (await (await request.get(`/workflows/${wid}/runs`, { headers: H })).json()) as { id: string; status: string }[]
  expect(runs[0].status).toBe('completed')
  await page.goto(`/workflows/runs/${runs[0].id}`)
  await expect(page.getByTestId('event-list')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('replay-bar')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  await shot(page, 'workflows-snapshot')

  await page.goto('/workflows/approvals')
  await expect(page.getByText(/等你確認/).first()).toBeVisible()
  await shot(page, 'workflows-approvals')

  // 清掉測試資料
  await request.post('/workflows/batch-delete', { headers: H, data: { ids: [wid] } })
  expect(c.errors.filter((e) => !/NaN/.test(e)), 'console errors').toEqual([])
  expect(c.badResponses).toEqual([])
})
