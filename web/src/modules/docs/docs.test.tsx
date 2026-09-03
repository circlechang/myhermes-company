// docs 模組前端：清單／文件面板渲染／diff 顯示／版本切換／血緣圖／圍欄過濾（fake fetch）
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import '../registry'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { renderApp, setupMocks } from '../../test/utils'
import { DocDetailPage } from './DocDetailPage'
import { DocModePage } from './DocModePage'
import { DocPanel } from './DocPanel'
import { DocsListPage } from './DocsListPage'
import { LineageGraph, layout } from './LineageGraph'
import { stripDocFence, type Doc, type DocVersionMeta, type Lineage } from './api'

const ok = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } })
const calls: { method: string; path: string; body?: unknown }[] = []

const V1 = '# 登入規格\n一、背景\n'
const V2 = '# 登入規格\n一、背景\n二、驗收條件\n'

const versions: DocVersionMeta[] = [
  { id: 'dv2', doc_id: 'doc_1', version: 2, author_kind: 'agent', author_id: 'researcher', summary: '第二節補上驗收條件', diff_stat: { added: 1, removed: 0 }, session_id: 's_1', run_id: 'run_2', created_at: '2026-08-31T02:00:00', chars: V2.length, lines: 3 },
  { id: 'dv1', doc_id: 'doc_1', version: 1, author_kind: 'agent', author_id: 'researcher', summary: '先列大綱', diff_stat: { added: 2, removed: 0 }, session_id: 's_1', run_id: 'run_1', created_at: '2026-08-31T01:00:00', chars: V1.length, lines: 2 },
]
let drift = false
const doc = (): Doc => ({
  id: 'doc_1', title: '登入規格', path: 'docs/doc_1_登入規格.md', format: 'md', status: 'draft', stage: 'intake', owner_agent_id: '',
  parent_doc_id: '', origin: 'chat', meta: {}, created_at: '2026-08-31T01:00:00', updated_at: '2026-08-31T02:00:00',
  latest_version: 2, versions: 2, latest: versions[0], drift, abs_path: '/ws/docs/doc_1_登入規格.md', content: V2,
  file_content: drift ? '有人改過' : V2,
})
let docOverride: Doc | null = null

const other: Doc = { ...doc(), id: 'doc_2', title: '出貨規格', status: 'final', stage: 'final', origin: 'workflow', latest_version: 5, drift: false }
const archivedDoc: Doc = { ...doc(), id: 'doc_3', title: '舊版報價', status: 'archived', stage: '', origin: 'upload', latest_version: 1, drift: false }

