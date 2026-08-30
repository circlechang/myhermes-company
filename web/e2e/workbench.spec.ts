import { test, expect } from '@playwright/test'
import path from 'node:path'
import { apiToken, collect, login, shot } from './helpers'

test.describe('workbench', () => {
  test('選 default → 短訊息收到回覆 → 上傳小圖 → 切模型 → Ctrl+K → Hermes 歷史', async ({ page, request }) => {
    test.setTimeout(240_000)
    const startedAt = Date.now()
    await login(page)
    const c = collect(page)
    await page.goto('/')
    const sidebar = page.getByTestId('sidebar-desktop')
    await sidebar.getByRole('button', { name: /^default/ }).first().click()
    await sidebar.getByRole('button', { name: /新對話/ }).click()
    const composer = page.getByPlaceholder(/輸入訊息/)
    await expect(composer).toBeEnabled({ timeout: 20_000 })
    await composer.fill('只回覆一個字：好')
    await composer.press('Enter')
    const list = page.getByTestId('message-list')
    await expect(list).toContainText('只回覆一個字')
    // 等回覆結束（停止鈕消失）且出現 AI 訊息
    await expect(page.getByRole('button', { name: '停止' })).toBeHidden({ timeout: 150_000 })
    await expect(list.getByText('AI', { exact: true }).first()).toBeVisible()
    await shot(page, 'workbench-reply')

    // 上傳一張 1x1 png，送一句話
    await page.getByTestId('file-input').setInputFiles(path.resolve('e2e/fixtures/dot.png'))
    await expect(page.getByTestId('pending-attachments')).toContainText('dot.png')
    await composer.fill('一句話：收到圖回「收到」')
    await composer.press('Enter')
    await expect(page.getByTestId('attachments').first()).toContainText('dot.png')
    await expect(page.getByRole('button', { name: '停止' })).toBeHidden({ timeout: 150_000 })
    await shot(page, 'workbench-upload')

    // 模型選擇器：開 → 挑目前供應商的第一個模型 → 徽章更新 → 切回預設
    await page.getByTestId('model-badge').click()
    const picker = page.getByTestId('model-picker')
    await expect(picker).toBeVisible()
    const firstModel = picker.locator('span.font-mono').first()
    await expect(firstModel).toBeVisible({ timeout: 30_000 })
    const modelId = (await firstModel.textContent())!.trim()
    await shot(page, 'workbench-model-picker')
    await firstModel.click()
    await expect(page.getByTestId('model-badge')).toContainText(modelId.split('/').pop()!)
    await page.getByTestId('model-badge').click()
    await picker.getByRole('button', { name: /預設/ }).first().click()

    // Ctrl+K 搜尋
    await page.keyboard.press('Control+k')
    const pal = page.getByTestId('search-palette')
    await expect(pal).toBeVisible()
    await pal.getByRole('textbox').fill('只回覆')
    await expect(pal).toContainText('只回覆', { timeout: 15_000 })
    await shot(page, 'workbench-search')
    await page.keyboard.press('Escape')
    await expect(pal).toBeHidden()

    // Hermes 歷史：展開 default 來源，開第一筆
    const hermes = page.getByTestId('group-hermes')
    await expect(hermes).toBeVisible()
    const histList = page.getByTestId('hermes-list-default')
    if (!(await histList.isVisible())) await hermes.locator('code', { hasText: /^default$/ }).first().click()
    await expect(histList).toBeVisible({ timeout: 20_000 })
    await histList.getByRole('button', { name: /Hermes$/ }).first().click()
    const hv = page.getByTestId('hermes-view')
    await expect(hv).toBeVisible({ timeout: 20_000 })
    await expect(hv.getByText('載入中')).toHaveCount(0, { timeout: 60_000 })
    await expect(hv.getByTestId('message-list')).toBeVisible()
    await shot(page, 'workbench-hermes-history')

    expect(c.errors, 'console errors').toEqual([])
    expect(c.badResponses, 'failed API').toEqual([])

    // 清掉本測試建立的工作臺 session
    const token = await apiToken(request)
    const H = { Authorization: `Bearer ${token}` }
    const sessions = (await (await request.get('/sessions', { headers: H })).json()) as { id: string; source?: string; created_at: string }[]
    for (const s of sessions) if (s.source === 'workbench' && new Date(s.created_at).getTime() >= startedAt - 60_000) await request.delete(`/sessions/${s.id}`, { headers: H })
  })
})
