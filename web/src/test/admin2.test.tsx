// I 檔案 / L Skills+記憶+Journey / M 主題 / N 日誌 / O 管理 前端測試（fake fetch）
import { screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '../modules/registry' // 註冊模組 i18n
import { setFetchImpl } from '../api/client'
import { mockFetch } from '../mock/fetch'
import { setEngineerMode } from '../prefs/engineerMode'
import { renderApp, setupMocks } from './utils'
import { FilesPage } from '../modules/files'
import { SkillsPage } from '../modules/skills'
import { ThemePage, applyTheme, THEME_DEFAULTS } from '../modules/theme'
import { LogsPage, setLogsWebSocketImpl } from '../modules/logs'
import { AdminPage } from '../modules/admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const calls: { method: string; path: string; body?: any }[] = []
function ok(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}
function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '')
  const method = (init.method ?? 'GET').toUpperCase()
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ method, path, body })
  const p = path.split('?')[0]
  const qs = new URLSearchParams(path.split('?')[1] ?? '')
  if (p === '/files/roots') return Promise.resolve(ok([{ id: 'workspace', label: 'Hermes workspace', kind: 'workspace', exists: true, writable: true }, { id: 'profile:default', label: 'profile default', kind: 'profile', exists: true, writable: true }]))
  if (p === '/files/list') {
    if (qs.get('path') === 'workspace/../x') return Promise.resolve(ok({ error: { code: 'path_traversal', message: "'..' is not allowed" } }, 400))
    return Promise.resolve(ok({ path: qs.get('path'), root: 'workspace', parent: qs.get('path') === 'workspace' ? null : 'workspace', entries: [{ name: 'sub', path: 'workspace/sub', kind: 'dir', size: 0, mtime: 1 }, { name: 'hello.md', path: 'workspace/hello.md', kind: 'file', size: 12, mtime: 1 }] }))
  }
  if (p === '/files/read') return Promise.resolve(ok({ path: qs.get('path'), name: 'hello.md', size: 12, mtime: 1, mime: 'text/markdown', binary: false, truncated: false, content: '# hi' }))
  if (p === '/files/write') return Promise.resolve(ok({ name: 'hello.md', path: body.path, kind: 'file', size: 5, mtime: 2 }))
  if (p === '/files/attach') return Promise.resolve(ok({ uri: `workspace://${body.path}`, abs_path: '/x', name: 'hello.md' }))
  if (p === '/hermes/status') return Promise.resolve(ok({ gateway_ok: true, version: '0.20.5', profiles: [{ name: 'default' }, { name: 'researcher' }], api_server_url: '' }))
  if (p === '/skills') return Promise.resolve(ok({ profile: 'default', items: [{ name: 'alpha', dir: 'alpha', path: '/s/alpha', source: 'local', category: 'research', description: 'Alpha skill', version: '1', tags: ['a'], mtime: 1, files: 2, enabled: true, profile: 'default', topic: '研究與情報' }, { name: 'beta', dir: 'beta', path: '/s/beta', source: 'builtin', category: 'x', description: 'Beta', version: '', tags: [], mtime: 1, files: 1, enabled: false, profile: 'default', topic: '其他' }].filter((s) => !qs.get('q') || s.name.includes(qs.get('q')!)), topics: [{ name: '研究與情報', hint: '查資料', count: 1 }, { name: '其他', hint: '', count: 1 }], categories: [{ name: 'research', count: 1 }, { name: 'x', count: 1 }] }))
  if (p === '/skills/usage') return Promise.resolve(ok({ counts: { alpha: 3, beta: 0 }, last_used: { alpha: 1700000000 }, top: [['alpha', 3]], recent: [['alpha', 1700000000]] }))
  if (p === '/skills/alpha/toggle') return Promise.resolve(ok({ enabled: body.enabled }))
  if (p === '/skills/alpha') return Promise.resolve(ok({ name: 'alpha', dir: 'alpha', path: '/s/alpha', source: 'local', category: 'research', description: 'Alpha skill', version: '1', tags: ['a'], mtime: 1, files: 2, enabled: true, profile: 'default', content: '---\nname: alpha\n---\nbody', frontmatter: { name: 'alpha' }, body: 'body', attachments: [{ rel: 'SKILL.md', size: 20 }, { rel: 'ref.txt', size: 5 }] }))
  if (p === '/skills/alpha/note') return Promise.resolve(ok({ content: method === 'PUT' ? body.content : 'old note' }))
  if (p === '/skills/bundles') return Promise.resolve(ok([{ name: 'pack', file: 'pack.yaml', description: 'd', instruction: '', skills: ['alpha'], mtime: 1 }]))
  if (p === '/memory/files') return Promise.resolve(ok({ profile: 'default', dir: '/m', files: [{ name: 'MEMORY.md', size: 10, mtime: 1, primary: true }] }))
  if (p === '/memory/file') return Promise.resolve(ok({ content: '- remember', exists: true, mtime: 1 }))
  if (p === '/memory/status') return Promise.resolve(ok({ ok: true, output: 'Provider: builtin' }))
  if (p === '/journey/graph') return Promise.resolve(ok({ profile: 'default', nodes: [{ id: 'skill:alpha', label: 'alpha', kind: 'skill', category: 'research', timestamp: 100 }, { id: 'memory:MEMORY.md', label: 'MEMORY.md', kind: 'memory', category: 'memory', timestamp: 200 }], edges: [{ source: 'memory:MEMORY.md', target: 'skill:alpha', kind: 'mention' }], categories: [{ name: 'research', count: 1 }, { name: 'memory', count: 1 }], time_range: [100, 200], stats: { nodes: 2, edges: 1 } }))
  if (p === '/theme' && method === 'GET') return Promise.resolve(ok({ settings: { ...THEME_DEFAULTS, mode: 'dark' }, has_background: false, updated_at: null }))
  if (p === '/theme' && method === 'PUT') return Promise.resolve(ok({ settings: { ...THEME_DEFAULTS, ...body.settings }, has_background: false, updated_at: null }))
  if (p === '/logs/files') return Promise.resolve(ok([{ id: 'hermes/gateway.log', group: 'hermes', name: 'gateway.log', size: 100, mtime: 1 }, { id: 'studio/studio.log', group: 'studio', name: 'studio.log', size: 10, mtime: 1 }]))
  if (p === '/logs/read') return Promise.resolve(ok({ file: qs.get('file'), size: 100, entries: [{ raw: 'x', ts: '2026-08-29 10:00:00', level: 'ERROR', component: 'gateway.run', msg: 'boom', http: null }, { raw: 'y', ts: null, level: 'INFO', component: null, msg: '"GET /health HTTP/1.1" 200 OK', http: { method: 'GET', path: '/health', status: 200 } }].filter((e) => !qs.get('level') || e.level === qs.get('level')) }))
  if (p === '/version') return Promise.resolve(ok({ studio: { version: '0.1.0' }, hermes: { version: '0.20.5', date: '2026.8.19', behind: 3 }, latest: { tag: 'v0.21.0', url: 'https://github.com/x' }, update_check_enabled: true, update_available: true, repo: 'NousResearch/hermes-agent' }))
  if (p === '/plugins') return Promise.resolve(ok([{ name: 'p1', status: 'enabled', version: '1', enabled: true }, { name: 'p2', status: 'not enabled', enabled: false }]))
  if (p === '/plugins/p2/enable') return Promise.resolve(ok({ ok: true, output: 'enabled p2' }))
  if (p === '/mcp/servers') return Promise.resolve(ok({ profile: 'default', servers: [{ name: 'twinmind', transport: 'http', url: 'https://api/mcp', args: [], auth: 'oauth', enabled: true, tools: 'all' }] }))
  if (p === '/mcp/servers/twinmind/test') return Promise.resolve(ok({ ok: true, output: 'connected 5 tools' }))
  if (p === '/terminal/cwds') return Promise.resolve(ok([{ id: 'workspace', label: 'Hermes workspace', path: '/w' }]))
  return mockFetch(input, init)
}

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  readyState = 1
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  constructor(public url: string) {
    FakeWS.instances.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.onclose?.()
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

afterEach(() => setEngineerMode(false))
beforeEach(() => {
  setupMocks({ loggedIn: true })
  setFetchImpl(fakeFetch as typeof fetch)
  calls.length = 0
  FakeWS.instances = []
})

describe('I 檔案瀏覽器', () => {
  it('列目錄、開檔（預覽→編輯）、編輯儲存、附回聊天事件', async () => {
    renderApp(<FilesPage />, { route: '/files' })
    const user = userEvent.setup()
    expect(await screen.findByText('hello.md')).toBeInTheDocument()
    expect(screen.getByText('sub')).toBeInTheDocument()
    await user.click(screen.getByText('hello.md'))
    // 預設是共用預覽元件（渲染 Markdown），切到編輯才是純文字編輯器
    expect(await screen.findByTestId('file-preview')).toBeInTheDocument()
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent('預覽標題')
    await user.click(screen.getByTestId('files-mode-edit'))
    const ta = (await screen.findByLabelText('editor')) as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toBe('# hi'))
    await user.type(ta, '!')
    await user.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/files/write')).toBe(true))
    const seen: unknown[] = []
    window.addEventListener('studio:attach', (e) => seen.push((e as CustomEvent).detail))
    await user.click(screen.getAllByRole('button', { name: '附回聊天' }).at(-1)!)
    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ uri: 'workspace://workspace/hello.md', path: 'workspace/hello.md' })
    expect(await screen.findByRole('status')).toHaveTextContent('workspace://workspace/hello.md')
  })
})

