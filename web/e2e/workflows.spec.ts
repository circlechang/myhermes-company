import { test, expect } from '@playwright/test'
import { apiToken, collect, loginFast, shot } from './helpers'

test('workflows: 三節點含閘門 → 執行 → 核准 → 快照', async ({ page, request }) => {
  test.setTimeout(300_000)
  const token = await apiToken(request)
  const H = { Authorization: `Bearer ${token}` }
  const agents = (await (await request.get('/agents', { headers: H })).json()) as { id: string; profile: string }[]
  const ag = agents.find((a) => a.profile === 'default')!.id
  const name = `E2E 工作流 ${Date.now()}`
  const nodes = [
    { id: 'a', title: '第一步', kind: 'hermes', agent_id: ag, prompt: '只回覆一個字：好', position: { x: 0, y: 0 } },
    { id: 'g', title: '審批閘門', kind: 'gate', position: { x: 250, y: 0 } },
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
  await expect(page.locator('.react-flow__node')).toHaveCount(3, { timeout: 20_000 })
  await shot(page, 'workflows-editor')

  await page.getByRole('button', { name: /執行$/ }).click()
  const panel = page.getByTestId('run-panel')
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByTestId('status-badge').first()).toContainText('等待審批', { timeout: 180_000 })
  await shot(page, 'workflows-waiting-approval')
  await panel.getByRole('button', { name: '核准' }).click()
  await expect(panel.getByTestId('status-badge').first()).toContainText(/^完成$/, { timeout: 180_000 })
  await shot(page, 'workflows-completed')

  const runs = (await (await request.get(`/workflows/${wid}/runs`, { headers: H })).json()) as { id: string; status: string }[]
  expect(runs[0].status).toBe('completed')
  await page.goto(`/workflows/runs/${runs[0].id}`)
  await expect(page.getByTestId('event-list')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('replay-bar')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(3)
  await shot(page, 'workflows-snapshot')

  await page.goto('/workflows/approvals')
  await expect(page.getByText(/審批面板/)).toBeVisible()
  await shot(page, 'workflows-approvals')

  // 清掉測試資料
  await request.post('/workflows/batch-delete', { headers: H, data: { ids: [wid] } })
  expect(c.errors.filter((e) => !/NaN/.test(e)), 'console errors').toEqual([])
  expect(c.badResponses).toEqual([])
})
