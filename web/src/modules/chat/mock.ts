// 聊天模組的 mock 路由（給 dev:mock 與 vitest 用）；由 src/mock/fetch.ts 委派進來。
import type { Message, Session } from '../../api/types'

export interface ChatMockState {
  sessions: Session[]
  messages: Record<string, Message[]>
  categories?: { id: string; name: string; color: string; position: number }[]
}

let seq = 500
const nid = (p: string) => `${p}${++seq}`
const now = () => new Date().toISOString()
const ok = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const fail = (status: number, code: string, message: string) => ok({ error: { code, message } }, status)

type S = Session & { archived?: boolean; category_id?: string | null; model?: string; provider?: string; running?: boolean; run_status?: string; usage?: unknown }

const full = (s: S) => ({
  archived: false, category_id: null, model: '', provider: '', running: false, run_status: '',
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, context_tokens: 0 }, ...s,
})

export const mockHermesSources = [
  { profile: 'default', total: 3, sources: { telegram: 2, cli: 1 } },
  { profile: 'editor', total: 1, sources: { cli: 1 } },
]
export const mockHermesSessions = [
  { profile: 'default', id: 'tg_001', source: 'telegram', title: '客戶問報價', model: 'gpt-5', started_at: '2026-08-20T01:00:00', message_count: 4, tool_call_count: 1, input_tokens: 100, output_tokens: 50, archived: false },
  { profile: 'default', id: 'tg_002', source: 'telegram', title: '週報草稿', model: 'gpt-5', started_at: '2026-08-21T01:00:00', message_count: 2, tool_call_count: 0, input_tokens: 10, output_tokens: 5, archived: false },
  { profile: 'default', id: 'cli_001', source: 'cli', title: 'cli · 修 bug', model: 'gpt-5', started_at: '2026-08-19T01:00:00', message_count: 6, tool_call_count: 2, input_tokens: 10, output_tokens: 5, archived: false },
  { profile: 'editor', id: 'cli_002', source: 'cli', title: 'editor 對話', model: 'claude', started_at: '2026-08-18T01:00:00', message_count: 2, tool_call_count: 0, input_tokens: 10, output_tokens: 5, archived: false },
]
const hermesMessages: Message[] = [
  { id: 'h1', role: 'user', content: '這個月的報價怎麼算', created_at: '2026-08-20T01:00:00Z' },
  { id: 'h2', role: 'tool', content: '', tool_name: 'read_file', tool_args: { path: '/tmp/price.csv' }, tool_result: 'a,b', created_at: '2026-08-20T01:00:10Z' },
  { id: 'h3', role: 'assistant', content: '報價是 **1.4 倍**成本。', created_at: '2026-08-20T01:00:20Z' },
]

export const mockModelOptions = {
  providers: [
    { slug: 'nous', name: 'Nous Portal', is_current: true, authenticated: true, models: [
      { id: 'anthropic/claude-sonnet-5', provider: 'nous', label: 'anthropic/claude-sonnet-5', pricing: { input: '$3', output: '$15', free: false } },
      { id: 'openai/gpt-5.5', provider: 'nous', label: 'openai/gpt-5.5', pricing: { input: '$2', output: '$8', free: false } },
    ] },
    { slug: 'openrouter', name: 'OpenRouter', is_current: false, authenticated: false, models: [
      { id: 'z-ai/glm-5.3:free', provider: 'openrouter', label: 'z-ai/glm-5.3:free', pricing: { free: true } },
    ] },
  ],
  models: [] as unknown[],
  current: { model: 'anthropic/claude-sonnet-5', provider: 'nous' },
}
mockModelOptions.models = mockModelOptions.providers.flatMap((p) => p.models)

