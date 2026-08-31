import { useTranslation } from 'react-i18next'
import type { Agent, AgentRuntime } from '../../api/types'

const STYLES: Record<AgentRuntime, string> = {
  hermes: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
  'claude-code': 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200',
  codex: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  pi: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-200',
}

export const LABELS: Record<AgentRuntime, string> = {
  hermes: 'Hermes',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
}

export function runtimeOf(a: Pick<Agent, 'runtime'>): AgentRuntime {
  return (a.runtime ?? 'hermes') as AgentRuntime
}

export const isCoding = (a: Pick<Agent, 'runtime'>) => runtimeOf(a) !== 'hermes'

type BadgeAgent = Pick<Agent, 'runtime' | 'runtime_name' | 'installed'>

/** 員工卡上的執行環境徽章；coding 員工的 CLI 沒安裝時直接標紅寫「未安裝」。 */
export function RuntimeBadge({ agent, className = '' }: { agent: BadgeAgent; className?: string }) {
  const { t } = useTranslation()
  const rt = runtimeOf(agent)
  const missing = rt !== 'hermes' && agent.installed === false
  const label = agent.runtime_name || LABELS[rt]
  return (
    <span
      className={`badge shrink-0 text-[10px] ${missing ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200' : STYLES[rt]} ${className}`}
      data-testid={`runtime-badge-${rt}`}
      title={label}
    >
      {missing ? `${label} · ${t('agents.notInstalled')}` : label}
    </span>
  )
}
