// Bots 訊息介面的 API：房間（私訊＋群組）、訊息、反應、討論串、核准、停止、房間文件、搜尋、Bot CRUD、技能、例行。
import { useQuery } from '@tanstack/react-query'
import { request } from '../../api/client'

export interface Bot {
  id: string
  name: string
  title: string
  description: string
  avatar: string
  profile: string
  model: string
  enabled: boolean
  runtime: string
  dm_room_id: string
  created_at: string
  /** Hermes 現在認不認得這個設定檔；false＝技能／例行要等 Hermes 重啟，聊天會先走 default 通道 */
  served: boolean
  /** ""＝好了｜preparing＝設定檔還在背景複製｜failed＝沒建成功（setup_error 有原因） */
  setup_state: string
  setup_error: string
  /** 這個 Bot 專屬的 GitHub 身分（空＝跟系統共用同一個 gh 登入） */
  gh_dir: string
  gh_account: string
}

export interface GithubLink {
  mode: 'shared' | 'own'
  dir?: string
  bin?: string
  account?: string
  ready?: boolean
  shared_account?: string
  login_cmd?: string
  message?: string
  kept_dir?: string
}

export interface GatewayNote {
  status: string
  needs_restart: boolean
  hint?: string | null
}

export interface Member {
  id: string
  room_id: string
  kind: 'human' | 'ai'
  member_id?: string | null
  agent_id?: string | null
  display_name: string
  profile: string
}

export interface DocAttachment {
  type: 'doc'
  doc_id: string
  title: string
  version: number
  summary: string
  action: 'created' | 'updated' | 'edited' | 'same'
  author: string
  author_rm_id: string
  diff_stat: { added: number; removed: number }
}
export interface ApprovalAttachment {
  type: 'approval'
  run_id: string
  approval_id: string
  command: string
  description: string
  tool: string
  choices: string[]
  status: 'pending' | 'once' | 'always' | 'deny' | 'session'
  decided_by?: string
}
export interface ToolItem {
  tool: string
  preview: string
  status: 'running' | 'done' | 'error'
  duration?: number
}
export interface ToolsAttachment {
  type: 'tools'
  items: ToolItem[]
}
export interface HandoffAttachment {
  type: 'handoff'
  to: { id: string; name: string; agent_id?: string | null }[]
}
export type Attachment = DocAttachment | ApprovalAttachment | ToolsAttachment | HandoffAttachment

export interface Reaction {
  emoji: string
  count: number
  mine: boolean
  names: string[]
}

export interface Msg {
  id: string
  room_id: string
  seq: number
  sender_id?: string | null
  sender_name: string
  sender_kind: 'human' | 'ai' | 'system'
  content: string
  depth: number
  run_id?: string | null
  status: 'done' | 'failed' | 'stopped'
  created_at: string
  reply_to_id: string
  thread_root_id: string
  doc_id: string
  attachments: Attachment[]
  reply_to?: { id: string; sender_name: string; content: string; has_doc: boolean } | null
  reply_count?: number
  thread_last_at?: string | null
  thread_participants?: string[]
  reactions?: Reaction[]
}

export interface Room {
  id: string
  name: string
  kind: 'group' | 'dm'
  dm_agent_id: string
  avatar: string
  no_mention_policy: string
  host_member_id?: string | null
  created_by: string
  created_at: string
  updated_at: string
  members: Member[]
  last_message?: Msg | null
  message_count: number
  unread?: number
  last_read_seq?: number
  pinned?: boolean
  hidden?: boolean
}

export interface RoomDoc {
  doc_id: string
  title: string
  format: string
  version: number
  summary: string
  author_kind: string
  author_id: string
  updated_at: string
  first_message_id: string
  last_message_id: string
}

export interface SearchResult {
  rooms: { id: string; name: string; kind: string; dm_agent_id: string }[]
  messages: { id: string; room_id: string; room_name: string; sender_name: string; content: string; thread_root_id: string; created_at: string }[]
  docs: { doc_id: string; title: string; room_id: string; room_name: string; message_id: string }[]
}

