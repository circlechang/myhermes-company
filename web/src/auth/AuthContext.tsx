import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, getToken, setToken } from '../api/client'
import type { Member } from '../api/types'

interface AuthState {
  member: Member | null
  ready: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => void
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [member, setMember] = useState<Member | null>(null)
  const [ready, setReady] = useState(false)
  const qc = useQueryClient()

  useEffect(() => {
    let alive = true
    if (!getToken()) {
      setReady(true)
      return
    }
    api.auth
      .me()
      .then((m) => alive && setMember(m))
      .catch(() => setToken(null))
      .finally(() => alive && setReady(true))
    return () => {
      alive = false
    }
  }, [])

  const logout = useCallback(() => {
    setToken(null)
    setMember(null)
    qc.clear()
  }, [qc])

  useEffect(() => {
    const h = () => logout()
    window.addEventListener('mhc:unauthorized', h)
    return () => window.removeEventListener('mhc:unauthorized', h)
  }, [logout])

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.auth.login(username, password)
    setToken(res.token)
    setMember(res.member)
  }, [])

  const value = useMemo(() => ({ member, ready, login, logout }), [member, ready, login, logout])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
