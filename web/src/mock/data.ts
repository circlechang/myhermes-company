import type { Agent, AgentDossier, Company, HermesStatus, KanbanTask, Member, Message, Session, Workflow } from '../api/types'

const now = () => new Date().toISOString()

export const mockMember: Member = { id: 'm1', username: 'admin', role: 'owner', company_id: 'c1' }
export const mockCompany: Company = { id: 'c1', name: '預設公司', created_at: '2026-08-29T00:00:00Z' }

export const mockAgents: Agent[] = [
  { id: 'a1', name: '小編', profile: 'editor', title: '內容編輯', description: '負責選題、文案與發布', model: 'claude-sonnet-4', enabled: true, soul_excerpt: '你是一位注重事實的內容編輯。', runtime: 'hermes', runtime_name: 'Hermes', installed: true, coding_config: null },
  { id: 'a2', name: '研究員', profile: 'researcher', title: '市場研究', description: '蒐集資料與整理洞察', model: 'gpt-5', enabled: true, soul_excerpt: '你先找證據，再給結論。', runtime: 'hermes', runtime_name: 'Hermes', installed: true, coding_config: null },
  { id: 'a3', name: '客服', profile: 'support', title: 'LINE 客服', description: '回覆 LINE OA 訊息', model: 'claude-haiku-4', enabled: false, soul_excerpt: '', runtime: 'hermes', runtime_name: 'Hermes', installed: true, coding_config: null },
  {
    id: 'a4', name: '工程師', profile: '', title: '寫程式', description: '在 repo 裡改檔案', model: 'sonnet', enabled: true,
    runtime: 'claude-code', runtime_name: 'Claude Code', installed: true, install_cmd: 'npm i -g @anthropic-ai/claude-code',
    workspace: '/Users/me/code/demo', workspace_vpath: 'extra:code/demo',
    coding_config: { model: 'sonnet', api_mode: 'direct', hermes_profile: '', extra: { permission_mode: 'acceptEdits' } },
  },
]

