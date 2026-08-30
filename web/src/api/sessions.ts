// 聊天模組 API：session 管理／分類／搜尋／上傳／預覽／模型／Hermes 歷史（對應 docs/API.md「Chat」）
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_BASE, HttpError, getToken, request } from './client'
import type { Message, Session } from './types'

export interface SessionUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  context_tokens: number
}

export interface ChatSession extends Session {
  member_id?: string
  archived: boolean
  category_id: string | null
  model: string
  provider: string
  running: boolean
  run_status: string
  last_run_id?: string
  usage: SessionUsage
  imported_from?: string
}

export interface Attachment {
  name: string
  path: string
  mime: string
  size: number
  session_id?: string
}

export interface ChatMessage extends Message {
  reply_to?: string | null
  attachments?: Attachment[]
  reasoning?: string | null
  usage?: Record<string, unknown> | null
  run_id?: string | null
}

export interface Category {
  id: string
  name: string
  color: string
  position: number
}

export interface SearchHit {
  session: ChatSession
  match: 'title' | 'message'
  snippet: string
  message_id?: string
}

export interface ModelEntry {
  id: string
  provider: string
  label: string
  pricing?: { input?: string; output?: string; free?: boolean } | null
}
export interface ModelOptions {
  providers: { slug: string; name: string; is_current?: boolean; authenticated?: boolean | null; models: ModelEntry[] }[]
  models: ModelEntry[]
  current: { model?: string | null; provider?: string | null }
  fallback?: boolean
  error?: string
}

export type PreviewKind = 'html' | 'pdf' | 'image' | 'markdown' | 'csv' | 'docx' | 'pptx' | 'xlsx' | 'code' | 'binary'
export interface Preview {
  kind: PreviewKind
  name: string
  path: string
  size: number
  url: string
  text?: string
  truncated?: boolean
  language?: string
  rows?: string[][]
  html?: string
  sheets?: { name: string; rows: unknown[][]; truncated: boolean }[]
  error?: string
}

export interface HermesHistorySession {
  profile: string
  id: string
  source: string
  title: string
  model?: string | null
  started_at?: string | null
  ended_at?: string | null
  last_activity_at?: string | null
  message_count: number
  tool_call_count: number
  input_tokens: number
  output_tokens: number
  archived: boolean
}
export interface HermesHistorySources {
  profile: string
  total: number
  sources: Record<string, number>
  error?: string
}

const json = (b: unknown) => JSON.stringify(b)
const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** 檔案 URL（瀏覽器直接開：img/iframe 用）。token 走 query 是因為 <img>/<iframe> 帶不了 header。 */
export function fileUrl(path: string, download = false): string {
  return `${API_BASE}/chat/files${qs({ path, download: download ? 'true' : undefined, token: getToken() ?? undefined })}`
}

async function uploadForm<T>(path: string, fd: FormData): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(API_BASE + path, { method: 'POST', body: fd, headers })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string } })?.error
    throw new HttpError(res.status, err?.code ?? 'http_error', err?.message ?? res.statusText)
  }
  return data as T
}

export const chatApi = {
  sessions: {
    list: (agentId?: string, opts: { includeArchived?: boolean; categoryId?: string } = {}) =>
      request<ChatSession[]>(`/sessions${qs({ agent_id: agentId, include_archived: opts.includeArchived ? 'true' : undefined, category_id: opts.categoryId })}`),
    get: (id: string) => request<ChatSession>(`/sessions/${id}`),
    create: (body: { agent_id: string; title?: string; model?: string; category_id?: string }) =>
      request<ChatSession>('/sessions', { method: 'POST', body: json(body) }),
    patch: (id: string, body: { title?: string; archived?: boolean; category_id?: string | null; model?: string; provider?: string }) =>
      request<ChatSession>(`/sessions/${id}`, { method: 'PATCH', body: json(body) }),
    setModel: (id: string, model: string, provider = '') =>
      request<ChatSession>(`/sessions/${id}/model`, { method: 'POST', body: json({ model, provider }) }),
    messages: (id: string) => request<ChatMessage[]>(`/sessions/${id}/messages`),
    remove: (id: string) => request<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
    search: (q: string, limit = 30) => request<SearchHit[]>(`/sessions/search${qs({ q, limit })}`),
  },
  categories: {
    list: () => request<Category[]>('/chat/categories'),
    create: (body: { name: string; color?: string }) => request<Category>('/chat/categories', { method: 'POST', body: json(body) }),
    patch: (id: string, body: Partial<Category>) => request<Category>(`/chat/categories/${id}`, { method: 'PATCH', body: json(body) }),
    remove: (id: string) => request<{ ok: boolean }>(`/chat/categories/${id}`, { method: 'DELETE' }),
  },
  uploads: {
    upload: (sessionId: string, files: File[]) => {
      const fd = new FormData()
      fd.set('session_id', sessionId)
      for (const f of files) fd.append('files', f, f.name)
      // 不走 request()：它會補 JSON content-type，multipart 要讓瀏覽器自己帶 boundary
      return uploadForm<Attachment[]>('/chat/uploads', fd)
    },
    list: (sessionId: string) => request<Attachment[]>(`/chat/uploads${qs({ session_id: sessionId })}`),
  },
  preview: (path: string) => request<Preview>(`/chat/preview${qs({ path })}`),
  models: (profile?: string, refresh = false) => request<ModelOptions>(`/chat/models${qs({ profile, refresh: refresh ? 'true' : undefined })}`),
  hermes: {
    sources: () => request<HermesHistorySources[]>('/chat/hermes-history/sources'),
    list: (opts: { profile?: string; source?: string; q?: string; limit?: number; offset?: number } = {}) =>
      request<HermesHistorySession[]>(`/chat/hermes-history${qs(opts)}`),
    messages: (profile: string, id: string) =>
      request<{ session: HermesHistorySession; messages: ChatMessage[] }>(`/chat/hermes-history/${encodeURIComponent(profile)}/${encodeURIComponent(id)}/messages`),
    import: (profile: string, id: string, body: { agent_id?: string; title?: string } = {}) =>
      request<ChatSession>(`/chat/hermes-history/${encodeURIComponent(profile)}/${encodeURIComponent(id)}/import`, { method: 'POST', body: json(body) }),
  },
}