describe('L Skills 與記憶', () => {
  it('列出 skills、搜尋、啟停、詳情與附檔', async () => {
    renderApp(<SkillsPage />, { route: '/skills' })
    const user = userEvent.setup()
    expect(await screen.findByText('alpha')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    // 用量改成「最後一次用是多久以前」＋次數，找起來才有意義
    expect(screen.getByText(/×3/)).toBeInTheDocument()
    expect(screen.getByText(/用過 .*前/)).toBeInTheDocument()
    expect(screen.getByText(/還沒用過/)).toBeInTheDocument()   // beta 沒紀錄
    expect(screen.getByTestId('skill-sort')).toBeInTheDocument()
    expect(screen.getByTestId('skill-topics')).toHaveTextContent('研究與情報')  // 用途維度 chip
    const tg = screen.getByRole('button', { name: '停用 alpha' })
    await waitFor(() => expect(tg).toBeEnabled())
    await user.click(tg)
    await waitFor(() => expect(calls.some((c) => c.path === '/skills/alpha/toggle' && c.body?.enabled === false)).toBe(true))
    await user.click(screen.getByText('alpha'))
    expect(await screen.findByText('ref.txt', { exact: false })).toBeInTheDocument()
    const ta = (await screen.findByLabelText('SKILL.md')) as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toContain('name: alpha'))
    await user.type(screen.getByLabelText('搜尋名稱／描述／標籤'), 'bet')
    await waitFor(() => expect(screen.queryByRole('button', { name: '停用 alpha' })).not.toBeInTheDocument())
  })
  it('記憶分頁讀 MEMORY.md；Journey 畫出節點', async () => {
    renderApp(<SkillsPage />, { route: '/skills' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: '記憶' }))
    const ta = (await screen.findByLabelText('memory-editor')) as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toBe('- remember'))
    setEngineerMode(true) // 這段看的是工程師資訊（PID／供應商／provider）
    expect(await screen.findByText(/Provider: builtin/)).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /關係圖|Journey/ }))
    expect(await screen.findByTestId('journey-svg')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('node-skill:alpha')).toBeInTheDocument())
    expect(screen.getByTestId('node-memory:MEMORY.md')).toBeInTheDocument()
    await user.click(screen.getByTestId('node-skill:alpha'))
    expect(await screen.findByText(/links: memory:MEMORY.md/)).toBeInTheDocument()
    // 時間軸回放：拉到最早只剩 skill:alpha
    fireEvent.change(screen.getByLabelText('timeline'), { target: { value: '0' } })
    await waitFor(() => expect(screen.queryByTestId('node-memory:MEMORY.md')).not.toBeInTheDocument())
  })
})

