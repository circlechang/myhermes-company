import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PageHeader } from '../../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../../components/QueryState'
import { wfApi } from './api'
import { StatusBadge } from './RunPanel'

export function ApprovalsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [all, setAll] = useState(false)
  const q = useQuery({ queryKey: ['workflow-approvals', all], queryFn: () => wfApi.approvals(all ? 'all' : 'pending'), refetchInterval: 5000 })
  const [comments, setComments] = useState<Record<string, string>>({})
  const decide = useMutation({
    mutationFn: ({ id, ok }: { id: string; ok: boolean }) => (ok ? wfApi.approve(id, comments[id] ?? '') : wfApi.reject(id, comments[id] ?? '')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflow-approvals'] }),
  })
  return (
    <div className="mx-auto max-w-4xl p-4">
      <PageHeader title={t('wf.approvalsPage.title')} subtitle={t('wf.approvalsPage.subtitle')} actions={<label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />{t('wf.approvalsPage.showAll')}</label>} />
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data?.length === 0 && <Empty text={t('wf.approvalsPage.empty')} />}
      <ul className="space-y-3">
        {q.data?.map((a) => (
          <li key={a.id} className="card p-3 text-sm" data-testid={`approval-card-${a.id}`}>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{a.workflow_name} / {a.node_title}</span>
              <StatusBadge s={a.status === 'pending' ? 'waiting_approval' : a.status === 'approved' ? 'completed' : a.status === 'rejected' ? 'failed' : 'stopped'} />
              <Link className="ml-auto text-xs text-indigo-600 dark:text-indigo-400" to={`/workflows/runs/${a.run_id}`}>{t('wf.approvalsPage.run')} {a.run_id}</Link>
            </div>
            <div className="mt-1 text-2xs text-zinc-600 dark:text-zinc-400">{new Date(a.created_at).toLocaleString()}{a.decided_by ? ` · ${a.decided_by}` : ''}</div>
            <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{t('wf.approvalsPage.payload')}</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{a.payload}</pre>
            {a.status === 'pending' ? (
              <div className="mt-2 space-y-1">
                <textarea className="input min-h-[40px] text-xs" placeholder={t('wf.panel.comment')} value={comments[a.id] ?? ''} onChange={(e) => setComments({ ...comments, [a.id]: e.target.value })} />
                <div className="flex gap-1">
                  <button className="btn-primary !py-0.5 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, ok: true })}>{t('wf.panel.approve')}</button>
                  <button className="btn-danger !py-0.5 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ id: a.id, ok: false })}>{t('wf.panel.reject')}</button>
                </div>
              </div>
            ) : a.comment ? <div className="mt-1 text-xs">意見：{a.comment}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
