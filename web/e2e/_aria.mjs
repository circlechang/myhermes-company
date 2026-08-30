import { chromium } from '@playwright/test'
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
await p.goto('http://127.0.0.1:8700/login')
await p.getByLabel(/使用者|帳號/).first().fill('admin'); await p.getByLabel(/密碼/).first().fill('admin'); await p.getByRole('button', { name: /登入/ }).click()
await p.waitForURL(u => !u.toString().includes('/login'))
for (const u of process.argv.slice(2)) { await p.goto('http://127.0.0.1:8700' + u); await p.waitForLoadState('networkidle').catch(()=>{}); await p.waitForTimeout(600); console.log('=== ' + u); console.log(await p.locator('main').ariaSnapshot()) }
await b.close()
