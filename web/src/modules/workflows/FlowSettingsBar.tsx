// 「怎麼跑」分頁底部的一條：什麼時候跑：每天 08:00 ▾   最多花多少：$1 ▾
// 點開才出現排程／webhook／上限的編輯器；老闆平常只看得到這一行的兩句話。
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useEngineerMode } from '../../prefs/engineerMode'
import { wfApi } from './api'
import { describeCron, shortTime } from './time'
import type { Budget, WorkflowEnv } from './types'

export interface FlowSettingsBarProps {
  workflowId: string
  budget: Budget
  onBudget: (b: Budget) => void
  profile: string
  profiles: string[]
  onProfile: (p: string) => void
  env?: WorkflowEnv
}

type Panel = 'when' | 'budget' | null

export function FlowSettingsBar({ workflowId, budget, onBudget, profile, profiles, onProfile, env }: FlowSettingsBarProps) {
  const { t } = useTranslation()
  const engineer = useEngineerMode()
  const [panel, setPanel] = useState<Panel>(null)
  const [cron, setCron] = useState('0 9 * * 1-5')
  const schedQ = useQuery({ queryKey: ['workflows', workflowId, 'schedules'], queryFn: () => wfApi.schedules(workflowId), enabled: !!workflowId })
  const hooksQ = useQuery({ queryKey: ['workflows', workflowId, 'webhooks'], queryFn: () => wfApi.webhooks(workflowId), enabled: !!workflowId })
  const addSchedule = useMutation({ mutationFn: () => wfApi.createSchedule(workflowId, cron), onSuccess: () => schedQ.refetch() })
  const patchSchedule = useMutation({ mutationFn: ({ sid, enabled }: { sid: string; enabled: boolean }) => wfApi.patchSchedule(sid, { enabled }), onSuccess: () => schedQ.refetch() })
  const delSchedule = useMutation({ mutationFn: (sid: string) => wfApi.deleteSchedule(sid), onSuccess: () => schedQ.refetch() })
  const addHook = useMutation({ mutationFn: () => wfApi.createWebhook(workflowId), onSuccess: () => hooksQ.refetch() })
  const delHook = useMutation({ mutationFn: (w: string) => wfApi.deleteWebhook(w), onSuccess: () => hooksQ.refetch() })

  const active = (schedQ.data ?? []).filter((s) => s.enabled)
  const hooks = hooksQ.data ?? []
  const whenText = active.length ? active.map((s) => describeCron(s.cron)).join('、') : t('wf.bar.manual')
  const whenExtra = hooks.length ? ` ＋ webhook×${hooks.length}` : ''
  const budgetText = budget.max_cost_usd != null ? `$${budget.max_cost_usd}` : budget.max_tokens != null ? `${budget.max_tokens.toLocaleString()} tokens` : t('wf.budget.none')
  const toggle = (p: Panel) => setPanel((cur) => (cur === p ? null : p))
  const setB = (k: keyof Budget, v: string) => onBudget({ ...budget, [k]: v === '' ? undefined : Number(v) })

  return (
    <div className="border-t border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-900" data-testid="flow-settings-bar">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 sm:px-4">
        <button type="button" className="btn-ghost !px-1 !py-0.5" aria-expanded={panel === 'when'} data-testid="bar-when" onClick={() => toggle('when')}>
          <span className="text-zinc-600 dark:text-zinc-400">{t('wf.bar.when')}：</span><span className="font-medium">{whenText}{whenExtra}</span> {panel === 'when' ? '▴' : '▾'}
        </button>
        <button type="button" className="btn-ghost !px-1 !py-0.5" aria-expanded={panel === 'budget'} data-testid="bar-budget" onClick={() => toggle('budget')}>
          <span className="text-zinc-600 dark:text-zinc-400">{t('wf.bar.budget')}：</span><span className="font-medium">{budgetText}</span> {panel === 'budget' ? '▴' : '▾'}
        </button>
      </div>

      {panel === 'when' && (
        <div className="mx-auto w-full max-w-3xl space-y-3 border-t border-zinc-100 px-3 py-3 text-xs dark:border-zinc-800 sm:px-4" data-testid="bar-when-panel">
          <div>
            <div className="mb-1 font-medium">{t('wf.trigger.schedule')}</div>
            <div className="flex gap-1">
              <input className="input font-mono" value={cron} onChange={(e) => setCron(e.target.value)} aria-label="cron" />
              <button type="button" className="btn-outline whitespace-nowrap !py-1 text-xs" disabled={addSchedule.isPending} onClick={() => addSchedule.mutate()}>{t('wf.trigger.addSchedule')}</button>
            </div>
            <div className="text-2xs text-zinc-600 dark:text-zinc-400">{t('wf.trigger.cronHint')}{cron.trim() ? ` → ${describeCron(cron)}` : ''}</div>
            {addSchedule.error && <div className="text-rose-600 dark:text-rose-400">{(addSchedule.error as Error).message}</div>}
            <ul className="mt-1 space-y-1">
              {schedQ.data?.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2" data-testid={`schedule-${s.id}`}>
                  <span className="font-medium">{describeCron(s.cron)}</span>
                  {engineer && <code className="text-zinc-500">{s.cron}</code>}
                  <label className="flex items-center gap-1"><input type="checkbox" checked={s.enabled} onChange={(e) => patchSchedule.mutate({ sid: s.id, enabled: e.target.checked })} />{t('wf.trigger.enabled')}</label>
                  <span className="text-zinc-600 dark:text-zinc-400">{t('wf.trigger.next')} {shortTime(s.next_run_at)}</span>
                  <button type="button" className="btn-ghost ml-auto !px-1 !py-0" aria-label={t('wf.delete')} onClick={() => delSchedule.mutate(s.id)}>✕</button>
                </li>
              ))}
              {schedQ.data?.length === 0 && <li className="text-zinc-500">{t('wf.trigger.none')}</li>}
            </ul>
          </div>
          <div>
            <div className="mb-1 font-medium">{t('wf.trigger.webhook')}</div>
            <button type="button" className="btn-outline !py-1 text-xs" onClick={() => addHook.mutate()}>{t('wf.trigger.addWebhook')}</button>
            <ul className="mt-1 space-y-1">
              {hooks.map((w) => (
                <li key={w.id} className="flex items-center gap-2">
                  <code className="min-w-0 truncate">POST {location.origin}/api{w.path}</code>
                  <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">{w.hits} {t('wf.trigger.hits')}</span>
                  <button type="button" className="btn-ghost ml-auto !px-1 !py-0" aria-label={t('wf.delete')} onClick={() => delHook.mutate(w.id)}>✕</button>
                </li>
              ))}
            </ul>
            {engineer && <div className="mt-1 text-2xs text-zinc-600 dark:text-zinc-400">body: {'{"text": "..."}'} 或任意 JSON，會當作第一步的 [外部輸入]</div>}
          </div>
        </div>
      )}

      {panel === 'budget' && (
        <div className="mx-auto w-full max-w-3xl space-y-3 border-t border-zinc-100 px-3 py-3 text-xs dark:border-zinc-800 sm:px-4" data-testid="bar-budget-panel">
          <div className="grid grid-cols-3 gap-2">
            <label>
              <span className="block text-zinc-600 dark:text-zinc-400">{t('wf.budget.maxCost')}</span>
              <input className="input" type="number" min={0} step={0.01} value={budget.max_cost_usd ?? ''} aria-label={t('wf.budget.maxCost')} onChange={(e) => setB('max_cost_usd', e.target.value)} />
            </label>
            <label>
              <span className="block text-zinc-600 dark:text-zinc-400">{t('wf.budget.maxTokens')}</span>
              <input className="input" type="number" min={0} step={1} value={budget.max_tokens ?? ''} aria-label={t('wf.budget.maxTokens')} onChange={(e) => setB('max_tokens', e.target.value)} />
            </label>
            <label>
              <span className="block text-zinc-600 dark:text-zinc-400">{t('wf.budget.deadline')}</span>
              <input className="input" type="number" min={0} step={1} value={budget.deadline_seconds ?? ''} aria-label={t('wf.budget.deadline')} onChange={(e) => setB('deadline_seconds', e.target.value)} />
            </label>
          </div>
          {engineer && (
            <div>
              <span className="block text-zinc-600 dark:text-zinc-400">{t('wf.profile')}</span>
              <select className="input !w-auto" value={profile} aria-label={t('wf.profile')} onChange={(e) => onProfile(e.target.value)}>
                <option value="">{t('wf.allProfiles')}</option>
                {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}
          {engineer && env && (
            <div className="text-zinc-600 dark:text-zinc-400">
              coding agents: {Object.entries(env.coding_tools).map(([k, v]) => `${k}${v.installed ? ' ✓' : ' ✗'}`).join('、')} · LINE {env.line_configured ? '✓' : '✗'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
