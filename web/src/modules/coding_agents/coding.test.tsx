import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CodingPage } from './CodingPage'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { renderApp, setupMocks } from '../../test/utils'
import type { AgentInfo, CodingSession } from './api'
import { setCodingWebSocketImpl } from './socket'
import i18n from 'i18next'
import mod from './index'

// 不經 registry（它會 glob 全部模組），自己把本模組的 i18n 掛上
for (const [lng, res] of Object.entries(mod.i18n ?? {})) i18n.addResourceBundle(lng, 'translation', res, true, true)

// 直接 render CodingPage（不經 App）：避免其他同事模組尚未裝齊的相依拖垮測試
// ---- 本模組自己的 fetch mock：/api/coding/* 由這裡處理，其他交給共用 mock
const agents: AgentInfo[] = [
  { id: 'claude', name: 'Claude Code', installed: true, path: '/u/bin/claude', version: '2.1.0', install_cmd: 'npm i -g @anthropic-ai/claude-code', package: '', docs: '', supports: { resume: true, images: true, proxy: 'anthropic' }, npm_available: true, running: 0,
    settings: { agent: 'claude', workspace: '/home/me/proj', model: '', api_mode: 'direct', hermes_profile: '', extra: { permission_mode: 'acceptEdits' } } },
  { id: 'codex', name: 'Codex CLI', installed: false, path: '', version: '', install_cmd: 'npm i -g @openai/codex', package: '', docs: '', supports: { resume: true, images: true, proxy: 'openai' }, npm_available: true, running: 0,
    settings: { agent: 'codex', workspace: '', model: '', api_mode: 'hermes', hermes_profile: '', extra: {} } },
  { id: 'pi', name: 'Pi', installed: false, path: '', version: '', install_cmd: 'npm i -g @mariozechner/pi-coding-agent', package: '', docs: '', supports: { resume: true, images: false, proxy: 'openai' }, npm_available: false, running: 0,
    settings: { agent: 'pi', workspace: '', model: '', api_mode: 'direct', hermes_profile: '', extra: {} } },
]
let sessions: CodingSession[] = []
let installCalls = 0
let messageFetches = 0
let savedSetting: unknown = null
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

const codingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input as Request).url
  const path = url.replace(/^.*\/api/, '')
  const method = init?.method ?? 'GET'
  if (path === '/coding/agents') return ok(agents)
  if (path.startsWith('/coding/sessions')) {
    if (method === 'POST' && path === '/coding/sessions') {
      const body = JSON.parse(String(init?.body))
      const s: CodingSession = { id: `cs${sessions.length + 1}`, title: `Claude Code · proj`, source: `coding:${body.agent}`, agent: body.agent, workspace: body.workspace || '/home/me/proj', model: '', external_session_id: '', status: 'idle', created_at: '', updated_at: '' }
      sessions = [s, ...sessions]
      return ok(s, 201)
    }
    if (path.endsWith('/messages')) { messageFetches++; return ok([]) }
    if (path.endsWith('/runs')) return ok([])
    if (path.endsWith('/images')) return ok({ path: '/home/me/proj/.studio-uploads/1_x.png', size: 3 }, 201)
    return ok(sessions.filter((s) => !path.includes('agent=') || path.endsWith(`agent=${s.agent}`)))
  }
  if (path.startsWith('/coding/agents/') && path.endsWith('/install')) {
    installCalls++
    return ok({ job_id: 'job1', command: 'npm i -g x' }, 202)
  }
  if (path === '/coding/install/job1') return ok({ id: 'job1', agent: 'codex', status: 'completed', log: 'added 1 package', command: 'npm i -g x' })
  if (path.startsWith('/coding/settings/')) {
    savedSetting = JSON.parse(String(init?.body))
    return ok({ ...agents[0].settings, ...(savedSetting as object) })
  }
  if (path.startsWith('/coding/proxy-info')) return ok({ anthropic_base_url: 'http://127.0.0.1:8700/coding/proxy/anthropic', openai_base_url: '', token: 'hsp_x', claude_env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8700/coding/proxy/anthropic', ANTHROPIC_AUTH_TOKEN: 'hsp_x' }, codex_config_snippet: '', codex_env: {} })
  return mockFetch(input, init)
}

// ---- 假 /ws/coding
class FakeCodingWs {
  static instances: FakeCodingWs[] = []
  readyState = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  sent: Record<string, unknown>[] = []
  constructor(public url: string) {
    FakeCodingWs.instances.push(this)
    setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')); this.emit({ type: 'ready', member_id: 'm1' }) }, 0)
  }
  emit(ev: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(ev) })) }
  send(raw: string) {
    const msg = JSON.parse(raw)
    this.sent.push(msg)
    if (msg.type === 'run') {
      const base = { session_id: msg.session_id, run_id: 'run-1' }
      const evs = [
        { type: 'run.started', ...base, command: 'claude -p …' },
        { type: 'session.init', ...base, external_session_id: 'abc12345-ext' },
        { type: 'tool.started', ...base, name: 'Write', args: { file_path: 'hello.py' }, call_id: 't1' },
        { type: 'tool.completed', ...base, name: 'Write', result: 'ok', call_id: 't1' },
        { type: 'message.delta', ...base, delta: 'Done: ' },
        { type: 'message.delta', ...base, delta: 'wrote hello.py' },
        { type: 'run.completed', ...base, output: 'Done: wrote hello.py', usage: { output_tokens: 9 },
          diff: { before: '', after: 'diff --git a/hello.py b/hello.py\nnew file mode 100644\n--- /dev/null\n+++ b/hello.py\n@@ -0,0 +1 @@\n+print("hello")\n', files: [{ status: '??', path: 'hello.py' }], is_git: true } },
      ]
      evs.forEach((e, i) => setTimeout(() => this.emit(e), 5 * (i + 1)))
    }
    if (msg.type === 'stop') this.emit({ type: 'run.cancelled', session_id: 'cs1', run_id: msg.run_id })
  }
  close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')) }
}

