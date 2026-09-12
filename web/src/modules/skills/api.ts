import { request } from '../../api/client'

export interface SkillItem {
  name: string
  dir: string
  path: string
  source: 'local' | 'builtin'
  category: string
  topic: string
  description: string
  version: string
  tags: string[]
  mtime: number
  files: number
  enabled: boolean
  profile: string
  seeded?: boolean
}
export interface SkillDetail extends SkillItem {
  content: string
  frontmatter: Record<string, unknown>
  body: string
  attachments: { rel: string; size: number }[]
}
export interface Bundle {
  name: string
  file: string
  description: string
  instruction: string
  skills: string[]
  mtime: number
}
export interface MemoryFile {
  name: string
  size: number
  mtime: number
  primary: boolean
}
export interface JourneyNode {
  id: string
  label: string
  kind: 'skill' | 'memory' | 'memory_entry'
  category: string
  timestamp: number
  source?: string
  enabled?: boolean
  parent?: string
  text?: string
  path?: string
}
export interface JourneyGraph {
  profile: string
  nodes: JourneyNode[]
  edges: { source: string; target: string; kind: string }[]
  categories: { name: string; count: number }[]
  time_range: [number, number]
  stats: Record<string, number | string>
}

const json = (b: unknown) => JSON.stringify(b)
const q = (o: Record<string, string>) => new URLSearchParams(o).toString()

export const skillsApi = {
  list: (profile: string, qs = '', category = '', source = '', topic = '') =>
    request<{
      profile: string
      items: SkillItem[]
      topics: { name: string; hint: string; count: number }[]
      categories: { name: string; count: number }[]
    }>(`/skills?${q({ profile, q: qs, category, source, topic })}`),
  detail: (name: string, profile: string) => request<SkillDetail>(`/skills/${encodeURIComponent(name)}?${q({ profile })}`),
  file: (name: string, profile: string, rel: string) =>
    request<{ rel: string; binary: boolean; size: number; content: string | null }>(`/skills/${encodeURIComponent(name)}/file?${q({ profile, rel })}`),
  write: (name: string, profile: string, content: string, category = '') =>
    request<SkillItem>(`/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: json({ profile, content, category }) }),
  toggle: (name: string, profile: string, enabled: boolean) =>
    request<{ enabled: boolean }>(`/skills/${encodeURIComponent(name)}/toggle`, { method: 'POST', body: json({ profile, enabled }) }),
  note: (name: string) => request<{ content: string }>(`/skills/${encodeURIComponent(name)}/note`),
  saveNote: (name: string, content: string) => request<{ content: string }>(`/skills/${encodeURIComponent(name)}/note`, { method: 'PUT', body: json({ content }) }),
  usage: () => request<{
    counts: Record<string, number>
    last_used: Record<string, number>
    top: [string, number][]
    recent: [string, number][]
  }>('/skills/usage'),
  bundles: () => request<Bundle[]>('/skills/bundles'),
  createBundle: (b: { name: string; skills: string[]; description?: string; instruction?: string }) =>
    request<{ ok: boolean; output: string }>('/skills/bundles', { method: 'POST', body: json(b) }),
  deleteBundle: (name: string) => request<{ ok: boolean }>(`/skills/bundles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
}

export const memoryApi = {
  files: (profile: string) => request<{ profile: string; dir: string; files: MemoryFile[] }>(`/memory/files?${q({ profile })}`),
  read: (profile: string, name: string) => request<{ content: string; exists: boolean; mtime: number }>(`/memory/file?${q({ profile, name })}`),
  write: (profile: string, name: string, content: string) => request<{ size: number }>('/memory/file', { method: 'PUT', body: json({ profile, name, content }) }),
  remove: (profile: string, name: string) => request<{ ok: boolean }>(`/memory/file?${q({ profile, name })}`, { method: 'DELETE' }),
  status: (profile: string) => request<{ ok: boolean; output: string }>(`/memory/status?${q({ profile })}`),
}

export const journeyApi = {
  graph: (profile: string, entries = true) => request<JourneyGraph>(`/journey/graph?${q({ profile, entries: entries ? '1' : '0' })}`),
}

export const profilesApi = {
  list: () => request<{ profiles: { name: string }[] }>('/hermes/status').then((r) => r.profiles.map((p) => p.name)),
}
