// 工作流清單：profile 篩選、批次刪除、建立、匯入；編輯在 /workflows/:id（modules/workflows）
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { useAgents } from '../api/hooks'
import { PageHeader } from '../components/PageHeader'
import { CollapsiblePanel, PanelGroup, WorkArea } from '../components/layout/index'
import { EmptyState } from '../components/EmptyState'
import { ErrorBox, Loading } from '../components/QueryState'
import { buildTemplate } from '../modules/workflows/templates'
import { TemplatePicker } from '../modules/workflows/templates/TemplatePicker'
import '../guide/i18n'
import { wfApi } from '../modules/workflows/api'
import { StatusBadge } from '../modules/workflows/RunPanel'
import { zhTW } from '../modules/workflows/i18n'
import i18n from 'i18next'

if (!i18n.hasResourceBundle('zh-TW', 'translation') || !i18n.exists('wf.title')) i18n.addResourceBundle('zh-TW', 'translation', zhTW, true, true)

const fmt = (s?: string) => (s ? new Date(s).toLocaleString() : '—')

export function WorkflowsPage() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [profile, setProfile] = useState('')
  const q = useQuery({ queryKey: ['workflows', { profile }], queryFn: () => wfApi.list(profile || undefined) })
  const runsQ = useQuery({ queryKey: ['workflow-runs', 'all'], queryFn: wfApi.allRuns, refetchInterval: 10_000 })
  const approvalsQ = useQuery({ queryKey: ['workflow-approvals', false], queryFn: () => wfApi.approvals('pending'), refetchInterval: 10_000 })
  const agents = useAgents()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showTpl, setShowTpl] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['workflows'] }); setSelected(new Set()) }
  // 建立＝先選範本（漸進揭露第 ① 層）：選完直接進生產線視圖，不是丟一張空白畫布
  const create = useMutation({
    mutationFn: ({ key, name }: { key: string; name: string }) => wfApi.create({ ...buildTemplate(key, agents.data ?? [], name), profile }),
    onSuccess: (w) => { invalidate(); setShowTpl(false); nav(`/workflows/${w.id}`) },
  })
  const batch = useMutation({ mutationFn: (ids: string[]) => wfApi.batchDelete(ids), onSuccess: invalidate })
  const importM = useMutation({ mutationFn: (data: unknown) => wfApi.import(data), onSuccess: (w) => { invalidate(); nav(`/workflows/${w.id}`) } })

  const onImport = async (f?: File) => {
    if (!f) return
    try { importM.mutate(JSON.parse(await f.text())) } catch { alert('JSON 解析失敗') }
  }
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const runCount = (wid: string) => runsQ.data?.filter((r) => r.workflow_id === wid).length ?? 0
  const lastRun = (wid: string) => runsQ.data?.find((r) => r.workflow_id === wid)
  const profiles = [...new Set((agents.data ?? []).map((a) => a.profile))]

  return (
    <PanelGroup>
      <CollapsiblePanel id="workflows.filters" side="left" title={t('panels.workflowList')} icon="Filter" defaultWidth={240} min={200} max={400}>
        <div className="panel-filters">
          <select className="input !w-auto" value={profile} onChange={(e) => setProfile(e.target.value)} aria-label={t('wf.profile')}>
            <option value="">{t('wf.allProfiles')}</option>
            {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {selected.size > 0 && (
            <button className="btn-danger" disabled={batch.isPending} onClick={() => { if (confirm(t('wf.confirmBatchDelete', { n: selected.size }))) batch.mutate([...selected]) }}>
              {t('wf.batchDelete')}（{selected.size}）
            </button>
          )}
        </div>
      </CollapsiblePanel>
      <WorkArea className="overflow-auto">
      <div className="mx-auto w-full max-w-5xl p-4">
      <PageHeader
        title={t('wf.title')}
        subtitle={t('wf.subtitle')}
        actions={
          <>
            <Link to="/workflows/approvals" className="btn-outline">{t('wf.approvals')}{approvalsQ.data?.length ? <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-2xs text-white">{approvalsQ.data.length}</span> : null}</Link>
            <button className="btn-outline" onClick={() => fileRef.current?.click()}>{t('wf.import')}</button>
            <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => onImport(e.target.files?.[0])} data-testid="import-input" />
            <button className="btn-primary" data-testid="new-workflow" onClick={() => setShowTpl(true)}>+ {t('wf.newWorkflow')}</button>
          </>
        }
      />
      {showTpl && (
        <TemplatePicker
          busy={create.isPending}
          error={create.error ? (create.error as Error).message : null}
          onCancel={() => setShowTpl(false)}
          onCreate={(key, name) => create.mutate({ key, name })}
        />
      )}
      {importM.error && <ErrorBox error={importM.error} />}
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data?.length === 0 && (
        <EmptyState
          testId="empty-workflows"
          title={t('guide.empty.workflows.title')}
          body={t('guide.empty.workflows.body')}
          action={{ label: t('wf.tpl.pick'), onClick: () => setShowTpl(true), disabled: agents.isLoading }}
        />
      )}
      <div className="table-wrap">
      <table className="w-full text-sm">
        <tbody>
          {q.data?.map((w) => {
            const lr = lastRun(w.id)
            return (
              <tr key={w.id} className="border-b border-zinc-200 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900" data-testid={`wf-row-${w.id}`}>
                <td className="w-8 py-2 align-top"><input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} aria-label={`select ${w.name}`} /></td>
                <td className="min-w-[12rem] py-2 align-top">
                  <Link to={`/workflows/${w.id}`} className="line-clamp-2 font-medium hover:underline" title={w.name}>{w.name}</Link>
                  <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('wf.tpl.count', { n: w.nodes.length })} · v{w.version ?? 1}{w.profile ? ` · ${w.profile}` : ''}</div>
                </td>
                <td className="nowrap-cell py-2 align-top text-xs text-zinc-600 dark:text-zinc-400">{runCount(w.id)} {t('wf.runs')}</td>
                <td className="nowrap-cell py-2 align-top">{lr && <StatusBadge s={lr.status} />}</td>
                <td className="nowrap-cell hidden py-2 align-top text-xs text-zinc-600 sm:table-cell dark:text-zinc-400">{fmt(w.updated_at)}</td>
                <td className="nowrap-cell hidden py-2 text-right align-top sm:table-cell"><Link to={`/workflows/${w.id}`} className="btn-outline !py-0.5 text-xs">{t('wf.open')}</Link></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      </div>
      </WorkArea>
    </PanelGroup>
  )
}
