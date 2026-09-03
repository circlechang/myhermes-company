// 今天：老闆只問三件事——要我決定什麼、出了什麼事、花了多少。只用既有端點，每 30 秒重抓。
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { request } from '../../api/client'
import { PageHeader } from '../../components/PageHeader'
import { ErrorBox, Loading } from '../../components/QueryState'
import { iconFor } from '../../components/nav/icons'
import { InboxRow, inboxApi, inboxQk } from '../inbox'
import { limitsApi, limitsQk } from '../limits'

/** 只列這頁真的會讀的欄位，不綁其他模組的型別（那些檔案有別人在改） */
interface Run { id: string; workflow_id: string; workflow_name: string; status: string; error: string; created_at: string; finished_at?: string | null }
interface SessionLite { id: string; title?: string; agent_id: string; updated_at: string; last_message_at?: string; doc_id?: string; preview?: string }
interface DocLite { id: string; title: string; updated_at: string }

/** 工作流「出問題」的四種狀態；一種一次呼叫，後端沒有多值篩選 */
const PROBLEM_STATUSES = ['failed', 'budget_exceeded', 'needs_attention', 'timeout'] as const
const POLL = 30_000

/** 後端時間多半沒帶時區（UTC）；補 Z 再轉本地 */
function parseTs(s?: string | null): Date | null {
  if (!s) return null
  const d = new Date(s.endsWith('Z') || /[+-]\d\d:\d\d$/.test(s) ? s : s + 'Z')
  return isNaN(d.getTime()) ? null : d
}
function isToday(s?: string | null): boolean {
  const d = parseTs(s)
  return !!d && d.toDateString() === new Date().toDateString()
}
const fmtTime = (s?: string | null) => parseTs(s)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) ?? ''
const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)))
const fmtUsd = (n: number) => `$${n.toFixed(n >= 10 ? 2 : 4)}`

function Card({ id, title, count, children, more }: { id: string; title: string; count?: number; children: React.ReactNode; more?: { to: string; label: string } }) {
  return (
    <section className="card p-4" data-testid={`today-${id}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-medium">{title}</h2>
        {count !== undefined && count > 0 && <span className="rounded-full bg-zinc-200 px-2 text-xs font-semibold dark:bg-zinc-700" data-testid={`today-${id}-count`}>{count}</span>}
        {more && <Link to={more.to} className="ml-auto text-xs text-zinc-600 underline dark:text-zinc-400">{more.label}</Link>}
      </div>
      {children}
    </section>
  )
}
const EmptyLine = ({ text, testId }: { text: string; testId: string }) => <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid={testId}>{text}</p>

export function TodayPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const inbox = useQuery({ queryKey: [...inboxQk, 'list'], queryFn: () => inboxApi.list(), refetchInterval: POLL })
  const problems = useQueries({
    queries: PROBLEM_STATUSES.map((st) => ({
      queryKey: ['workflow-runs', 'status', st],
      queryFn: () => request<Run[]>(`/workflow-runs?status=${st}`),
      refetchInterval: POLL,
    })),
  })
  const today = useQuery({ queryKey: [...limitsQk, 'today'], queryFn: limitsApi.today, refetchInterval: POLL })
  const limits = useQuery({ queryKey: [...limitsQk, 'list'], queryFn: limitsApi.list, refetchInterval: POLL })
  const completed = useQuery({ queryKey: ['workflow-runs', 'status', 'completed'], queryFn: () => request<Run[]>('/workflow-runs?status=completed'), refetchInterval: POLL })
  const sessions = useQuery({ queryKey: ['sessions', 'today'], queryFn: () => request<SessionLite[]>('/sessions'), refetchInterval: POLL })
  const docs = useQuery({ queryKey: ['docs', 'today'], queryFn: () => request<DocLite[]>('/docs'), refetchInterval: POLL })

  const inboxItems = inbox.data?.items ?? []
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

  const RunIcon = iconFor('Workflow')
  const ChatIcon = iconFor('MessageSquare')
  const DocIcon = iconFor('FileText')

  return (
    <div className="mx-auto max-w-6xl p-4">
      <PageHeader title={t('today.title')} subtitle={t('today.subtitle')} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card id="decide" title={t('today.decide')} count={inbox.data?.count ?? inboxItems.length} more={{ to: '/inbox', label: t('today.goInbox') }}>
          {inbox.isLoading && <Loading />}
          {inbox.error && <ErrorBox error={inbox.error} onRetry={() => inbox.refetch()} />}
          {inbox.data && inboxItems.length === 0 && <EmptyLine text={t('today.decideEmpty')} testId="today-decide-empty" />}
          <ul className="space-y-2">{inboxItems.map((it) => <InboxRow key={it.id} it={it} onDone={() => qc.invalidateQueries({ queryKey: inboxQk })} />)}</ul>
        </Card>

        <Card id="problems" title={t('today.problems')} count={problemRuns.length} more={{ to: '/workflows', label: t('today.goWorkflows') }}>
          {problemsLoading && <Loading />}
          {problemsError && <ErrorBox error={problemsError} onRetry={() => problems.forEach((q) => q.refetch())} />}
          {!problemsLoading && !problemsError && problemRuns.length === 0 && <EmptyLine text={t('today.problemsEmpty')} testId="today-problems-empty" />}
          <ul className="space-y-2">
            {problemRuns.map((r) => (
              <li key={r.id} className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm dark:border-rose-900 dark:bg-rose-950/30" data-testid={`today-run-${r.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/workflows/runs/${r.id}`} className="font-medium underline">{r.workflow_name || r.workflow_id}</Link>
                  <span className="badge bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200">{t(`today.status.${r.status}`, { defaultValue: r.status })}</span>
                  <span className="ml-auto text-xs text-zinc-600 dark:text-zinc-400">{fmtTime(r.finished_at ?? r.created_at)}</span>
                </div>
                {r.error && <div className="mt-1 line-clamp-2 text-xs text-rose-700 dark:text-rose-300">{r.error}</div>}
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
                <span className="text-2xl font-semibold" data-testid="today-cost-usd">{fmtUsd(today.data.company.usd)}</span>
                <span className="text-zinc-600 dark:text-zinc-400">{fmtTok(today.data.company.tokens)} tokens · {t('today.runs', { n: today.data.company.runs })}</span>
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
                        <span className="text-xs text-zinc-600 dark:text-zinc-400">{fmtTok(a.tokens)}</span>
                        <span className="w-16 text-right font-medium">{fmtUsd(a.usd)}</span>
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
                <Link to={`/workflows/runs/${r.id}`} className="min-w-0 flex-1 truncate underline">{r.workflow_name || r.workflow_id}</Link>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">{fmtTime(r.finished_at)}</span>
              </li>
            ))}
            {doneSessions.map((s) => (
              <li key={`s-${s.id}`} className="flex items-center gap-2" data-testid={`today-done-session-${s.id}`}>
                <ChatIcon className="h-4 w-4 shrink-0 text-indigo-600" aria-hidden />
                <Link to="/workbench" className="min-w-0 flex-1 truncate underline" title={s.preview}>{s.title || t('workbench.untitled')}</Link>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">{fmtTime(s.last_message_at)}</span>
              </li>
            ))}
            {doneDocs.map((d) => (
              <li key={`d-${d.id}`} className="flex items-center gap-2" data-testid={`today-done-doc-${d.id}`}>
                <DocIcon className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                <Link to={`/docs/${d.id}`} className="min-w-0 flex-1 truncate underline">{d.title}</Link>
                <span className="text-xs text-zinc-600 dark:text-zinc-400">{fmtTime(d.updated_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
