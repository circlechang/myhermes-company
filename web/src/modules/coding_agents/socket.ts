import { useCallback, useEffect, useRef, useState } from 'react'
import { codingWsUrl } from './api'
import type { CodingEvent } from './state'

let WebSocketImpl: typeof WebSocket = typeof WebSocket !== 'undefined' ? WebSocket : (undefined as unknown as typeof WebSocket)
export function setCodingWebSocketImpl(impl: typeof WebSocket) {
  WebSocketImpl = impl
}

export type ClientMessage =
  | { type: 'run'; session_id: string; input: string; images?: string[] }
  | { type: 'stop'; run_id: string }
  | { type: 'ping' }

export function useCodingSocket(onEvent: (ev: CodingEvent) => void, enabled = true) {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('closed')
  const wsRef = useRef<WebSocket | null>(null)
  const cb = useRef(onEvent)
  cb.current = onEvent
  const retry = useRef(0)
  const closedByUs = useRef(false)

  useEffect(() => {
    if (!enabled) return
    closedByUs.current = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      setStatus('connecting')
      const ws = new WebSocketImpl(codingWsUrl())
      wsRef.current = ws
      ws.onopen = () => {
        retry.current = 0
        setStatus('open')
      }
      ws.onmessage = (e) => {
        try {
          cb.current(JSON.parse(e.data) as CodingEvent)
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        setStatus('closed')
        if (closedByUs.current) return
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry.current++))
      }
      ws.onerror = () => {}
    }
    connect()
    return () => {
      closedByUs.current = true
      if (timer) clearTimeout(timer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled])

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== 1) return false
    ws.send(JSON.stringify(msg))
    return true
  }, [])
  return { status, send }
}
