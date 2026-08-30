import { useEffect, useRef, useState } from 'react'
import { workflowWsUrl } from './api'
import type { WfWsEvent } from './types'

let WebSocketImpl: typeof WebSocket = typeof WebSocket !== 'undefined' ? WebSocket : (undefined as unknown as typeof WebSocket)
export function setWorkflowWebSocketImpl(impl: typeof WebSocket) {
  WebSocketImpl = impl
}

/** 單一 /ws/workflows 連線；事件交給 onEvent，斷線退避重連。 */
export function useWorkflowSocket(onEvent: (ev: WfWsEvent) => void, enabled = true) {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('closed')
  const ref = useRef(onEvent)
  ref.current = onEvent
  useEffect(() => {
    if (!enabled || !WebSocketImpl) return
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let retry = 0
    let closed = false
    const connect = () => {
      setStatus('connecting')
      ws = new WebSocketImpl(workflowWsUrl())
      ws.onopen = () => {
        retry = 0
        setStatus('open')
      }
      ws.onmessage = (e) => {
        try {
          ref.current(JSON.parse(e.data) as WfWsEvent)
        } catch {
          /* ignore */
        }
      }
      ws.onclose = () => {
        setStatus('closed')
        if (!closed) timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++))
      }
      ws.onerror = () => {}
    }
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [enabled])
  return status
}
