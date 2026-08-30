import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_BASE, getToken, request } from '../../api/client'

export type HermesStatus = 'triage' | 'todo' | 'ready' | 'running' | 'review' | 'blocked' | 'scheduled' | 'done' | 'archived'
export type PriorityLabel = 'low' | 'medium' | 'high' | 'urgent'

export interface Diagnostic { kind: string; severity: 'warning' | 'error' | 'critical'; title: string; detail?: string }
export interface Card {
  id: string
  title: string
  body?: string | null
  assignee?: string | null
  status: HermesStatus
  priority?: number | null
  priority_label: PriorityLabel
  tags: string[]
  diagnostics: Diagnostic[]
  created_at?: number
  started_at?: number | null
  completed_at?: number | null
  result?: string | null
  skills?: string[]
  model_override?: string | null
  workspace_path?: string | null
}
export interface Board {
  tasks: Card[]
  diagnostics: { task_id: string; title: string; status: string; assignee?: string; diagnostics: Diagnostic[] }[]
  profiles: string[]
  statuses: HermesStatus[]
  assignee: string | null
  archived: boolean
}
export interface CardDetail {
  task: Card
  latest_summary?: string | null
  parents: unknown[]
  children: unknown[]
  comments: { author: string; body: string; created_at: number }[]
  events: { kind: string; payload?: Record<string, unknown> | null; created_at: number; run_id?: number | null }[]
}
export interface Attachment { id: number | string; filename?: string; name?: string; content_type?: string; size?: number; uploaded_by?: string; created_at?: number }

// 看板欄位（UI）→ hermes 狀態
export type Column = 'todo' | 'ready' | 'running' | 'review' | 'blocked' | 'done'
export const COLUMNS: Column[] = ['todo', 'ready', 'running', 'review', 'blocked', 'done']
export const columnOf = (s: HermesStatus): Column | null => {
  if (s === 'triage' || s === 'todo') return 'todo'
  if (s === 'scheduled' || s === 'blocked') return 'blocked'
  if (s === 'archived') return null
  return s as Column
}
/** 拖到某欄要送給後端的目標狀態；running 不能拖（由 dispatcher 決定）。 */
export const dropTarget = (col: Column): HermesStatus | null => (col === 'running' ? null : col)
/** 純函式：把 dnd 的 active/over 轉成要不要呼叫 move。同欄或不可拖 → null。 */
export function resolveDrop(card: Card | undefined, overId: string | null | undefined): HermesStatus | null {
  if (!card || !overId) return null
  const col = overId.startsWith('col-') ? (overId.slice(4) as Column) : null
  if (!col || !COLUMNS.includes(col)) return null
  if (columnOf(card.status) === col) return null
  return dropTarget(col)
}

const json = (b: unknown) => JSON.stringify(b)
export const kbApi = {
  board: (assignee?: string, archived = false) =>
    request<Board>(`/kanban/board?${new URLSearchParams({ ...(assignee ? { assignee } : {}), ...(archived ? { archived: 'true' } : {}) })}`),
  create: (body: { title: string; body?: string; assignee?: string; priority?: PriorityLabel | number; tags?: string[]; skills?: string[]; model?: string; max_runtime?: string }) =>
    request<{ id: string }>('/kanban/cards', { method: 'POST', body: json(body) }),
  detail: (id: string) => request<CardDetail>(`/kanban/cards/${id}`),
  move: (id: string, status: HermesStatus, extra: { reason?: string; result?: string } = {}) =>
    request<unknown>(`/kanban/cards/${id}/move`, { method: 'POST', body: json({ status, ...extra }) }),
  assign: (id: string, profile: string) => request<unknown>(`/kanban/cards/${id}/assign`, { method: 'POST', body: json({ profile }) }),
  comment: (id: string, text: string) => request<unknown>(`/kanban/cards/${id}/comments`, { method: 'POST', body: json({ text }) }),
  tags: (id: string, tags: string[]) => request<{ tags: string[] }>(`/kanban/cards/${id}/tags`, { method: 'PUT', body: json({ tags }) }),
  archive: (id: string) => request<unknown>(`/kanban/cards/${id}/archive`, { method: 'POST' }),
  dispatch: (id: string, profile?: string) => request<Record<string, unknown>>(`/kanban/cards/${id}/dispatch`, { method: 'POST', body: json({ profile: profile ?? '', max_spawn: 1 }) }),
  attachments: (id: string) => request<Attachment[]>(`/kanban/cards/${id}/attachments`),
  deleteAttachment: (id: string, att: string | number) => request<unknown>(`/kanban/cards/${id}/attachments/${att}`, { method: 'DELETE' }),
  upload: async (id: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(new URL(`${API_BASE}/kanban/cards/${id}/attachments`, location.origin).toString(), { method: 'POST', headers: { Authorization: `Bearer ${getToken() ?? ''}` }, body: fd })
    if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    return res.json()
  },
}

export const kk = {
  board: (assignee?: string, archived?: boolean) => ['kanban', 'board', assignee ?? 'all', archived ? 'archived' : 'live'] as const,
  detail: (id: string) => ['kanban', 'card', id] as const,
  attachments: (id: string) => ['kanban', 'card', id, 'attachments'] as const,
}
export const useBoard = (assignee?: string, archived = false, live = true) =>
  useQuery({ queryKey: kk.board(assignee, archived), queryFn: () => kbApi.board(assignee, archived), refetchInterval: live ? 8000 : false })
export const useCardDetail = (id?: string) => useQuery({ queryKey: kk.detail(id ?? ''), queryFn: () => kbApi.detail(id!), enabled: !!id })
export const useAttachments = (id?: string) => useQuery({ queryKey: kk.attachments(id ?? ''), queryFn: () => kbApi.attachments(id!), enabled: !!id, retry: false })

export function useKanbanMutations(cardId?: string) {
  const qc = useQueryClient()
  const inv = () => {
    qc.invalidateQueries({ queryKey: ['kanban'] })
    if (cardId) qc.invalidateQueries({ queryKey: kk.detail(cardId) })
  }
  return {
    create: useMutation({ mutationFn: kbApi.create, onSuccess: inv }),
    move: useMutation({ mutationFn: ({ id, status, extra }: { id: string; status: HermesStatus; extra?: { reason?: string; result?: string } }) => kbApi.move(id, status, extra), onSuccess: inv }),
    assign: useMutation({ mutationFn: ({ id, profile }: { id: string; profile: string }) => kbApi.assign(id, profile), onSuccess: inv }),
    comment: useMutation({ mutationFn: ({ id, text }: { id: string; text: string }) => kbApi.comment(id, text), onSuccess: inv }),
    tags: useMutation({ mutationFn: ({ id, tags }: { id: string; tags: string[] }) => kbApi.tags(id, tags), onSuccess: inv }),
    archive: useMutation({ mutationFn: (id: string) => kbApi.archive(id), onSuccess: inv }),
    dispatch: useMutation({ mutationFn: ({ id, profile }: { id: string; profile?: string }) => kbApi.dispatch(id, profile), onSuccess: inv }),
    upload: useMutation({ mutationFn: ({ id, file }: { id: string; file: File }) => kbApi.upload(id, file), onSuccess: () => cardId && qc.invalidateQueries({ queryKey: kk.attachments(cardId) }) }),
    deleteAttachment: useMutation({ mutationFn: ({ id, att }: { id: string; att: string | number }) => kbApi.deleteAttachment(id, att), onSuccess: () => cardId && qc.invalidateQueries({ queryKey: kk.attachments(cardId) }) }),
  }
}
