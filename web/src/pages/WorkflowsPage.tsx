// 工作流清單：profile 篩選、批次刪除、建立、匯入；編輯在 /workflows/:id（modules/workflows）
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { useAgents } from '../api/hooks'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/EmptyState'
import { ErrorBox, Loading } from '../components/QueryState'
import { exampleWorkflow } from '../modules/workflows/template'
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
  const [name, setName] = useState('')
  const [showForm, setShowForm] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['workflows'] }); setSelected(new Set()) }
  const create = useMutation({
    mutationFn: () => {
      const firstAgent = agents.data?.find((a) => a.enabled) ?? agents.data?.[0]
      return wfApi.create({
        name: name.trim(), profile,
        nodes: [{ id: 'n1', title: t('wf.kinds.hermes'), kind: 'hermes', agent_id: firstAgent?.id, profile: firstAgent?.profile, prompt: '請描述本節點任務', position: { x: 80, y: 80 } }],
        edges: [], viewport: { x: 0, y: 0, zoom: 1 },
      })
    },
    onSuccess: (w) => { invalidate(); setName(''); setShowForm(false); nav(`/workflows/${w.id}`) },
  })
  const batch = useMutation({ mutationFn: (ids: string[]) => wfApi.batchDelete(ids), onSuccess: invalidate })
  const importM = useMutation({ mutationFn: (data: unknown) => wfApi.import(data), onSuccess: (w) => { invalidate(); nav(`/workflows/${w.id}`) } })
  // 範例模板走 POST /workflows（與建立表單同一條），不用 import 的 export 格式包裝
  const exampleM = useMutation({ mutationFn: () => wfApi.create({ ...exampleWorkflow(agents.data ?? []), profile }), onSuccess: (w) => { invalidate(); nav(`/workflows/${w.id}`) } })
  const loadExample = () => exampleM.mutate()

  const submit = (e: FormEvent) => { e.preventDefault(); if (name.trim()) create.mutate() }
  const onImport = async (f?: File) => {
    if (!f) return
    try { importM.mutate(JSON.parse(await f.text())) } catch { alert('JSON 解析失敗') }
  }
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const runCount = (wid: string) => runsQ.data?.filter((r) => r.workflow_id === wid).length ?? 0
  const lastRun = (wid: string) => runsQ.data?.find((r) => r.workflow_id === wid)
  const profiles = [...new Set((agents.data ?? []).map((a) => a.profile))]

  return (
    <div className="mx-auto max-w-5xl p-4">
      <PageHeader
        title={t('wf.title')}
        subtitle={t('wf.subtitle')}
        actions={
          <>
            <Link to="/workflows/approvals" className="btn-outline">{t('wf.approvals')}{approvalsQ.data?.length ? <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[10px] text-white">{approvalsQ.data.length}</span> : null}</Link>
            <button className="btn-outline" onClick={() => fileRef.current?.click()}>{t('wf.import')}</button>
            <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => onImport(e.target.files?.[0])} data-testid="import-input" />
            <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>+ {t('wf.newWorkflow')}</button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
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
      {showForm && (
        <form onSubmit={submit} className="card mb-3 flex items-end gap-2 p-3">
          <label className="flex-1">
            <span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('wf.name')}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('workflows.placeholderName', '例如：每日熱點內容產線')} autoFocus />
          </label>
          <button className="btn-primary" disabled={create.isPending || !name.trim()}>建立</button>
          {create.error && <span className="text-xs text-rose-600 dark:text-rose-400">{(create.error as Error).message}</span>}
        </form>
      )}
      {importM.error && <ErrorBox error={importM.error} />}
      {exampleM.error && <ErrorBox error={exampleM.error} />}
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data?.length === 0 && (
        <EmptyState
          testId="empty-workflows"
          title={t('guide.empty.workflows.title')}
          body={t('guide.empty.workflows.body')}
          action={{ label: t('guide.empty.workflows.action'), onClick: loadExample, disabled: exampleM.isPending || agents.isLoading }}
          secondary={<button type="button" className="btn-outline" onClick={() => setShowForm(true)}>{t('guide.empty.workflows.create')}</button>}
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
                  <div className="text-xs text-zinc-600 dark:text-zinc-400">{w.nodes.length} {t('workflows.nodes', '節點')} · {w.edges.length} {t('workflows.edges', '連線')} · v{w.version ?? 1}{w.profile ? ` · ${w.profile}` : ''}</div>
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
  )
}
