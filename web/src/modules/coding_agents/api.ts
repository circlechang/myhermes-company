import { getToken, request } from '../../api/client'

export type AgentId = 'claude' | 'codex' | 'pi'

export interface AgentSetting {
  agent: AgentId
  workspace: string
  model: string
  api_mode: 'direct' | 'hermes'
  hermes_profile: string
  extra: Record<string, unknown>
  updated_at?: string
}

export interface AgentInfo {
  id: AgentId
  name: string
  installed: boolean
  path: string
  version: string
  install_cmd: string
  package: string
  docs: string
  supports: { resume: boolean; images: boolean; proxy: string }
  npm_available: boolean
  settings: AgentSetting
  running: number
}

export interface CodingSession {
  id: string
  title: string
  source: string
  agent: AgentId
  workspace: string
  model: string
  external_session_id: string
  status: 'idle' | 'running' | 'failed'
  created_at: string
  updated_at: string
  last_message_at?: string
  last_run_id?: string
}

export interface CodingMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  run_id?: string
  tool_name?: string
  tool_args?: unknown
  tool_result?: unknown
  created_at: string
}

export interface CodingRun {
  id: string
  session_id: string
  agent: AgentId
  prompt: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  exit_code: number | null
  diff_before: string
  diff_after: string
  files: { status: string; path: string }[]
  usage: Record<string, unknown>
  error: string
  started_at: string
  finished_at?: string
}

export interface InstallJob {
  id: string
  agent: AgentId
  status: 'running' | 'completed' | 'failed'
  log: string
  command: string
  exit_code?: number
}

export interface FsListing {
  path: string
  parent: string | null
  is_git: boolean
  dirs: { name: string; path: string; is_git: boolean }[]
}

export interface ProxyInfo {
  anthropic_base_url: string
  openai_base_url: string
  token: string
  claude_env: Record<string, string>
  codex_config_snippet: string
  codex_env: Record<string, string>
}

const json = (b: unknown) => JSON.stringify(b)

export const codingApi = {
  agents: () => request<AgentInfo[]>('/coding/agents'),
  install: (agent: AgentId) => request<{ job_id: string; command: string }>(`/coding/agents/${agent}/install`, { method: 'POST' }),
  installJob: (id: string) => request<InstallJob>(`/coding/install/${id}`),
  setting: (agent: AgentId) => request<AgentSetting>(`/coding/settings/${agent}`),
  saveSetting: (agent: AgentId, body: Partial<AgentSetting>) =>
    request<AgentSetting>(`/coding/settings/${agent}`, { method: 'PUT', body: json(body) }),
  proxyInfo: () => request<ProxyInfo>('/coding/proxy-info'),
  fs: (path?: string) => request<FsListing>(`/coding/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  sessions: (agent?: AgentId) => request<CodingSession[]>(`/coding/sessions${agent ? `?agent=${agent}` : ''}`),
  createSession: (body: { agent: AgentId; workspace?: string; model?: string; title?: string }) =>
    request<CodingSession>('/coding/sessions', { method: 'POST', body: json(body) }),
  removeSession: (id: string) => request<{ ok: boolean }>(`/coding/sessions/${id}`, { method: 'DELETE' }),
  messages: (id: string) => request<CodingMessage[]>(`/coding/sessions/${id}/messages`),
  runs: (id: string) => request<CodingRun[]>(`/coding/sessions/${id}/runs`),
  uploadImage: (id: string, filename: string, data_base64: string) =>
    request<{ path: string; size: number }>(`/coding/sessions/${id}/images`, { method: 'POST', body: json({ filename, data_base64 }) }),
}

export function codingWsUrl(): string {
  const token = getToken() ?? ''
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/coding?token=${encodeURIComponent(token)}`
}