export const mockRuntimeCatalog = {
  runtimes: [
    { id: 'hermes', name: 'Hermes', installed: true, install_cmd: '', kind: 'hermes' },
    { id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.251', install_cmd: 'npm i -g @anthropic-ai/claude-code', kind: 'coding' },
    { id: 'codex', name: 'Codex CLI', installed: true, version: '0.145.0', install_cmd: 'npm i -g @openai/codex', kind: 'coding' },
    { id: 'pi', name: 'Pi', installed: false, install_cmd: 'npm i -g @mariozechner/pi-coding-agent', kind: 'coding' },
  ],
  workspace_roots: [{ id: 'extra:code', label: 'code', path: '/Users/me/code' }],
}

export const mockProfileList = {
  active: 'editor',
  restricted: false,
  profiles: ['editor', 'researcher', 'support'].map((name) => ({
    name, display_name: name, model: 'gpt-5', provider: 'openai', gateway: 'running', is_default: name === 'editor',
    description: '', path: `/home/.hermes/profiles/${name}`, has_soul: true, has_env: false, skills: 3,
  })),
}

export const mockSouls: Record<string, string> = {
  a1: '# SOUL\n\n你是一位注重事實的內容編輯。\n\n- 先確認來源再下筆\n- 用繁體中文\n- 標題不超過 20 字\n',
  a2: '# SOUL\n\n你先找證據，再給結論。\n',
  a3: '',
}

export const mockSessions: Session[] = [
  { id: 's1', agent_id: 'a1', title: '本週熱點選題', created_at: '2026-08-28T09:00:00Z', updated_at: '2026-08-29T01:20:00Z', last_message_at: '2026-08-29T01:20:00Z', source: 'studio', run_status: 'completed', result: '本週三個熱點：', result_kind: 'ok' },
  { id: 's2', agent_id: 'a1', title: 'LINE 貼文草稿', created_at: '2026-08-27T02:00:00Z', updated_at: '2026-08-27T03:10:00Z', source: 'studio', result: '', result_kind: '' },
  { id: 's3', agent_id: 'a2', title: '競品分析', created_at: '2026-08-26T02:00:00Z', updated_at: '2026-08-26T05:00:00Z', source: 'cli', run_status: 'failed', result: '失敗：gateway unreachable', result_kind: 'failed' },
]

export const mockMessages: Record<string, Message[]> = {
  s1: [
    { id: 'msg1', role: 'user', content: '幫我列本週三個熱點', created_at: '2026-08-29T01:19:00Z' },
    { id: 'msg2', role: 'tool', content: '', tool_name: 'web_search', tool_args: { q: '本週 熱點' }, tool_result: { hits: 3 }, created_at: '2026-08-29T01:19:30Z' },
    { id: 'msg3', role: 'assistant', content: '本週三個熱點：\n1. PPWR 授權代表新規\n2. 循環包材補助\n3. AI 客服上線潮', created_at: '2026-08-29T01:20:00Z' },
  ],
  s2: [],
  s3: [],
}

export const mockTasks: KanbanTask[] = [
  { id: 't1', title: '整理董事會簡報素材', body: '需要 Q3 數據', status: 'backlog', assignee: 'researcher', priority: 'medium' },
  { id: 't2', title: '寫 LINE 週報文案', status: 'todo', assignee: 'editor', priority: 'high' },
  { id: 't3', title: '競品價格表', status: 'in_progress', assignee: 'researcher', priority: 'urgent' },
  { id: 't4', title: '客服 SOP 初稿', status: 'review', assignee: 'support', priority: 'low' },
  { id: 't5', title: '上週熱點文', status: 'done', assignee: 'editor', priority: 'medium' },
]

export const mockWorkflows: Workflow[] = [
  {
    id: 'w1', name: '每日熱點內容產線',
    nodes: [
      { id: 'n1', title: '找熱點', kind: 'agent', agent_id: 'a2', prompt: '找出今天三個熱點，每個一句話講重點，附來源連結' },
      { id: 'n2', title: '等我看', kind: 'gate' },
      { id: 'n3', title: '寫貼文', kind: 'agent', agent_id: 'a1', prompt: '依選題寫 LINE 貼文：短句、先講結論、結尾一個行動呼籲' },
      // api/types 的 Workflow 節點型別還沒列 delivery（流程模組自己的 types 有），mock 先轉型
      { id: 'n4', title: '送到 LINE', kind: 'delivery', channel: 'line', to: '行銷組' } as unknown as Workflow['nodes'][number],
    ],
    edges: [{ source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' }, { source: 'n3', target: 'n4' }],
    budget: { max_cost_usd: 1 },
    created_at: '2026-08-28T00:00:00Z', updated_at: now(),
  } as Workflow, // budget 只在流程模組的型別裡
  // 第二條：停在「等我看」，用來看右欄的閱讀欄（全文、可拉寬）
  {
    id: 'w2', name: 'PPWR 週報',
    nodes: [
      { id: 'p1', title: '整理本週法規動態', kind: 'agent', agent_id: 'a2', prompt: '整理本週 PPWR／VerpackDG 的官方動態，每則附來源與影響對象' },
      { id: 'p2', title: '等我看', kind: 'gate' },
      { id: 'p3', title: '寫成週報', kind: 'agent', agent_id: 'a1', prompt: '依核准的重點寫 800 字週報，先結論後細節' },
    ],
    edges: [{ source: 'p1', target: 'p2' }, { source: 'p2', target: 'p3' }],
    created_at: '2026-08-30T00:00:00Z', updated_at: now(),
  } as Workflow,
]

const todayAt = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString() }
const tomorrowAt = (h: number, m = 0) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0); return d.toISOString() }
const WR1_USAGE = { input_tokens: 9_800, output_tokens: 2_545, total_tokens: 12_345, cost_usd: 0.41 }
/** 流程 w1 跑過的一次：清單卡與「最近一次」分頁都吃這筆 */
export const mockWorkflowRuns = () => [
  { id: 'wr1', workflow_id: 'w1', workflow_name: '每日熱點內容產線', status: 'completed', trigger: 'cron', usage: WR1_USAGE, error: '', created_by: 'admin', parent_run_id: '', created_at: todayAt(8), started_at: todayAt(8), finished_at: todayAt(8, 4) },
]
export const mockRunDetail = () => ({
  ...mockWorkflowRuns()[0],
  snapshot: { nodes: mockWorkflows[0].nodes, edges: mockWorkflows[0].edges },
  node_states: {
    n1: { status: 'completed', output: '一、PPWR 授權代表新規：非歐盟出口商 11/12 起要指定 AR。\n二、德國 VerpackG 改 VerpackDG，8/12 生效。\n三、循環包裝補貼草案進入公聽。', started_at: todayAt(8, 0), finished_at: todayAt(8, 3), usage: { total_tokens: 8_000, cost_usd: 0.28 } },
    n2: { status: 'completed', decision: true, started_at: todayAt(8, 1), finished_at: todayAt(8, 2) },
    n3: { status: 'completed', output: '【PPWR 新規】從 11/12 起，賣進歐盟的包裝要先指定授權代表。三件事今天就能做：查清楚你的 SKU、找 AR、把 LUCID 登記補齊。', started_at: todayAt(8, 2), finished_at: todayAt(8, 4), usage: { total_tokens: 4_345, cost_usd: 0.13 } },
    n4: { status: 'completed', delivery: { channel: 'line', to: '行銷組' }, started_at: todayAt(8, 4), finished_at: todayAt(8, 4) },
  },
  events: [],
  edge_decisions: {},
  input: {},
  approvals: [{ id: 'wa1', run_id: 'wr1', workflow_id: 'w1', workflow_name: '每日熱點內容產線', node_id: 'n2', node_title: '等我看', status: 'approved', payload: '一、PPWR 授權代表新規…', comment: '', decided_by: 'admin', decided_at: todayAt(8, 2), created_at: todayAt(8, 3) }],
})
const WR2_PAYLOAD = `# 本週 PPWR 法規動態（3 則）

## 一、授權代表（AR）義務 11/12 起適用於非歐盟出口商
- 來源：歐盟執委會 Q&A 更新（9/1）
- 影響：所有把包裝賣進歐盟、但在歐盟沒有法人實體的台灣出口商
- 重點：AR 必須是歐盟境內法人，且不能只做「代辦登記」，要對 EPR 費用連帶負責

## 二、德國 VerpackG 改名 VerpackDG，8/12 生效
- 來源：德國聯邦司法部公報
- 影響：LUCID 登記流程不變，但罰則上限提高到 20 萬歐元
- 重點：老手（既有登記者）死線 11/12，逾期會被平台下架

## 三、循環包裝補貼草案進入公聽
- 來源：環境部草案（8/29）
- 影響：使用可重複包裝達 30% 以上的品牌
- 重點：補貼採事後核銷，需要第三方循環次數證明

建議選第一則做本週主題：直接影響最多客戶、時間最近、可以接我們的 AR 服務。`
export const mockWorkflowRunsW2 = () => [
  { id: 'wr2', workflow_id: 'w2', workflow_name: 'PPWR 週報', status: 'waiting_approval', trigger: 'manual', usage: { input_tokens: 6_000, output_tokens: 1_200, total_tokens: 7_200, cost_usd: 0.22 }, error: '', created_by: 'admin', parent_run_id: '', created_at: todayAt(9), started_at: todayAt(9), finished_at: null },
]
export const mockRunDetailW2 = () => ({
  ...mockWorkflowRunsW2()[0],
  snapshot: { nodes: mockWorkflows[1].nodes, edges: mockWorkflows[1].edges },
  node_states: {
    p1: { status: 'completed', output: WR2_PAYLOAD, started_at: todayAt(9, 0), finished_at: todayAt(9, 5), usage: { total_tokens: 7_200, cost_usd: 0.22 } },
    p2: { status: 'waiting_approval', approval_id: 'wa2', started_at: todayAt(9, 5) },
    p3: { status: 'pending' },
  },
  events: [], edge_decisions: {}, input: {},
  approvals: [{ id: 'wa2', run_id: 'wr2', workflow_id: 'w2', workflow_name: 'PPWR 週報', node_id: 'p2', node_title: '等我看', status: 'pending', payload: WR2_PAYLOAD, comment: '', decided_by: '', decided_at: null, created_at: todayAt(9, 5) }],
})
/** 流程 w1 的排程：每天 08:00 */
export const mockSchedules = () => [
  { id: 'sc1', workflow_id: 'w1', cron: '0 8 * * *', enabled: true, input: {}, last_run_at: todayAt(8), last_run_id: 'wr1', next_run_at: tomorrowAt(8) },
]