export function chatMock(state: ChatMockState, path: string, method: string, body: Record<string, unknown>, u: URL): Response | null {
  state.categories ??= [{ id: 'cat1', name: '行銷', color: '#fde68a', position: 0 }]
  let m: RegExpMatchArray | null

  if (path === '/sessions' && method === 'GET') {
    const agentId = u.searchParams.get('agent_id')
    const inc = u.searchParams.get('include_archived') === 'true'
    const cat = u.searchParams.get('category_id')
    return ok((state.sessions as S[]).filter((s) => (!agentId || s.agent_id === agentId) && (inc || !s.archived) && (!cat || s.category_id === cat)).map(full))
  }
  if (path === '/sessions' && method === 'POST') {
    const s: S = { id: nid('s'), agent_id: String(body.agent_id), title: (body.title as string) || '新對話', created_at: now(), updated_at: now(), source: 'workbench', model: (body.model as string) ?? '', category_id: (body.category_id as string) ?? null }
    state.sessions.unshift(s)
    state.messages[s.id] = []
    return ok(full(s), 201)
  }
  if (path === '/sessions/search') {
    const q = (u.searchParams.get('q') ?? '').toLowerCase()
    if (!q) return ok([])
    const hits = []
    for (const s of state.sessions as S[]) {
      if ((s.title ?? '').toLowerCase().includes(q)) { hits.push({ session: full(s), match: 'title', snippet: s.title }); continue }
      const mm = (state.messages[s.id] ?? []).find((x) => x.content.toLowerCase().includes(q))
      if (mm) hits.push({ session: full(s), match: 'message', snippet: mm.content.slice(0, 120), message_id: mm.id })
    }
    return ok(hits)
  }
  if ((m = path.match(/^\/sessions\/([^/]+)\/model$/)) && method === 'POST') {
    const s = state.sessions.find((x) => x.id === m![1]) as S | undefined
    if (!s) return fail(404, 'not_found', 'session not found')
    s.model = String(body.model ?? '')
    s.provider = String(body.provider ?? '')
    return ok(full(s))
  }
  if ((m = path.match(/^\/sessions\/([^/]+)$/)) && method === 'PATCH') {
    const s = state.sessions.find((x) => x.id === m![1]) as S | undefined
    if (!s) return fail(404, 'not_found', 'session not found')
    if (typeof body.title === 'string') {
      if (!body.title.trim()) return fail(400, 'bad_request', 'title 不可為空')
      s.title = body.title.trim()
    }
    if (typeof body.archived === 'boolean') s.archived = body.archived
    if (body.category_id !== undefined) s.category_id = body.category_id === '' ? null : (body.category_id as string)
    if (typeof body.model === 'string') s.model = body.model
    s.updated_at = now()
    return ok(full(s))
  }
  if ((m = path.match(/^\/sessions\/([^/]+)$/)) && method === 'GET') {
    const s = state.sessions.find((x) => x.id === m![1]) as S | undefined
    return s ? ok(full(s)) : fail(404, 'not_found', 'session not found')
  }

  if (path === '/chat/categories' && method === 'GET') return ok(state.categories)
  if (path === '/chat/categories' && method === 'POST') {
    const c = { id: nid('cat'), name: String(body.name), color: String(body.color ?? ''), position: state.categories.length }
    state.categories.push(c)
    return ok(c, 201)
  }
  if ((m = path.match(/^\/chat\/categories\/([^/]+)$/))) {
    const c = state.categories.find((x) => x.id === m![1])
    if (!c) return fail(404, 'not_found', 'category not found')
    if (method === 'PATCH') { Object.assign(c, body); return ok(c) }
    if (method === 'DELETE') {
      state.categories = state.categories.filter((x) => x.id !== c.id)
      for (const s of state.sessions as S[]) if (s.category_id === c.id) s.category_id = null
      return ok({ ok: true })
    }
  }
  if (path === '/chat/uploads' && method === 'GET') return ok([])
  if (path === '/chat/models') return ok(mockModelOptions)
  if (path === '/chat/preview') {
    const p = u.searchParams.get('path') ?? ''
    const name = p.split('/').pop() ?? p
    const ext = name.split('.').pop()?.toLowerCase()
    const base = { name, path: p, size: 1234, url: `/chat/files?path=${encodeURIComponent(p)}` }
    if (ext === 'md') return ok({ ...base, kind: 'markdown', text: '# 預覽標題\n\n- 一\n- 二' })
    if (ext === 'csv') return ok({ ...base, kind: 'csv', rows: [['a', 'b'], ['1', '2']], truncated: false })
    if (ext === 'html') return ok({ ...base, kind: 'html', text: '<h1>hi</h1>' })
    if (ext === 'docx') return ok({ ...base, kind: 'docx', html: '<h1>Doc</h1><p>內文</p>' })
    if (ext === 'xlsx') return ok({ ...base, kind: 'xlsx', sheets: [{ name: 'S1', rows: [['h', 'v'], [1, 2]], truncated: false }] })
    if (ext === 'png' || ext === 'jpg') return ok({ ...base, kind: 'image' })
    if (ext === 'pdf') return ok({ ...base, kind: 'pdf' })
    return ok({ ...base, kind: 'code', language: ext ?? 'text', text: 'print(1)\n' })
  }
  if (path === '/chat/hermes-history/sources') return ok(mockHermesSources)
  if (path === '/chat/hermes-history') {
    const prof = u.searchParams.get('profile')
    return ok(mockHermesSessions.filter((s) => !prof || s.profile === prof))
  }
  if ((m = path.match(/^\/chat\/hermes-history\/([^/]+)\/([^/]+)\/messages$/))) {
    const s = mockHermesSessions.find((x) => x.profile === m![1] && x.id === m![2])
    return s ? ok({ session: s, messages: hermesMessages }) : fail(404, 'not_found', 'hermes session not found')
  }
  if ((m = path.match(/^\/chat\/hermes-history\/([^/]+)\/([^/]+)\/import$/)) && method === 'POST') {
    const h = mockHermesSessions.find((x) => x.profile === m![1] && x.id === m![2])
    if (!h) return fail(404, 'not_found', 'hermes session not found')
    const s: S = { id: nid('s'), agent_id: 'a1', title: h.title, created_at: now(), updated_at: now(), source: h.source, model: h.model }
    state.sessions.unshift(s)
    state.messages[s.id] = hermesMessages.map((x) => ({ ...x, id: nid('msg') }))
    return ok(full(s), 201)
  }
  return null
}
