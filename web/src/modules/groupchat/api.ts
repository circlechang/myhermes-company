import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getToken, request } from '../../api/client'

export type Policy = 'none' | 'round_robin' | 'host'

export interface RoomMember {
  id: string
  room_id: string
  kind: 'human' | 'ai'
  member_id?: string | null
  agent_id?: string | null
  display_name: string
  profile: string
  model: string
  system_prompt: string
  joined_at: string
}
export interface RoomMessage {
  id: string
  room_id: string
  seq: number
  sender_id?: string | null
  sender_name: string
  sender_kind: 'human' | 'ai' | 'system'
  content: string
  depth: number
  run_id?: string | null
  status: 'done' | 'failed'
  created_at: string
}
export interface RoomSummary {
  id: string
  room_id: string
  content: string
  covers_until_seq: number
  made_by: string
  created_at: string
}
export interface Room {
  id: string
  name: string
  invite_code: string
  no_mention_policy: Policy
  host_member_id?: string | null
  summarizer_member_id?: string | null
  history_n: number
  compress_threshold_tokens: number
  max_ai_depth: number
  created_by: string
  created_at: string
  updated_at: string
  members: RoomMember[]
  last_message?: RoomMessage | null
  message_count: number
}
export interface ContextStats {
  messages_since_summary: number
  estimated_tokens: number
  threshold: number
  history_n: number
  summary: RoomSummary | null
}

const json = (b: unknown) => JSON.stringify(b)
export const gcApi = {
  rooms: () => request<Room[]>('/groupchat/rooms'),
  room: (id: string) => request<Room>(`/groupchat/rooms/${id}`),
  create: (body: { name: string; no_mention_policy?: Policy; agent_ids?: string[]; history_n?: number; compress_threshold_tokens?: number; max_ai_depth?: number }) =>
    request<Room>('/groupchat/rooms', { method: 'POST', body: json(body) }),
  patch: (id: string, body: Partial<Pick<Room, 'name' | 'no_mention_policy' | 'host_member_id' | 'summarizer_member_id' | 'history_n' | 'compress_threshold_tokens' | 'max_ai_depth'>>) =>
    request<Room>(`/groupchat/rooms/${id}`, { method: 'PATCH', body: json(body) }),
  remove: (id: string) => request<void>(`/groupchat/rooms/${id}`, { method: 'DELETE' }),
  join: (invite_code: string) => request<Room>('/groupchat/rooms/join', { method: 'POST', body: json({ invite_code }) }),
  regenInvite: (id: string) => request<{ invite_code: string }>(`/groupchat/rooms/${id}/invite/regenerate`, { method: 'POST' }),
  addMember: (id: string, body: { agent_id?: string; member_id?: string; display_name?: string; model?: string; system_prompt?: string }) =>
    request<RoomMember>(`/groupchat/rooms/${id}/members`, { method: 'POST', body: json(body) }),
  patchMember: (id: string, rm: string, body: Partial<Pick<RoomMember, 'display_name' | 'model' | 'system_prompt' | 'agent_id'>>) =>
    request<RoomMember>(`/groupchat/rooms/${id}/members/${rm}`, { method: 'PATCH', body: json(body) }),
  removeMember: (id: string, rm: string) => request<void>(`/groupchat/rooms/${id}/members/${rm}`, { method: 'DELETE' }),
  messages: (id: string, beforeSeq?: number) =>
    request<RoomMessage[]>(`/groupchat/rooms/${id}/messages${beforeSeq ? `?before_seq=${beforeSeq}` : ''}`),
  send: (id: string, content: string) => request<RoomMessage>(`/groupchat/rooms/${id}/messages`, { method: 'POST', body: json({ content }) }),
  context: (id: string) => request<ContextStats>(`/groupchat/rooms/${id}/context`),
  compress: (id: string) => request<RoomSummary>(`/groupchat/rooms/${id}/compress`, { method: 'POST' }),
}

export const gk = {
  rooms: ['groupchat', 'room-list'] as const,  // 不與 room(id) 前綴重疊，避免 invalidate 連帶清掉訊息快取
  room: (id: string) => ['groupchat', 'rooms', id] as const,
  messages: (id: string) => ['groupchat', 'rooms', id, 'messages'] as const,
  context: (id: string) => ['groupchat', 'rooms', id, 'context'] as const,
}
export const useRooms = () => useQuery({ queryKey: gk.rooms, queryFn: gcApi.rooms })
export const useRoom = (id?: string) => useQuery({ queryKey: gk.room(id ?? ''), queryFn: () => gcApi.room(id!), enabled: !!id })
export const useRoomMessages = (id?: string) => useQuery({ queryKey: gk.messages(id ?? ''), queryFn: () => gcApi.messages(id!), enabled: !!id })
export const useRoomContext = (id?: string) =>
  useQuery({ queryKey: gk.context(id ?? ''), queryFn: () => gcApi.context(id!), enabled: !!id, refetchInterval: 15_000 })

export function useRoomMutations(roomId?: string) {
  const qc = useQueryClient()
  const inv = () => {
    qc.invalidateQueries({ queryKey: gk.rooms })
    if (roomId) qc.invalidateQueries({ queryKey: gk.room(roomId) })
  }
  return {
    create: useMutation({ mutationFn: gcApi.create, onSuccess: inv }),
    join: useMutation({ mutationFn: gcApi.join, onSuccess: inv }),
    patch: useMutation({ mutationFn: (b: Parameters<typeof gcApi.patch>[1]) => gcApi.patch(roomId!, b), onSuccess: inv }),
    remove: useMutation({ mutationFn: (id: string) => gcApi.remove(id), onSuccess: inv }),
    regen: useMutation({ mutationFn: () => gcApi.regenInvite(roomId!), onSuccess: inv }),
    addMember: useMutation({ mutationFn: (b: Parameters<typeof gcApi.addMember>[1]) => gcApi.addMember(roomId!, b), onSuccess: inv }),
    patchMember: useMutation({ mutationFn: ({ rm, body }: { rm: string; body: Parameters<typeof gcApi.patchMember>[2] }) => gcApi.patchMember(roomId!, rm, body), onSuccess: inv }),
    removeMember: useMutation({ mutationFn: (rm: string) => gcApi.removeMember(roomId!, rm), onSuccess: inv }),
    compress: useMutation({ mutationFn: () => gcApi.compress(roomId!), onSuccess: () => roomId && qc.invalidateQueries({ queryKey: gk.context(roomId) }) }),
  }
}

export function groupchatWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/ws/groupchat?token=${encodeURIComponent(getToken() ?? '')}`
}
