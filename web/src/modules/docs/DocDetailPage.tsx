// /docs/{id}：上方文件本體（預覽元件）、右側版本歷史（可比對任兩版）、下方血緣圖。
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { DiffStatBadge, DiffView } from './DiffView'
import { DocPanel } from './DocPanel'
import { LineageGraph } from './LineageGraph'
import { STATUS_ORDER, useDoc, useDocDiff, useDocMutations, useDocVersions, useLineage } from './api'

const fmt = (s?: string) => (s ? new Date(s.endsWith('Z') || s.includes('+') ? s : `${s}Z`).toLocaleString() : '—')

export function DocDetailPage() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const nav = useNavigate()
  const doc = useDoc(id)
  const versions = useDocVersions(id)
  const lineage = useLineage(id)
  const m = useDocMutations(id)
  const [cmp, setCmp] = useState<{ a?: number; b?: number } | null>(null)
  const diff = useDocDiff(id, cmp?.a, cmp?.b, cmp !== null)
  useEffect(() => setCmp(null), [id])

  if (doc.isLoading) return <Loading />
  if (doc.error) return <ErrorBox error={doc.error} onRetry={() => doc.refetch()} />
  if (!doc.data) return null

  return (
    <div className="p-4" data-testid="doc-detail-page">
      <PageHeader title={doc.data.title} subtitle={doc.data.path} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <select
          className="input w-28"
          aria-label={t('docs.filter.status')}
          value={doc.data.status}
          onChange={(e) => m.patch.mutate({ status: e.target.value })}
          data-testid="doc-status-select"
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {t(`docs.status.${s}`)}
            </option>
          ))}
        </select>
        <span className="text-zinc-600 dark:text-zinc-400">
          {t(`docs.origin.${doc.data.origin}`)}
          {doc.data.stage ? ` · ${doc.data.stage}` : ''} · {t('docs.updatedAt')} {fmt(doc.data.updated_at)}
        </span>
        <code className="text-[11px] text-zinc-500">{doc.data.abs_path}</code>
        <button
          type="button"
          className="btn-outline ml-auto"
          onClick={() => m.fork.mutate(`${doc.data!.title}（分支）`, { onSuccess: (d) => nav(`/docs/${d.id}`) })}
          data-testid="doc-fork"
        >
          {t('docs.fork')}
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="card flex min-h-[22rem] flex-col overflow-hidden">
          <DocPanel docId={id} />
        </div>
        <div className="card flex flex-col p-3">
          <h3 className="mb-2 text-sm font-medium">{t('docs.versions')}</h3>
          {versions.isLoading && <Loading />}
          {versions.data && versions.data.length === 0 && <Empty text={t('docs.noVersions')} />}
          <ul className="max-h-80 space-y-1 overflow-auto text-xs" data-testid="version-list">
            {(versions.data ?? []).map((v, i, arr) => (
              <li key={v.id} className="rounded border border-zinc-200 p-2 dark:border-zinc-800" data-testid={`version-${v.version}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    v{v.version}
                    {i === 0 ? ` (${t('docs.latest')})` : ''}
                  </span>
                  <DiffStatBadge added={v.diff_stat.added} removed={v.diff_stat.removed} />
                </div>
                <div className="text-zinc-600 dark:text-zinc-400">{v.summary || '—'}</div>
                <div className="text-zinc-500">
                  {t(`docs.author.${v.author_kind}`)}
                  {v.author_id ? ` · ${v.author_id}` : ''} · {v.chars} {t('docs.chars')} · {fmt(v.created_at)}
                </div>
                <div className="mt-1 flex gap-1">
                  {i < arr.length - 1 && (
                    <button type="button" className="btn-ghost px-1 py-0" onClick={() => setCmp({ a: arr[i + 1].version, b: v.version })}>
                      {t('docs.diffPrev')}
                    </button>
                  )}
                  {i > 0 && (
                    <button type="button" className="btn-ghost px-1 py-0" onClick={() => setCmp({ a: v.version, b: arr[0].version })} data-testid={`cmp-latest-${v.version}`}>
                      {t('docs.diffLatest')}
                    </button>
                  )}
                  {i > 0 && (
                    <button type="button" className="btn-outline px-1 py-0" disabled={m.revert.isPending} onClick={() => m.revert.mutate(v.version)} data-testid={`revert-${v.version}`}>
                      {t('docs.revertTo')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {cmp !== null && (
            <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
              <div className="mb-1 flex items-center justify-between text-xs font-medium">
                <span>
                  {t('docs.diff')} v{diff.data?.from ?? cmp.a} → v{diff.data?.to ?? cmp.b}
                </span>
                <button type="button" className="btn-ghost text-xs" onClick={() => setCmp(null)}>
                  {t('common.close')}
                </button>
              </div>
              {diff.isLoading && <Loading />}
              {diff.data && <DiffView text={diff.data.diff} testId="doc-compare-diff" />}
            </div>
          )}
        </div>
      </div>

      <div className="card mt-3 p-3">
        <h3 className="mb-2 text-sm font-medium">{t('docs.lineage.title')}</h3>
        {lineage.isLoading && <Loading />}
        {lineage.error && <ErrorBox error={lineage.error} onRetry={() => lineage.refetch()} />}
        {lineage.data && <LineageGraph data={lineage.data} onPick={(nid) => nid !== id && nav(`/docs/${nid}`)} />}
      </div>
    </div>
  )
}
