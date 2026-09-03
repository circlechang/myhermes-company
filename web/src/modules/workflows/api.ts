import { getToken, request } from '../../api/client'
import type { Approval, NodeOutput, RunDetail, RunSummary, Schedule, Webhook, WfEdge, WfNode, Workflow, WorkflowEnv } from './types'

const json = (b: unknown) => JSON.stringify(b)

export const wfApi = {
  list: (profile?: string) => request<Workflow[]>(`/workflows${profile ? `?profile=${encodeURIComponent(profile)}` : ''}`),
  get: (id: string) => request<Workflow>(`/workflows/${id}`),
  create: (body: Partial<Workflow>) => request<Workflow>('/workflows', { method: 'POST', body: json(body) }),
  update: (id: string, body: Partial<Workflow>) => request<Workflow>(`/workflows/${id}`, { method: 'PATCH', body: json(body) }),
  remove: (id: string) => request<void>(`/workflows/${id}`, { method: 'DELETE' }),
  batchDelete: (ids: string[]) => request<{ deleted: number }>('/workflows/batch-delete', { method: 'POST', body: json({ ids }) }),
  export: (id: string) => request<Record<string, unknown>>(`/workflows/${id}/export`),
  import: (data: unknown, name?: string) => request<Workflow>('/workflows/import', { method: 'POST', body: json({ data, name }) }),
  run: (id: string, input?: Record<string, unknown>) => request<{ run_id: string }>(`/workflows/${id}/run`, { method: 'POST', body: json({ input: input ?? {} }) }),
  runs: (id: string) => request<RunSummary[]>(`/workflows/${id}/runs`),
  allRuns: () => request<RunSummary[]>('/workflow-runs'),
  runDetail: (runId: string) => request<RunDetail>(`/workflow-runs/${runId}`),
  stop: (runId: string) => request<{ ok: boolean }>(`/workflow-runs/${runId}/stop`, { method: 'POST' }),
  /** 試跑這一站：只跑一個節點，回 202 {run_id, status, upstream_run_id}；trigger=try 不進歷史 */
  tryNode: (id: string, nodeId: string, body: { input?: string; use_latest_upstream?: boolean } = {}) =>
    request<{ run_id: string; status: string; upstream_run_id?: string | null }>(`/workflows/${id}/nodes/${encodeURIComponent(nodeId)}/try`, { method: 'POST', body: json(body) }),
  rerun: (runId: string, fromNode?: string, force = false) => request<{ run_id: string }>(`/workflow-runs/${runId}/rerun`, { method: 'POST', body: json({ from_node: fromNode, force }) }),
  nodeOutput: (runId: string, nodeId: string) => request<NodeOutput>(`/workflow-runs/${runId}/nodes/${encodeURIComponent(nodeId)}/output`),
  deleteRun: (runId: string) => request<{ ok: boolean }>(`/workflow-runs/${runId}`, { method: 'DELETE' }),
  approvals: (status = 'pending') => request<Approval[]>(`/workflow-approvals?status=${status}`),
  approve: (id: string, comment = '') => request<{ ok: boolean }>(`/workflow-approvals/${id}/approve`, { method: 'POST', body: json({ comment }) }),
  reject: (id: string, comment = '') => request<{ ok: boolean }>(`/workflow-approvals/${id}/reject`, { method: 'POST', body: json({ comment }) }),
  schedules: (id: string) => request<Schedule[]>(`/workflows/${id}/schedules`),
  createSchedule: (id: string, cron: string, input: Record<string, unknown> = {}) =>
    request<Schedule>(`/workflows/${id}/schedules`, { method: 'POST', body: json({ cron, input }) }),
  patchSchedule: (sid: string, body: Partial<Schedule>) => request<Schedule>(`/workflow-schedules/${sid}`, { method: 'PATCH', body: json(body) }),
  deleteSchedule: (sid: string) => request<{ ok: boolean }>(`/workflow-schedules/${sid}`, { method: 'DELETE' }),
  webhooks: (id: string) => request<Webhook[]>(`/workflows/${id}/webhooks`),
  createWebhook: (id: string) => request<Webhook>(`/workflows/${id}/webhooks`, { method: 'POST' }),
  deleteWebhook: (wid: string) => request<{ ok: boolean }>(`/workflow-webhooks/${wid}`, { method: 'DELETE' }),
  env: () => request<WorkflowEnv>('/workflow-env'),
  /** 一句話建流程：只回草稿（不建流程），對話框確認後再走 create／createSchedule */
  draft: (text: string, agentId?: string) => request<DraftProposal>('/workflows/draft', { method: 'POST', body: json({ text, agent_id: agentId }) }),
}

/** POST /workflows/draft 的回應：nodes/edges 可以直接餵 create；steps 是給人看的一行摘要 */
export interface DraftStep {
  id: string
  kind: 'hermes' | 'gate' | 'delivery'
  /** 誰做：員工名字／「你」／「送到 LINE」 */
  who: string
  detail: string
}
export interface DraftProposal {
  name: string
  nodes: WfNode[]
  edges: WfEdge[]
  schedule: { cron: string; label: string } | null
  agent_id: string
  raw: string
  steps: DraftStep[]
}

export function workflowWsUrl(): string {
  const token = getToken() ?? ''
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/workflows?token=${encodeURIComponent(token)}`
}

/** 清單頁用：每條流程只抓最近 1 筆（batch 打 GET /workflows/{id}/runs?limit=1） */
export const wfListApi = {
  latestRun: (id: string) => request<RunSummary[]>(`/workflows/${id}/runs?limit=1`),
}