// ---- hooks ---------------------------------------------------------------
export const cqk = {
  sessions: (agentId?: string, archived?: boolean) => ['sessions', agentId ?? 'all', archived ? 'archived' : 'live'] as const,
  session: (id: string) => ['sessions', id] as const,
  messages: (id: string) => ['sessions', id, 'messages'] as const,
  categories: ['chat', 'categories'] as const,
  models: (profile?: string) => ['chat', 'models', profile ?? 'default'] as const,
  hermesSources: ['chat', 'hermes', 'sources'] as const,
  hermesList: (profile?: string, source?: string) => ['chat', 'hermes', 'list', profile ?? 'all', source ?? 'all'] as const,
  hermesMessages: (profile: string, id: string) => ['chat', 'hermes', profile, id] as const,
  preview: (path: string) => ['chat', 'preview', path] as const,
}

export const useChatSessions = (agentId?: string, includeArchived = false) =>
  useQuery({
    queryKey: cqk.sessions(agentId, includeArchived),
    queryFn: () => chatApi.sessions.list(agentId, { includeArchived }),
    enabled: !!agentId,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.some((s) => s.running) ? 3000 : false),
  })
export const useChatMessages = (id?: string) =>
  useQuery({ queryKey: cqk.messages(id ?? ''), queryFn: () => chatApi.sessions.messages(id!), enabled: !!id })
export const useCategories = () => useQuery({ queryKey: cqk.categories, queryFn: chatApi.categories.list })
export const useModelOptions = (profile?: string, enabled = true) =>
  useQuery({ queryKey: cqk.models(profile), queryFn: () => chatApi.models(profile), enabled, staleTime: 5 * 60_000, retry: false })
export const useHermesSources = () => useQuery({ queryKey: cqk.hermesSources, queryFn: chatApi.hermes.sources, staleTime: 60_000, retry: false })
export const useHermesList = (profile?: string, source?: string, enabled = true) =>
  useQuery({ queryKey: cqk.hermesList(profile, source), queryFn: () => chatApi.hermes.list({ profile, source, limit: 100 }), enabled, retry: false })
export const useHermesMessages = (profile?: string, id?: string) =>
  useQuery({ queryKey: cqk.hermesMessages(profile ?? '', id ?? ''), queryFn: () => chatApi.hermes.messages(profile!, id!), enabled: !!profile && !!id })
export const usePreview = (path?: string) =>
  useQuery({ queryKey: cqk.preview(path ?? ''), queryFn: () => chatApi.preview(path!), enabled: !!path, retry: false })

function useInvalidateSessions() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['sessions'] })
}

export function usePatchSession() {
  const inv = useInvalidateSessions()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof chatApi.sessions.patch>[1] }) => chatApi.sessions.patch(id, body),
    onSuccess: inv,
  })
}
export function useSetSessionModel() {
  const inv = useInvalidateSessions()
  return useMutation({
    mutationFn: ({ id, model, provider }: { id: string; model: string; provider?: string }) => chatApi.sessions.setModel(id, model, provider),
    onSuccess: inv,
  })
}
export function useCreateChatSession() {
  const inv = useInvalidateSessions()
  return useMutation({ mutationFn: chatApi.sessions.create, onSuccess: inv })
}
export function useDeleteChatSession() {
  const inv = useInvalidateSessions()
  return useMutation({ mutationFn: (id: string) => chatApi.sessions.remove(id), onSuccess: inv })
}
export function useCategoryMutations() {
  const qc = useQueryClient()
  const inv = () => {
    qc.invalidateQueries({ queryKey: cqk.categories })
    qc.invalidateQueries({ queryKey: ['sessions'] })
  }
  const create = useMutation({ mutationFn: chatApi.categories.create, onSuccess: inv })
  const patch = useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<Category> }) => chatApi.categories.patch(id, body), onSuccess: inv })
  const remove = useMutation({ mutationFn: (id: string) => chatApi.categories.remove(id), onSuccess: inv })
  return { create, patch, remove }
}
export function useImportHermes() {
  const inv = useInvalidateSessions()
  return useMutation({
    mutationFn: ({ profile, id, agent_id }: { profile: string; id: string; agent_id?: string }) => chatApi.hermes.import(profile, id, { agent_id }),
    onSuccess: inv,
  })
}
