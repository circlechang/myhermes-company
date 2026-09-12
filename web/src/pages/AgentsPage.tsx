import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAgentDossier, useAgents, useDeleteAgent, useSaveSoul, useSkills, useSoul, useUpdateAgent } from '../api/hooks'
import type { Agent, AgentDossier, DossierRecent } from '../api/types'
import { PageHeader } from '../components/PageHeader'
import { CollapsiblePanel, PanelGroup, WorkArea } from '../components/layout/index'
import { useIsMobile } from '../components/nav/useNavState'
import { Empty, ErrorBox, Loading } from '../components/QueryState'
import { CreateAgentDialog } from '../components/agents/CreateAgentDialog'
import { RuntimeBadge, isCoding } from '../components/agents/RuntimeBadge'
import { ProfilesPanel, useProfiles } from '../modules/profiles'
import { useEngineerMode } from '../prefs/engineerMode'

const DOSSIER_DAYS = 7
type Tab = 'dossier' | 'soul'

/** 老闆看的是「花多少」不是「幾個 token」：美元兩位小數，token 以 k 顯示 */
const fmtUsd = (n: number) => n.toFixed(2)
const fmtTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function useRelativeTime() {
  const { t } = useTranslation()
  return (iso: string | null) => {
    if (!iso) return ''
    const diff = Math.max(0, Date.now() - new Date(iso).getTime())
    const min = Math.floor(diff / 60_000)
    if (min < 1) return t('agents.dossier.justNow')
    if (min < 60) return t('agents.dossier.minutesAgo', { n: min })
    const h = Math.floor(min / 60)
    if (h < 24) return t('agents.dossier.hoursAgo', { n: h })
    return t('agents.dossier.daysAgo', { n: Math.floor(h / 24) })
  }
}

const KIND_ICON: Record<DossierRecent['kind'], string> = { chat: '💬', workflow: '⚙️', doc: '📄' }
const STATUS_CLASS: Record<string, string> = {
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  reused: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
}

function StatTile({ id, label, value, sub, warn }: { id: string; label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border px-3 py-2 dark:border-zinc-700" data-testid={`dossier-stat-${id}`}>
      <div className="text-xs text-zinc-600 dark:text-zinc-400">{label}</div>
      <div className={`truncate text-lg font-semibold ${warn ? 'text-rose-600 dark:text-rose-400' : ''}`}>{value}</div>
      <div className="truncate text-xs text-zinc-500 dark:text-zinc-500">{sub}</div>
    </div>
  )
}

