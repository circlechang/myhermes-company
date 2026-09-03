// 極簡 mock：攔截 fetch，依 docs/API.md 回應；狀態存在記憶體。
import type { KanbanTask, Message, Session, Workflow } from '../api/types'
import * as d from './data'
import { chatMock } from '../modules/chat/mock'
import { previewMock } from '../components/preview/mock'

let seq = 100
const nid = (p: string) => `${p}${++seq}`
const now = () => new Date().toISOString()

export interface MockState {
  agents: typeof d.mockAgents
  souls: Record<string, string>
  sessions: Session[]
  messages: Record<string, Message[]>
  tasks: KanbanTask[]
  workflows: Workflow[]
  docs: MockDoc[]
}

/** mock 用的極簡文件：只帶 UI 真的會讀的欄位。 */
export interface MockDoc {
  id: string
  title: string
  path: string
  format: 'html' | 'md'
  status: string
  stage: string
  origin: string
  content: string
  latest_version: number | null
  versions: number
  drift: boolean
  created_at: string
  updated_at: string
}

export function freshState(): MockState {
  return {
    agents: structuredClone(d.mockAgents),
    souls: { ...d.mockSouls },
    sessions: structuredClone(d.mockSessions),
    messages: structuredClone(d.mockMessages),
    tasks: structuredClone(d.mockTasks),
    workflows: structuredClone(d.mockWorkflows),
    docs: [],
  }
}

export let state: MockState = freshState()
export function resetMockState() {
  state = freshState()
}

const ok = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const fail = (status: number, code: string, message: string) => ok({ error: { code, message } }, status)

export const MOCK_TOKEN = 'mock-jwt-token'

