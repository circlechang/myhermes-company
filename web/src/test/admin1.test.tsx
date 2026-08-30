// B 頻道 / C 用量 / D 排程 / G 模型 / H Profile 前端測試（自製 fetch mock）
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setFetchImpl, setToken } from '../api/client'
import '../modules/registry'
import { ChannelsPage } from '../modules/channels'
import { CronPage } from '../modules/cron'
import { ModelsPage } from '../modules/models'
import { ProfilesPage } from '../modules/profiles'
import { UsagePage } from '../modules/usage'
import { AgentsPage } from '../pages/AgentsPage'
import { mockFetch, MOCK_TOKEN } from '../mock/fetch'
import { MockWebSocket } from '../mock/MockWebSocket'
import { setWebSocketImpl } from '../ws/chatSocket'
import { renderApp } from './utils'

type Handler = (method: string, path: string, body: unknown, url: URL) => unknown
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

const profiles = [
  { name: 'default', display_name: 'default', model: 'gpt-5.6-luna', provider: 'openai-codex', gateway: 'running', is_default: true, description: '', path: '/h', has_soul: true, has_env: true, skills: 3 },
  { name: 'researcher', display_name: 'researcher', model: 'stealth/ox-alpha', provider: '', gateway: 'running', is_default: false, description: '研究員', path: '/h/profiles/researcher', has_soul: true, has_env: false, skills: 1 },
]
let jobs: Record<string, unknown>[] = []
let calls: { method: string; path: string; body: unknown }[] = []

