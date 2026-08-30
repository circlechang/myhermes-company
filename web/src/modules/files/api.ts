import { API_BASE, getToken, request } from '../../api/client'

export interface FileRoot {
  id: string
  label: string
  kind: string
  exists: boolean
  writable: boolean
}
export interface FileEntry {
  name: string
  path: string
  kind: 'dir' | 'file' | 'missing'
  size: number
  mtime: number
  ext?: string
}
export interface DirListing {
  path: string
  root: string
  parent: string | null
  entries: FileEntry[]
}
export interface FileContent {
  path: string
  name: string
  size: number
  mtime: number
  mime: string
  binary: boolean
  truncated: boolean
  content: string | null
}

const json = (b: unknown) => JSON.stringify(b)
const q = (o: Record<string, string>) => new URLSearchParams(o).toString()

export const filesApi = {
  roots: () => request<FileRoot[]>('/files/roots'),
  list: (path: string) => request<DirListing>(`/files/list?${q({ path })}`),
  read: (path: string) => request<FileContent>(`/files/read?${q({ path })}`),
  write: (path: string, content: string) => request<FileEntry>('/files/write', { method: 'PUT', body: json({ path, content }) }),
  mkdir: (path: string) => request<FileEntry>('/files/mkdir', { method: 'POST', body: json({ path }) }),
  rename: (path: string, new_name: string) => request<FileEntry>('/files/rename', { method: 'POST', body: json({ path, new_name }) }),
  copy: (path: string, dest: string) => request<FileEntry>('/files/copy', { method: 'POST', body: json({ path, dest }) }),
  move: (path: string, dest: string) => request<FileEntry>('/files/move', { method: 'POST', body: json({ path, dest }) }),
  remove: (path: string) => request<{ ok: boolean }>(`/files?${q({ path })}`, { method: 'DELETE' }),
  attach: (path: string) => request<{ uri: string; abs_path: string; name: string }>('/files/attach', { method: 'POST', body: json({ path }) }),
  upload: async (dir: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/files/upload?${q({ path: dir })}`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
    if (!res.ok) throw new Error((await res.json())?.error?.message ?? res.statusText)
    return (await res.json()) as FileEntry
  },
  downloadUrl: (path: string) => `${API_BASE}/files/download?${q({ path })}`,
}

/** 「附回聊天」事件：聊天模組監聽 `studio:attach`，detail = {path, uri, name} */
export function dispatchAttach(detail: { path: string; uri: string; name: string }) {
  window.dispatchEvent(new CustomEvent('studio:attach', { detail }))
}
