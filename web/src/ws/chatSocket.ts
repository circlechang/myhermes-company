import { useCallback, useEffect, useRef, useState } from 'react'
import { chatWsUrl } from '../api/client'
import type { WsClientMessage, WsServerEvent } from '../api/types'

let WebSocketImpl: typeof WebSocket = typeof WebSocket !== 'undefined' ? WebSocket : (undefined as unknown as typeof WebSocket)
export function setWebSocketImpl(impl: typeof WebSocket) {
  WebSocketImpl = impl
}

export type WsStatus = 'connecting' | 'open' | 'closed'

/**
 * 單一 /ws/chat 連線；事件交給 onEvent。斷線會退避重連（最長 10s）。
 */
export function useChatSocket(onEvent: (ev: WsServerEvent) => void, enabled = true) {
  const [status, setStatus] = useState<WsStatus>('closed')
  const wsRef = useRef<WebSocket | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  const retryRef = useRef(0)
  const closedByUs = useRef(false)

  useEffect(() => {
    if (!enabled) return
    closedByUs.current = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      setStatus('connecting')
      const ws = new WebSocketImpl(chatWsUrl())
      wsRef.current = ws
      ws.onopen = () => {
        retryRef.current = 0
        setStatus('open')
      }
      ws.onmessage = (e) => {
        try {
          onEventRef.current(JSON.parse(e.data) as WsServerEvent)
        } catch {
          /* ignore malformed */
        }
      }
      ws.onclose = () => {
        setStatus('closed')
        if (closedByUs.current) return
        const wait = Math.min(10_000, 500 * 2 ** retryRef.current++)
        timer = setTimeout(connect, wait)
      }
      ws.onerror = () => {
        /* onclose 會跟著來 */
      }
    }
    connect()
    return () => {
      closedByUs.current = true
      if (timer) clearTimeout(timer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled])

  const send = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== 1) return false
    ws.send(JSON.stringify(msg))
    return true
  }, [])

  return { status, send }
}