export interface Skill { name: string; enabled: boolean; description: string; category: string }
export interface CronJob {
  id: string
  name: string
  schedule_display?: string
  paused: boolean
  prompt?: string
  next_run_at?: string | null
  last_run_at?: string | null
}

const json = (b: unknown) => JSON.stringify(b)
const G = '/groupchat'

export const botsApi = {
  rooms: () => request<Room[]>(`${G}/rooms?view=messenger`),
  room: (id: string) => request<Room>(`${G}/rooms/${id}`),
  messages: (id: string) => request<Msg[]>(`${G}/rooms/${id}/messages?scope=main&limit=200`),
  thread: (id: string, root: string) => request<Msg[]>(`${G}/rooms/${id}/messages?scope=thread&thread=${encodeURIComponent(root)}&limit=300`),
  send: (id: string, body: { content: string; reply_to_id?: string; thread_root_id?: string; doc_id?: string }) =>
    request<Msg>(`${G}/rooms/${id}/messages`, { method: 'POST', body: json(body) }),
  read: (id: string, seq?: number) => request<{ last_read_seq: number }>(`${G}/rooms/${id}/read`, { method: 'POST', body: json(seq ? { seq } : {}) }),
  prefs: (id: string, body: { pinned?: boolean; hidden?: boolean }) => request<Room>(`${G}/rooms/${id}/prefs`, { method: 'PATCH', body: json(body) }),
  react: (id: string, mid: string, emoji: string) =>
    request<{ message_id: string; reactions: Reaction[] }>(`${G}/rooms/${id}/messages/${mid}/reactions`, { method: 'POST', body: json({ emoji }) }),
  stop: (id: string) => request<{ stopped: number }>(`${G}/rooms/${id}/stop`, { method: 'POST' }),
  approve: (id: string, mid: string, choice: 'once' | 'always' | 'deny') =>
    request<Msg>(`${G}/rooms/${id}/messages/${mid}/approval`, { method: 'POST', body: json({ choice }) }),
  roomDocs: (id: string) => request<RoomDoc[]>(`${G}/rooms/${id}/docs`),
  editDoc: (id: string, docId: string, content: string, summary = '') =>
    request<{ same: boolean; version: number }>(`${G}/rooms/${id}/docs/${docId}/versions`, { method: 'POST', body: json({ content, summary }) }),
  search: (q: string) => request<SearchResult>(`${G}/search?q=${encodeURIComponent(q)}`),
  createGroup: (name: string, agent_ids: string[]) =>
    request<Room>(`${G}/rooms`, { method: 'POST', body: json({ name, agent_ids, no_mention_policy: 'auto', max_ai_depth: 4 }) }),
  patchRoom: (id: string, body: { name?: string }) => request<Room>(`${G}/rooms/${id}`, { method: 'PATCH', body: json(body) }),
  deleteRoom: (id: string) => request<void>(`${G}/rooms/${id}`, { method: 'DELETE' }),
  addMember: (id: string, agent_id: string) => request<Member>(`${G}/rooms/${id}/members`, { method: 'POST', body: json({ agent_id }) }),
  removeMember: (id: string, rm: string) => request<void>(`${G}/rooms/${id}/members/${rm}`, { method: 'DELETE' }),
  bots: () => request<Bot[]>(`${G}/bots`),
  openDm: (agent_id: string) => request<Room>(`${G}/dm`, { method: 'POST', body: json({ agent_id }) }),
  createBot: (body: { name: string; title?: string; description?: string; avatar?: string }) =>
    request<{ bot: Bot; room: Room; gateway?: GatewayNote }>(`${G}/bots`, { method: 'POST', body: json(body) }),
  patchBot: (id: string, body: Partial<Pick<Bot, 'name' | 'title' | 'description' | 'avatar'>>) =>
    request<Bot>(`${G}/bots/${id}`, { method: 'PATCH', body: json(body) }),
  duplicateBot: (id: string) => request<{ bot: Bot; room: Room; gateway?: GatewayNote }>(`${G}/bots/${id}/duplicate`, { method: 'POST' }),
  deleteBot: (id: string) => request<void>(`${G}/bots/${id}`, { method: 'DELETE' }),
  retrySetup: (id: string) => request<Bot>(`${G}/bots/${id}/retry-setup`, { method: 'POST' }),
  github: (id: string) => request<GithubLink>(`${G}/bots/${id}/github`),
  githubSetup: (id: string) => request<GithubLink>(`${G}/bots/${id}/github`, { method: 'POST' }),
  githubCheck: (id: string) => request<GithubLink>(`${G}/bots/${id}/github/check`, { method: 'POST' }),
  githubUnlink: (id: string) => request<GithubLink>(`${G}/bots/${id}/github`, { method: 'DELETE' }),
  skills: (agentId: string) => request<Skill[]>(`/agents/${agentId}/skills`),
  jobs: (profile: string) => request<{ jobs: CronJob[] }>(`/cron/jobs?profile=${encodeURIComponent(profile)}`),
  pauseJob: (profile: string, id: string, paused: boolean) =>
    request<unknown>(`/cron/jobs/${id}/${paused ? 'pause' : 'resume'}?profile=${encodeURIComponent(profile)}`, { method: 'POST' }),
  deleteJob: (profile: string, id: string) => request<unknown>(`/cron/jobs/${id}?profile=${encodeURIComponent(profile)}`, { method: 'DELETE' }),
  createJob: (profile: string, body: { name: string; schedule: string; prompt: string }) =>
    request<CronJob>('/cron/jobs', { method: 'POST', body: json({ ...body, profile, deliver: 'local' }) }),
}