const lineage: Lineage = {
  root: 'doc_1',
  nodes: [
    { id: 'doc_0', title: '母規格', status: 'draft', stage: 'intake', origin: 'chat', path: 'a.md', latest_version: 1, chars: 10, is_root: false, parent_doc_id: '', created_at: '2026-08-31T00:00:00' },
    { id: 'doc_1', title: '登入規格', status: 'draft', stage: 'directions', origin: 'workflow', path: 'b.md', latest_version: 2, chars: 20, is_root: true, parent_doc_id: 'doc_0', created_at: '2026-08-31T01:00:00' },
    { id: 'doc_3', title: '定稿', status: 'final', stage: 'final', origin: 'workflow', path: 'c.md', latest_version: 3, chars: 30, is_root: false, parent_doc_id: 'doc_1', created_at: '2026-08-31T03:00:00' },
  ],
  edges: [
    { id: 'l1', from_doc_id: 'doc_0', to_doc_id: 'doc_1', kind: 'split', run_id: 'wr_1', node_id: 'f' },
    { id: 'l2', from_doc_id: 'doc_1', to_doc_id: 'doc_3', kind: 'selected', run_id: 'wr_1', node_id: 's' },
  ],
}

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const full = decodeURIComponent(url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, ''))
  const [p, query = ''] = full.split('?')
  const method = (init.method ?? 'GET').toUpperCase()
  calls.push({ method, path: full, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
  if (p === '/docs' && method === 'GET') {
    const q = new URLSearchParams(query)
    let rows = [doc(), other, archivedDoc]
    if (q.get('status')) rows = rows.filter((d) => d.status === q.get('status'))
    if (q.get('origin')) rows = rows.filter((d) => d.origin === q.get('origin'))
    return Promise.resolve(ok(rows))
  }
  if (p === '/docs' && method === 'POST') return Promise.resolve(ok({ ...doc(), id: 'doc_new', title: '新規格' }, 201))
  if (p === '/docs/doc_1' && method === 'PATCH') return Promise.resolve(ok({ ...doc(), ...(typeof init.body === 'string' ? JSON.parse(init.body) : {}) }))
  if (p === '/docs/doc_1' && method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
  if (p === '/docs/doc_1') return Promise.resolve(ok(docOverride ?? doc()))
  if (p === '/docs/doc_1/versions' && method === 'GET') return Promise.resolve(ok(versions))
  if (p === '/docs/doc_1/versions/1') return Promise.resolve(ok({ ...versions[1], content: V1 }))
  if (p === '/docs/doc_1/versions/2') return Promise.resolve(ok({ ...versions[0], content: V2 }))
  if (p === '/docs/doc_1/diff')
    return Promise.resolve(ok({ doc_id: 'doc_1', from: 1, to: 2, added: 1, removed: 0, diff: '--- v1\n+++ v2\n@@ -1,2 +1,3 @@\n # 登入規格\n 一、背景\n+二、驗收條件' }))
  if (p === '/docs/doc_1/lineage') return Promise.resolve(ok(lineage))
  if (p === '/docs/doc_1/snapshot') return Promise.resolve(ok({ ...versions[0], version: 3, same: false }))
  if (p === '/docs/doc_1/revert') return Promise.resolve(ok({ ...versions[0], version: 3, reverted_to: 1 }))
  return mockFetch(input, init)
}

beforeEach(() => {
  setupMocks({ loggedIn: true })
  setFetchImpl(fakeFetch as typeof fetch)
  calls.length = 0
  drift = false
  docOverride = null  // 測試之間不互相污染
})

describe('stripDocFence', () => {
  it('把 ```doc 圍欄從助理訊息裡拿掉，只留摘要', () => {
    expect(stripDocFence('補上驗收條件。\n```doc\n# 規格\n內文\n```')).toBe('補上驗收條件。')
  })
  it('四個反引號包住的內層 ``` 不會提早結束', () => {
    expect(stripDocFence('改了。\n````doc\n# 規格\n```py\nx\n```\n````\n收尾。')).toBe('改了。\n收尾。')
  })
  it('沒有圍欄就原樣留著', () => {
    expect(stripDocFence('這輪沒改文件。')).toBe('這輪沒改文件。')
  })
})

describe('DocsListPage', () => {
  it('列出文件、顯示版本與狀態，可依狀態篩選', async () => {
    renderApp(<DocsListPage />)
    expect(await screen.findByTestId('doc-doc_1')).toBeInTheDocument()
    const row = within(screen.getByTestId('doc-doc_1'))
    expect(row.getByText('登入規格')).toBeInTheDocument()
    expect(row.getByText('v2')).toBeInTheDocument()
    expect(row.getByText('草稿')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByTestId('filter-status'), 'final')
    await waitFor(() => expect(screen.queryByTestId('doc-doc_1')).not.toBeInTheDocument())
    expect(screen.getByTestId('doc-doc_2')).toBeInTheDocument()
  })

  it('可以建新文件', async () => {
    renderApp(<DocsListPage />)
    await screen.findByTestId('doc-doc_1')
    await userEvent.type(screen.getByTestId('new-doc-title'), '出貨規格')
    await userEvent.click(screen.getByTestId('new-doc'))
    await waitFor(() => expect(calls.find((c) => c.path === '/docs' && c.method === 'POST')?.body).toEqual({ title: '出貨規格' }))
  })

  it('封存＝把狀態改成 archived；封存的那份顯示「取消封存」', async () => {
    renderApp(<DocsListPage />)
    await screen.findByTestId('doc-doc_1')
    await userEvent.click(screen.getByTestId('doc-archive-doc_1'))
    await waitFor(() => expect(calls.find((c) => c.path === '/docs/doc_1' && c.method === 'PATCH')?.body).toEqual({ status: 'archived' }))
    expect(screen.getByTestId('doc-archive-doc_3')).toHaveTextContent('取消封存')
    await userEvent.click(screen.getByTestId('doc-archive-doc_3'))
    await waitFor(() => expect(calls.find((c) => c.path === '/docs/doc_3' && c.method === 'PATCH')?.body).toEqual({ status: 'draft' }))
  })

  it('刪除要先確認；取消就不打 API，確認才 DELETE', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderApp(<DocsListPage />)
    await userEvent.click(await screen.findByTestId('doc-delete-doc_1'))
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined()
    await userEvent.click(screen.getByTestId('doc-delete-doc_1'))
    await waitFor(() => expect(calls.find((c) => c.path === '/docs/doc_1' && c.method === 'DELETE')).toBeTruthy())
    expect(confirmSpy).toHaveBeenLastCalledWith(expect.stringContaining('登入規格'))
    confirmSpy.mockRestore()
  })
})

describe('DocModePage', () => {
  it('封存的文件預設不在左欄，按「顯示封存」才出現；每列都有封存／刪除', async () => {
    renderApp(<DocModePage />)
    await screen.findByTestId('doc-pick-doc_1')
    expect(screen.queryByTestId('doc-pick-doc_3')).not.toBeInTheDocument()
    expect(screen.getByTestId('doc-actions-doc_1')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('doc-mode-toggle-archived'))
    expect(screen.getByTestId('doc-pick-doc_3')).toBeInTheDocument()
    expect(screen.getByTestId('doc-archive-doc_3')).toHaveTextContent('取消封存')
    await userEvent.click(screen.getByTestId('doc-mode-toggle-archived'))
    await waitFor(() => expect(screen.queryByTestId('doc-pick-doc_3')).not.toBeInTheDocument())
  })

  it('刪掉正在看的文件後，中央面板回到「先選一份文件」', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderApp(<DocModePage />, { route: '/doc-mode?doc=doc_1' })
    await screen.findByTestId('doc-panel')
    await userEvent.click(await screen.findByTestId('doc-delete-doc_1'))
    await waitFor(() => expect(calls.find((c) => c.path === '/docs/doc_1' && c.method === 'DELETE')).toBeTruthy())
    await waitFor(() => expect(screen.queryByTestId('doc-panel')).not.toBeInTheDocument())
    expect(screen.getAllByText('先選一份文件').length).toBeGreaterThan(0)
  })
})

