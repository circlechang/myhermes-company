// docs 模組截圖：文件模式工作臺、diff 檢視、血緣視圖、spec-builder 階段頁。
// 對已跑起來的伺服器（預設 E2E_BASE_URL）走一遍；截圖存 docs/qa/docs/。
import { expect, test } from '@playwright/test'
import path from 'node:path'
import { apiToken, collect, login } from './helpers'

const DIR = path.resolve(process.cwd(), '../docs/qa/docs')
const DOC_ID = process.env.E2E_DOC_ID ?? ''
const SPEC_DOC_ID = process.env.E2E_SPEC_DOC_ID ?? ''

async function shot(page: import('@playwright/test').Page, name: string) {
  await page.screenshot({ path: path.join(DIR, `${name}.png`), fullPage: false })
}

test.describe('docs 模組', () => {
  test('文件模式工作臺（左聊天、右文件）', async ({ page }) => {
    const c = collect(page)
    await login(page)
    await page.goto(`/doc-mode${DOC_ID ? `?doc=${DOC_ID}` : ''}`)
    await expect(page.getByTestId('doc-mode-page')).toBeVisible()
    if (DOC_ID) {
      await expect(page.getByTestId('doc-panel')).toBeVisible()
      await expect(page.getByTestId('doc-title')).toBeVisible()
      await expect(page.getByTestId('message-list')).toBeVisible({ timeout: 15_000 })
    }
    await page.waitForTimeout(800)
    await shot(page, '01-doc-mode')
    expect(c.errors, c.errors.join('\n')).toEqual([])
  })

  test('文件面板的 diff 檢視（綠增紅刪）', async ({ page }) => {
    test.skip(!DOC_ID, '需要 E2E_DOC_ID')
    const c = collect(page)
    await login(page)
    await page.goto(`/doc-mode?doc=${DOC_ID}`)
    await expect(page.getByTestId('doc-panel')).toBeVisible()
    await page.getByTestId('doc-diff-toggle').click()
    await expect(page.getByTestId('doc-diff')).toBeVisible()
    await page.waitForTimeout(400)
    await shot(page, '02-doc-diff')
    expect(c.errors, c.errors.join('\n')).toEqual([])
  })

  test('文件清單', async ({ page, request }) => {
    const c = collect(page)
    // 自己種一筆，不依賴環境裡剛好有文件（清單空的時候 doc-list 不會渲染）
    const tok = await apiToken(request)
    const created = await request.post('/api/docs', {
      headers: { authorization: `Bearer ${tok}` },
      data: { title: `E2E 文件 ${Date.now()}`, content: '# E2E\n\n這是 e2e 自建的文件。' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    await login(page)
    await page.goto('/docs')
    await expect(page.getByTestId('docs-page')).toBeVisible()
    await expect(page.getByTestId('doc-list')).toBeVisible()
    await page.waitForTimeout(500)
    await shot(page, '03-docs-list')
    expect(c.errors, c.errors.join('\n')).toEqual([])
  })

  test('血緣視圖（/docs/:id）', async ({ page }) => {
    const id = SPEC_DOC_ID || DOC_ID
    test.skip(!id, '需要 E2E_SPEC_DOC_ID 或 E2E_DOC_ID')
    const c = collect(page)
    await login(page)
    await page.goto(`/docs/${id}`)
    await expect(page.getByTestId('doc-detail-page')).toBeVisible()
    await expect(page.getByTestId('version-list')).toBeVisible()
    const graph = page.getByTestId('lineage-graph')
    await expect(graph).toBeVisible({ timeout: 15_000 })
    await graph.scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    await shot(page, '04-lineage')
    expect(c.errors, c.errors.join('\n')).toEqual([])
  })

  test('spec-builder 階段頁', async ({ page, request }) => {
    const c = collect(page)
    // 套件沒裝的話階段列不會出現：先確保裝好（install 是冪等的）
    const tok = await apiToken(request)
    const inst = await request.post('/api/packs/spec-builder/install', {
      headers: { authorization: `Bearer ${tok}` },
      data: {},
    })
    expect([200, 201].includes(inst.status()), await inst.text()).toBeTruthy()
    // 沒有主題時階段列不會渲染（顯示空狀態），所以先確保有一個主題可看
    let topic = process.env.E2E_TOPIC
    if (!topic) {
      const list = await request.get('/api/packs/spec-builder/topics', {
        headers: { authorization: `Bearer ${tok}` },
      })
      const existing = (await list.json()) as Array<{ id: string }>
      topic = existing[0]?.id
      if (!topic) {
        const made = await request.post('/api/packs/spec-builder/topics', {
          headers: { authorization: `Bearer ${tok}` },
          data: { title: `E2E 規格主題 ${Date.now()}` },
        })
        expect([200, 201].includes(made.status()), await made.text()).toBeTruthy()
        topic = ((await made.json()) as { id: string }).id
      }
    }
    await login(page)
    await page.goto(`/packs/spec-builder?topic=${topic}`)
    await expect(page.getByTestId('stage-row')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(800)
    await shot(page, '05-spec-builder')
    expect(c.errors, c.errors.join('\n')).toEqual([])
  })
})
