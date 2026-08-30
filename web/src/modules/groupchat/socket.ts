// /ws/groupchat 連線：join 房間、送訊息、收 message.new / ai.* / summary.* 事件。
import { useCallback, useEffect, useRef, useState } from 'react'
import { groupchatWsUrl, type RoomMessage, type RoomSummary } from './api'

let WebSocketImpl: typeof WebSocket = typeof WebSocket !== 'undefined' ? WebSocket : (undefined as unknown as typeof WebSocket)
export function setGroupchatWebSocketImpl(impl: typeof WebSocket) {
  WebSocketImpl = impl
}

export type GcEvent =
  | { type: 'ready'; member_id: string }
  | { type: 'joined'; room_id: string; member: { id: string; display_name: string } }
  | { type: 'left'; room_id: string }
  | { type: 'message.new'; room_id: string; message: RoomMessage }
  | { type: 'ai.typing'; room_id: string; member_id: string; name: string; trigger_id: string }
  | { type: 'ai.started'; room_id: string; member_id: string; run_id: string }
  | { type: 'ai.delta'; room_id: string; member_id: string; run_id: string; delta: string }
  | { type: 'ai.tool'; room_id: string; member_id: string; run_id: string; tool?: string }
  | { type: 'ai.done'; room_id: string; member_id: string; run_id: string }
  | { type: 'ai.failed'; room_id: string; member_id: string; run_id?: string; error: string; message: RoomMessage }
  | { type: 'human.typing'; room_id: string; member_id: string; name: string }
  | { type: 'summary.started'; room_id: string; member_id: string }
  | { type: 'summary.updated'; room_id: string; summary: RoomSummary }
  | { type: 'summary.failed'; room_id: string; error: string }
  | { type: 'error'; code: string; message: string; room_id?: string }
  | { type: 'pong' }

export type GcStatus = 'connecting' | 'open' | 'closed'

export function useGroupchatSocket(roomId: string | undefined, onEvent: (ev: GcEvent) => void, enabled = true) {
  const [status, setStatus] = useState<GcStatus>('closed')
  const wsRef = useRef<WebSocket | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const retry = useRef(0)
  const closedByUs = useRef(false)
  const joinedRoom = useRef<string | undefined>(undefined)

  const sendRaw = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload))
      return true
    }
    return false
  }, [])

  useEffect(() => {
    if (!enabled) return
    closedByUs.current = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      setStatus('connecting')
      const ws = new WebSocketImpl(groupchatWsUrl())
      wsRef.current = ws
      ws.onopen = () => {
        retry.current = 0
        setStatus('open')
        if (joinedRoom.current) ws.send(JSON.stringify({ type: 'join', room_id: joinedRoom.current }))
      }
      ws.onmessage = (e) => {
        try {
          onEventRef.current(JSON.parse(e.data) as GcEvent)
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        setStatus('closed')
        if (closedByUs.current) return
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry.current++))
      }
      ws.onerror = () => undefined
    }
    connect()
    return () => {
      closedByUs.current = true
      if (timer) clearTimeout(timer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled])

  // 切房間：leave 舊、join 新
  useEffect(() => {
    const prev = joinedRoom.current
    if (prev && prev !== roomId) sendRaw({ type: 'leave', room_id: prev })
    joinedRoom.current = roomId
    if (roomId) sendRaw({ type: 'join', room_id: roomId })
  }, [roomId, status, sendRaw])

  const sendMessage = useCallback((content: string) => sendRaw({ type: 'message', room_id: joinedRoom.current, content }), [sendRaw])
  const typing = useCallback(() => sendRaw({ type: 'typing', room_id: joinedRoom.current }), [sendRaw])
  return { status, sendMessage, typing }
}
