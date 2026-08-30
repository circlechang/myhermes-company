import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import './i18n'
import './index.css'
import { App } from './App'
import { AuthProvider } from './auth/AuthContext'
import { IS_MOCK } from './api/client'

async function boot() {
  if (IS_MOCK) {
    const { installMocks } = await import('./mock')
    installMocks()
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000 } } })
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>,
  )
}
boot()
