import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../App'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { renderApp, setupMocks } from '../../test/utils'
import type { Room, RoomMessage } from './api'
import { setGroupchatWebSocketImpl } from './socket'
import { setEngineerMode } from '../../prefs/engineerMode'
import { bossCopyViolations } from '../../test/bossCopy'
import { GroupChatPage } from './GroupChatPage'

// ---- 假 /groupchat REST ----
let rooms: Room[] = []
let msgs: Record<string, RoomMessage[]> = {}
let seq = 0
const okJ = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
function mkRoom(name: string, ai: string[]): Room {
  const id = `room_${++seq}`
  return {
    id, name, invite_code: 'ABCD1234', no_mention_policy: 'none', history_n: 20, compress_threshold_tokens: 6000, max_ai_depth: 3,
    created_by: 'm1', created_at: '2026-08-29T00:00:00', updated_at: '2026-08-29T00:00:00', message_count: 0,
    members: [
      { id: `rm_h_${id}`, room_id: id, kind: 'human', member_id: 'm1', display_name: 'admin', profile: '', model: '', system_prompt: '', joined_at: '' },
      ...ai.map((n) => ({ id: `rm_${n}_${id}`, room_id: id, kind: 'ai' as const, agent_id: `a-${n}`, display_name: n, profile: n, model: '', system_prompt: '', joined_at: '' })),
    ],
  }
}
async function gcFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const u = new URL(url, 'http://localhost')
  const path = decodeURIComponent(u.pathname).replace(/^\/api/, '')
  const method = (init.method ?? 'GET').toUpperCase()
  const body = init.body ? JSON.parse(String(init.body)) : {}
  let m: RegExpMatchArray | null
  if (path === '/groupchat/rooms' && method === 'GET') return okJ(rooms)
  if (path === '/groupchat/rooms' && method === 'POST') {
    const r = mkRoom(body.name, (body.agent_ids ?? []).map((id: string) => (id === 'a2' ? '研究員' : '小編')))
    r.no_mention_policy = body.no_mention_policy ?? 'none'
    rooms.push(r)
    msgs[r.id] = []
    return okJ(r, 201)
  }
  if (path === '/groupchat/rooms/join') {
    const r = rooms.find((x) => x.invite_code === body.invite_code.toUpperCase())
    return r ? okJ(r) : okJ({ error: { code: 'not_found', message: 'invite code not found' } }, 404)
  }
  if ((m = path.match(/^\/groupchat\/rooms\/([^/]+)$/)) && method === 'GET') return okJ(rooms.find((x) => x.id === m![1]))
  if ((m = path.match(/^\/groupchat\/rooms\/([^/]+)$/)) && method === 'DELETE') { rooms = rooms.filter((x) => x.id !== m![1]); return new Response(null, { status: 204 }) }
  if ((m = path.match(/^\/groupchat\/rooms\/([^/]+)$/)) && method === 'PATCH') { const r = rooms.find((x) => x.id === m![1])!; Object.assign(r, body); return okJ(r) }
  if ((m = path.match(/^\/groupchat\/rooms\/([^/]+)\/messages$/))) return okJ(msgs[m[1]] ?? [])
  if ((m = path.match(/^\/groupchat\/rooms\/([^/]+)\/context$/))) return okJ({ messages_since_summary: msgs[m[1]]?.length ?? 0, estimated_tokens: 12, threshold: 6000, history_n: 20, summary: null })
  if ((m = path.match(/^\/groupchat\/rooms\/([^/]+)\/members$/)) && method === 'POST') {
    const r = rooms.find((x) => x.id === m![1])!
    const mem = { id: `rm_new`, room_id: r.id, kind: 'ai' as const, agent_id: body.agent_id, display_name: body.agent_id === 'a2' ? '研究員' : '小編', profile: 'x', model: '', system_prompt: '', joined_at: '' }
    r.members.push(mem)
    return okJ(mem, 201)
  }
  if ((m = path.match(/^\/groupchat\/rooms\/([^/]+)\/members\/([^/]+)$/)) && method === 'PATCH') {
    const r = rooms.find((x) => x.id === m![1])!
    const mem = r.members.find((x) => x.id === m![2])!
    Object.assign(mem, body)
    return okJ(mem)
  }
  if (path.startsWith('/groupchat')) return okJ({ error: { code: 'not_found', message: path } }, 404)
  return mockFetch(input, init)
}

