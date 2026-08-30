import { setFetchImpl } from '../api/client'
import { setWebSocketImpl } from '../ws/chatSocket'
import { mockFetch } from './fetch'
import { MockWebSocket } from './MockWebSocket'

export function installMocks(opts?: { wsDelayMs?: number }) {
  setFetchImpl(mockFetch as typeof fetch)
  if (opts?.wsDelayMs !== undefined) MockWebSocket.options.delayMs = opts.wsDelayMs
  setWebSocketImpl(MockWebSocket as unknown as typeof WebSocket)
}
