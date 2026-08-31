// /docs：文件清單，可依狀態／站別／來源篩選。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { STATUS_ORDER, useDocMutations, useDocs, type DocOrigin } from './api'

const ORIGINS: DocOrigin[] = ['chat', 'workflow', 'pack', 'upload']
const fmt = (s?: string) => (s ? new Date(s.endsWith('Z') || s.includes('+') ? s : `${s}Z`).toLocaleString() : '—')

export function DocsListPage() {
  const { t } = useTranslation()
  const [status, setStatus] = useState('')
  const [origin, setOrigin] = useState('')
  const [stage, setStage] = useState('')
  const [q, setQ] = useState('')
  const docs = useDocs({ status, origin, stage, q })
  const m = useDocMutations()
  const [title, setTitle] = useState('')

  const stages = [...new Set((docs.data ?? []).map((d) => d.stage).filter(Boolean))]

  return (
    <div className="p-4" data-testid="docs-page">
      <PageHeader title={t('docs.title')} subtitle={t('docs.subtitle')} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <select className="input w-32" aria-label={t('docs.filter.status')} value={status} onChange={(e) => setStatus(e.target.value)} data-testid="filter-status">
          <option value="">{t('docs.filter.allStatus')}</option>
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {t(`docs.status.${s}`)}
            </option>
          ))}
        </select>
        <select className="input w-32" aria-label={t('docs.filter.origin')} value={origin} onChange={(e) => setOrigin(e.target.value)} data-testid="filter-origin">
          <option value="">{t('docs.filter.allOrigin')}</option>
          {ORIGINS.map((s) => (
            <option key={s} value={s}>
              {t(`docs.origin.${s}`)}
            </option>
          ))}
        </select>
        <select className="input w-32" aria-label={t('docs.filter.stage')} value={stage} onChange={(e) => setStage(e.target.value)} data-testid="filter-stage">
          <option value="">{t('docs.filter.allStage')}</option>
          {stages.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input className="input w-44" placeholder={t('docs.filter.search')} aria-label={t('docs.filter.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="filter-q" />
        <span className="ml-auto flex items-center gap-1">
          <input className="input w-44" placeholder={t('docs.newTitle')} aria-label={t('docs.newTitle')} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="new-doc-title" />
          <button
            type="button"
            className="btn-primary"
            disabled={!title.trim() || m.create.isPending}
            onClick={() => m.create.mutate({ title: title.trim() }, { onSuccess: () => setTitle('') })}
            data-testid="new-doc"
          >
            {t('docs.new')}
          </button>
        </span>
      </div>
      {docs.isLoading && <Loading />}
      {docs.error && <ErrorBox error={docs.error} onRetry={() => docs.refetch()} />}
      {docs.data && docs.data.length === 0 && <Empty text={t('docs.empty')} />}
      <ul className="space-y-1" data-testid="doc-list">
        {(docs.data ?? []).map((d) => (
          <li key={d.id} className="card flex flex-wrap items-center gap-2 p-2 text-sm" data-testid={`doc-${d.id}`}>
            <Link className="min-w-0 flex-1 truncate font-medium hover:underline" to={`/docs/${d.id}`}>
              {d.title}
            </Link>
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">{t(`docs.status.${d.status}`)}</span>
            {d.stage && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800 dark:bg-sky-900/50 dark:text-sky-200">{d.stage}</span>}
            <span className="text-xs text-zinc-600 dark:text-zinc-400">{t(`docs.origin.${d.origin}`)}</span>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">v{d.latest_version ?? 0}</span>
            {d.drift && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('docs.driftShort')}</span>}
            <span className="text-xs text-zinc-500">{fmt(d.updated_at)}</span>
            <code className="w-full truncate text-[11px] text-zinc-500">{d.path}</code>
          </li>
        ))}
      </ul>
    </div>
  )
}
