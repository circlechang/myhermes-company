// 流程清單：一條流程一張卡，回答四件事——誰參與、上次怎樣、下次何時、要不要現在跑。
// 匯入 JSON、批次刪除、工作區篩選收進右上角 ⋯；「等你看」不再是這頁的按鈕（今天頁、收件匣、卡片上就地處理）。
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import { useAgents } from '../api/hooks'
import type { Agent } from '../api/types'
import { PageHeader } from '../components/PageHeader'
import { PanelGroup, WorkArea } from '../components/layout/index'
import { EmptyState } from '../components/EmptyState'
import { ErrorBox, Loading } from '../components/QueryState'
import { buildTemplate } from '../modules/workflows/templates'
import { TemplatePicker } from '../modules/workflows/templates/TemplatePicker'
import { DraftDialog } from '../modules/workflows/DraftDialog'
import '../guide/i18n'
import { wfApi, wfListApi } from '../modules/workflows/api'
import { zhTW } from '../modules/workflows/i18n'
import { orderStations, participantOf } from '../modules/workflows/stations'
import { firstLine, shortTime, usd } from '../modules/workflows/time'
import type { RunDetail, RunSummary, Workflow } from '../modules/workflows/types'
import i18n from 'i18next'

if (!i18n.hasResourceBundle('zh-TW', 'translation') || !i18n.exists('wf.title')) i18n.addResourceBundle('zh-TW', 'translation', zhTW, true, true)

const FAILED = ['failed', 'timeout', 'budget_exceeded', 'needs_attention']

/** 參與者鏈：研究員 → 你 → 小編 → LINE */
function chainOf(w: Workflow, agents: Agent[], t: (k: string) => string): string {
  const st = orderStations({ nodes: w.nodes, edges: w.edges })
  const names = st.map((s) => participantOf(s.node, s.kind, agents, t))
  // 連續兩步同一個人就併成一個，鏈才不會「小編 → 小編」
  return names.filter((n, i) => i === 0 || n !== names[i - 1]).join(' → ')
}

/** 失敗的那一步是第幾步（要拿 run 明細才知道） */
function failedStep(d?: RunDetail): { n: number; error: string } | null {
  if (!d) return null
  const st = orderStations({ nodes: d.snapshot.nodes, edges: d.snapshot.edges })
  for (const s of st) {
    const ns = d.node_states[s.node.id]
    if (ns && (ns.status === 'failed' || ns.status === 'outcome_unknown')) return { n: s.seq, error: ns.error ?? '' }
  }
  return null
}