describe('Coding Agents 頁', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    setFetchImpl(codingFetch)
    FakeCodingWs.instances = []
    setCodingWebSocketImpl(FakeCodingWs as unknown as typeof WebSocket)
    sessions = []
    installCalls = 0
    messageFetches = 0
    savedSetting = null
  })

  it('agent 卡片：狀態／版本／安裝指令，owner 可一鍵安裝', async () => {
    renderApp(<CodingPage />, { route: '/coding' })
    const user = userEvent.setup()
    const claude = await screen.findByTestId('agent-card-claude')
    expect(within(claude).getByText('已安裝')).toBeInTheDocument()
    expect(within(claude).getByText(/v2\.1\.0/)).toBeInTheDocument()
    const codex = screen.getByTestId('agent-card-codex')
    expect(within(codex).getByText('未安裝')).toBeInTheDocument()
    expect(within(codex).getByText('npm i -g @openai/codex')).toBeInTheDocument()
    await user.click(await within(codex).findByRole('button', { name: '一鍵安裝' }))
    expect(await screen.findByTestId('install-job')).toHaveTextContent('completed')
    expect(installCalls).toBe(1)
    // pi 沒 npm → 安裝鍵 disabled
    const piBtn = within(screen.getByTestId('agent-card-pi')).getAllByRole('button').find((b) => b.textContent === '一鍵安裝')
    expect(piBtn).toBeDisabled()
  })

  it('設定面板：切 API 模式為 Hermes 會顯示 proxy 環境變數並儲存', async () => {
    renderApp(<CodingPage />, { route: '/coding' })
    const user = userEvent.setup()
    const claude = await screen.findByTestId('agent-card-claude')
    await user.click(within(claude).getByRole('button', { name: '設定' }))
    const panel = await screen.findByTestId('settings-panel')
    await user.selectOptions(within(panel).getByLabelText('API 模式'), 'hermes')
    expect(await within(panel).findByText(/ANTHROPIC_BASE_URL=/)).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: '儲存' }))
    await waitFor(() => expect(savedSetting).toMatchObject({ api_mode: 'hermes', workspace: '/home/me/proj' }))
  })

  it('新開 session → 執行 → 串流輸出、工具卡、diff 分頁', async () => {
    renderApp(<CodingPage />, { route: '/coding' })
    const user = userEvent.setup()
    await screen.findByTestId('agent-card-claude')
    await user.click(screen.getByRole('button', { name: '新開 Session' }))
    const ta = await screen.findByLabelText('任務')
    await user.type(ta, 'write hello.py{Enter}')
    await waitFor(() => expect(FakeCodingWs.instances[0].sent.some((m) => m.type === 'run' && m.input === 'write hello.py')).toBe(true))
    // run.completed 帶 diff 會自動切到 diff 分頁，輸出分頁的內容此時不在 DOM 裡：
    // 先驗 diff 分頁，再切回「輸出」看串流內容（原本先找 'Done: …' 會在事件跑得快時輸給自動切換，全套並行必紅）
    const diffTab = await screen.findByRole('tab', { name: /檔案 diff \(1\)/ })
    await waitFor(() => expect(diffTab).toHaveAttribute('aria-selected', 'true'))
    const dv = await screen.findByTestId('diff-view')
    expect(within(dv).getByText('執行後（git diff HEAD）')).toBeInTheDocument()
    expect(within(dv).getAllByText('hello.py').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('tab', { name: '輸出' }))
    expect(await screen.findByText('Done: wrote hello.py')).toBeInTheDocument()
    expect(screen.getByText('Write')).toBeInTheDocument()
    expect(screen.getByText(/output_tokens=9/)).toBeInTheDocument()
    expect(screen.getByText('abc12345')).toBeInTheDocument()
    // run.completed 後會 invalidate messages/runs 重抓；重抓回來（這裡是空的）不能把剛串流完的即時輸出洗掉
    await waitFor(() => expect(messageFetches).toBeGreaterThanOrEqual(2))
    expect(screen.getByText('Done: wrote hello.py')).toBeInTheDocument()
    expect(screen.getByText(/output_tokens=9/)).toBeInTheDocument()
  })
})
