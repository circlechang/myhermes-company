import type { Agent, Company, HermesStatus, KanbanTask, Member, Message, Session, Workflow } from '../api/types'

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
  { id: 's1', agent_id: 'a1', title: '本週熱點選題', created_at: '2026-08-28T09:00:00Z', updated_at: '2026-08-29T01:20:00Z', last_message_at: '2026-08-29T01:20:00Z', source: 'studio' },
  { id: 's2', agent_id: 'a1', title: 'LINE 貼文草稿', created_at: '2026-08-27T02:00:00Z', updated_at: '2026-08-27T03:10:00Z', source: 'studio' },
  { id: 's3', agent_id: 'a2', title: '競品分析', created_at: '2026-08-26T02:00:00Z', updated_at: '2026-08-26T05:00:00Z', source: 'cli' },
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
      { id: 'n1', title: '抓熱點', kind: 'agent', agent_id: 'a2', prompt: '列出今日三個熱點' },
      { id: 'n2', title: '審批', kind: 'gate' },
      { id: 'n3', title: '寫文案', kind: 'agent', agent_id: 'a1', prompt: '依選題寫 LINE 貼文' },
    ],
    edges: [{ source: 'n1', target: 'n2' }, { source: 'n2', target: 'n3' }],
    created_at: '2026-08-28T00:00:00Z', updated_at: now(),
  },
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
