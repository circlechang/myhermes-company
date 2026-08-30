// 首登導向：owner 且 setup 未完成 → /setup；非 owner 未完成 → 頂端提示條。舊版伺服器沒有 /setup → 靜默略過。
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { isSetupSkipped, setupApi } from './api'

export function SetupGate({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { member } = useAuth()
  const loc = useLocation()
  const q = useQuery({ queryKey: ['setup', 'state'], queryFn: setupApi.state, enabled: !!member, retry: false, staleTime: 60_000 })
  if (!member) return <>{children}</>
  if (q.isLoading) return <>{children}</>
  const st = q.data
  if (!st || st.completed) return <>{children}</>
  if (member.role === 'owner') {
    if (!isSetupSkipped() && loc.pathname !== '/setup') return <Navigate to="/setup" replace />
    return <>{children}</>
  }
  return (
    <>
      <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100" role="status" data-testid="setup-pending-banner">
        {t('setup.notOwnerBanner')}
      </div>
      {children}
    </>
  )
}