export const bk = {
  rooms: ['bots', 'rooms'] as const,
  bots: ['bots', 'bots'] as const,
  messages: (id: string) => ['bots', 'msgs', id] as const,
  thread: (id: string, root: string) => ['bots', 'thread', id, root] as const,
  docs: (id: string) => ['bots', 'docs', id] as const,
  skills: (agentId: string) => ['bots', 'skills', agentId] as const,
  jobs: (profile: string) => ['bots', 'jobs', profile] as const,
}

export const useRooms = () => useQuery({ queryKey: bk.rooms, queryFn: botsApi.rooms, refetchInterval: 30_000 })
export const useBots = () =>
  useQuery({
    queryKey: bk.bots,
    queryFn: botsApi.bots,
    // 有 Bot 的設定檔還在背景準備時多問幾次，好了就停
    refetchInterval: (q) => (q.state.data?.some((b) => b.setup_state === 'preparing') ? 4000 : false),
  })
export const useMessages = (id?: string) =>
  useQuery({ queryKey: bk.messages(id ?? ''), queryFn: () => botsApi.messages(id!), enabled: !!id })
export const useThread = (id?: string, root?: string) =>
  useQuery({ queryKey: bk.thread(id ?? '', root ?? ''), queryFn: () => botsApi.thread(id!, root!), enabled: !!id && !!root })
export const useRoomDocs = (id?: string) => useQuery({ queryKey: bk.docs(id ?? ''), queryFn: () => botsApi.roomDocs(id!), enabled: !!id })
export const useGithubLink = (agentId?: string) =>
  useQuery({ queryKey: ['bots', 'github', agentId ?? ''], queryFn: () => botsApi.github(agentId!), enabled: !!agentId, retry: false })

export const useSkills = (agentId?: string) =>
  useQuery({ queryKey: bk.skills(agentId ?? ''), queryFn: () => botsApi.skills(agentId!), enabled: !!agentId, staleTime: 60_000, retry: false })
export const useJobs = (profile?: string) =>
  useQuery({ queryKey: bk.jobs(profile ?? ''), queryFn: () => botsApi.jobs(profile!), enabled: !!profile, retry: false })
