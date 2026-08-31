import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAgents, useDeleteAgent, useSaveSoul, useSkills, useSoul, useUpdateAgent } from '../api/hooks'
import { PageHeader } from '../components/PageHeader'
import { CollapsiblePanel, PanelGroup, WorkArea } from '../components/layout/index'
import { Empty, ErrorBox, Loading } from '../components/QueryState'
import { CreateAgentDialog } from '../components/agents/CreateAgentDialog'
import { RuntimeBadge, isCoding } from '../components/agents/RuntimeBadge'
import { ProfilesPanel, useProfiles } from '../modules/profiles'

export function AgentsPage() {
  const { t } = useTranslation()
  const agentsQ = useAgents()
  const [selected, setSelected] = useState<string | undefined>()
  const agent = agentsQ.data?.find((a) => a.id === selected)
  const hermesSelected = agent && !agent.runtime ? true : agent?.runtime === 'hermes'
  const soulQ = useSoul(hermesSelected ? selected : undefined)
  const skillsQ = useSkills(hermesSelected ? selected : undefined)
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

  return (
    <PanelGroup>
      <CollapsiblePanel id="agents.list" side="left" title={t('panels.agentList')} icon="Bot" defaultWidth={320} min={220} max={480} bodyClassName="overflow-auto p-4">
        <PageHeader title={t('agents.title')} subtitle={t('agents.subtitle')} />
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
                  {!isCoding(a) && a.profile !== a.name && (
                    <code className="id-text shrink text-zinc-600 dark:text-zinc-400" title={a.profile}>{a.profile}</code>
                  )}
                  <RuntimeBadge agent={a} />
                  <span className={`badge ml-auto text-[10px] ${a.enabled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'}`}>
                    {a.enabled ? t('agents.enabled') : t('agents.disabled')}
                  </span>
                </div>
                <div className="truncate text-xs text-zinc-600 dark:text-zinc-400" title={isCoding(a) ? a.workspace : `${a.title ?? ''} · ${a.model ?? ''}`}>
                  {isCoding(a) ? (a.workspace || '—') : `${a.title} · ${a.model ?? t('common.unknown')}`}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <details className="mt-4" data-testid="profiles-panel">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{t('profiles.title')}</summary>
          <div className="mt-2"><ProfilesPanel compact /></div>
        </details>
      </CollapsiblePanel>
      <WorkArea className="overflow-auto p-4">
        {!agent ? (
          <Empty text={t('agents.selectOne')} />
        ) : (
          <div className="mx-auto max-w-4xl space-y-4">
            <div className="card p-4">
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-0 flex-1 basis-48">
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    {agent.name}
                    <RuntimeBadge agent={agent} />
                  </h2>
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
              <dl className="mt-3 grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-zinc-600 dark:text-zinc-400">{coding ? t('agents.runtime') : t('agents.profile')}</dt>
                  <dd><code className="id-text" title={coding ? agent.runtime : agent.profile}>{coding ? agent.runtime : agent.profile}</code></dd>
                </div>
                <div className="min-w-0"><dt className="text-zinc-600 dark:text-zinc-400">{t('agents.titleField')}</dt><dd className="truncate" title={agent.title ?? undefined}>{agent.title ?? '—'}</dd></div>
                <div className="min-w-0"><dt className="text-zinc-600 dark:text-zinc-400">{t('agents.model')}</dt><dd className="truncate" title={agent.model ?? undefined}>{agent.model || '—'}</dd></div>
              </dl>
              {coding && (
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
                    <dd><pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-100 p-2 text-[11px] dark:bg-zinc-800">{JSON.stringify(agent.coding_config?.extra ?? {}, null, 1)}</pre></dd>
                  </div>
                </dl>
              )}
              <div className="mt-3 text-right">
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

            {coding ? (
              <div className="card p-4 text-sm text-zinc-600 dark:text-zinc-400" data-testid="coding-no-soul">{t('agents.noSoulForCoding')}</div>
            ) : (
            <div className="card p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-medium">{t('agents.soul')}</h3>
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

            )}

            {!coding && (
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
            )}
          </div>
        )}
      </WorkArea>
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
