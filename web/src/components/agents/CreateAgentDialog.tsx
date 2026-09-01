import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useCreateAgent, useRuntimes } from '../../api/hooks'
import type { AgentRuntime } from '../../api/types'
import { ErrorBox } from '../QueryState'
import { LABELS } from './RuntimeBadge'

/** 新增 AI 員工：選執行環境（Hermes → 綁 profile；coding → 選工作目錄與模型）。
 *  未安裝的 coding runtime 選得到、但選了就擋住建立，並把安裝指令印出來。 */
export function CreateAgentDialog({ profiles, onClose, onCreated }: {
  profiles: string[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const { t } = useTranslation()
  const runtimesQ = useRuntimes()
  const create = useCreateAgent()
  const [runtime, setRuntime] = useState<AgentRuntime>('hermes')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [profile, setProfile] = useState(profiles[0] ?? '')
  const [workspace, setWorkspace] = useState('')
  const [model, setModel] = useState('')
  const [apiMode, setApiMode] = useState<'direct' | 'hermes'>('direct')

  const options = runtimesQ.data?.runtimes ?? [{ id: 'hermes' as const, name: 'Hermes', installed: true, install_cmd: '', kind: 'hermes' as const }]
  const picked = useMemo(() => options.find((o) => o.id === runtime), [options, runtime])
  const coding = runtime !== 'hermes'
  const notInstalled = coding && picked?.installed === false
  const canSubmit = !!name.trim() && !notInstalled && (coding ? !!workspace.trim() : !!profile) && !create.isPending

  const submit = async () => {
    const body: Record<string, unknown> = { name: name.trim(), title: title.trim(), runtime, enabled: true }
    if (coding) {
      body.workspace = workspace.trim()
      body.coding_config = { model: model.trim(), api_mode: apiMode }
      body.model = model.trim()
    } else {
      body.profile = profile
    }
    const a = await create.mutateAsync(body)
    onCreated(a.id)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onClose} data-testid="create-agent-dialog">
      <div className="card w-full max-w-lg space-y-3 p-4 text-sm shadow-xl" role="dialog" aria-label={t('agents.createTitle')} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between font-medium">
          <span>{t('agents.createTitle')}</span>
          <button type="button" className="btn-ghost text-xs" onClick={onClose} aria-label={t('common.close')}>✕</button>
        </div>

        <label className="block">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('agents.name')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label={t('agents.name')} data-testid="new-agent-name" />
        </label>
        <label className="block">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('agents.titleField')}</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('agents.titleField')} />
        </label>

        <label className="block">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('agents.runtime')}</span>
          <select
            className="input"
            value={runtime}
            aria-label={t('agents.runtime')}
            data-testid="new-agent-runtime"
            onChange={(e) => setRuntime(e.target.value as AgentRuntime)}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id} data-testid={`runtime-option-${o.id}`}>
                {(o.name || LABELS[o.id]) + (o.installed ? '' : ` — ${t('agents.notInstalled')}`)}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-zinc-600 dark:text-zinc-400">{t('agents.runtimeHint')}</span>
        </label>

        {notInstalled && (
          <div className="rounded-md border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200" data-testid="runtime-not-installed">
            {t('agents.installHint')}
            <code className="ml-1 select-all">{picked?.install_cmd}</code>
          </div>
        )}

        {!coding ? (
          <label className="block">
            <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('agents.profile')}</span>
            <select className="input" value={profile} onChange={(e) => setProfile(e.target.value)} aria-label={t('agents.profile')} data-testid="new-agent-profile">
              {profiles.map((p) => (<option key={p} value={p}>{p}</option>))}
            </select>
          </label>
        ) : (
          <>
            <label className="block">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('agents.workspace')}</span>
              <input className="input font-mono text-xs" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="/path/to/repo" aria-label={t('agents.workspace')} data-testid="new-agent-workspace" />
              <span className="mt-1 block text-xs text-zinc-600 dark:text-zinc-400">{t('agents.workspaceHint')}</span>
              {!!runtimesQ.data?.workspace_roots?.length && (
                <ul className="mt-1 max-h-24 space-y-0.5 overflow-auto rounded border border-zinc-200 p-1 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400" data-testid="workspace-roots">
                  {runtimesQ.data.workspace_roots.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="underline hover:text-zinc-800 dark:hover:text-zinc-200" onClick={() => setWorkspace(r.path)}>{r.path}</button>
                    </li>
                  ))}
                </ul>
              )}
            </label>
            <label className="block">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('agents.model')}</span>
              <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="sonnet" aria-label={t('agents.model')} data-testid="new-agent-model" />
            </label>
            <label className="block">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">{t('agents.apiMode')}</span>
              <select className="input" value={apiMode} onChange={(e) => setApiMode(e.target.value as 'direct' | 'hermes')} aria-label={t('agents.apiMode')}>
                <option value="direct">{t('agents.apiModeDirect')}</option>
                <option value="hermes">{t('agents.apiModeHermes')}</option>
              </select>
            </label>
          </>
        )}

        {create.error && <ErrorBox error={create.error} />}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-outline" onClick={onClose}>{t('agents.cancel')}</button>
          <button type="button" className="btn-primary" disabled={!canSubmit} onClick={() => void submit()} data-testid="new-agent-submit">
            {t('agents.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
