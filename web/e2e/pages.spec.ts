import { test, expect } from '@playwright/test'
import { collect, i18nLeaks, login, shot } from './helpers'

// 其餘頁面：載入＋一個代表性互動
test.describe('pages', () => {
  test.beforeEach(async ({ page }) => { await login(page) })

  test('theme: 切暗色即時生效', async ({ page }) => {
    const c = collect(page)
    await page.goto('/theme')
    await page.getByRole('radio', { name: '暗色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await shot(page, 'theme-dark')
    await page.getByRole('radio', { name: '亮色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    // 還原成跟隨系統，並等 PUT /theme 落地再離開（否則設定會停在上一個狀態）
    const put = page.waitForResponse((r) => /\/api\/theme$/.test(r.url()) && r.request().method() === 'PUT')
    await page.getByRole('radio', { name: '跟隨系統' }).click()
    await put
    await expect(page.getByText('已儲存')).toBeVisible()
    expect(c.errors).toEqual([]); expect(c.badResponses).toEqual([])
  })

  test('logs: 切檔案與等級', async ({ page }) => {
    const c = collect(page)
    await page.goto('/logs')
    const file = page.getByLabel(/檔案|File/).first()
    await expect(file).toBeVisible()
    const opts = await file.locator('option').allTextContents()
    if (opts.length > 1) await file.selectOption({ index: 1 })
    await page.waitForLoadState('networkidle')
    await shot(page, 'logs')
    expect(c.errors).toEqual([]); expect(c.badResponses).toEqual([])
  })

  test('files: 進入子目錄再回上層', async ({ page }) => {
    const c = collect(page)
    await page.goto('/files')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('載入中')).toHaveCount(0, { timeout: 20_000 })
    const dir = page.locator('button, a').filter({ hasText: /📁|\/$/ }).first()
    if (await dir.count()) {
      await dir.click()
      await expect(page.getByText('載入中')).toHaveCount(0, { timeout: 20_000 })
    }
    await shot(page, 'files')
    await page.getByRole('button', { name: /上一層/ }).click()
    await expect(page.getByText('載入中')).toHaveCount(0, { timeout: 20_000 })
    expect(c.errors).toEqual([]); expect(c.badResponses).toEqual([])
  })

  test('skills: 四個分頁', async ({ page }) => {
    const c = collect(page)
    await page.goto('/skills')
    for (const tab of ['Bundles', /記憶|Memory/, /Journey|旅程/]) {
      await page.getByRole('tab', { name: tab }).first().click()
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(500)
    }
    await shot(page, 'skills-journey')
    expect(await i18nLeaks(page)).toEqual([])
    expect(c.errors).toEqual([]); expect(c.badResponses).toEqual([])
  })

  for (const [name, url, expectText] of [
    ['profiles', '/profiles', /default/], ['models', '/models', /provider|供應商|模型/i], ['channels', '/channels', /LINE/],
    ['cron', '/cron', /排程|cron/i], ['usage', '/usage', /token/i], ['coding', '/coding', /Claude Code|Codex|Pi/],
    ['voice', '/voice', /TTS|STT|語音/], ['settings', '/settings', /Gateway/], ['agents', '/agents', /default/],
  ] as [string, string, RegExp][]) {
    test(`${name} 載入`, async ({ page }) => {
      const c = collect(page)
      await page.goto(url)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('main, body').first()).toContainText(expectText, { timeout: 20_000 })
      expect(await i18nLeaks(page)).toEqual([])
      await shot(page, name)
      expect(c.errors).toEqual([]); expect(c.badResponses).toEqual([])
    })
  }
})
