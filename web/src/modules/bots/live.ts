// 即時狀態：一條 /ws/groupchat 連線 join 所有房間，
// 把 message.new／message.updated／reaction.updated 直接寫進 react-query 快取，
// 把「誰正在打字、串流到哪、用什麼工具」放在一個小 store（useSyncExternalStore）。
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { groupchatWsUrl } from '../groupchat/api'
import { bk, type Msg, type Reaction, type Room, type ToolItem } from './api'

let WebSocketImpl: typeof WebSocket = typeof WebSocket !== 'undefined' ? WebSocket : (undefined as unknown as typeof WebSocket)
export function setBotsWebSocketImpl(impl: typeof WebSocket) {
  WebSocketImpl = impl
}

export interface LiveRun {
  key: string
  memberId: string
  name: string
  runId?: string
  text: string
  tools: ToolItem[]
  threadRootId: string
  startedAt: number
}
export interface RoomLive {
  runs: Record<string, LiveRun> // `${member_id}|${trigger_id}` -> run（同一個 Bot 可能同時回兩則：原本那則＋插話）
  routing: boolean
}

type State = Record<string, RoomLive>
let state: State = {}
const listeners = new Set<() => void>()
function emit() {
  for (const l of listeners) l()
}
function patchRoom(roomId: string, fn: (r: RoomLive) => RoomLive) {
  const cur = state[roomId] ?? { runs: {}, routing: false }
  state = { ...state, [roomId]: fn(cur) }
  emit()
}
export function resetLive() {
  state = {}
  emit()
}
const EMPTY: RoomLive = { runs: {}, routing: false }
export function useRoomLive(roomId?: string): RoomLive {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => (roomId ? state[roomId] ?? EMPTY : EMPTY),
  )
}
/** 側欄用：哪些房間有 Bot 正在做事 */
export function useBusyRooms(): Set<string> {
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
  const out = new Set<string>()
  for (const [k, v] of Object.entries(snap)) if (Object.keys(v.runs).length || v.routing) out.add(k)
  return out
}

// ---------------------------------------------------------------------------
// cache helpers
// ---------------------------------------------------------------------------
function upsert(list: Msg[] | undefined, m: Msg): Msg[] {
  const arr = list ? [...list] : []
  const i = arr.findIndex((x) => x.id === m.id)
  if (i >= 0) arr[i] = { ...arr[i], ...m }
  else arr.push(m)
  return arr.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.seq - b.seq))
}

// 已經算進「N 則回覆」的討論串訊息（REST 回應和 WS 廣播會各來一次，只算一次）
const countedThread = new Set<string>()

export function applyMessage(qc: QueryClient, m: Msg) {
  if (m.thread_root_id) {
    const fresh = !countedThread.has(m.id)
    if (countedThread.size > 5000) countedThread.clear()
    countedThread.add(m.id)
    qc.setQueryData<Msg[]>(bk.thread(m.room_id, m.thread_root_id), (old) => (old ? upsert(old, m) : old))
    qc.setQueryData<Msg[]>(bk.messages(m.room_id), (old) =>
      old?.map((x) =>
        x.id === m.thread_root_id
          ? {
              ...x,
              reply_count: (x.reply_count ?? 0) + (fresh ? 1 : 0),
              thread_last_at: m.created_at,
              thread_participants: Array.from(new Set([...(x.thread_participants ?? []), m.sender_name])).slice(0, 4),
            }
          : x,
      ),
    )
  } else {
    qc.setQueryData<Msg[]>(bk.messages(m.room_id), (old) => (old ? upsert(old, m) : old))
  }
  // 根訊息本身被更新（例如核准卡狀態）也要同步到討論串快取
  qc.setQueriesData<Msg[]>({ queryKey: ['bots', 'thread', m.room_id] }, (old) => (old?.some((x) => x.id === m.id) ? upsert(old, m) : old))
}

function applyReactions(qc: QueryClient, roomId: string, messageId: string, reactions: Reaction[], mine: { names: string; ids: Set<string> }) {
  const fix = (rs: Reaction[]) =>
    rs.map((r) => ({ ...r, mine: (r.rm_ids ?? []).some((id) => mine.ids.has(id)) || (!r.rm_ids && r.names.includes(mine.names)) }))
  const f = (old: Msg[] | undefined) => old?.map((x) => (x.id === messageId ? { ...x, reactions: fix(reactions) } : x))
  qc.setQueryData<Msg[]>(bk.messages(roomId), f)
  qc.setQueriesData<Msg[]>({ queryKey: ['bots', 'thread', roomId] }, f)
}

// ---------------------------------------------------------------------------
// socket
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ev = Record<string, any>

