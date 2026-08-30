// 套件模組 REST（docs/API.md「Packs」）
import { request } from '../../api/client'

export type StageStatus = 'draft' | 'running' | 'review' | 'done' | 'failed' | 'archived' | 'skipped'

export interface PackStage {
  id: string
  title: string
  agent: string
  workflow: string
  outputs: string[]
  gate: boolean
  description: string
  inputs: string[]
  criteria?: string
  role?: string
  deliverables?: string[]
  optional?: boolean
  default_enabled?: boolean
  branch?: { file: string; pattern: string; min: number }
  hint?: { file: string; pattern: string }
}
export interface InstalledPack {
  id: string
  name: string
  version: string
  installed_at: string
  agents: Record<string, string>
  workflows: Record<string, string>
  profiles_created: string[]
}
export interface Pack {
  name: string
  version: string
  title: string
  description: string
  workspace_dir: string
  profiles: string[]
  agents: { profile: string; name: string; title: string; description: string }[]
  stages: PackStage[]
  has_hooks: boolean
  installed: InstalledPack | null
}
export interface PackStatus {
  name: string
  installed: InstalledPack | null
  profiles: Record<string, boolean>
  agents: { profile: string; agent_id: string; name: string; title: string; enabled: boolean; exists: boolean }[]
  topics_count: number
  workspace: string
}
export interface TopicSummary {
  id: string
  title: string
  created_at: string | null
  updated_at: string | null
  current_stage: string | null
  stages: Record<string, StageStatus>
  lights: StageStatus[]
  archived?: boolean
  archived_reason?: string
}
export interface StageFile { path: string; exists: boolean; size: number; mtime: string | null }
export interface TopicStage extends PackStage {
  status: StageStatus
  run_id: string | null
  session_id: string | null
  updated_at: string | null
  feedback: string
  error?: string
  missing_outputs?: string[]
  files: StageFile[]
  can_run: boolean
  can_approve: boolean
  enabled?: boolean
  can_toggle?: boolean
  rollback_targets?: string[]
  archived_reason?: string
  review_hint?: string
  branch_result?: { passed: boolean | null; score: number | null; min: number; reason: string; note: string }
}
export interface TopicDetail extends TopicSummary {
  notes: string
  dir: string
  stage_list: TopicStage[]
  files: StageFile[]
}

const json = (b: unknown) => JSON.stringify(b)
const enc = encodeURIComponent

export const packsApi = {
  list: () => request<{ items: Pack[]; errors: Record<string, string>; roots: string[] }>('/packs'),
  get: (name: string) => request<Pack & { status: PackStatus }>(`/packs/${enc(name)}`),
  status: (name: string) => request<PackStatus>(`/packs/${enc(name)}/status`),
  install: (name: string) => request<PackStatus>(`/packs/${enc(name)}/install`, { method: 'POST' }),
  uninstall: (name: string) => request<{ ok: boolean; workflows_removed: number }>(`/packs/${enc(name)}`, { method: 'DELETE' }),
  topics: (name: string) => request<TopicSummary[]>(`/packs/${enc(name)}/topics`),
  createTopic: (name: string, body: { title: string; slug?: string; notes?: string }) =>
    request<TopicDetail>(`/packs/${enc(name)}/topics`, { method: 'POST', body: json(body) }),
  topic: (name: string, id: string) => request<TopicDetail>(`/packs/${enc(name)}/topics/${enc(id)}`),
  file: (name: string, id: string, path: string) =>
    request<{ path: string; content: string; binary: boolean; size: number }>(`/packs/${enc(name)}/topics/${enc(id)}/file?path=${enc(path)}`),
  saveFile: (name: string, id: string, path: string, content: string) =>
    request<StageFile>(`/packs/${enc(name)}/topics/${enc(id)}/file`, { method: 'PUT', body: json({ path, content }) }),
  run: (name: string, id: string, stage: string, force = false) =>
    request<{ run_id: string; stage: TopicStage }>(`/packs/${enc(name)}/topics/${enc(id)}/stages/${enc(stage)}/run`, { method: 'POST', body: json({ force }) }),
  approve: (name: string, id: string, stage: string, comment = '') =>
    request<{ ok: boolean; status: StageStatus }>(`/packs/${enc(name)}/topics/${enc(id)}/stages/${enc(stage)}/approve`, { method: 'POST', body: json({ comment }) }),
  reject: (name: string, id: string, stage: string, comment: string, to?: string) =>
    request<{ ok: boolean; status: StageStatus; to?: string }>(`/packs/${enc(name)}/topics/${enc(id)}/stages/${enc(stage)}/reject`,
      { method: 'POST', body: json(to && to !== stage ? { comment, to } : { comment }) }),
  setEnabled: (name: string, id: string, stage: string, enabled: boolean) =>
    request<{ ok: boolean; status: StageStatus; enabled: boolean }>(`/packs/${enc(name)}/topics/${enc(id)}/stages/${enc(stage)}/enabled`, { method: 'POST', body: json({ enabled }) }),
}
export const packsQk = {
  list: ['packs'] as const,
  pack: (n: string) => ['packs', n] as const,
  topics: (n: string) => ['packs', n, 'topics'] as const,
  topic: (n: string, id: string) => ['packs', n, 'topics', id] as const,
}