export async function mockFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const u = new URL(url, 'http://localhost')
  const path = u.pathname.replace(/^\/api/, '')
  const method = (init.method ?? 'GET').toUpperCase()
  const body = init.body ? JSON.parse(String(init.body)) : {}
  const h = (init.headers ?? {}) as Record<string, string>
  const authHeader = typeof (h as { get?: unknown }).get === 'function' ? (h as unknown as Headers).get('Authorization') : (h.Authorization ?? h.authorization)
  const authed = authHeader === `Bearer ${MOCK_TOKEN}`

  await new Promise((r) => setTimeout(r, 30))

  if (path === '/health') return ok({ ok: true })
  if (path === '/auth/login' && method === 'POST') {
    if (body.username === 'admin' && body.password === 'admin') return ok({ token: MOCK_TOKEN, member: d.mockMember })
    return fail(401, 'invalid_credentials', '帳號或密碼錯誤')
  }
  if (!authed) return fail(401, 'unauthorized', 'missing token')

  if (path === '/auth/me') return ok(d.mockMember)
  if (path === '/companies/current') return ok(d.mockCompany)
  if (path === '/hermes/status') return ok(d.mockHermesStatus)

  // agents
  let m: RegExpMatchArray | null
  if (path === '/agents/runtimes') return ok(d.mockRuntimeCatalog)
  if (path === '/profiles' && method === 'GET') return ok(d.mockProfileList)
  if (path === '/agents' && method === 'GET') return ok(state.agents)
  if (path === '/agents' && method === 'POST') {
    const runtime = body.runtime ?? 'hermes'
    const cat = d.mockRuntimeCatalog.runtimes.find((r) => r.id === runtime)
    if (!cat) return fail(400, 'bad_runtime', `runtime 不合法: ${runtime}`)
    if (!cat.installed) return fail(400, 'agent_not_installed', `${cat.name} 尚未安裝，先跑：${cat.install_cmd}`)
    if (runtime !== 'hermes' && !d.mockRuntimeCatalog.workspace_roots.some((r) => String(body.workspace ?? '').startsWith(r.path))) {
      return fail(400, 'workspace_not_allowed', '工作目錄不在允許清單內')
    }
    const a = { id: nid('a'), enabled: true, runtime, runtime_name: cat.name, installed: cat.installed, ...body }
    state.agents.push(a)
    return ok(a, 201)
  }
  if ((m = path.match(/^\/agents\/([^/]+)$/))) {
    const a = state.agents.find((x) => x.id === m![1])
    if (!a) return fail(404, 'not_found', 'agent not found')
    if (method === 'PATCH') {
      Object.assign(a, body)
      return ok(a)
    }
    if (method === 'DELETE') {
      state.agents = state.agents.filter((x) => x.id !== a.id)
      return ok(undefined, 204)
    }
    return ok(a)
  }
  if ((m = path.match(/^\/agents\/([^/]+)\/soul$/))) {
    if (method === 'PUT') {
      state.souls[m[1]] = body.content ?? ''
      const a = state.agents.find((x) => x.id === m![1])
      if (a) a.soul_excerpt = (body.content ?? '').split('\n').find((l: string) => l && !l.startsWith('#')) ?? ''
    }
    return ok({ content: state.souls[m[1]] ?? '' })
  }
  if ((m = path.match(/^\/agents\/([^/]+)\/dossier$/))) {
    return ok(m[1] === 'a1' ? d.mockDossier : d.emptyDossier(m[1]))
  }
  if ((m = path.match(/^\/agents\/([^/]+)\/skills$/))) {
    return ok([
      { name: 'web_search', enabled: true, description: '網路搜尋' },
      { name: 'file_io', enabled: true, description: '讀寫檔案' },
      { name: 'line_push', enabled: false, description: 'LINE 推播' },
    ])
  }

  // 統一檔案預覽（/preview、/preview/inline）
  const pv = previewMock(path, method, body, u)
  if (pv) return ok(pv)

  // 聊天模組（session 管理／分類／搜尋／上傳／預覽／模型／Hermes 歷史）先接手，沒接的落回下面
  const chatRes = chatMock(state, path, method, body, u)
  if (chatRes) return chatRes

  // sessions
  if (path === '/sessions' && method === 'GET') {
    const agentId = u.searchParams.get('agent_id')
    return ok(agentId ? state.sessions.filter((s) => s.agent_id === agentId) : state.sessions)
  }
  if (path === '/sessions' && method === 'POST') {
    const s: Session = { id: nid('s'), agent_id: body.agent_id, title: body.title, created_at: now(), updated_at: now(), source: 'studio' }
    state.sessions.unshift(s)
    state.messages[s.id] = []
    return ok(s, 201)
  }
  if ((m = path.match(/^\/sessions\/([^/]+)\/messages$/))) return ok(state.messages[m[1]] ?? [])
  if ((m = path.match(/^\/sessions\/([^/]+)$/)) && method === 'DELETE') {
    state.sessions = state.sessions.filter((s) => s.id !== m![1])
    delete state.messages[m[1]]
    return ok(undefined, 204)
  }

  // kanban
  if (path === '/kanban/tasks' && method === 'GET') {
    const st = u.searchParams.get('status')
    return ok(st ? state.tasks.filter((t) => t.status === st) : state.tasks)
  }
  if (path === '/kanban/tasks' && method === 'POST') {
    const t: KanbanTask = { id: nid('t'), status: 'backlog', created_at: now(), ...body }
    state.tasks.push(t)
    return ok(t, 201)
  }
  if ((m = path.match(/^\/kanban\/tasks\/([^/]+)\/status$/))) {
    const t = state.tasks.find((x) => x.id === m![1])
    if (!t) return fail(404, 'not_found', 'task not found')
    t.status = body.status
    t.updated_at = now()
    return ok(t)
  }
  if ((m = path.match(/^\/kanban\/tasks\/([^/]+)\/comment$/))) return ok({ ok: true })

  // kanban board（modules/kanban）：mock 的 status 映射成 hermes 狀態
  const hermesStatus = (s: string) => ({ backlog: 'todo', in_progress: 'running' } as Record<string, string>)[s] ?? s
  const prioInt = (p?: string) => ({ low: 10, medium: 50, high: 80, urgent: 100 } as Record<string, number>)[p ?? 'medium'] ?? 50
  const card = (t: KanbanTask) => ({ ...t, status: hermesStatus(t.status), priority: prioInt(t.priority), priority_label: t.priority ?? 'medium', tags: (t as { tags?: string[] }).tags ?? [], diagnostics: t.id === 't4' ? [{ kind: 'stuck_in_review', severity: 'warning', title: 'review 超過 48h' }] : [] })
  if (path === '/kanban/board') {
    const a = u.searchParams.get('assignee')
    const tasks = state.tasks.filter((t) => !a || t.assignee === a).map(card)
    return ok({ tasks, diagnostics: [], profiles: ['researcher', 'editor', 'support'], statuses: ['triage', 'todo', 'ready', 'running', 'review', 'blocked', 'scheduled', 'done', 'archived'], assignee: a, archived: false })
  }
  if (path === '/kanban/cards' && method === 'POST') {
    const t: KanbanTask = { id: nid('t'), status: 'todo', created_at: now(), title: body.title, body: body.body, assignee: body.assignee, priority: body.priority }
    ;(t as { tags?: string[] }).tags = body.tags ?? []
    state.tasks.push(t)
    return ok({ ok: true, id: t.id, tags: body.tags ?? [] }, 201)
  }
  if ((m = path.match(/^\/kanban\/cards\/([^/]+)$/)) && method === 'GET') {
    const t = state.tasks.find((x) => x.id === m![1])
    if (!t) return fail(502, 'hermes_cli_error', 'no such task')
    return ok({ task: card(t), latest_summary: null, parents: [], children: [], comments: [{ author: 'admin', body: '第一則留言', created_at: 1700000000 }], events: [{ kind: 'created', payload: {}, created_at: 1700000000 }] })
  }
  if ((m = path.match(/^\/kanban\/cards\/([^/]+)\/move$/))) {
    const t = state.tasks.find((x) => x.id === m![1])
    if (!t) return fail(502, 'hermes_cli_error', 'no such task')
    t.status = (({ running: 'in_progress' } as Record<string, string>)[body.status] ?? body.status) as KanbanTask['status']
    return ok({ ok: true, id: t.id })
  }
  if ((m = path.match(/^\/kanban\/cards\/([^/]+)\/assign$/))) {
    const t = state.tasks.find((x) => x.id === m![1])
    if (t) t.assignee = body.profile === 'none' ? undefined : body.profile
    return ok({ ok: true })
  }
  if ((m = path.match(/^\/kanban\/cards\/([^/]+)\/tags$/))) return ok({ task_id: m[1], tags: body.tags })
  if ((m = path.match(/^\/kanban\/cards\/([^/]+)\/comments$/))) return ok({ ok: true }, 201)
  if ((m = path.match(/^\/kanban\/cards\/([^/]+)\/attachments$/))) return ok([])
  if ((m = path.match(/^\/kanban\/cards\/([^/]+)\/archive$/))) {
    state.tasks = state.tasks.filter((x) => x.id !== m![1])
    return ok({ ok: true })
  }
  if ((m = path.match(/^\/kanban\/cards\/([^/]+)\/dispatch$/))) return ok({ assign: { ok: true }, promote: { ok: true }, dispatch: { spawned: 1 } })
  if (path === '/voice/capabilities') return ok({ stt: { available: false }, tts: { available: false }, browser_first: true })

  // docs（以文件為核心：工作臺可以開文件，右側面板讀這幾條）
  if (path === '/docs' && method === 'GET') return ok(state.docs)
  if (path === '/docs' && method === 'POST') {
    const fmt = (body.format ?? 'html') as 'html' | 'md'
    const id = nid('doc')
    const doc: MockDoc = {
      id, title: body.title || '未命名文件', path: `docs/${id}.${fmt === 'md' ? 'md' : 'html'}`, format: fmt,
      status: body.status ?? 'draft', stage: body.stage ?? '', origin: body.origin ?? 'chat',
      content: body.content ?? '', latest_version: body.content ? 1 : null, versions: body.content ? 1 : 0,
      drift: false, created_at: now(), updated_at: now(),
    }
    state.docs.push(doc)
    return ok(doc, 201)
  }
  if ((m = path.match(/^\/docs\/([^/]+)$/)) && method === 'GET') {
    const doc = state.docs.find((x) => x.id === m![1])
    return doc ? ok(doc) : fail(404, 'not_found', 'doc not found')
  }
  if ((m = path.match(/^\/docs\/([^/]+)$/)) && method === 'PATCH') {
    const doc = state.docs.find((x) => x.id === m![1])
    if (!doc) return fail(404, 'not_found', 'doc not found')
    Object.assign(doc, body, { updated_at: now() })
    return ok(doc)
  }
  if ((m = path.match(/^\/docs\/([^/]+)$/)) && method === 'DELETE') {
    state.docs = state.docs.filter((x) => x.id !== m![1])
    return new Response(null, { status: 204 })
  }
  if ((m = path.match(/^\/docs\/([^/]+)\/versions$/)) && method === 'GET') return ok([])

  // today／inbox／limits：給 /today 用的最小 mock。/inbox/count 固定回 0，因為頂欄 badge 測試假設一開始沒數字
  if (path === '/inbox/count') return ok({ count: 0, by_kind: {} })
  if (path === '/inbox' && method === 'GET') return ok(d.mockInbox)
  if (path === '/workflow-approvals/ap1/approve' || path === '/workflow-approvals/ap1/reject') return ok({ ok: true })
  if (path === '/limits' && method === 'GET') return ok(d.mockLimits)
  if (path === '/limits/today') return ok(d.mockLimitsToday())
  // /workflow-runs 不帶 status 維持空陣列（工作流頁的既有假設）；帶 status 才回今日的幾筆
  if (path === '/workflow-runs' && u.searchParams.get('status')) {
    const st = u.searchParams.get('status')
    return ok(d.mockRuns().filter((r) => r.status === st))
  }

  // workflows
  if (path === '/workflow-env') return ok({ coding_tools: { 'claude-code': { bin: 'claude', path: null, installed: false } }, line_configured: false, workspace: '/tmp' })
  if (path === '/workflow-runs') return ok([])
  if (path === '/workflow-approvals' || path.startsWith('/workflow-approvals?')) return ok([])
  // 流程 w1 有跑過一次＋一條排程（清單卡、最近一次分頁、截圖用）；其他流程都是空的
  if ((m = path.match(/^\/workflows\/([^/]+)\/runs$/)) && method === 'GET') return ok(m[1] === 'w1' ? d.mockWorkflowRuns() : m[1] === 'w2' ? d.mockWorkflowRunsW2() : [])
  if ((m = path.match(/^\/workflows\/([^/]+)\/schedules$/)) && method === 'GET') return ok(m[1] === 'w1' ? d.mockSchedules() : [])
  if ((m = path.match(/^\/workflows\/([^/]+)\/webhooks$/)) && method === 'GET') return ok([])
  if ((m = path.match(/^\/workflow-runs\/([^/]+)$/)) && method === 'GET') return m[1] === 'wr1' ? ok(d.mockRunDetail()) : m[1] === 'wr2' ? ok(d.mockRunDetailW2()) : fail(404, 'not_found', 'run not found')
  if ((m = path.match(/^\/workflows\/([^/]+)\/run$/)) && method === 'POST') return ok({ run_id: nid('wr'), status: 'pending' }, 202)
  if ((m = path.match(/^\/workflows\/([^/]+)\/schedules$/)) && method === 'POST')
    return ok({ id: nid('sc'), workflow_id: m[1], cron: body.cron, enabled: true, input: body.input ?? {}, last_run_at: null, next_run_at: null }, 201)
  // 一句話建流程：固定回四步草稿（研究員 → 你 → 小編 → LINE）＋每天 08:00；只回草稿不建流程
  if (path === '/workflows/draft' && method === 'POST') {
    if (!String(body.text ?? '').trim()) return fail(400, 'bad_request', 'text 不可空白')
    const hermes = state.agents.filter((a) => a.enabled && (a.runtime ?? 'hermes') === 'hermes')
    if (!hermes.length) return fail(422, 'no_agent', '沒有可用的 Hermes 員工；先在「AI 員工」啟用一位')
    const research = hermes.find((a) => a.name === '研究員') ?? hermes[0]
    const writer = hermes.find((a) => a.name === '小編') ?? hermes[0]
    const pos = (i: number) => ({ x: 40 + i * 260, y: 120 })
    const nodes = [
      { id: 's1', kind: 'hermes', title: '找出今天三個熱點', agent_id: research.id, prompt: '找出今天三個循環包裝的熱點，每個用一句話講重點並附來源。', position: pos(0) },
      { id: 's2', kind: 'gate', title: '我挑一個', position: pos(1) },
      { id: 's3', kind: 'hermes', title: '依選題寫 LINE 貼文', agent_id: writer.id, prompt: '依老闆挑的題目寫一則 LINE 貼文：短句、先講結論、結尾一個行動呼籲。', position: pos(2) },
      { id: 's4', kind: 'delivery', title: '送到 LINE', channel: 'line', to: '行銷組', position: pos(3) },
    ]
    const edges = nodes.slice(1).map((n, i) => ({ id: `${nodes[i].id}-${n.id}`, source: nodes[i].id, target: n.id, sourceHandle: 'output', targetHandle: 'input' }))
    const steps = [
      { id: 's1', kind: 'hermes', who: research.name, detail: '找出今天三個熱點' },
      { id: 's2', kind: 'gate', who: '你', detail: '我挑一個' },
      { id: 's3', kind: 'hermes', who: writer.name, detail: '依選題寫 LINE 貼文' },
      { id: 's4', kind: 'delivery', who: '送到 LINE', detail: '行銷組' },
    ]
    return ok({ name: '每日熱點內容產線', nodes, edges, schedule: { cron: '0 8 * * *', label: '每天 08:00' }, agent_id: research.id, raw: '', steps })
  }
  // 試跑這一站：只回 run_id，之後的節點狀態由 WS 事件推
  if ((m = path.match(/^\/workflows\/([^/]+)\/nodes\/([^/]+)\/try$/)) && method === 'POST') return ok({ run_id: nid('wr_try'), status: 'running', upstream_run_id: null }, 202)
  if ((m = path.match(/^\/workflow-approvals\/([^/]+)\/(approve|reject)$/)) && method === 'POST') return ok({ ok: true, approval_id: m[1], decision: m[2], choice: '' })
  if (path === '/workflows' && method === 'GET') return ok(state.workflows)
  if (path === '/workflows' && method === 'POST') {
    if (!body.nodes?.length) return fail(422, 'validation', '至少需要一個節點')
    const w: Workflow = { id: nid('w'), name: body.name, nodes: body.nodes, edges: body.edges ?? [], viewport: body.viewport, created_at: now(), updated_at: now() }
    state.workflows.push(w)
    return ok(w, 201)
  }
  if ((m = path.match(/^\/workflows\/([^/]+)$/))) {
    const w = state.workflows.find((x) => x.id === m![1])
    if (!w) return fail(404, 'not_found', 'workflow not found')
    if (method === 'PATCH') {
      Object.assign(w, body, { updated_at: now() })
      return ok(w)
    }
    if (method === 'DELETE') {
      state.workflows = state.workflows.filter((x) => x.id !== w.id)
      return ok(undefined, 204)
    }
    return ok(w)
  }

  return fail(404, 'not_found', `no mock for ${method} ${path}`)
}