const handler: Handler = (method, path, body, url) => {
  if (path === '/profiles' && method === 'GET') return { profiles, active: 'default', restricted: false }
  if (path === '/profiles' && method === 'POST') { const b = body as { name: string }; profiles.push({ ...profiles[1], name: b.name, is_default: false, description: '' }); return profiles[profiles.length - 1] }
  if (path === '/profiles/assignments/members') return [{ id: 'm1', username: 'admin', role: 'owner', profiles: [], all_profiles: true }, { id: 'm2', username: 'bob', role: 'member', profiles: ['researcher'], all_profiles: false }]
  if (path.startsWith('/profiles/assignments/members/') && method === 'PUT') return { id: 'm2', username: 'bob', role: 'member', profiles: (body as { profiles: string[] }).profiles, all_profiles: false }
  if (path === '/profiles/researcher/config' && url.searchParams.get('raw')) return { path: '/h/profiles/researcher/config.yaml', text: '# c\nmodel:\n  default: stealth/ox-alpha\n' }
  if (path === '/profiles/researcher/config' && method === 'PUT') return { ok: true, config: {} }
  if (path === '/profiles/researcher/use') { profiles.forEach((p) => (p.is_default = p.name === 'researcher')); return { ok: true, active: 'researcher' } }
  if (path === '/channels') return {
    env_path: '/h/.env', config_path: '/h/config.yaml',
    platforms: [
      { id: 'line', label: 'LINE', description: 'LINE Messaging API', docs_url: '', configured: false, config_section: null, config_keys: [], config: {}, plugin: '',
        webhook_url: 'http://<host>:8646/line/webhook', webhook_hint: 'hint',
        fields: [{ name: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'Channel access token', required: true, secret: true, kind: 'text', set: false, hint: '', default: '' },
          { name: 'LINE_CHANNEL_SECRET', label: 'Channel secret', required: true, secret: true, kind: 'text', set: false, hint: '', default: '' },
          { name: 'LINE_PORT', label: 'Webhook 埠', required: false, secret: false, kind: 'int', set: false, hint: '', default: '8646', value: '' }] },
      { id: 'telegram', label: 'Telegram', description: '', docs_url: '', configured: true, config_section: 'telegram', config: { reactions: false }, plugin: '',
        config_keys: [{ name: 'reactions', label: '表情回應', kind: 'bool', default: false, hint: '' }],
        fields: [{ name: 'TELEGRAM_BOT_TOKEN', label: 'Bot token', required: true, secret: true, kind: 'text', set: true, hint: '', default: '' }] },
    ],
  }
  if (path === '/channels/gateway/status') return { ok: true, running: true, pid: 4242, supervised: true, stale_service: false, profiles: [{ name: 'researcher', running: true, pid: 1 }], raw: '' }
  if (path === '/channels/line' && method === 'PUT') return { ok: true, restart: null, platform: { id: 'line', label: 'LINE', configured: true, fields: [], config_keys: [], config: {}, webhook_url: 'https://t.example.com/line/webhook' } }
  if (path === '/cron/presets') return { presets: [{ id: 'daily_3', label: '每天 03:00', schedule: '0 3 * * *' }] }
  if (path === '/cron/targets') return { targets: [{ id: 'local', label: '本機', kind: 'builtin' }, { id: 'telegram', label: 'Telegram', kind: 'platform' }] }
  if (path === '/cron/jobs' && method === 'GET') return { jobs }
  if (path === '/cron/jobs' && method === 'POST') { const b = body as Record<string, unknown>; const j = { id: `j${jobs.length + 1}`, ...b, schedule_display: b.schedule, paused: false, next_run_at: '2026-08-30T03:00' }; jobs.push(j); return j }
  const m = path.match(/^\/cron\/jobs\/(\w+)\/(pause|resume|run|runs)$/)
  if (m) {
    const j = jobs.find((x) => x.id === m[1])!
    if (m[2] === 'runs') return { runs: [{ id: 'e1', status: 'completed', claimed_at: '2026-08-29T03:00:00', duration_s: 12 }], outputs: [{ filename: 'out.md', size: 3 }] }
    if (m[2] === 'pause') j.paused = true
    if (m[2] === 'resume') j.paused = false
    return j
  }
  if (path.match(/^\/cron\/jobs\/\w+$/) && method === 'DELETE') { jobs = jobs.filter((x) => `/cron/jobs/${x.id}` !== path); return { ok: true } }
  if (path === '/usage/summary') return {
    totals: { input_tokens: 1_251_000, output_tokens: 115_010, total_tokens: 1_366_010, cache_read_tokens: 500_000, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 4, sessions_per_day: 0.13, api_calls: 6, messages: 8, tool_calls: 1, cost_usd: 3.81, cost_hermes_usd: 1.5, cost_table_usd: 2.31, sessions_unpriced: 0, cache_hit_rate: 0.2856, days: 30 },
    daily: [{ key: '2026-08-28', sessions: 1, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0 }, { key: '2026-08-29', sessions: 3, input_tokens: 20, output_tokens: 2, cache_read_tokens: 0, cost_usd: 1 }],
    by_model: [{ key: 'gpt-5.6-luna', sessions: 3, input_tokens: 1_000_000, output_tokens: 100_000, cache_read_tokens: 0, cost_usd: 2.3 }],
    by_source: [{ key: 'cli', sessions: 4, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0 }],
    by_profile: [{ key: 'default', sessions: 4, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cost_usd: 0 }],
    studio: { sessions: 1, messages: 2, input_tokens: 5, output_tokens: 5 }, sources: [{ profile: 'default', path: '/h/state.db', exists: true, sessions: 4 }],
  }
  if (path === '/usage/prices') return { unit: 'USD per 1M tokens', prices: [{ model: 'gpt-5.6-luna', input: 1.25, output: 10, cache_read: 0.125, source: 'builtin' }] }
  if (path === '/models/providers') return {
    active_provider: 'openai-codex', current: { model: 'gpt-5.6-luna', provider: 'openai-codex', base_url: 'https://chatgpt.com/backend-api/codex' }, groups: ['訂閱／OAuth', '聚合器', '自訂'],
    providers: [
      { id: 'openai-codex', name: 'OpenAI Codex', kind: 'builtin', auth_type: 'oauth_external', base_url: 'https://chatgpt.com/backend-api/codex', key_envs: [], key_env_set: null, oauth_capable: true, oauth_logged_in: true, credentials: [{ id: 'a', label: 'device_code', auth_type: 'oauth', source: 'device_code' }], configured: true, is_active: true, is_current: true, group: '訂閱／OAuth', hidden_models: [], aliases: {}, enabled: true },
      { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', auth_type: 'api_key', base_url: 'https://api.deepseek.com/v1', key_envs: ['DEEPSEEK_API_KEY'], key_env_set: null, oauth_capable: false, oauth_logged_in: false, credentials: [], configured: false, is_active: false, is_current: false, group: '官方 API', hidden_models: [], aliases: {}, enabled: true },
    ],
  }
  if (path === '/models/providers/openai-codex/models') return { models: ['gpt-5.6-luna', 'gpt-5.5'], source: 'gateway' }
  if (path === '/models/providers/detect') return { base_url: 'https://v4.example.com/v4', models: ['glm-5'], detected: true }
  if (path === '/models/providers' && method === 'POST') return { id: 'my-glm', key_env: 'HERMES_CUSTOM_MY_GLM', key_set: true }
  if (path === '/models/speech') return { tts: { provider: 'edge', providers: [{ id: 'edge', name: 'Edge TTS', key_envs: [], key_set: true, current: true, config_keys: [], settings: { voice: 'x' } }] }, stt: { provider: 'local', enabled: true, providers: [{ id: 'local', name: '本機 Whisper', key_envs: [], key_set: true, current: true, config_keys: [], settings: {} }] }, voice: {} }
  if (path === '/agents') return [{ id: 'a1', name: '研究員', profile: 'researcher', title: '', model: 'stealth/ox-alpha', enabled: true, soul_excerpt: '' }]
  if (path === '/auth/me') return { id: 'm1', username: 'admin', role: 'owner', company_id: 'c1', profiles: [], all_profiles: true }
  if (path === '/companies/current') return { id: 'c1', name: 'x', created_at: '' }
  return null
}

beforeEach(() => {
  jobs = []
  calls = []
  profiles.splice(2)
  profiles.forEach((p) => (p.is_default = p.name === 'default'))
  setWebSocketImpl(MockWebSocket as unknown as typeof WebSocket)
  setToken(MOCK_TOKEN)
  setFetchImpl(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url, 'http://localhost')
    const path = url.pathname.replace(/^\/api/, '')
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body })
    const r = handler(method, path, body, url)
    if (r === null) return mockFetch(input, init)
    return ok(r)
  })
})

