import type {
  Agent, AgentSkill, ApiError, Company, HermesStatus, KanbanTask, LoginResponse, Member, Message, RuntimeCatalog, Session, Workflow,
} from './types'

export const TOKEN_KEY = 'mhc.token'
const LEGACY_TOKEN_KEY = 'hermes-studio.token'

// 改名前存的 token 搬到新 key（一次性），舊 key 清掉
try {
  const old = localStorage.getItem(LEGACY_TOKEN_KEY)
  if (old && !localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, old)
  if (old) localStorage.removeItem(LEGACY_TOKEN_KEY)
} catch {
  /* ignore */
}
export const IS_MOCK = import.meta.env.VITE_MOCK === '1'
export const API_BASE = '/api'

// 記憶體副本：localStorage 不可用（隱私模式、測試環境）時仍能運作
let memToken: string | null = null
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken
  } catch {
    return memToken
  }
}
export function setToken(token: string | null) {
  memToken = token
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

// 讓測試與 mock 可以換掉 fetch
let fetchImpl: typeof fetch = (...args) => fetch(...args)
export function setFetchImpl(f: typeof fetch) {
  fetchImpl = f
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetchImpl(API_BASE + path, { ...init, headers })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const err = (data as ApiError)?.error
    if (res.status === 401) {
      setToken(null)
      window.dispatchEvent(new CustomEvent('mhc:unauthorized'))
    }
    throw new HttpError(res.status, err?.code ?? 'http_error', err?.message ?? res.statusText)
  }
  return data as T
}

const json = (body: unknown) => JSON.stringify(body)

export const api = {
  auth: {
    login: (username: string, password: string) =>
      request<LoginResponse>('/auth/login', { method: 'POST', body: json({ username, password }) }),
    me: () => request<Member>('/auth/me'),
  },
  company: { current: () => request<Company>('/companies/current') },
  agents: {
    list: () => request<Agent[]>('/agents'),
    runtimes: () => request<RuntimeCatalog>('/agents/runtimes'),
    create: (body: Record<string, unknown>) => request<Agent>('/agents', { method: 'POST', body: json(body) }),
    update: (id: string, body: Partial<Agent>) => request<Agent>(`/agents/${id}`, { method: 'PATCH', body: json(body) }),
    remove: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
    soul: (id: string) => request<{ content: string }>(`/agents/${id}/soul`),
    saveSoul: (id: string, content: string) =>
      request<{ content: string }>(`/agents/${id}/soul`, { method: 'PUT', body: json({ content }) }),
    skills: (id: string) => request<AgentSkill[]>(`/agents/${id}/skills`),
  },
  sessions: {
    list: (agentId?: string) => request<Session[]>(`/sessions${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`),
    create: (agent_id: string, title?: string) =>
      request<Session>('/sessions', { method: 'POST', body: json({ agent_id, title }) }),
    messages: (id: string) => request<Message[]>(`/sessions/${id}/messages`),
    remove: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  },
  kanban: {
    list: (status?: string) => request<KanbanTask[]>(`/kanban/tasks${status ? `?status=${status}` : ''}`),
    create: (body: { title: string; body?: string; assignee?: string; priority?: string }) =>
      request<KanbanTask>('/kanban/tasks', { method: 'POST', body: json(body) }),
    setStatus: (id: string, status: string) =>
      request<KanbanTask>(`/kanban/tasks/${id}/status`, { method: 'POST', body: json({ status }) }),
    comment: (id: string, text: string) =>
      request<unknown>(`/kanban/tasks/${id}/comment`, { method: 'POST', body: json({ text }) }),
  },
  workflows: {
    list: () => request<Workflow[]>('/workflows'),
    get: (id: string) => request<Workflow>(`/workflows/${id}`),
    create: (body: Partial<Workflow>) => request<Workflow>('/workflows', { method: 'POST', body: json(body) }),
    update: (id: string, body: Partial<Workflow>) => request<Workflow>(`/workflows/${id}`, { method: 'PATCH', body: json(body) }),
    remove: (id: string) => request<void>(`/workflows/${id}`, { method: 'DELETE' }),
  },
  hermes: {
    status: () => request<HermesStatus>('/hermes/status'),
    health: () => request<{ ok: boolean }>('/health'),
  },
}

export function chatWsUrl(): string {
  const token = getToken() ?? ''
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/chat?token=${encodeURIComponent(token)}`
}