export const mockHermesStatus: HermesStatus = {
  gateway_ok: true,
  version: '0.20.5',
  api_server_url: 'http://127.0.0.1:8642',
  profiles: [
    { name: 'default', model: 'claude-sonnet-4', gateway: true },
    { name: 'editor', model: 'claude-sonnet-4', gateway: true },
    { name: 'researcher', model: 'gpt-5', gateway: false },
    { name: 'support', model: 'claude-haiku-4', gateway: false },
  ],
}

/** 人事檔案：第一位員工有一週的活動，其他人都是零（空狀態） */
export const mockDossier: AgentDossier = {
  agent_id: 'a1', days: 7, since: new Date(Date.now() - 7 * 86400_000).toISOString(),
  chat: { sessions: 5, messages: 42 },
  workflow: { node_runs: 12, completed: 10, failed: 2, workflows: [{ workflow_name: '週報流程', count: 8 }, { workflow_name: '貼文流程', count: 4 }] },
  usage: { input_tokens: 98_000, output_tokens: 25_456, total_tokens: 123_456, cost_usd: 1.87 },
  approvals: { requested: 6, approved: 4, rejected: 2 },
  docs: { versions: 3, docs: 2 },
  recent: [
    { kind: 'workflow', title: '週報流程 · draft', at: new Date(Date.now() - 2 * 3600_000).toISOString(), status: 'completed', link: '/workflows/runs/wr1' },
    { kind: 'chat', title: '幫我改 LINE 文案', at: new Date(Date.now() - 5 * 3600_000).toISOString(), status: 'completed', link: '/workbench?session=s1' },
    { kind: 'doc', title: '九月週報', at: new Date(Date.now() - 86400_000).toISOString(), status: 'v3', link: '/docs/doc1' },
    { kind: 'workflow', title: '貼文流程 · review', at: new Date(Date.now() - 2 * 86400_000).toISOString(), status: 'failed', link: '/workflows/runs/wr2' },
  ],
}
export const emptyDossier = (id: string): AgentDossier => ({
  agent_id: id, days: 7, since: new Date(Date.now() - 7 * 86400_000).toISOString(),
  chat: { sessions: 0, messages: 0 }, workflow: { node_runs: 0, completed: 0, failed: 0, workflows: [] },
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0 }, approvals: { requested: 0, approved: 0, rejected: 0 },
  docs: { versions: 0, docs: 0 }, recent: [],
})

