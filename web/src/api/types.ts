// 依 docs/API.md v0.1
export type Role = 'owner' | 'admin' | 'member'

export interface Member {
  id: string
  username: string
  role: Role
  company_id: string
}

export interface LoginResponse {
  token: string
  member: Member
}

export interface Company {
  id: string
  name: string
  created_at: string
}

export interface Agent {
  id: string
  name: string
  profile: string
  title?: string
  description?: string
  avatar?: string
  model?: string
  enabled: boolean
  soul_excerpt?: string
}

export interface AgentSkill {
  name: string
  enabled: boolean
  description?: string
}

export interface Session {
  id: string
  agent_id: string
  title?: string
  created_at: string
  updated_at: string
  last_message_at?: string
  source?: string
}

export type MessageRole = 'user' | 'assistant' | 'tool'

export interface Message {
  id: string
  role: MessageRole
  content: string
  tool_name?: string
  tool_args?: unknown
  tool_result?: unknown
  created_at: string
}

export type KanbanStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done'
export const KANBAN_STATUSES: KanbanStatus[] = ['backlog', 'todo', 'in_progress', 'review', 'done']

export interface KanbanTask {
  id: string
  title: string
  body?: string
  status: KanbanStatus
  assignee?: string
  priority?: 'low' | 'medium' | 'high' | 'urgent'
  created_at?: string
  updated_at?: string
}

export interface WorkflowNode {
  id: string
  title: string
  agent_id?: string
  agent?: string
  model?: string
  skills?: string[]
  prompt?: string
  attachments?: string[]
  kind: 'agent' | 'gate' | 'condition'
}

export interface WorkflowEdge {
  source: string
  target: string
  on?: 'always' | 'success' | 'failure'
  condition?: string
}

export interface Workflow {
  id: string
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  viewport?: { x: number; y: number; zoom: number }
  created_at?: string
  updated_at?: string
}

export interface HermesStatus {
  gateway_ok: boolean
  /** gateway 連得上但 Studio 手上的 API key 被拒（Hermes 回 gateway_auth_failed） */
  auth_error?: boolean
  gateway_reachable?: boolean
  error?: string
  version?: string
  profiles: { name: string; model?: string; gateway?: string | boolean }[]
  api_server_url?: string
}

export interface ApiError {
  error: { code: string; message: string }
}

// ---- WS /ws/chat 事件契約 ----
export type ApprovalDecision = 'once' | 'session' | 'always' | 'deny'

export type WsClientMessage =
  | { type: 'run'; session_id: string; input: string }
  | { type: 'approval'; run_id: string; decision: ApprovalDecision; approval_id?: string }
  | { type: 'stop'; run_id: string }
  | { type: 'steer'; run_id: string; input: string }

interface WsBase {
  session_id: string
  run_id?: string
}

export type WsServerEvent =
  | (WsBase & { type: 'run.started'; run_id: string })
  | (WsBase & { type: 'message.delta'; delta: string })
  | (WsBase & { type: 'tool.started'; name: string; args?: unknown; call_id?: string })
  | (WsBase & { type: 'tool.completed'; name: string; result?: unknown; call_id?: string })
  | (WsBase & { type: 'approval.request'; approval_id: string; command: string; context?: string })
  | (WsBase & { type: 'approval.responded'; approval_id: string; decision: ApprovalDecision })
  | (WsBase & { type: 'subagent.start'; subagent_id?: string; goal?: string; task_index?: number; task_count?: number; model?: string; depth?: number })
  | (WsBase & { type: 'subagent.complete'; subagent_id?: string; goal?: string; status?: string; summary?: string; output_tail?: string; duration_seconds?: number; input_tokens?: number; output_tokens?: number; tool_count?: number; cost_usd?: number })
  | (WsBase & { type: 'run.completed'; output?: string; usage?: Record<string, unknown> })
  | (WsBase & { type: 'run.failed'; error: string })
  | (WsBase & { type: 'run.cancelled' })
  | (WsBase & { type: string; [k: string]: unknown })