// ---- 假 WS ----
class FakeWs {
  static last: FakeWs | null = null
  static OPEN = 1
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  constructor(public url: string) {
    FakeWs.last = this
    setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open')) }, 0)
  }
  send(data: string) {
    const msg = JSON.parse(data)
    this.sent.push(msg)
    if (msg.type === 'join') this.emit({ type: 'joined', room_id: msg.room_id, member: { id: 'rm_h', display_name: 'admin' } })
  }
  close() { this.readyState = 3; this.onclose?.(new CloseEvent('close')) }
  emit(obj: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(obj) })) }
}

describe('群聊（modules/groupchat）', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    setFetchImpl(gcFetch as typeof fetch)
    setGroupchatWebSocketImpl(FakeWs as unknown as typeof WebSocket)
    rooms = []; msgs = {}; seq = 0; FakeWs.last = null
  })

  it('建房間（選 AI、策略）→ 進房 → WS join → 送訊息 → 收 AI 進度與回覆', async () => {
    renderApp(<App />, { route: '/groupchat' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /新房間/ }))
    await user.type(screen.getByLabelText('房間名稱'), '策略會')
    await user.selectOptions(screen.getByLabelText('無 @ 時'), 'round_robin')
    await user.click(await screen.findByLabelText(/研究員/))
    await user.click(screen.getByRole('button', { name: '建立' }))
    // 進房：成員籤、策略標籤、連線狀態
    expect(await screen.findByText('🤖 研究員')).toBeInTheDocument()
    expect(screen.getByText('輪流回覆')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('ws-status')).toHaveTextContent('已連線'))
    const ws = FakeWs.last!
    await waitFor(() => expect(ws.sent.some((s) => s.type === 'join' && s.room_id === 'room_1')).toBe(true))

    // @ 自動完成
    const input = screen.getByLabelText('訊息')
    await user.type(input, '@研')
    const menu = await screen.findByTestId('mention-menu')
    expect(within(menu).getByText(/研究員/)).toBeInTheDocument()
    await user.keyboard('{Tab}')
    expect((input as HTMLTextAreaElement).value).toBe('@研究員 ')
    await user.type(input, '幫我查{Enter}')
    expect(ws.sent.at(-1)).toEqual({ type: 'message', room_id: 'room_1', content: '@研究員 幫我查' })
    expect((input as HTMLTextAreaElement).value).toBe('')

    // 伺服器回：message.new（人類）→ ai.typing → ai.delta → message.new（AI）
    const human: RoomMessage = { id: 'rmsg_1', room_id: 'room_1', seq: 1, sender_id: 'rm_h', sender_name: 'admin', sender_kind: 'human', content: '@研究員 幫我查', depth: 0, status: 'done', created_at: '2026-08-29T01:00:00' }
    act(() => ws.emit({ type: 'message.new', room_id: 'room_1', message: human }))
    expect(await screen.findByTestId('msg-human')).toHaveTextContent('幫我查')
    act(() => ws.emit({ type: 'ai.typing', room_id: 'room_1', member_id: 'rm_研究員_room_1', name: '研究員', trigger_id: 'rmsg_1' }))
    expect(await screen.findByTestId('live-draft')).toHaveTextContent('思考中')
    act(() => ws.emit({ type: 'ai.started', room_id: 'room_1', member_id: 'rm_研究員_room_1', run_id: 'run_1' }))
    act(() => ws.emit({ type: 'ai.delta', room_id: 'room_1', member_id: 'rm_研究員_room_1', run_id: 'run_1', delta: '查到' }))
    act(() => ws.emit({ type: 'ai.delta', room_id: 'room_1', member_id: 'rm_研究員_room_1', run_id: 'run_1', delta: '了' }))
    expect(screen.getByTestId('live-draft')).toHaveTextContent('回覆中')
    expect(screen.getByTestId('live-draft')).toHaveTextContent('查到了')
    const ai: RoomMessage = { ...human, id: 'rmsg_2', seq: 2, sender_id: 'rm_研究員_room_1', sender_name: '研究員', sender_kind: 'ai', content: '查到了 **重點**', depth: 1 }
    act(() => ws.emit({ type: 'ai.done', room_id: 'room_1', member_id: 'rm_研究員_room_1', run_id: 'run_1' }))
    act(() => ws.emit({ type: 'message.new', room_id: 'room_1', message: ai }))
    const aiRow = await screen.findByTestId('msg-ai')
    expect(within(aiRow).getByText('重點')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('live-draft')).not.toBeInTheDocument())
    // 每則訊息有朗讀鈕
    expect(within(aiRow).getByTestId('speak-button')).toBeInTheDocument()
    // 其他房間的事件不會混進來
    act(() => ws.emit({ type: 'message.new', room_id: 'room_other', message: { ...ai, id: 'rmsg_9', content: '別房的' } }))
    expect(screen.queryByText('別房的')).not.toBeInTheDocument()
  })

  it('邀請碼加入、設定面板：加 AI 員工、編輯角色提示、上下文狀態', async () => {
    const r = mkRoom('既有房', ['小編'])
    rooms.push(r); msgs[r.id] = []
    renderApp(<App />, { route: '/groupchat' })
    const user = userEvent.setup()
    // 邀請碼預設收起，先點「有邀請碼？」
    await user.click(await screen.findByTestId('have-invite'))
    await user.type(await screen.findByLabelText('邀請碼'), 'abcd1234')
    await user.click(screen.getByRole('button', { name: '加入' }))
    expect(await screen.findByText('🤖 小編')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '房間設定' }))
    const panel = await screen.findByTestId('room-settings')
    expect(within(panel).getByTestId('invite-code')).toHaveTextContent('ABCD1234')
    expect(await within(panel).findByTestId('context-stats')).toHaveTextContent('摘要後累積 0 則')
    await user.selectOptions(within(panel).getByLabelText('加入 AI 員工…'), 'a2')
    await user.click(within(panel).getByRole('button', { name: '加入' }))
    expect(await within(within(panel).getByTestId('member-list')).findByText(/研究員/)).toBeInTheDocument()
    await user.click(within(panel).getAllByRole('button', { name: '編輯' })[0])
    const editor = await screen.findByTestId('member-editor')
    await user.type(within(editor).getByLabelText('角色提示'), '你是文案')
    await user.click(within(editor).getByRole('button', { name: '儲存' }))
    await waitFor(() => expect(r.members.find((x) => x.display_name === '小編')?.system_prompt).toBe('你是文案'))
    // 錯誤邀請碼
    const list = within(screen.getByTestId('room-list'))
    await user.type(list.getByLabelText('邀請碼'), 'NOPE')
    await user.click(list.getByRole('button', { name: '加入' }))
    expect(await screen.findByText(/invite code not found/)).toBeInTheDocument()
  })

  it('老闆模式：清單先是「＋ 新房間」、邀請碼收在「有邀請碼？」後面、空狀態一句話＋按鈕、沒有系統詞', async () => {
    setEngineerMode(false)
    renderApp(<GroupChatPage />, { route: '/groupchat' })
    const user = userEvent.setup()
    const list = within(await screen.findByTestId('room-list'))
    const newRoom = list.getByRole('button', { name: '＋ 新房間' })
    const haveInvite = list.getByTestId('have-invite')
    // 「＋ 新房間」在邀請碼入口前面；邀請碼輸入框預設不出現
    expect(newRoom.compareDocumentPosition(haveInvite) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(list.queryByLabelText('邀請碼')).not.toBeInTheDocument()
    const empty = within(await screen.findByTestId('empty-rooms-main'))
    expect(empty.getByText('開一個房間，把兩位以上員工拉進來一起討論。')).toBeInTheDocument()
    expect(bossCopyViolations()).toEqual([])
    await user.click(empty.getByRole('button', { name: /開一個房間/ }))
    expect(await screen.findByTestId('create-room-form')).toBeInTheDocument()
    await user.click(list.getByTestId('have-invite'))
    expect(await list.findByLabelText('邀請碼')).toBeInTheDocument()
  })
})
