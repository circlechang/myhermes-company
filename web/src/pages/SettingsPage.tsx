import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useCompany, useHermesStatus } from '../api/hooks'
import { useAuth } from '../auth/AuthContext'
import { PageHeader } from '../components/PageHeader'
import { ErrorBox, Loading } from '../components/QueryState'

export function SettingsPage() {
  const { t } = useTranslation()
  const q = useHermesStatus()
  const company = useCompany()
  const { member } = useAuth()
  const s = q.data
  return (
    <div className="mx-auto max-w-4xl p-4">
      <PageHeader
        title={t('settings.title')}
        actions={<button className="btn-outline" onClick={() => q.refetch()} disabled={q.isFetching}>{t('settings.refresh')}</button>}
      />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {s && (
        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="mb-2 font-medium">{t('settings.gateway')}</h2>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3 [&>div]:min-w-0">
              <div>
                <dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.gateway')}</dt>
                <dd className="flex items-center gap-2">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${s.gateway_ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                  {s.gateway_ok ? t('settings.gatewayOk') : s.auth_error ? t('settings.gatewayAuthError') : t('settings.gatewayDown')}
                </dd>
                {s.auth_error && <dd className="mt-1 text-xs text-rose-600 dark:text-rose-300" data-testid="gateway-auth-error">{t('settings.gatewayAuthErrorHint')}</dd>}
              </div>
              <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.version')}</dt><dd>{s.version ?? '—'}</dd></div>
              <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.apiServerUrl')}</dt><dd><code className="path-text" title={s.api_server_url ?? undefined}>{s.api_server_url ?? '—'}</code></dd></div>
            </dl>
          </div>
          <div className="card p-4">
            <h2 className="mb-2 font-medium">{t('settings.profiles')}</h2>
            <div className="table-wrap">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-600 dark:text-zinc-400">
                <tr><th className="nowrap-cell py-1">{t('settings.profileName')}</th><th className="nowrap-cell pl-3">{t('settings.profileModel')}</th><th className="nowrap-cell pl-3">{t('settings.profileGateway')}</th></tr>
              </thead>
              <tbody>
                {s.profiles.map((p) => (
                  <tr key={p.name} className="border-t border-zinc-200 dark:border-zinc-800">
                    <td className="nowrap-cell py-1.5"><code className="font-mono">{p.name}</code></td>
                    <td className="nowrap-cell pl-3">{p.model ?? '—'}</td>
                    <td className="nowrap-cell pl-3">{typeof p.gateway === 'boolean' ? (p.gateway ? t('common.yes') : t('common.no')) : (p.gateway ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          <div className="card p-4">
            <h2 className="mb-2 font-medium">{t('settings.studio')}</h2>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3 [&>div]:min-w-0">
              <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.company')}</dt><dd>{company.data?.name ?? '—'}</dd></div>
              <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.member')}</dt><dd>{member?.username}</dd></div>
              <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.role')}</dt><dd>{member ? t(`settings.roles.${member.role}`) : '—'}</dd></div>
            </dl>
            {member?.role === 'owner' && (
              <p className="mt-3 text-sm">
                <Link to="/setup" className="underline" data-testid="settings-rerun-setup">{t('setup.rerun')}</Link>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