function DossierBody({ agent, d, engineer }: { agent: Agent; d: AgentDossier; engineer: boolean }) {
  const { t } = useTranslation()
  const rel = useRelativeTime()
  const coding = isCoding(agent)
  const idle = d.chat.sessions === 0 && d.workflow.node_runs === 0 && d.usage.total_tokens === 0 && d.approvals.requested === 0 && d.docs.versions === 0
  const statusLabel = (s: string) => (s ? t(`agents.dossier.status.${s}`, { defaultValue: s }) : '')
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{t('agents.dossier.range', { days: d.days })}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile id="chat" label={t('agents.dossier.statChat')} value={t('agents.dossier.statChatValue', { n: d.chat.sessions })} sub={t('agents.dossier.statChatSub', { n: d.chat.messages })} />
        <StatTile id="workflow" label={t('agents.dossier.statWorkflow')} value={t('agents.dossier.statWorkflowValue', { n: d.workflow.node_runs })} sub={t('agents.dossier.statWorkflowSub', { n: d.workflow.failed })} warn={d.workflow.failed > 0} />
        <StatTile id="usage" label={t('agents.dossier.statUsage')} value={t('agents.dossier.statUsageValue', { usd: fmtUsd(d.usage.cost_usd) })} sub={t('agents.dossier.statUsageSub', { tokens: fmtTokens(d.usage.total_tokens) })} />
        <StatTile id="approvals" label={t('agents.dossier.statApprovals')} value={t('agents.dossier.statApprovalsValue', { n: d.approvals.rejected })} sub={t('agents.dossier.statApprovalsSub', { n: d.approvals.requested })} warn={d.approvals.rejected > 0} />
      </div>

      {idle ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400" data-testid="dossier-empty">
          {t('agents.dossier.empty', { days: d.days })}{' '}
          <Link to="/workbench" className="underline">{t('agents.dossier.goWorkbench')}</Link>
        </div>
      ) : (
        <div>
          <h3 className="mb-2 font-medium">{t('agents.dossier.recentTitle')}</h3>
          <ul className="divide-y rounded-md border dark:divide-zinc-700 dark:border-zinc-700" data-testid="dossier-recent">
            {d.recent.map((r, i) => (
              <li key={`${r.kind}-${i}`}>
                <Link to={r.link} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800/60">
                  <span title={t(`agents.dossier.kind${r.kind === 'chat' ? 'Chat' : r.kind === 'workflow' ? 'Workflow' : 'Doc'}`)}>{KIND_ICON[r.kind]}</span>
                  <span className="min-w-0 flex-1 truncate" title={r.title}>{r.title}</span>
                  {r.status && <span className={`badge text-2xs ${STATUS_CLASS[r.status] ?? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'}`}>{statusLabel(r.status)}</span>}
                  <span className="shrink-0 text-xs text-zinc-500">{rel(r.at)}</span>
                </Link>
              </li>
            ))}
          </ul>
          {d.docs.versions > 0 && (
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400" data-testid="dossier-docs">
              {t('agents.dossier.docsLine', { days: d.days, versions: d.docs.versions, docs: d.docs.docs })}{' '}
              <Link to="/docs" className="underline">{t('agents.dossier.docsLink')}</Link>
            </p>
          )}
        </div>
      )}

      {engineer && (
        <dl className="grid grid-cols-1 gap-3 border-t pt-3 text-xs dark:border-zinc-700 sm:grid-cols-3" data-testid="dossier-system">
          <div className="min-w-0 sm:col-span-3 text-zinc-500">{t('agents.dossier.system')}</div>
          <div className="min-w-0">
            <dt className="text-zinc-600 dark:text-zinc-400">{coding ? t('agents.runtime') : t('agents.profile')}</dt>
            <dd><code className="id-text" title={coding ? agent.runtime : agent.profile}>{coding ? agent.runtime : agent.profile}</code></dd>
          </div>
          <div className="min-w-0"><dt className="text-zinc-600 dark:text-zinc-400">{t('agents.model')}</dt><dd className="truncate" title={agent.model ?? undefined}>{agent.model || '—'}</dd></div>
          {coding && (
            <div className="min-w-0"><dt className="text-zinc-600 dark:text-zinc-400">{t('agents.workspace')}</dt><dd><code className="id-text truncate" title={agent.workspace}>{agent.workspace || '—'}</code></dd></div>
          )}
        </dl>
      )}
    </div>
  )
}