/** /today 用：一筆等核准的工作流閘門 */
export const mockInbox = {
  items: [
    {
      id: 'ib1', kind: 'workflow_gate', ref_id: 'ap1', title: '選題要不要發：PPWR 授權代表新規', detail: '研究員挑出三題，建議發第一題。', agent: 'researcher',
      created_at: '2026-08-29T01:30:00Z', link: '/workflows/runs/run1', actions: ['approve', 'reject', 'goto'],
      api: { approve: '/workflow-approvals/ap1/approve', reject: '/workflow-approvals/ap1/reject' },
    },
  ],
  count: 1, by_kind: { workflow_gate: 1 }, warnings: [] as string[],
}
const todayIso = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString() }
/** /today 用：今天一筆失敗、一筆完成 */
export const mockRuns = () => [
  { id: 'run1', workflow_id: 'w1', workflow_name: '熱點→貼文', status: 'failed', trigger: 'manual', usage: {}, error: 'LINE 投遞失敗：channel 未設定', created_by: 'admin', parent_run_id: '', created_at: todayIso(9), finished_at: todayIso(9) },
  { id: 'run2', workflow_id: 'w1', workflow_name: '熱點→貼文', status: 'completed', trigger: 'cron', usage: {}, error: '', created_by: 'admin', parent_run_id: '', created_at: todayIso(7), finished_at: todayIso(8) },
]
export const mockLimitsToday = () => ({
  date: new Date().toISOString().slice(0, 10),
  company: { tokens: 184_000, usd: 0.62, runs: 5 },
  agents: [
    { agent_id: 'a1', name: '小編', profile: 'editor', enabled: true, model: 'claude-sonnet-4', tokens: 120_000, usd: 0.41, runs: 3 },
    { agent_id: 'a2', name: '研究員', profile: 'researcher', enabled: true, model: 'gpt-5', tokens: 64_000, usd: 0.21, runs: 2 },
  ],
})
export const mockLimits = [
  { id: 'l1', scope: 'company', agent_id: '', daily_tokens: 200_000, daily_usd: 1, enabled: true, action: 'notify', last_triggered_on: '', disabled_agents: [], created_at: '2026-08-29T00:00:00Z', updated_at: '2026-08-29T00:00:00Z', agent: null,
    today: { tokens: 184_000, usd: 0.62, runs: 5, tokens_pct: 92, usd_pct: 62, exceeded: false, triggered_today: false } },
]

/** /today 用：30 日用量總計（本月累計 NT$）。數字對得上 admin1 測試那份，但那份是 test 私有的 fake fetch */
export const mockUsageSummary = () => ({
  totals: { input_tokens: 5_100_000, output_tokens: 420_000, total_tokens: 5_520_000, cache_read_tokens: 900_000, cache_write_tokens: 0, reasoning_tokens: 0,
    sessions: 42, sessions_per_day: 1.4, api_calls: 260, messages: 310, tool_calls: 88, cost_usd: 18.83, cost_hermes_usd: 10.2, cost_table_usd: 8.63,
    sessions_unpriced: 0, cache_hit_rate: 0.16, days: 30 },
  daily: [] as { key: string; sessions: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number }[],
  by_model: [], by_source: [], by_profile: [],
  studio: { sessions: 12, messages: 80, input_tokens: 400_000, output_tokens: 50_000 },
  sources: [{ profile: 'default', path: '/h/state.db', exists: true, sessions: 42 }],
})

/** 有事找我（LINE 通知）：預設關著；status 說 LINE 已接好（測試要看提示時自己改成 false） */
export const mockNotifyPrefs = () => ({
  enabled: false, line_to: '', public_url: '', on_waiting: true, on_failed: true, on_chat_approval: true, quiet_hours: '',
  updated_at: '2026-09-01T00:00:00Z',
})
export const mockNotifyStatus = { line_configured: true }
