// docs 模組 API：文件＝第一級物件（對應 server/studio/modules/docs，見 docs/API.md「Docs」）
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../../api/client'
import type { ChatSession } from '../../api/sessions'

export type DocStatus = 'draft' | 'review' | 'final' | 'archived'
export type DocOrigin = 'chat' | 'workflow' | 'pack' | 'upload'
export type LinkKind = 'derived' | 'split' | 'merged' | 'selected'

export interface DiffStat {
  added: number
  removed: number
}

export interface DocVersionMeta {
  id: string
  doc_id: string
  version: number
  author_kind: 'human' | 'agent'
  author_id: string
  summary: string
  diff_stat: DiffStat
  session_id: string
  run_id: string
  created_at: string
  chars: number
  lines: number
}

export interface Doc {
  id: string
  title: string
  path: string
  /** 'html'（預設，可直接預覽）或 'md'（既有文件）。後端以路徑副檔名回推，一定有值。 */
  format?: 'html' | 'md'
  status: DocStatus
  stage: string
  owner_agent_id: string
  parent_doc_id: string
  origin: DocOrigin
  meta: Record<string, unknown>
  created_at: string
  updated_at: string
  latest_version: number | null
  versions: number
  latest: DocVersionMeta | null
  drift: boolean
  abs_path: string
  content?: string
  file_content?: string | null
}

export interface DocDiff {
  doc_id: string
  from: number | null
  to: number | null
  diff: string
  added: number
  removed: number
}

export interface LineageNode {
  id: string
  title: string
  status: DocStatus
  stage: string
  origin: DocOrigin
  path: string
  latest_version: number | null
  chars: number
  is_root: boolean
  parent_doc_id: string
  created_at: string
}
export interface LineageEdge {
  id: string
  from_doc_id: string
  to_doc_id: string
  kind: LinkKind
  run_id: string
  node_id: string
}
export interface Lineage {
  root: string
  nodes: LineageNode[]
  edges: LineageEdge[]
}

const json = (b: unknown) => JSON.stringify(b)
const qs = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const docsApi = {
  list: (f: { status?: string; stage?: string; origin?: string; q?: string } = {}) => request<Doc[]>(`/docs${qs(f)}`),
  get: (id: string) => request<Doc>(`/docs/${id}`),
  create: (body: Partial<Doc> & { content?: string }) => request<Doc>('/docs', { method: 'POST', body: json(body) }),
  patch: (id: string, body: Record<string, unknown>) => request<Doc>(`/docs/${id}`, { method: 'PATCH', body: json(body) }),
  remove: (id: string) => request<void>(`/docs/${id}`, { method: 'DELETE' }),
  versions: (id: string) => request<DocVersionMeta[]>(`/docs/${id}/versions`),
  version: (id: string, v: number) => request<DocVersionMeta & { content: string }>(`/docs/${id}/versions/${v}`),
  addVersion: (id: string, content: string, summary = '') =>
    request<DocVersionMeta & { same: boolean }>(`/docs/${id}/versions`, {
      method: 'POST',
      body: json({ content, summary, author_kind: 'human' }),
    }),
  diff: (id: string, a?: number, b?: number) => request<DocDiff>(`/docs/${id}/diff${qs({ a, b })}`),
  revert: (id: string, version: number) =>
    request<DocVersionMeta & { reverted_to: number }>(`/docs/${id}/revert`, { method: 'POST', body: json({ version }) }),
  snapshot: (id: string) => request<DocVersionMeta & { same: boolean }>(`/docs/${id}/snapshot`, { method: 'POST', body: json({}) }),
  lineage: (id: string) => request<Lineage>(`/docs/${id}/lineage`),
  fork: (id: string, title: string) => request<Doc>(`/docs/${id}/fork`, { method: 'POST', body: json({ title }) }),
}

export const docKey = (...parts: unknown[]) => ['docs', ...parts]

export function useDocs(filters: { status?: string; stage?: string; origin?: string; q?: string } = {}) {
  return useQuery({ queryKey: docKey('list', filters), queryFn: () => docsApi.list(filters) })
}
export function useDoc(id?: string) {
  return useQuery({ queryKey: docKey('one', id), queryFn: () => docsApi.get(id!), enabled: !!id })
}
export function useDocVersions(id?: string) {
  return useQuery({ queryKey: docKey('versions', id), queryFn: () => docsApi.versions(id!), enabled: !!id })
}
export function useDocDiff(id?: string, a?: number, b?: number, enabled = true) {
  return useQuery({ queryKey: docKey('diff', id, a, b), queryFn: () => docsApi.diff(id!, a, b), enabled: enabled && !!id })
}
export function useLineage(id?: string) {
  return useQuery({ queryKey: docKey('lineage', id), queryFn: () => docsApi.lineage(id!), enabled: !!id })
}

/** 文件模式要的是「這位成員的所有對話」（chat 模組的 useChatSessions 需要 agent_id 才會跑）。 */
export function useDocSessions() {
  return useQuery({ queryKey: docKey('sessions'), queryFn: () => request<ChatSession[]>('/sessions') })
}

export function useDocMutations(id?: string) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ['docs'] })
  return {
    save: useMutation({ mutationFn: (v: { content: string; summary?: string }) => docsApi.addVersion(id!, v.content, v.summary ?? '人工編輯'), onSuccess: done }),
    revert: useMutation({ mutationFn: (v: number) => docsApi.revert(id!, v), onSuccess: done }),
    snapshot: useMutation({ mutationFn: () => docsApi.snapshot(id!), onSuccess: done }),
    patch: useMutation({ mutationFn: (b: Record<string, unknown>) => docsApi.patch(id!, b), onSuccess: done }),
    fork: useMutation({ mutationFn: (title: string) => docsApi.fork(id!, title), onSuccess: done }),
    create: useMutation({ mutationFn: (b: Partial<Doc> & { content?: string }) => docsApi.create(b), onSuccess: done }),
    /** 封存／取消封存等狀態切換；帶 id 所以清單頁不用先選文件 */
    setStatus: useMutation({ mutationFn: (v: { id: string; status: DocStatus }) => docsApi.patch(v.id, { status: v.status }), onSuccess: done }),
    /** 刪 DB 列、版本與血緣（工作區檔案保留）；後端限 admin */
    remove: useMutation({ mutationFn: (docId: string) => docsApi.remove(docId), onSuccess: done }),
  }
}

/** 助理訊息裡的 ```doc 圍欄不應該再被貼出來一次（後端已抽掉，串流中的要前端自己藏）。 */
export function stripDocFence(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: number | null = null
  for (const line of lines) {
    if (fence === null) {
      const m = /^(`{3,})[ \t]*(doc-patch|doc)[ \t]*$/i.exec(line)
      if (m) {
        fence = m[1].length
        continue
      }
      out.push(line)
    } else if (new RegExp('^`{' + fence + ',}[ \\t]*$').test(line)) {
      fence = null
    }
  }
  return out.join('\n').trim()
}

export const STATUS_ORDER: DocStatus[] = ['draft', 'review', 'final', 'archived']
