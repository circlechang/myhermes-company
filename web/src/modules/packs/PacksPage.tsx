// /packs：套件清單＋安裝／移除
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { EmptyState } from '../../components/EmptyState'
import { PageHeader } from '../../components/PageHeader'
import { ErrorBox, Loading } from '../../components/QueryState'
import { packsApi, packsQk, type Pack } from './api'

function PackCard({ p, isAdmin }: { p: Pack; isAdmin: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [err, setErr] = useState<string | null>(null)
  const invalidate = () => qc.invalidateQueries({ queryKey: packsQk.list })
  const install = useMutation({ mutationFn: () => packsApi.install(p.name), onSuccess: invalidate, onError: (e: Error) => setErr(e.message) })
  const uninstall = useMutation({ mutationFn: () => packsApi.uninstall(p.name), onSuccess: invalidate, onError: (e: Error) => setErr(e.message) })
  const busy = install.isPending || uninstall.isPending
  return (
    <li className="card flex flex-col gap-3 p-4" data-testid={`pack-${p.name}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 text-base font-semibold">{p.title}</h2>
            <code className="id-text shrink text-[11px] text-zinc-600 dark:text-zinc-400" title={`${p.name}@${p.version}`}>{p.name}@{p.version}</code>
            <span className={`badge px-1.5 py-0.5 text-[11px] font-medium ${p.installed ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'}`}>
              {p.installed ? t('packs.installed') : t('packs.notInstalled')}
            </span>
          </div>
          <p className="mt-1 line-clamp-3 text-sm text-zinc-700 dark:text-zinc-300" title={p.description}>{p.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.installed && (
            <Link className="btn-primary" to={`/packs/${encodeURIComponent(p.name)}`} data-testid={`open-${p.name}`}>
              {t('packs.open')}
            </Link>
          )}
          {isAdmin && (
            <button className="btn-outline" disabled={busy} onClick={() => install.mutate()} data-testid={`install-${p.name}`}>
              {p.installed ? t('packs.reinstall') : t('packs.install')}
            </button>
          )}
          {isAdmin && p.installed && (
            <button className="btn-danger" disabled={busy} onClick={() => { if (confirm(t('packs.confirmUninstall', { name: p.name }))) uninstall.mutate() }}>
              {t('packs.uninstall')}
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-3 text-xs sm:grid-cols-3">
        <div>
          <div className="mb-1 font-medium text-zinc-600 dark:text-zinc-400">{t('packs.stages')}</div>
          <ol className="flex flex-wrap gap-1">
            {p.stages.map((s) => (
              <li key={s.id} className="badge max-w-full truncate border border-zinc-200 px-1.5 py-0.5 dark:border-zinc-700" title={s.title}>
                {s.title}{s.gate ? ' ✋' : ''}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <div className="mb-1 font-medium text-zinc-600 dark:text-zinc-400">{t('packs.agents')}</div>
          <ul className="space-y-0.5">
            {p.agents.map((a) => (
              <li key={a.profile}>
                <span className="font-medium">{a.name}</span> <code className="font-mono text-zinc-600 dark:text-zinc-400">{a.profile}</code>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1 font-medium text-zinc-600 dark:text-zinc-400">{t('packs.workflows')}</div>
          <div className="text-zinc-600 dark:text-zinc-300">{p.stages.length} · {p.has_hooks ? t('packs.hooks') : ''}</div>
          {p.installed && <div className="text-zinc-600 dark:text-zinc-400">{t('packs.installed')} {new Date(p.installed.installed_at + (p.installed.installed_at.endsWith('Z') ? '' : 'Z')).toLocaleString()}</div>}
        </div>
      </div>
      {err && <div className="text-xs text-rose-600 dark:text-rose-400">{err}</div>}
    </li>
  )
}

export function PacksPage() {
  const { t } = useTranslation()
  const { member: me } = useAuth()
  const isAdmin = me?.role === 'owner' || me?.role === 'admin'
  const q = useQuery({ queryKey: packsQk.list, queryFn: packsApi.list })
  return (
    <div className="mx-auto max-w-5xl p-4">
      <PageHeader title={t('packs.title')} subtitle={t('packs.subtitle')} />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.items.length === 0 && <EmptyState title={t('packs.empty')} />}
      {q.data && (
        <ul className="space-y-3">
          {q.data.items.map((p) => <PackCard key={p.name} p={p} isAdmin={isAdmin} />)}
        </ul>
      )}
      {!isAdmin && <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">{t('packs.adminOnly')}</p>}
      {q.data && Object.keys(q.data.errors).length > 0 && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="font-medium">{t('packs.errors')}</div>
          <ul className="mt-1 list-disc pl-4">
            {Object.entries(q.data.errors).map(([n, e]) => <li key={n}><code>{n}</code>：{e}</li>)}
          </ul>
        </div>
      )}
      {q.data && (
        <div className="mt-4 text-[11px] text-zinc-600 dark:text-zinc-400">
          {t('packs.roots')}：{q.data.roots.map((r) => <code key={r} className="mr-2 break-all font-mono">{r}</code>)}
        </div>
      )}
    </div>
  )
}