describe('M 主題', () => {
  it('applyTheme 寫 CSS 變數與 data-theme；頁面改字級會即時套用並儲存', async () => {
    applyTheme({ ...THEME_DEFAULTS, mode: 'dark', font_size: 16, primary: '#ff0000' })
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.style.getPropertyValue('--studio-font-size')).toBe('16px')
    expect(root.style.getPropertyValue('--studio-primary')).toBe('#ff0000')
    applyTheme({ ...THEME_DEFAULTS, mode: 'system' })
    expect(root.hasAttribute('data-theme')).toBe(false)
    renderApp(<ThemePage />, { route: '/theme' })
    await waitFor(() => expect(root.getAttribute('data-theme')).toBe('dark'))
    fireEvent.change(screen.getByLabelText('字級'), { target: { value: '18' } })
    expect(root.style.getPropertyValue('--studio-font-size')).toBe('18px')
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/theme' && c.body?.settings?.font_size === 18)).toBe(true))
  })
})

describe('N 日誌', () => {
  it('讀取、等級篩選、HTTP 高亮、WebSocket 尾端追蹤', async () => {
    setLogsWebSocketImpl(FakeWS as unknown as typeof WebSocket)
    renderApp(<LogsPage />, { route: '/logs' })
    const user = userEvent.setup()
    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByText('/health')).toBeInTheDocument()
    expect(screen.getByText('200', { selector: 'span' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('等級'), 'ERROR')
    await waitFor(() => expect(screen.queryByText('/health')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: '即時追蹤' }))
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))
    expect(FakeWS.instances[0].url).toContain('/ws/logs?')
    expect(FakeWS.instances[0].url).toContain('file=hermes%2Fgateway.log')
    FakeWS.instances[0].emit({ type: 'line', entry: { raw: 'z', ts: '2026-08-29 11:00:00', level: 'WARNING', component: 'c', msg: 'tailed line', http: null } })
    expect(await screen.findByText('tailed line')).toBeInTheDocument()
  })
})

describe('O 管理', () => {
  it('版本／plugins／MCP 分頁', async () => {
    renderApp(<AdminPage />, { route: '/admin' })
    const user = userEvent.setup()
    expect(await screen.findByTestId('hermes-version')).toHaveTextContent('0.20.5')
    expect(screen.getByText('有新版本可用')).toBeInTheDocument()
    expect(screen.getByText(/落後 upstream 3/)).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Plugins' }))
    const en = await screen.findByRole('button', { name: '啟用 p2' })
    await waitFor(() => expect(en).toBeEnabled())
    await user.click(en)
    await waitFor(() => expect(calls.some((c) => c.path === '/plugins/p2/enable')).toBe(true))
    await user.click(screen.getByRole('tab', { name: 'MCP' }))
    expect(await screen.findByText('twinmind')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '測試' }))
    expect(await screen.findByTestId('mcp-output')).toHaveTextContent('connected 5 tools')
    await user.click(screen.getByRole('tab', { name: '終端' }))
    expect(await screen.findByTestId('terminal-host')).toBeInTheDocument()
  })
})