export function useMessengerSocket(roomIds: string[], opts: { activeRoomId?: string; myName: string; myRmIds?: Set<string>; onRead?: (roomId: string, seq: number) => void; onBotMessage?: (m: Msg) => void }) {
  const qc = useQueryClient()
  const wsRef = useRef<WebSocket | null>(null)
  const joined = useRef<Set<string>>(new Set())
  const optsRef = useRef(opts)
  optsRef.current = opts
  const key = [...roomIds].sort().join(',')

  useEffect(() => {
    let closed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      const ws = new WebSocketImpl(groupchatWsUrl())
      wsRef.current = ws
      ws.onopen = () => {
        const reconnected = retry > 0 || joined.current.size > 0
        retry = 0
        joined.current = new Set()
        for (const id of key ? key.split(',') : []) {
          ws.send(JSON.stringify({ type: 'join', room_id: id }))
          joined.current.add(id)
        }
        // 斷線期間漏掉的訊息不會補推：重連後重抓一次（不然訊息列表會有洞）
        if (reconnected) {
          qc.invalidateQueries({ queryKey: bk.rooms })
          qc.invalidateQueries({ queryKey: ['bots', 'msgs'] })
          qc.invalidateQueries({ queryKey: ['bots', 'thread'] })
        }
      }
      ws.onmessage = (e) => {
        let ev: Ev
        try {
          ev = JSON.parse(e.data)
        } catch {
          return
        }
        handle(ev)
      }
      ws.onclose = () => {
        if (closed) return
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++))
      }
      ws.onerror = () => undefined
    }
    const runKey = (ev: Ev) => `${ev.member_id}|${ev.trigger_id ?? ''}`
    const dropRuns = (rid: string, memberId: string, runId?: string | null) =>
      patchRoom(rid, (r) => {
        const runs = { ...r.runs }
        for (const [k, v] of Object.entries(runs)) if (v.memberId === memberId && v.runId === runId) delete runs[k]
        return { ...r, runs }
      })
    const patchRun = (rid: string, ev: Ev, fn: (cur: LiveRun) => LiveRun) =>
      patchRoom(rid, (r) => {
        const k = runKey(ev)
        const cur = r.runs[k] ?? Object.values(r.runs).find((x) => x.memberId === ev.member_id && x.runId === ev.run_id)
        if (!cur) return r
        return { ...r, runs: { ...r.runs, [cur.key]: fn(cur) } }
      })
    const handle = (ev: Ev) => {
      const rid: string = ev.room_id
      switch (ev.type) {
        case 'message.new': {
          const m = ev.message as Msg
          applyMessage(qc, m)
          if (m.sender_kind === 'ai' && m.sender_id && m.run_id) dropRuns(rid, m.sender_id, m.run_id)
          qc.setQueryData<Room[]>(bk.rooms, (old) =>
            old?.map((r) =>
              r.id === rid
                ? {
                    ...r,
                    updated_at: m.created_at,
                    last_message: m.thread_root_id ? r.last_message : m,
                    unread:
                      optsRef.current.activeRoomId === rid || m.sender_kind === 'human' || m.thread_root_id
                        ? r.unread ?? 0
                        : (r.unread ?? 0) + 1,
                  }
                : r,
            ),
          )
          if (optsRef.current.activeRoomId === rid && !m.thread_root_id) optsRef.current.onRead?.(rid, m.seq)
          if (m.sender_kind === 'ai') optsRef.current.onBotMessage?.(m)
          break
        }
        case 'message.updated':
          applyMessage(qc, ev.message as Msg)
          break
        case 'reaction.updated':
          applyReactions(qc, rid, ev.message_id, ev.reactions as Reaction[], { names: optsRef.current.myName, ids: optsRef.current.myRmIds ?? new Set<string>() })
          break
        case 'ai.typing': {
          const k = runKey(ev)
          patchRoom(rid, (r) => ({
            ...r,
            runs: { ...r.runs, [k]: { key: k, memberId: ev.member_id, name: ev.name, text: '', tools: [], threadRootId: ev.thread_root_id ?? '', startedAt: Date.now() } },
          }))
          break
        }
        case 'ai.started':
          patchRun(rid, ev, (cur) => ({ ...cur, runId: ev.run_id }))
          break
        case 'ai.delta':
          patchRun(rid, ev, (cur) => ({ ...cur, text: cur.text + (ev.delta ?? '') }))
          break
        case 'ai.tool':
          patchRun(rid, ev, (cur) => ({ ...cur, tools: [...cur.tools, { tool: ev.tool ?? 'tool', preview: ev.preview ?? '', status: 'running' }] }))
          break
        case 'ai.tool_done':
          patchRun(rid, ev, (cur) => {
            const tools = [...cur.tools]
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].status === 'running') {
                tools[i] = { ...tools[i], status: ev.error ? 'error' : 'done' }
                break
              }
            }
            return { ...cur, tools }
          })
          break
        case 'ai.failed':
        case 'ai.stopped': {
          const m = ev.message as Msg | null
          if (m) applyMessage(qc, m)
          patchRoom(rid, (r) => {
            const runs = { ...r.runs }
            delete runs[runKey(ev)]
            for (const [k, v] of Object.entries(runs)) if (v.memberId === ev.member_id && v.runId && v.runId === ev.run_id) delete runs[k]
            return { ...r, runs }
          })
          if (optsRef.current.activeRoomId === rid && m && !m.thread_root_id) optsRef.current.onRead?.(rid, m.seq)
          qc.invalidateQueries({ queryKey: bk.rooms })
          break
        }
        case 'route.started':
          patchRoom(rid, (r) => ({ ...r, routing: true }))
          break
        case 'route.done':
          patchRoom(rid, (r) => ({ ...r, routing: false }))
          break
        case 'room.stopped':
          patchRoom(rid, (r) => ({ ...r, routing: false }))
          break
        case 'docs.changed':
          qc.invalidateQueries({ queryKey: bk.docs(rid) })
          for (const d of (ev.doc_ids as string[]) ?? []) qc.invalidateQueries({ queryKey: ['docs'] , predicate: (q) => JSON.stringify(q.queryKey).includes(d) })
          break
        default:
          break
      }
    }
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      wsRef.current?.close()
      wsRef.current = null
    }
    // 房間清單變了才重連（新群組、新私訊）
  }, [key, qc])
}