describe('DocPanel', () => {
  it('HTML 文件走沙箱 iframe：內容進 srcdoc，不進頁面 DOM', async () => {
    const html = '<!doctype html><html><body><h1>驗收條件</h1></body></html>'
    docOverride = { ...doc(), format: 'html', path: 'docs/doc_1.html', content: html }
    renderApp(<DocPanel docId="doc_1" />)
    const frame = await screen.findByTestId('doc-html-preview')
    expect(frame.getAttribute('srcdoc')).toContain('驗收條件')
    // sandbox="" ＝ 不給 script、不給 same-origin。內容來自模型，不能拿到頁面 token。
    expect(frame.getAttribute('sandbox')).toBe('')
    // 沒有被當成一般 HTML 塞進頁面
    expect(screen.queryByRole('heading', { name: '驗收條件' })).not.toBeInTheDocument()
  })

  it('渲染目前版本的 Markdown，版本徽章是最新版', async () => {
    renderApp(<DocPanel docId="doc_1" />)
    expect(await screen.findByTestId('doc-title')).toHaveTextContent('登入規格')
    expect(screen.getByTestId('doc-version')).toHaveTextContent('v2')
    expect(await screen.findByText(/二、驗收條件/)).toBeInTheDocument()
  })

  it('切到差異：綠增紅刪都畫出來', async () => {
    renderApp(<DocPanel docId="doc_1" />)
    await screen.findByTestId('doc-title')
    await userEvent.click(screen.getByTestId('doc-diff-toggle'))
    const diff = await screen.findByTestId('doc-diff')
    expect(within(diff).getByText('+二、驗收條件')).toBeInTheDocument()
    expect(diff.querySelector('[data-line="add"]')).toBeTruthy()
    expect(screen.getByTestId('diff-stat')).toHaveTextContent('+1')
  })

  it('版本下拉可以切回舊版內容', async () => {
    renderApp(<DocPanel docId="doc_1" />)
    await screen.findByTestId('doc-title')
    expect(await screen.findByText(/二、驗收條件/)).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByTestId('doc-version-select'), '1')
    await waitFor(() => expect(screen.queryByText(/二、驗收條件/)).not.toBeInTheDocument())
    expect(screen.getByText(/一、背景/)).toBeInTheDocument()
  })

  it('有新版時亮出確認條，可接受或還原上一版', async () => {
    const onAccept = vi.fn()
    renderApp(<DocPanel docId="doc_1" pending={{ version: 2, summary: '第二節補上驗收條件', diff_stat: { added: 1, removed: 0 } }} onAccept={onAccept} />)
    const bar = await screen.findByTestId('doc-pending')
    expect(bar).toHaveTextContent('新版本 v2')
    expect(bar).toHaveTextContent('第二節補上驗收條件')
    // 有新版時自動切到 diff
    expect(await screen.findByTestId('doc-diff')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('doc-accept'))
    expect(onAccept).toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('doc-revert'))
    await waitFor(() => expect(calls.find((c) => c.path === '/docs/doc_1/revert')?.body).toEqual({ version: 1 }))
  })

  it('漂移時顯示提示並可一鍵存成新版本', async () => {
    drift = true
    renderApp(<DocPanel docId="doc_1" />)
    expect(await screen.findByTestId('doc-drift')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('doc-snapshot'))
    await waitFor(() => expect(calls.some((c) => c.path === '/docs/doc_1/snapshot' && c.method === 'POST')).toBe(true))
  })

  it('人可以直接編輯，存檔＝人類作者的新版本', async () => {
    renderApp(<DocPanel docId="doc_1" />)
    await screen.findByTestId('doc-title')
    await userEvent.click(screen.getByTestId('doc-edit-toggle'))
    const box = await screen.findByTestId('doc-editor')
    await userEvent.clear(box)
    await userEvent.type(box, '手改')
    await userEvent.click(screen.getByTestId('doc-save'))
    await waitFor(() => {
      const c = calls.find((x) => x.path === '/docs/doc_1/versions' && x.method === 'POST')
      expect(c?.body).toMatchObject({ content: '手改', author_kind: 'human' })
    })
  })
})

