import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { setFetchImpl, setToken } from '../api/client'
import { AuthProvider } from '../auth/AuthContext'
import { mockFetch, MOCK_TOKEN, resetMockState } from '../mock/fetch'
import { MockWebSocket } from '../mock/MockWebSocket'
import { setWebSocketImpl } from '../ws/chatSocket'

export function setupMocks({ loggedIn = false, wsDelayMs = 0 } = {}) {
  resetMockState()
  setFetchImpl(mockFetch as typeof fetch)
  MockWebSocket.instances = []
  MockWebSocket.options = { delayMs: wsDelayMs }
  setWebSocketImpl(MockWebSocket as unknown as typeof WebSocket)
  setToken(loggedIn ? MOCK_TOKEN : null)
}

export function renderApp(ui: ReactElement, { route = '/' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
