import { expect, test } from '@playwright/test'
import path from 'node:path'
import { apiToken, login } from './helpers'

// AI 員工＝Coding Agent：對真機（暫存 MHC_HOME、port 8747）截圖存 docs/qa/coding-staff/
const DIR = path.resolve(process.cwd(), '../docs/qa/coding-staff')
const shot = (page: import('@playwright/test').Page, name: string) =>
  page.screenshot({ path: path.join(DIR, `${name}.png`), fullPage: false })

test.describe('coding 員工', () => {
  // 不依賴環境裡剛好有 coding 員工：每次自己確保 devbot 存在（工作目錄放 Hermes workspace 底下才過白名單）
  test.beforeAll(async ({ request }) => {
    const tok = await apiToken(request)
    const h = { authorization: `Bearer ${tok}` }
    const list = await request.get('/api/agents', { headers: h })
    const agents = (await list.json()) as Array<{ name: string; runtime?: string }>
    if (agents.some((a) => a.name === 'devbot')) return
    // 工作目錄要先存在才能綁（409 exists 代表已經有了，也可以）
    const dir = await request.post('/api/files/mkdir', {
      headers: h,
      data: { path: 'workspace/e2e-devbot' },
    })
    expect([200, 201, 409].includes(dir.status()), await dir.text()).toBeTruthy()
    const made = await request.post('/api/agents', {
      headers: h,
      data: {
        name: 'devbot',
        runtime: 'claude-code',
        title: 'e2e 用的工程師',
        workspace: `${process.env.HOME}/.hermes/workspace/e2e-devbot`,
        enabled: true,
      },
    })
    expect([200, 201].includes(made.status()), await made.text()).toBeTruthy()
  })

  test('員工清單有 runtime 徽章與工作目錄', async ({ page }) => {
    await login(page)
    await page.goto('/agents')
    await expect(page.getByTestId('agents-list').getByText('devbot').first()).toBeVisible()
    await expect(page.getByTestId('agents-list').getByTestId('runtime-badge-claude-code').first()).toBeVisible()
    await shot(page, '01-agents-list')
    // 選到 coding 員工 → 沒有 SOUL.md，改顯示 coding 設定與「開啟工作目錄」
    await page.getByTestId('agents-list').getByText('devbot').first().click()
    await expect(page.getByTestId('coding-no-soul')).toBeVisible()
    await expect(page.getByTestId('coding-settings')).toBeVisible()
    await shot(page, '02-agent-detail-coding')
  })

  test('建立員工對話框：runtime 選單標出未安裝的', async ({ page }) => {
    await login(page)
    await page.goto('/agents')
    await page.getByTestId('new-agent').click()
    const dialog = page.getByTestId('create-agent-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('new-agent-runtime').locator('option')).toHaveCount(4)
    await dialog.getByTestId('new-agent-name').fill('pibot')
    await dialog.getByTestId('new-agent-runtime').selectOption('pi')
    await expect(dialog.getByTestId('runtime-not-installed')).toContainText('npm i -g')
    await expect(dialog.getByTestId('new-agent-submit')).toBeDisabled()
    await shot(page, '03-create-dialog-not-installed')
    // 切到已安裝的 Claude Code：改成選工作目錄
    await dialog.getByTestId('new-agent-runtime').selectOption('claude-code')
    await expect(dialog.getByTestId('workspace-roots')).toBeVisible()
    await shot(page, '04-create-dialog-claude-code')
  })

  test('工作臺：coding 員工可選、可開對話', async ({ page, request }) => {
    // 自己種一段對話，不依賴環境裡剛好有跑過的紀錄
    // （真的把任務跑起來、產生工具卡與檔案改動，由 pytest 的假 CLI 測試涵蓋）
    const tok = await apiToken(request)
    const h = { authorization: `Bearer ${tok}` }
    const agentsRes = await request.get('/api/agents', { headers: h })
    const dev = ((await agentsRes.json()) as Array<{ id: string; name: string }>).find((a) => a.name === 'devbot')
    expect(dev, 'devbot 應該已被 beforeAll 種好').toBeTruthy()
    const made = await request.post('/api/sessions', { headers: h, data: { agent_id: dev!.id, title: '與 devbot 的對話' } })
    expect([200, 201].includes(made.status()), await made.text()).toBeTruthy()

    await login(page)
    await page.goto('/')
    const sidebar = page.getByTestId('sidebar-desktop')
    await sidebar.getByText('devbot').first().click()
    await expect(sidebar.getByTestId('runtime-badge-claude-code').first()).toBeVisible()
    await sidebar.getByText('與 devbot 的對話').first().click()
    // coding 員工用的是同一個聊天介面（前端不分 runtime）
    await expect(page.getByPlaceholder(/輸入訊息/)).toBeVisible()
    await page.waitForTimeout(500)
    await shot(page, '05-workbench-coding-chat')
  })

  test('工作流「誰做」下拉列得到 coding 員工', async ({ page, request }) => {
    // 自己建一條，不依賴環境裡剛好有這條工作流
    const tok = await apiToken(request)
    // 節點必須指定 agent_id：拿剛才種的 devbot
    const agentsRes = await request.get('/api/agents', { headers: { authorization: `Bearer ${tok}` } })
    const dev = ((await agentsRes.json()) as Array<{ id: string; name: string }>).find((a) => a.name === 'devbot')
    expect(dev, 'devbot 應該已被 beforeAll 種好').toBeTruthy()
    const name = `coding 員工工作流 ${Date.now()}`
    const made = await request.post('/api/workflows', {
      headers: { authorization: `Bearer ${tok}` },
      data: {
        name,
        nodes: [{ id: 'n1', title: '第一站', kind: 'hermes', agent_id: dev!.id, prompt: '只回一個字：好', position: { x: 80, y: 80 } }],
        edges: [],
      },
    })
    expect([200, 201].includes(made.status()), await made.text()).toBeTruthy()
    const wf = (await made.json()) as { id: string }
    await login(page)
    await page.goto(`/workflows/${wf.id}`)
    const who = page.locator('select[data-testid$="-agent"]').first()
    await expect(who).toBeVisible()
    const labels = await who.locator('option').allTextContents()
    expect(labels.some((l) => l.includes('devbot') && l.includes('Claude Code'))).toBeTruthy()
    await who.scrollIntoViewIfNeeded()
    await shot(page, '06-workflow-who-dropdown')
  })
})