describe('H. Profile 頁', () => {
  it('列出 profile、建立、設為預設、config 編輯、帳號綁定', async () => {
    renderApp(<ProfilesPage />, { route: '/profiles' })
    const user = userEvent.setup()
    const table = await screen.findByTestId('profiles-table')
    expect(within(table).getByText('researcher')).toBeInTheDocument()
    expect(within(table).getByText('研究員')).toBeInTheDocument()
    await user.type(screen.getByLabelText('名稱'), 'studio-tmp')
    await user.selectOptions(screen.getByLabelText('來源'), 'researcher')
    await user.click(screen.getByRole('button', { name: '建立' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/profiles' && (c.body as { clone_from: string }).clone_from === 'researcher')).toBe(true))
    expect(await within(table).findByText('studio-tmp')).toBeInTheDocument()
    await user.click(within(table).getAllByRole('button', { name: '設為預設' })[0])
    await waitFor(() => expect(calls.some((c) => c.path === '/profiles/researcher/use')).toBe(true))
    await user.click(within(table).getByRole('button', { name: /^researcher/ }))
    const ta = (await screen.findByLabelText('config.yaml')) as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toContain('stealth/ox-alpha'))
    await user.type(screen.getByLabelText('值'), 'gpt-5.5')
    await user.click(screen.getByRole('button', { name: '套用' }))
    await waitFor(() => expect(calls.some((c) => c.path === '/profiles/researcher/config' && c.method === 'PUT' && JSON.stringify(c.body).includes('"model.default":"gpt-5.5"'))).toBe(true))
    expect(await screen.findByText('bob')).toBeInTheDocument()
    const bobRow = screen.getByText('bob').closest('tr')!
    await user.click(within(bobRow).getByRole('checkbox', { name: /default/ }))
    await waitFor(() => expect(calls.some((c) => c.path === '/profiles/assignments/members/m2' && JSON.stringify(c.body).includes('default'))).toBe(true))
  })

  it('AI 員工頁內嵌 profile 面板', async () => {
    renderApp(<AgentsPage />, { route: '/agents' })
    expect(await screen.findByTestId('profiles-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('profiles-table')).toBeInTheDocument()
  })
})

describe('B. 頻道頁', () => {
  it('顯示 gateway 狀態、LINE webhook 提示，儲存只送有填的欄位', async () => {
    renderApp(<ChannelsPage />, { route: '/channels' })
    const user = userEvent.setup()
    expect(await screen.findByText(/PID 4242/)).toBeInTheDocument()
    expect(await screen.findByTestId('line-webhook')).toHaveTextContent('/line/webhook')
    await user.type(screen.getByLabelText('Channel access token'), 'tok')
    await user.type(screen.getByLabelText('Channel secret'), 'sec')
    await user.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/channels/line')).toBe(true))
    const put = calls.find((c) => c.method === 'PUT' && c.path === '/channels/line')!.body as { env: Record<string, string>; restart: boolean }
    expect(put.env).toEqual({ LINE_CHANNEL_ACCESS_TOKEN: 'tok', LINE_CHANNEL_SECRET: 'sec' })
    expect(put.restart).toBe(false)
    expect(await screen.findByText('已儲存')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Telegram/ }))
    expect(await screen.findByText('（已存）')).toBeInTheDocument()
  })
})

describe('D. 排程頁', () => {
  it('建立（快捷預設）、暫停、恢復、歷史、刪除', async () => {
    renderApp(<CronPage />, { route: '/cron' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '新增排程' }))
    await user.type(screen.getByLabelText('名稱'), '測試 job')
    await user.selectOptions(await screen.findByLabelText('快捷預設'), '0 3 * * *')
    await user.type(screen.getByLabelText('任務指令'), '說早安')
    await user.selectOptions(await screen.findByLabelText('投遞到'), 'telegram')
    await user.click(screen.getByRole('button', { name: '儲存' }))
    const job = await screen.findByTestId('job-j1')
    expect(within(job).getByText('0 3 * * *')).toBeInTheDocument()
    expect((calls.find((c) => c.method === 'POST' && c.path === '/cron/jobs')!.body as { deliver: string }).deliver).toBe('telegram')
    await user.click(within(job).getByRole('button', { name: '暫停' }))
    expect(await within(job).findByText('已暫停')).toBeInTheDocument()
    await user.click(within(job).getByRole('button', { name: '恢復' }))
    await waitFor(() => expect(within(job).queryByText('已暫停')).not.toBeInTheDocument())
    await user.click(within(job).getByRole('button', { name: '測試 job' }))
    expect(await within(job).findByText('completed')).toBeInTheDocument()
    expect(within(job).getByText('out.md')).toBeInTheDocument()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(within(job).getByRole('button', { name: '刪除' }))
    await waitFor(() => expect(screen.queryByTestId('job-j1')).not.toBeInTheDocument())
  })
})

describe('C. 用量頁', () => {
  it('顯示統計數字與模型分佈', async () => {
    renderApp(<UsagePage />, { route: '/usage' })
    expect(await screen.findByTestId('stat-輸入 token')).toHaveTextContent('1.25M')
    expect(screen.getByTestId('stat-快取命中率')).toHaveTextContent('28.6%')
    expect(screen.getByTestId('stat-估算成本')).toHaveTextContent('$3.81')
    expect(screen.getByTestId('stat-Session 數')).toHaveTextContent('4')
    expect(screen.getAllByText('gpt-5.6-luna').length).toBeGreaterThan(0)
    expect(await screen.findByText('價格表')).toBeInTheDocument()
  })
})

describe('G. 模型頁', () => {
  it('列供應商、展開模型清單、設預設、新增自訂供應商（偵測）', async () => {
    renderApp(<ModelsPage />, { route: '/models' })
    const user = userEvent.setup()
    expect(await screen.findByTestId('current-model')).toHaveTextContent('gpt-5.6-luna')
    const card = await screen.findByTestId('provider-openai-codex')
    expect(screen.queryByTestId('provider-deepseek')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('只顯示已設定'))
    expect(await screen.findByTestId('provider-deepseek')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'OpenAI Codex' }))
    expect(await within(card).findByText('gpt-5.5')).toBeInTheDocument()
    await user.click(within(card).getAllByTitle('設為預設模型')[1])
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/models/default' && (c.body as { model: string }).model === 'gpt-5.5')).toBe(true))
    await user.click(screen.getByRole('button', { name: '新增自訂供應商' }))
    await user.type(screen.getByLabelText('名稱'), 'My GLM')
    await user.type(screen.getByLabelText('base_url'), 'https://v4.example.com')
    await user.click(screen.getByRole('button', { name: '偵測端點' }))
    expect(await screen.findByText(/v4.example.com\/v4/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '儲存' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/models/providers' && (c.body as { base_url: string }).base_url === 'https://v4.example.com/v4')).toBe(true))
    expect(await screen.findByText('STT／TTS 供應商目錄')).toBeInTheDocument()
  })
})
