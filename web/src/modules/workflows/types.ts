// 工作流模組型別（與 server/studio/workflow_validate.py 對齊）
export type NodeKind = 'hermes' | 'coding-agent' | 'gate' | 'condition' | 'loop' | 'delivery'
export type EdgeOn = 'always' | 'success' | 'failure'
export type ConditionOp = 'contains' | 'not_contains' | 'regex' | 'json_path' | 'min_length' | 'max_length' | 'equals'

export interface Rule {
  op: ConditionOp
  value?: string
  path?: string
}

export interface WfNode {
  id: string
  kind: NodeKind | 'agent'
  title: string
  position?: { x: number; y: number }
  // hermes / condition(ai)
  agent_id?: string
  profile?: string
  model?: string
  skills?: string[]
  prompt?: string
  system?: string
  attachments?: string[]
  tool_approval?: 'deny' | 'allow'
  done_check?: boolean // 結構化自檢：模型最後附 {"status": complete|continue|blocked}
  done_check_max_rounds?: number // continue 最多幾輪（預設 3）
  // coding-agent
  tool?: 'claude-code' | 'codex' | 'pi'
  cwd?: string
  timeout_seconds?: number
  // condition
  mode?: 'rule' | 'ai'
  rule?: Rule
  // loop
  max_iterations?: number
  until?: Rule | null
  // delivery
  channel?: 'line' | 'webhook' | 'file'
  to?: string
  url?: string
  path?: string
  append?: boolean
  template?: string
}

export interface WfEdge {
  id?: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  on?: EdgeOn
  loop_back?: boolean
}

export interface Budget {
  max_tokens?: number
  max_cost_usd?: number
  deadline_seconds?: number
}

export interface Workflow {
  id: string
  name: string
  description?: string
  profile?: string
  version?: number
  nodes: WfNode[]
  edges: WfEdge[]
  viewport?: { x: number; y: number; zoom: number }
  budget?: Budget
  created_at?: string
  updated_at?: string
}

export type NodeStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'skipped' | 'reused' | 'stopped' | 'outcome_unknown'
export type RunStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'stopped' | 'timeout' | 'budget_exceeded' | 'needs_attention'

export interface SpillInfo {
  path: string
  bytes: number
  head_bytes: number
  tail_bytes: number
}

export interface DoneRound {
  round: number
  status: 'complete' | 'continue' | 'blocked'
  evidence: string
  next: string
  warning?: string
  output_chars?: number
  session_id?: string
}

export interface Usage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  cost_usd?: number
}

export interface NodeState {
  status: NodeStatus
  attempt?: number
  output?: string
  error?: string
  usage?: Usage
  session_id?: string
  hermes_session_id?: string
  started_at?: string | null
  finished_at?: string | null
  approval_id?: string
  decision?: boolean
  iterations?: number
  skipped_reason?: string
  reason?: string
  delivery?: Record<string, unknown>
  exit_code?: number
  profile?: string
  spill?: SpillInfo
  done_rounds?: DoneRound[]
  effect_hash?: string
}

export interface NodeOutput {
  run_id: string
  node_id: string
  spilled: boolean
  bytes: number
  path: string | null
  content: string
}

export interface RunEvent {
  ts: string
  seq: number
  type: string
  node_id?: string
  status?: string
  edge?: string
  source?: string
  target?: string
  taken?: boolean
  handle?: string
  on?: string
  loop_back?: boolean
  decision?: string
  comment?: string
  approval_id?: string
  error?: string
  reason?: string
  iteration?: number
  note?: string
  [k: string]: unknown
}

export interface RunSummary {
  id: string
  workflow_id: string
  workflow_name: string
  status: RunStatus
  trigger: string
  usage: Usage
  error: string
  created_by: string
  parent_run_id: string
  created_at: string
  started_at?: string | null
  finished_at?: string | null
}

export interface Approval {
  id: string
  run_id: string
  workflow_id: string
  workflow_name: string
  node_id: string
  node_title: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  payload: string
  comment: string
  decided_by: string
  decided_at?: string | null
  created_at: string
}

export interface RunDetail extends RunSummary {
  snapshot: { nodes: WfNode[]; edges: WfEdge[]; viewport?: Workflow['viewport']; budget?: Budget; version?: number; name?: string }
  node_states: Record<string, NodeState>
  events: RunEvent[]
  edge_decisions: Record<string, boolean>
  input: Record<string, unknown>
  approvals: Approval[]
}

export interface Schedule {
  id: string
  workflow_id: string
  cron: string
  enabled: boolean
  input: Record<string, unknown>
  last_run_at?: string | null
  last_run_id?: string
  next_run_at?: string | null
}

export interface Webhook {
  id: string
  workflow_id: string
  token: string
  enabled: boolean
  path: string
  hits: number
  last_hit_at?: string | null
}

export interface WorkflowEnv {
  coding_tools: Record<string, { bin: string; path: string | null; installed: boolean }>
  line_configured: boolean
  workspace: string
}

// WS /ws/workflows 事件
export interface WfWsEvent {
  type: string
  run_id?: string
  workflow_id?: string
  node_id?: string
  status?: string
  delta?: string
  output?: string
  error?: string
  usage?: Usage
  attempt?: number
  approval_id?: string
  payload?: string
  decision?: string
  comment?: string
  branch?: string | null
  reason?: string
  name?: string
  ts?: string
  round?: number
  evidence?: string
  kind?: string
}