export function WorkflowsPage() {
  const { t } = useTranslation()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [profile, setProfile] = useState('')
  const q = useQuery({ queryKey: ['workflows', { profile }], queryFn: () => wfApi.list(profile || undefined) })
  const agents = useAgents()
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showTpl, setShowTpl] = useState(false)
  const [draftOpen, setDraftOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const flows = useMemo(() => q.data ?? [], [q.data])

  // 每張卡兩個小請求：最近一次（limit=1）與排程。流程通常個位數，直接 batch；失敗的那次再多抓一筆明細找第幾步
  const latest = useQueries({
    queries: flows.map((w) => ({ queryKey: ['workflows', w.id, 'runs', 'latest'], queryFn: () => wfListApi.latestRun(w.id), refetchInterval: 15_000 })),
  })
  const scheds = useQueries({
    queries: flows.map((w) => ({ queryKey: ['workflows', w.id, 'schedules'], queryFn: () => wfApi.schedules(w.id), staleTime: 60_000 })),
  })
  const latestRun = (i: number): RunSummary | undefined => latest[i]?.data?.[0]
  const failedRunIds = flows.map((_, i) => latestRun(i)).filter((r): r is RunSummary => !!r && FAILED.includes(r.status)).map((r) => r.id)
  const details = useQueries({
    queries: failedRunIds.map((rid) => ({ queryKey: ['workflow-runs', rid], queryFn: () => wfApi.runDetail(rid), staleTime: 60_000 })),
  })
  const detailOf = (rid?: string) => (rid ? details[failedRunIds.indexOf(rid)]?.data : undefined)

  useEffect(() => {
    if (!menu) return
    const off = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [menu])

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['workflows'] }); setSelected(new Set()); setSelectMode(false) }
  const create = useMutation({
    mutationFn: ({ key, name }: { key: string; name: string }) => wfApi.create({ ...buildTemplate(key, agents.data ?? [], name), profile }),
    onSuccess: (w) => { invalidate(); setShowTpl(false); nav(`/workflows/${w.id}`) },
  })
  const batch = useMutation({ mutationFn: (ids: string[]) => wfApi.batchDelete(ids), onSuccess: invalidate })
  const importM = useMutation({ mutationFn: (data: unknown) => wfApi.import(data), onSuccess: (w) => { invalidate(); nav(`/workflows/${w.id}`) } })
  // 跑一次：打 POST 後直接進流程頁，「最近一次」分頁會接上這一次
  const runM = useMutation({ mutationFn: (id: string) => wfApi.run(id), onSuccess: (_r, id) => { qc.invalidateQueries({ queryKey: ['workflows', id, 'runs'] }); nav(`/workflows/${id}`) } })

  const onImport = async (f?: File) => {
    if (!f) return
    try { importM.mutate(JSON.parse(await f.text())) } catch { alert('JSON 解析失敗') }
  }
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const profiles = [...new Set((agents.data ?? []).map((a) => a.profile))]

  const lastText = (r?: RunSummary, d?: RunDetail): { text: string; tone: string } => {
    if (!r) return { text: t('wf.list.never'), tone: 'text-zinc-500' }
    const when = shortTime(r.started_at ?? r.created_at) // 講開始時間（今天 08:00），跟排程對得上
    const cost = usd(r.usage?.cost_usd)
    const tail = cost ? `（${t('wf.list.cost', { usd: cost })}）` : ''
    if (r.status === 'completed') return { text: `${when} ✓ ${t('wf.list.done')}${tail}`, tone: 'text-emerald-700 dark:text-emerald-300' }
    if (FAILED.includes(r.status)) {
      const f = failedStep(d)
      const why = f ? `${t('wf.list.failedAt', { n: f.n })}：${firstLine(f.error || r.error, 60)}` : firstLine(r.error, 60)
      return { text: `${when} ⚠ ${t('wf.list.failed')}${why ? `（${why}）` : ''}${tail}`, tone: 'text-rose-700 dark:text-rose-300' }
    }
    if (r.status === 'waiting_approval') return { text: `${when} ⏸ ${t('wf.list.waiting')}`, tone: 'text-amber-700 dark:text-amber-300' }
    if (r.status === 'stopped') return { text: `${when} ■ ${t('wf.list.stopped')}${tail}`, tone: 'text-zinc-600 dark:text-zinc-400' }
    return { text: `${when} ▶ ${t('wf.list.inProgress')}`, tone: 'text-sky-700 dark:text-sky-300' }
  }
  const menuItem = 'block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800'

  return (
    <PanelGroup>
      <WorkArea className="overflow-auto">
      <div className="mx-auto w-full max-w-5xl p-4">
      <PageHeader
        title={t('wf.title')}
        subtitle={t('wf.subtitle')}
        actions={
          <>
            <div className="relative" ref={menuRef}>
              <button className="btn-outline !px-2" aria-haspopup="menu" aria-expanded={menu} aria-label={t('wf.list.more')} data-testid="wf-list-more" onClick={() => setMenu((v) => !v)}>⋯</button>
              {menu && (
                <div role="menu" data-testid="wf-list-more-menu" className="absolute right-0 z-30 mt-1 w-60 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
                  <button role="menuitem" className={menuItem} data-testid="menu-import" onClick={() => { setMenu(false); fileRef.current?.click() }}>{t('wf.import')}</button>
                  <button role="menuitem" className={menuItem} data-testid="menu-select" onClick={() => { setMenu(false); setSelectMode((v) => !v); setSelected(new Set()) }}>{selectMode ? t('wf.cancelSelect') : t('wf.selectMode')}</button>
                  <label className="block px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    {t('wf.profile')}
                    <select className="input mt-0.5 !w-full" value={profile} onChange={(e) => setProfile(e.target.value)} aria-label={t('wf.profile')}>
                      <option value="">{t('wf.allProfiles')}</option>
                      {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
            <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={(e) => onImport(e.target.files?.[0])} data-testid="import-input" />
            <button className="btn-ghost" data-testid="pick-template" onClick={() => setShowTpl(true)}>{t('wf.pickTemplate')}</button>
            <button className="btn-primary" data-testid="new-workflow" onClick={() => setDraftOpen(true)}>+ {t('wf.newWorkflow')}</button>
          </>
        }
      />
      <DraftDialog
        open={draftOpen}
        onClose={() => setDraftOpen(false)}
        onCreated={(wid) => { invalidate(); setDraftOpen(false); nav(`/workflows/${wid}`) }}
        onPickTemplate={() => { setDraftOpen(false); setShowTpl(true) }}
      />
      {showTpl && (
        <TemplatePicker
          busy={create.isPending}
          error={create.error ? (create.error as Error).message : null}
          onCancel={() => setShowTpl(false)}
          onCreate={(key, name) => create.mutate({ key, name })}
        />
      )}
      {selectMode && (
        <div className="mb-3 flex items-center gap-2 text-sm" data-testid="select-bar">
          <button className="btn-danger !py-1" disabled={!selected.size || batch.isPending} data-testid="batch-delete" onClick={() => { if (confirm(t('wf.confirmBatchDelete', { n: selected.size }))) batch.mutate([...selected]) }}>
            {t('wf.batchDelete')}（{selected.size}）
          </button>
          <button className="btn-ghost !py-1" onClick={() => { setSelectMode(false); setSelected(new Set()) }}>{t('wf.cancelSelect')}</button>
        </div>
      )}
      {importM.error && <ErrorBox error={importM.error} />}
      {runM.error && <ErrorBox error={runM.error} />}
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
      <ul className="space-y-2">
        {flows.map((w, i) => {
          const r = latestRun(i)
          const last = lastText(r, detailOf(r?.id))
          const next = (scheds[i]?.data ?? []).find((s) => s.enabled)?.next_run_at
          return (
            <li key={w.id} className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-3" data-testid={`wf-card-${w.id}`}>
              {selectMode && <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} aria-label={`select ${w.name}`} />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <Link to={`/workflows/${w.id}`} className="min-w-0 truncate font-medium hover:underline" title={w.name}>{w.name}</Link>
                  <span className="min-w-0 truncate text-xs text-zinc-600 dark:text-zinc-400" data-testid={`wf-card-${w.id}-chain`}>{chainOf(w, agents.data ?? [], t)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                  <span className={last.tone} data-testid={`wf-card-${w.id}-last`}>{t('wf.list.last')}：{last.text}</span>
                  <span className="text-zinc-600 dark:text-zinc-400" data-testid={`wf-card-${w.id}-next`}>{t('wf.list.next')}：{next ? shortTime(next) : t('wf.list.noSchedule')}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button className="btn-primary !py-1 text-xs" disabled={runM.isPending} data-testid={`wf-card-${w.id}-run`} onClick={() => runM.mutate(w.id)}>▶ {t('wf.list.runOnce')}</button>
                <Link to={`/workflows/${w.id}`} className="btn-outline !py-1 text-xs" data-testid={`wf-card-${w.id}-open`}>{t('wf.list.open')}</Link>
              </div>
            </li>
          )
        })}
      </ul>
      </div>
      </WorkArea>
    </PanelGroup>
  )
}