describe('LineageGraph', () => {
  it('分層排版：沒有入邊的在最左邊，往下游遞增', () => {
    const { placed } = layout(lineage.nodes, lineage.edges)
    const byId = Object.fromEntries(placed.map((p) => [p.id, p]))
    expect(byId.doc_0.level).toBe(0)
    expect(byId.doc_1.level).toBe(1)
    expect(byId.doc_3.level).toBe(2)
    expect(byId.doc_0.x).toBeLessThan(byId.doc_1.x)
  })

  it('有環也不會把座標推爆（spec → 草稿 split → 被選中的又寫回 spec）', () => {
    const cyc: Lineage = {
      root: 'spec',
      nodes: [
        { ...lineage.nodes[0], id: 'spec', title: '規格', is_root: true, parent_doc_id: '' },
        { ...lineage.nodes[1], id: 'd1', title: '草稿1', is_root: false, parent_doc_id: 'spec' },
        { ...lineage.nodes[2], id: 'd2', title: '草稿2', is_root: false, parent_doc_id: 'spec' },
      ],
      edges: [
        { id: 'e1', from_doc_id: 'spec', to_doc_id: 'd1', kind: 'split', run_id: '', node_id: '' },
        { id: 'e2', from_doc_id: 'spec', to_doc_id: 'd2', kind: 'split', run_id: '', node_id: '' },
        { id: 'e3', from_doc_id: 'd2', to_doc_id: 'spec', kind: 'selected', run_id: '', node_id: '' },
      ],
    }
    const { placed, width } = layout(cyc.nodes, cyc.edges)
    expect(width).toBeLessThan(1200)
    for (const p of placed) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(p.x).toBeLessThan(1200)
      expect(p.level).toBeLessThan(cyc.nodes.length)
    }
    expect(placed.find((p) => p.id === 'spec')!.level).toBe(0)
  })

  it('畫出節點與各種血緣邊，點節點可跳頁', async () => {
    const onPick = vi.fn()
    renderApp(<LineageGraph data={lineage} onPick={onPick} />)
    expect(screen.getByTestId('lineage-graph')).toBeInTheDocument()
    expect(screen.getByTestId('lineage-node-doc_0')).toBeInTheDocument()
    expect(screen.getByTestId('lineage-node-doc_3')).toBeInTheDocument()
    expect(screen.getByTestId('lineage-edge-split')).toBeInTheDocument()
    expect(screen.getByTestId('lineage-edge-selected')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('lineage-node-doc_3'))
    expect(onPick).toHaveBeenCalledWith('doc_3')
  })
})

describe('DocDetailPage', () => {
  const render1 = () => renderApp(<Routes><Route path="/docs/:id" element={<DocDetailPage />} /></Routes>, { route: '/docs/doc_1' })

  it('文件本體＋版本歷史＋血緣圖三段都在', async () => {
    render1()
    expect(await screen.findByTestId('doc-detail-page')).toBeInTheDocument()
    expect(await screen.findByTestId('doc-panel')).toBeInTheDocument()
    const list = await screen.findByTestId('version-list')
    expect(within(list).getByTestId('version-2')).toHaveTextContent('第二節補上驗收條件')
    expect(within(list).getByTestId('version-1')).toHaveTextContent('先列大綱')
    expect(await screen.findByTestId('lineage-graph')).toBeInTheDocument()
  })

  it('可以比對任兩版，並還原到舊版', async () => {
    render1()
    await screen.findByTestId('version-list')
    await userEvent.click(screen.getByTestId('cmp-latest-1'))
    expect(await screen.findByTestId('doc-compare-diff')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('revert-1'))
    await waitFor(() => expect(calls.find((c) => c.path === '/docs/doc_1/revert')?.body).toEqual({ version: 1 }))
  })
})
