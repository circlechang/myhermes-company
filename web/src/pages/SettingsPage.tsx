// 設定總覽：常用偏好（工程師模式、外觀）＋藏起來的頁面入口；Hermes 狀態收到最下面，工程師模式才展開。
// gateway 的 key 錯誤橫幅永遠顯示——它會擋住所有工作，不能藏。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useCompany, useHermesStatus } from '../api/hooks'
import { useAuth } from '../auth/AuthContext'
import { PageHeader } from '../components/PageHeader'
import { iconFor } from '../components/nav/icons'
import { allNav } from '../components/nav/navConfig'
import { ErrorBox, Loading } from '../components/QueryState'
import { NotifyPrefs } from '../components/settings/NotifyPrefs'
import { hiddenNav, type NavItem } from '../modules/registry'
import { setEngineerMode, useEngineerMode } from '../prefs/engineerMode'

/** 總覽的分區；不在名單裡的隱藏項一律塞進「系統」，新模組不會漏 */
const HUB_GROUPS: { group: 'connect' | 'cost' | 'look' | 'system'; keys: string[] }[] = [
  { group: 'connect', keys: ['channels', 'cron', 'files'] },
  { group: 'cost', keys: ['usage', 'limits'] },
  { group: 'look', keys: ['theme', 'voice'] },
  { group: 'system', keys: ['logs', 'admin', 'compat', 'events', 'search', 'soulHistory', 'profiles'] },
]

function Tile({ it }: { it: NavItem }) {
  const { t } = useTranslation()
  const Icon = iconFor(it.icon)
  return (
    <Link to={it.to} className="card flex items-start gap-3 p-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/60" data-testid={`settings-tile-${it.key}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600 dark:text-zinc-400" aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium">{t(`nav.${it.key}`)}</span>
        <span className="block text-xs text-zinc-600 dark:text-zinc-400">{t(`settings.hub.${it.key}`, { defaultValue: '' })}</span>
      </span>
    </Link>
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  const q = useHermesStatus()
  const company = useCompany()
  const { member } = useAuth()
  const engineer = useEngineerMode()
  const [statusOpen, setStatusOpen] = useState(true)
  const s = q.data

  const hidden = hiddenNav(allNav)
  const byKey = new Map(hidden.map((it) => [it.key, it]))
  const listed = new Set(HUB_GROUPS.flatMap((g) => g.keys))
  const sections = HUB_GROUPS.map((g) => ({
    group: g.group,
    items: [
      ...g.keys.map((k) => byKey.get(k)).filter((x): x is NavItem => !!x),
      ...(g.group === 'system' ? hidden.filter((it) => !listed.has(it.key)) : []),
    ],
  })).filter((g) => g.items.length > 0)

  return (
    <div className="mx-auto max-w-4xl p-4">
      <PageHeader title={t('settings.title')} />
      {s?.auth_error && (
        <div className="card mb-4 border-rose-300 p-4 text-sm dark:border-rose-800" role="alert">
          <div className="font-medium text-rose-700 dark:text-rose-300">{t('settings.gatewayAuthError')}</div>
          <div className="mt-1 text-xs text-rose-600 dark:text-rose-300" data-testid="gateway-auth-error">{t('settings.gatewayAuthErrorHint')}</div>
        </div>
      )}

      <div className="space-y-4">
        <div className="card p-4">
          <h2 className="mb-2 font-medium">{t('settings.quick')}</h2>
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              role="switch"
              className="mt-1"
              checked={engineer}
              onChange={(e) => setEngineerMode(e.target.checked)}
              aria-checked={engineer}
              data-testid="engineer-mode-toggle"
            />
            <span>
              <span className="block font-medium">{t('settings.engineerMode')}</span>
              <span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('settings.engineerModeHint')}</span>
            </span>
          </label>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link to="/theme" className="underline" data-testid="settings-theme-link">{t('settings.themeLink')}</Link>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.themeLinkHint')}</span>
          </div>
          {member?.role === 'owner' && (
            <p className="mt-2 text-sm">
              <Link to="/setup" className="underline" data-testid="settings-rerun-setup">{t('setup.rerun')}</Link>
            </p>
          )}
        </div>

        {/* 有事找我：閘門／失敗／危險指令推 LINE，放在常用偏好正下方 */}
        <NotifyPrefs />

        {sections.map((g) => (
          <section key={g.group} data-testid={`settings-hub-${g.group}`}>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{t(`settings.hubGroup.${g.group}`)}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{g.items.map((it) => <Tile key={it.to} it={it} />)}</div>
          </section>
        ))}

        {engineer && (
          <section className="card p-4" data-testid="settings-hermes-status">
            <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setStatusOpen((o) => !o)} aria-expanded={statusOpen} data-testid="settings-hermes-status-toggle">
              <span className="font-medium">{t('settings.hermesStatus')}</span>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.hermesStatusHint')}</span>
              <span className="ml-auto text-xs">{statusOpen ? '▾' : '▸'}</span>
            </button>
            {statusOpen && (
              <div className="mt-3 space-y-4">
                <div className="flex justify-end">
                  <button className="btn-outline" onClick={() => q.refetch()} disabled={q.isFetching}>{t('settings.refresh')}</button>
                </div>
                {q.isLoading && <Loading />}
                {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
                {s && (
                  <>
                    <div>
                      <h3 className="mb-2 text-sm font-medium">{t('settings.gateway')}</h3>
                      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3 [&>div]:min-w-0">
                        <div>
                          <dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.gateway')}</dt>
                          <dd className="flex items-center gap-2">
                            <span className={`inline-block h-2.5 w-2.5 rounded-full ${s.gateway_ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                            {s.gateway_ok ? t('settings.gatewayOk') : s.auth_error ? t('settings.gatewayAuthError') : t('settings.gatewayDown')}
                          </dd>
                        </div>
                        <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.version')}</dt><dd>{s.version ?? '—'}</dd></div>
                        <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.apiServerUrl')}</dt><dd><code className="path-text" title={s.api_server_url ?? undefined}>{s.api_server_url ?? '—'}</code></dd></div>
                      </dl>
                    </div>
                    <div>
                      <h3 className="mb-2 text-sm font-medium">{t('settings.profiles')}</h3>
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
                    <div>
                      <h3 className="mb-2 text-sm font-medium">{t('settings.studio')}</h3>
                      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3 [&>div]:min-w-0">
                        <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.company')}</dt><dd>{company.data?.name ?? '—'}</dd></div>
                        <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.member')}</dt><dd>{member?.username}</dd></div>
                        <div><dt className="text-xs text-zinc-600 dark:text-zinc-400">{t('settings.role')}</dt><dd>{member ? t(`settings.roles.${member.role}`) : '—'}</dd></div>
                      </dl>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
