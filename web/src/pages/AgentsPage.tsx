import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAgents, useSaveSoul, useSkills, useSoul, useUpdateAgent } from '../api/hooks'
import { PageHeader } from '../components/PageHeader'
import { Empty, ErrorBox, Loading } from '../components/QueryState'
import { ProfilesPanel } from '../modules/profiles'

export function AgentsPage() {
  const { t } = useTranslation()
  const agentsQ = useAgents()
  const [selected, setSelected] = useState<string | undefined>()
  const agent = agentsQ.data?.find((a) => a.id === selected)
  const soulQ = useSoul(selected)
  const skillsQ = useSkills(selected)
  const save = useSaveSoul(selected ?? '')
  const updateAgent = useUpdateAgent()
  const [draft, setDraft] = useState('')
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (soulQ.data) setDraft(soulQ.data.content)
  }, [soulQ.data])

  const dirty = soulQ.data ? draft !== soulQ.data.content : false

  return (
    <div className="grid min-h-full grid-cols-1 md:h-full md:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="min-h-0 min-w-0 border-b border-zinc-200 p-4 md:overflow-auto md:border-b-0 md:border-r dark:border-zinc-800">
        <PageHeader title={t('agents.title')} subtitle={t('agents.subtitle')} />
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
                  <code className="id-text shrink text-zinc-600 dark:text-zinc-400" title={a.profile}>{a.profile}</code>
                  <span className={`badge ml-auto text-[10px] ${a.enabled ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'}`}>
                    {a.enabled ? t('agents.enabled') : t('agents.disabled')}
                  </span>
                </div>
                <div className="truncate text-xs text-zinc-600 dark:text-zinc-400" title={`${a.title ?? ''} · ${a.model ?? ''}`}>{a.title} · {a.model ?? t('common.unknown')}</div>
              </button>
            </li>
          ))}
        </ul>
        <details className="mt-4" data-testid="profiles-panel">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{t('profiles.title')}</summary>
          <div className="mt-2"><ProfilesPanel compact /></div>
        </details>
      </aside>
      <section className="min-h-0 min-w-0 p-4 md:overflow-auto">
        {!agent ? (
          <Empty text={t('agents.selectOne')} />
        ) : (
          <div className="mx-auto max-w-4xl space-y-4">
            <div className="card p-4">
              <div className="flex flex-wrap items-start gap-4">
                <div className="min-w-0 flex-1 basis-48">
                  <h2 className="text-lg font-semibold">{agent.name}</h2>
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
                <div className="min-w-0"><dt className="text-zinc-600 dark:text-zinc-400">{t('agents.profile')}</dt><dd><code className="id-text" title={agent.profile}>{agent.profile}</code></dd></div>
                <div className="min-w-0"><dt className="text-zinc-600 dark:text-zinc-400">{t('agents.titleField')}</dt><dd className="truncate" title={agent.title ?? undefined}>{agent.title ?? '—'}</dd></div>
                <div className="min-w-0"><dt className="text-zinc-600 dark:text-zinc-400">{t('agents.model')}</dt><dd className="truncate" title={agent.model ?? undefined}>{agent.model ?? '—'}</dd></div>
              </dl>
            </div>

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
          </div>
        )}
      </section>
    </div>
  )
}
