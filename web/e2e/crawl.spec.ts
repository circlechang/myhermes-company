import { test, expect } from '@playwright/test'
import { collect, login, shot, i18nLeaks } from './helpers'

// 第一輪粗掃：每頁載入、無 console error、無 4xx/5xx、無 i18n key 漏出
const pages: [string, string][] = [
  ['workbench', '/'], ['agents', '/agents'], ['profiles', '/profiles'], ['models', '/models'], ['channels', '/channels'],
  ['cron', '/cron'], ['usage', '/usage'], ['kanban', '/kanban'], ['workflows', '/workflows'], ['groupchat', '/groupchat'],
  ['files', '/files'], ['skills', '/skills'], ['theme', '/theme'], ['logs', '/logs'], ['admin', '/admin'], ['coding', '/coding'],
  ['voice', '/voice'], ['settings', '/settings'],
]

test.describe('crawl', () => {
  test.beforeEach(async ({ page }) => { await login(page) })
  for (const [name, url] of pages) {
    test(`page ${name}`, async ({ page }) => {
      const c = collect(page)
      await page.goto(url)
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(800)
      const leaks = await i18nLeaks(page)
      await shot(page, `crawl-${name}`)
      const text = (await page.locator('main, body').first().innerText()).trim()
      console.log(`[${name}] errors=${JSON.stringify(c.errors)} bad=${JSON.stringify(c.badResponses)} leaks=${JSON.stringify(leaks)} textlen=${text.length}`)
      expect(text.length, 'white screen').toBeGreaterThan(20)
      expect(c.errors, 'console errors').toEqual([])
      expect(c.badResponses, 'failed API').toEqual([])
      expect(leaks, 'i18n leaks').toEqual([])
    })
  }
})
