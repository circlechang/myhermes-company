import { request, getToken, API_BASE } from '../../api/client'

export interface ProfileInfo {
  name: string
  display_name: string
  model: string
  provider: string
  gateway: string
  is_default: boolean
  description: string
  path: string
  has_soul: boolean
  has_env: boolean
  skills: number
}
export interface ProfileList { profiles: ProfileInfo[]; active: string; restricted: boolean }
export interface MemberWithProfiles { id: string; username: string; role: string; profiles: string[]; all_profiles: boolean }

const json = (b: unknown) => JSON.stringify(b)

export const profilesApi = {
  list: () => request<ProfileList>('/profiles'),
  create: (body: { name: string; clone_from?: string; description?: string }) => request<ProfileInfo>('/profiles', { method: 'POST', body: json(body) }),
  clone: (name: string, new_name: string) => request<ProfileInfo>(`/profiles/${encodeURIComponent(name)}/clone`, { method: 'POST', body: json({ new_name }) }),
  rename: (name: string, new_name: string) => request<ProfileInfo>(`/profiles/${encodeURIComponent(name)}/rename`, { method: 'POST', body: json({ new_name }) }),
  remove: (name: string) => request<{ ok: boolean }>(`/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  use: (name: string) => request<{ ok: boolean; active: string }>(`/profiles/${encodeURIComponent(name)}/use`, { method: 'POST' }),
  config: (name: string) => request<{ path: string; config: Record<string, unknown> }>(`/profiles/${encodeURIComponent(name)}/config`),
  configRaw: (name: string) => request<{ path: string; text: string }>(`/profiles/${encodeURIComponent(name)}/config?raw=1`),
  saveConfig: (name: string, body: { set?: Record<string, unknown>; patch?: Record<string, unknown>; unset?: string[]; text?: string }) =>
    request<{ ok: boolean; config: Record<string, unknown> }>(`/profiles/${encodeURIComponent(name)}/config`, { method: 'PUT', body: json(body) }),
  members: () => request<MemberWithProfiles[]>('/profiles/assignments/members'),
  assign: (memberId: string, profiles: string[]) =>
    request<MemberWithProfiles>(`/profiles/assignments/members/${memberId}`, { method: 'PUT', body: json({ profiles }) }),
  exportUrl: (name: string) => `${API_BASE}/profiles/${encodeURIComponent(name)}/export`,
  async download(name: string) {
    const res = await fetch(this.exportUrl(name), { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
    if (!res.ok) throw new Error(`export failed: ${res.status}`)
    const blob = await res.blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name}.tar.gz`
    a.click()
    URL.revokeObjectURL(a.href)
  },
  async import(file: File, name?: string) {
    const fd = new FormData()
    fd.append('file', file)
    if (name) fd.append('name', name)
    const res = await fetch(`${API_BASE}/profiles/import`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error?.message ?? res.statusText)
    return data as ProfileInfo
  },
}
