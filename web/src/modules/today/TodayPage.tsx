// 今天：老闆只問三件事——要我決定什麼、出了什麼事、花了多少。只用既有端點，每 30 秒重抓。
// 「等你決定」就是收件匣本人（種類 chip＋核准按鈕），不再另開 /inbox 頁；錢講 NT$、時間講「今天 09:30」。
import { useQueries, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { ErrorBox, Loading } from '../../components/QueryState'
import { iconFor } from '../../components/nav/icons'
import { fmtMoney, fmtTokens, fmtWhen, parseWhen, useFxRate } from '../../lib/format'
import { useEngineerMode } from '../../prefs/engineerMode'
import { InboxPanel, InboxRefreshButton, useInboxList } from '../inbox'
import { limitsApi, limitsQk } from '../limits'

/** 只列這頁真的會讀的欄位，不綁其他模組的型別（那些檔案有別人在改） */
interface Run { id: string; workflow_id: string; workflow_name: string; status: string; error: string; created_at: string; finished_at?: string | null }
interface SessionLite { id: string; title?: string; agent_id: string; updated_at: string; last_message_at?: string; doc_id?: string; preview?: string }
interface DocLite { id: string; title: string; updated_at: string }
/** /usage/summary 只讀 30 日總成本；完整型別在 usage 模組，這裡不綁 */
interface UsageTotals { totals: { cost_usd: number; total_tokens: number } }

/** 工作流「出問題」的四種狀態；一種一次呼叫，後端沒有多值篩選 */
const PROBLEM_STATUSES = ['failed', 'budget_exceeded', 'needs_attention', 'timeout'] as const
const POLL = 30_000

function isToday(s?: string | null): boolean {
  const d = parseWhen(s)
  return !!d && d.toDateString() === new Date().toDateString()
}
/** 錯誤訊息提到 LINE／channel → 多半是通道沒設，直接帶去設定頁 */
const isChannelError = (err: string) => /LINE|channel/i.test(err)

function Card({ id, title, count, children, more, actions }: { id: string; title: string; count?: number; children: React.ReactNode; more?: { to: string; label: string }; actions?: React.ReactNode }) {
  return (
    <section className="card p-4" data-testid={`today-${id}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-medium">{title}</h2>
        {count !== undefined && count > 0 && <span className="rounded-full bg-zinc-200 px-2 text-xs font-semibold dark:bg-zinc-700" data-testid={`today-${id}-count`}>{count}</span>}
        {more && <Link to={more.to} className="ml-auto text-xs text-zinc-600 underline dark:text-zinc-400">{more.label}</Link>}
        {actions && <div className={more ? '' : 'ml-auto'}>{actions}</div>}
      </div>
      {children}
    </section>
  )
}
const EmptyLine = ({ text, testId }: { text: string; testId: string }) => <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid={testId}>{text}</p>

/** 「匯率」小連結 → 展開一格輸入框，存 localStorage（mhc.fxrate），全站 NT$ 立刻跟著變 */
function FxRateEditor() {
  const { t } = useTranslation()
  const [rate, setRate] = useFxRate()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(String(rate))
  if (!open) {
    return (
      <button type="button" className="text-xs text-zinc-500 underline dark:text-zinc-400" data-testid="today-fx-link" onClick={() => { setDraft(String(rate)); setOpen(true) }}>
        {t('today.fxRate', { rate })}
      </button>
    )
  }
  const commit = () => {
    const n = Number(draft)
    if (Number.isFinite(n) && n > 0) setRate(n)
    setOpen(false)
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <label htmlFor="today-fx-input" className="text-zinc-500 dark:text-zinc-400">{t('today.fxLabel')}</label>
      <input id="today-fx-input" className="input w-20 py-0 text-xs" inputMode="decimal" value={draft} data-testid="today-fx-input"
        onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setOpen(false) }} autoFocus />
      <button type="button" className="btn-outline px-2 py-0 text-xs" onClick={commit}>{t('common.save')}</button>
    </span>
  )
}

export function TodayPage() {
  const { t, i18n } = useTranslation()
  const engineer = useEngineerMode()
  const [fxRate] = useFxRate()
  const lang = i18n.language

  const inbox = useInboxList()
  const problems = useQueries({
    queries: PROBLEM_STATUSES.map((st) => ({
      queryKey: ['workflow-runs', 'status', st],
      queryFn: () => request<Run[]>(`/workflow-runs?status=${st}`),
      refetchInterval: POLL,
    })),
  })
  const today = useQuery({ queryKey: [...limitsQk, 'today'], queryFn: limitsApi.today, refetchInterval: POLL })
  const limits = useQuery({ queryKey: [...limitsQk, 'list'], queryFn: limitsApi.list, refetchInterval: POLL })
  // 本月累計：30 日用量總計（一天抓幾次都行，端點是彙總過的）
  const month = useQuery({ queryKey: ['usage', 'summary', 30, 'today-card'], queryFn: () => request<UsageTotals>('/usage/summary?days=30'), refetchInterval: POLL * 10 })
  const completed = useQuery({ queryKey: ['workflow-runs', 'status', 'completed'], queryFn: () => request<Run[]>('/workflow-runs?status=completed'), refetchInterval: POLL })
  const sessions = useQuery({ queryKey: ['sessions', 'today'], queryFn: () => request<SessionLite[]>('/sessions'), refetchInterval: POLL })
  const docs = useQuery({ queryKey: ['docs', 'today'], queryFn: () => request<DocLite[]>('/docs'), refetchInterval: POLL })

  const problemRuns = problems.flatMap((q) => q.data ?? []).sort((a, b) => (b.created_at > a.created_at ? 1 : -1))
  const problemsLoading = problems.some((q) => q.isLoading)
  const problemsError = problems.find((q) => q.error)?.error

  const doneRuns = (completed.data ?? []).filter((r) => isToday(r.finished_at)).sort((a, b) => ((b.finished_at ?? '') > (a.finished_at ?? '') ? 1 : -1))
  const doneSessions = (sessions.data ?? []).filter((s) => isToday(s.last_message_at)).sort((a, b) => ((b.last_message_at ?? '') > (a.last_message_at ?? '') ? 1 : -1)).slice(0, 8)
  const doneDocs = (docs.data ?? []).filter((d) => isToday(d.updated_at)).sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1)).slice(0, 8)
  const nothingDone = !completed.isLoading && !sessions.isLoading && !docs.isLoading && doneRuns.length + doneSessions.length + doneDocs.length === 0

  const topAgents = [...(today.data?.agents ?? [])].sort((a, b) => b.usd - a.usd).slice(0, 3)
  // 護欄快到頂或已超過就亮一行橘字；沒設護欄就提示去設
  const nearLimit = (limits.data ?? []).some((l) => l.enabled && (l.today?.exceeded || (l.today?.usd_pct ?? 0) >= 80 || (l.today?.tokens_pct ?? 0) >= 80))
  const money = (usd: number) => fmtMoney(usd, { rate: fxRate })
  const when = (s?: string | null) => fmtWhen(s, new Date(), lang)

  const RunIcon = iconFor('Workflow')
  const ChatIcon = iconFor('MessageSquare')
  const DocIcon = iconFor('FileText')

  return (
    <div className="mx-auto max-w-6xl p-4">
      <PageHeader title={t('today.title')} subtitle={t('today.subtitle')} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card id="decide" title={t('today.decide')} count={inbox.data?.count ?? inbox.data?.items.length} actions={<InboxRefreshButton />}>
          <InboxPanel compact emptyText={t('today.decideEmpty')} />
        </Card>

        <Card id="problems" title={t('today.problems')} count={problemRuns.length} more={{ to: '/workflows', label: t('today.goWorkflows') }}>
          {problemsLoading && <Loading />}
          {problemsError && <ErrorBox error={problemsError} onRetry={() => problems.forEach((q) => q.refetch())} />}
          {!problemsLoading && !problemsError && problemRuns.length === 0 && <EmptyLine text={t('today.problemsEmpty')} testId="today-problems-empty" />}
          <ul className="space-y-2">
            {problemRuns.map((r) => (
              <li key={r.id} className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm dark:border-rose-900 dark:bg-rose-950/30" data-testid={`today-run-${r.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  {/* 連到流程頁（開在「最近一次」），不是 run 頁：老闆要看的是「這條流程怎麼了」 */}
                  <Link to={`/workflows/${r.workflow_id}`} className="font-medium underline">{r.workflow_name || r.workflow_id}</Link>
                  <span className="badge bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200">{t(`today.status.${r.status}`, { defaultValue: r.status })}</span>
                  <span className="ml-auto text-xs text-zinc-600 dark:text-zinc-400">{when(r.finished_at ?? r.created_at)}</span>
                </div>
                {r.error && (
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs text-rose-700 dark:text-rose-300">
                    <span className="line-clamp-2 min-w-0 flex-1">{r.error}</span>
                    {isChannelError(r.error)
                      ? <Link to="/channels" className="shrink-0 underline" data-testid={`today-run-${r.id}-fix`}>{t('today.fixChannel')}</Link>
                      : <Link to={`/workflows/${r.workflow_id}`} className="shrink-0 underline" data-testid={`today-run-${r.id}-fix`}>{t('today.openFlow')}</Link>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card id="cost" title={t('today.cost')} more={{ to: '/usage', label: t('today.goUsage') }}>
          {today.isLoading && <Loading />}
          {today.error && <ErrorBox error={today.error} onRetry={() => today.refetch()} />}
          {today.data && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-2xl font-semibold" data-testid="today-cost-local">{t('today.costToday', { amount: money(today.data.company.usd).local })}</span>
                {engineer && <span className="text-xs text-zinc-500 dark:text-zinc-400" data-testid="today-cost-usd">{money(today.data.company.usd).usd}</span>}
                <span className="text-zinc-600 dark:text-zinc-400">{fmtTokens(today.data.company.tokens, lang)} · {t('today.runs', { n: today.data.company.runs })}</span>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {month.data && (
                  <span data-testid="today-cost-month">
                    {t('today.costMonth', { amount: money(month.data.totals.cost_usd).local })}
                    {engineer && <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">{money(month.data.totals.cost_usd).usd}</span>}
                  </span>
                )}
                <FxRateEditor />
              </div>
              {nearLimit && (
                <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="today-cost-warn">
                  {t('today.costWarn')} <Link to="/limits" className="underline">{t('today.goLimits')}</Link>
                </p>
              )}
              {topAgents.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">{t('today.costTop')}</div>
                  <ul className="space-y-1">
                    {topAgents.map((a) => (
                      <li key={a.agent_id} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{a.name || a.agent_id}</span>
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">{fmtTokens(a.tokens, lang)}</span>
                        {engineer && <span className="text-xs text-zinc-500 dark:text-zinc-400">{money(a.usd).usd}</span>}
                        <span className="w-16 text-right font-medium">{money(a.usd).local}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {limits.data && limits.data.length === 0 && (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('today.costNoLimit')} <Link to="/limits" className="underline">{t('today.goLimits')}</Link></p>
              )}
            </div>
          )}
        </Card>

        <Card id="done" title={t('today.done')} count={doneRuns.length + doneSessions.length + doneDocs.length}>
          {(completed.isLoading || sessions.isLoading || docs.isLoading) && <Loading />}
          {nothingDone && <EmptyLine text={t('today.doneEmpty')} testId="today-done-empty" />}
          <ul className="space-y-1 text-sm">
            {doneRuns.map((r) => (
              <li key={`r-${r.id}`} className="flex items-center gap-2" data-testid={`today-done-run-${r.id}`}>
                <RunIcon className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
                <Link to={`/workflows/${r.workflow_id}`} className="min-w-0 flex-1 truncate underline">{r.workflow_name || r.workflow_id}</Link>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">{when(r.finished_at)}</span>
              </li>
            ))}
            {doneSessions.map((s) => (
              <li key={`s-${s.id}`} className="flex items-center gap-2" data-testid={`today-done-session-${s.id}`}>
                <ChatIcon className="h-4 w-4 shrink-0 text-indigo-600" aria-hidden />
                <Link to="/workbench" className="min-w-0 flex-1 truncate underline" title={s.preview}>{s.title || t('workbench.untitled')}</Link>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">{when(s.last_message_at)}</span>
              </li>
            ))}
            {doneDocs.map((d) => (
              <li key={`d-${d.id}`} className="flex items-center gap-2" data-testid={`today-done-doc-${d.id}`}>
                <DocIcon className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                <Link to={`/docs/${d.id}`} className="min-w-0 flex-1 truncate underline">{d.title}</Link>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">{when(d.updated_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