export function AgentsPage() {
  const { t } = useTranslation()
  const engineer = useEngineerMode()
  // 手機：清單優先。沒選人就整頁是清單；點了才進人事檔案，左上角「‹ 員工」回清單
  const isMobile = useIsMobile()
  const agentsQ = useAgents()
  const [selected, setSelected] = useState<string | undefined>()
  const [tab, setTab] = useState<Tab>('dossier')
  const agent = agentsQ.data?.find((a) => a.id === selected)
  const hermesSelected = agent && !agent.runtime ? true : agent?.runtime === 'hermes'
  const soulQ = useSoul(hermesSelected ? selected : undefined)
  const skillsQ = useSkills(hermesSelected ? selected : undefined)
  const dossierQ = useAgentDossier(selected, DOSSIER_DAYS)
  const save = useSaveSoul(selected ?? '')
  const updateAgent = useUpdateAgent()
  const removeAgent = useDeleteAgent()
  const profilesQ = useProfiles()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState('')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const coding = agent ? isCoding(agent) : false

  useEffect(() => {
    if (soulQ.data) setDraft(soulQ.data.content)
  }, [soulQ.data])

  const dirty = soulQ.data ? draft !== soulQ.data.content : false
  // 左欄副標：老闆模式只看職稱；工程師模式才露模型 id。coding 員工的工作目錄就是他的身分（哪個 repo），照舊顯示
  const subtitleOf = (a: Agent) => (isCoding(a) ? (a.workspace || '—') : engineer ? `${a.title} · ${a.model ?? t('common.unknown')}` : (a.title || a.description || '—'))

  const showList = !isMobile || !selected
  const showDetail = !isMobile || !!selected

  return (
    <PanelGroup>
      {showList && (
      <CollapsiblePanel id="agents.list" side="left" title={t('panels.agentList')} icon="Bot" defaultWidth={320} min={220} max={480} bodyClassName="overflow-auto p-4" mobileMode="inline">
        <PageHeader title={t('agents.title')} subtitle={engineer ? t('agents.subtitle') : t('agents.subtitleBoss')} />
        <button type="button" className="btn-primary mb-2 w-full text-xs" onClick={() => setCreating(true)} data-testid="new-agent">
          ＋ {t('agents.newAgent')}
        </button>
        {agentsQ.isLoading && <Loading />}
        {agentsQ.error && <ErrorBox error={agentsQ.error} onRetry={() => agentsQ.refetch()} />}
        {agentsQ.data?.length === 0 && <Empty />}
        <ul className="space-y-1" data-testid="agents-list">
          {agentsQ.data?.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setSelected(a.id)}
                className={`w-full rounded-md px-3 py-2 text-left ${a.id === selected ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-medium" title={a.name}>{a.name}</span>
                  {engineer && !isCoding(a) && a.profile !== a.name && (
                    <code className="id-text shrink text-zinc-600 dark:text-zinc-400" title={a.profile}>{a.profile}</code>
                  )}
                  <RuntimeBadge agent={a} />
                  <span className={`badge ml-auto text-2xs ${a.enabled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'}`}>
                    {a.enabled ? t('agents.enabled') : t('agents.disabled')}
                  </span>
                </div>
                <div className="truncate text-xs text-zinc-600 dark:text-zinc-400" title={subtitleOf(a)}>{subtitleOf(a)}</div>
              </button>
            </li>
          ))}
        </ul>
        {/* PROFILE 管理：<details> 沒有 open，手機／桌面一律先收著 */}
        <details className="mt-4" data-testid="profiles-panel">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{t('profiles.title')}</summary>
          <div className="mt-2"><ProfilesPanel compact /></div>
        </details>
      </CollapsiblePanel>
      )}
      {showDetail && (
      <WorkArea className="overflow-auto p-4">
        {isMobile && (
          <button type="button" className="btn-ghost mb-2 self-start !px-1.5 text-xs" onClick={() => setSelected(undefined)} aria-label={t('panels.backToAgents')} data-testid="mobile-back">
            ‹ {t('panels.backToAgents')}
          </button>
        )}
        {!agent ? (
          <Empty text={engineer ? t('agents.selectOne') : t('agents.dossier.selectOne')} />
        ) : (
          <div className="mx-auto max-w-4xl space-y-4">
            <div className="card p-4">
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-0 flex-1 basis-48">
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    {agent.name}
                    <RuntimeBadge agent={agent} />
                  </h2>
                  {agent.title && <div className="text-sm text-zinc-700 dark:text-zinc-300" data-testid="agent-title">{agent.title}</div>}
                  <p className="line-clamp-3 text-sm text-zinc-600 dark:text-zinc-400" title={agent.description || undefined}>{agent.description || t('common.none')}</p>
                </div>
                <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm">
                  <input
                    type="checkbox"
                    checked={agent.enabled}
                    onChange={(e) => updateAgent.mutate({ id: agent.id, body: { enabled: e.target.checked } })}
                  />
                  {t('agents.enabled')}
                </label>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2 border-t pt-3 dark:border-zinc-700">
                <div className="flex gap-1 text-sm" role="tablist">
                  {(['dossier', 'soul'] as Tab[]).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={tab === k}
                      data-testid={`agent-tab-${k}`}
                      onClick={() => setTab(k)}
                      className={`rounded-md px-3 py-1 ${tab === k ? 'bg-zinc-200 font-medium dark:bg-zinc-700' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
                    >
                      {k === 'dossier' ? t('agents.dossier.tab') : t('agents.dossier.soulTab')}
                    </button>
                  ))}
                </div>
                {coding && <Link to="/coding" className="btn-ghost text-xs" data-testid="agent-open-coding">{t('agents.openCoding')}</Link>}
                <button
                  type="button"
                  className="btn-ghost text-xs text-rose-600 dark:text-rose-400"
                  data-testid="delete-agent"
                  onClick={() => { if (window.confirm(t('agents.confirmDelete'))) { removeAgent.mutate(agent.id); setSelected(undefined) } }}
                >
                  {t('agents.delete')}
                </button>
              </div>
            </div>

            {tab === 'dossier' && (
              <div className="card p-4" data-testid="agent-dossier">
                {dossierQ.isLoading && <Loading />}
                {dossierQ.error && <ErrorBox error={dossierQ.error} onRetry={() => dossierQ.refetch()} />}
                {dossierQ.data && <DossierBody agent={agent} d={dossierQ.data} engineer={engineer} />}
              </div>
            )}

            {tab === 'soul' && coding && (
              <div className="card p-4">
                <div className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="coding-no-soul">{t('agents.noSoulForCoding')}</div>
                <dl className="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2" data-testid="coding-settings">
                  <div className="min-w-0">
                    <dt className="text-zinc-600 dark:text-zinc-400">{t('agents.workspace')}</dt>
                    <dd className="flex items-center gap-2">
                      <code className="id-text truncate" title={agent.workspace}>{agent.workspace || '—'}</code>
                      <Link className="shrink-0 whitespace-nowrap underline" to={`/files?path=${encodeURIComponent(agent.workspace_vpath ?? '')}`} data-testid="open-workspace">
                        {t('agents.openWorkspace')}
                      </Link>
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-zinc-600 dark:text-zinc-400">{t('agents.apiMode')}</dt>
                    <dd>{agent.coding_config?.api_mode === 'hermes' ? t('agents.apiModeHermes') : t('agents.apiModeDirect')}</dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-zinc-600 dark:text-zinc-400">{t('agents.codingSettings')}</dt>
                    <dd><pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-800">{JSON.stringify(agent.coding_config?.extra ?? {}, null, 1)}</pre></dd>
                  </div>
                </dl>
              </div>
            )}

            {tab === 'soul' && !coding && (
              <>
                <div className="card p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="font-medium">{engineer ? t('agents.soul') : t('agents.dossier.soulTab')}</h3>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('agents.soulHint')}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <Link
                        to={`/soul-history?profile=${encodeURIComponent(agent.profile)}`}
                        className="whitespace-nowrap text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
                        data-testid="soul-history-link"
                      >
                        {t('agents.soulHistory')}
                      </Link>
                      {savedAt && !dirty && <span className="text-emerald-600 dark:text-emerald-400">{t('common.saved')}</span>}
                      <button
                        className="btn-primary"
                        disabled={!dirty || save.isPending}
                        onClick={() => save.mutateAsync(draft).then(() => setSavedAt(Date.now()))}
                      >
                        {t('agents.saveSoul')}
                      </button>
                    </div>
                  </div>
                  {soulQ.isLoading && <Loading />}
                  {soulQ.error && <ErrorBox error={soulQ.error} onRetry={() => soulQ.refetch()} />}
                  {save.error && <ErrorBox error={save.error} />}
                  <textarea
                    aria-label={t('agents.soul')}
                    className="input min-h-[360px] font-mono text-xs"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                  />
                </div>

                <div className="card p-4">
                  <h3 className="mb-2 font-medium">{t('agents.skills')}</h3>
                  {skillsQ.isLoading && <Loading />}
                  {(skillsQ.error || skillsQ.data?.length === 0) && <Empty text={t('agents.noSkills')} />}
                  <ul className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 md:grid-cols-3">
                    {skillsQ.data?.map((s) => (
                      <li key={s.name} className={`min-w-0 rounded-md border px-2 py-1.5 dark:border-zinc-700 ${s.enabled ? '' : 'opacity-50'}`}>
                        <code className="id-text" title={s.name}>{s.name}</code>
                        <div className="line-clamp-3 text-xs text-zinc-600 dark:text-zinc-400" title={s.description}>{s.description}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </div>
        )}
      </WorkArea>
      )}
      {creating && (
        <CreateAgentDialog
          profiles={(profilesQ.data?.profiles ?? []).map((p) => p.name)}
          onClose={() => setCreating(false)}
          onCreated={(id) => setSelected(id)}
        />
      )}
    </PanelGroup>
  )
}
