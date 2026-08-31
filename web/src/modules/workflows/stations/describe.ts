// 一張站卡要回答的四件事怎麼講成人話：誰做／做什麼／產出什麼／完成條件。
// 介面上不出現 node／edge／gate／DAG，這裡就是那層翻譯。
import type { Agent } from '../../../api/types'
import type { NodeKind, NodeStatus, WfNode } from '../types'

export type Light = 'pending' | 'running' | 'completed' | 'waiting_approval' | 'failed'

/** 執行狀態收斂成 5 盞燈（其餘一律歸到最接近的那盞）。 */
export function lightOf(status?: NodeStatus | string): Light {
  switch (status) {
    case 'running':
      return 'running'
    case 'waiting_approval':
      return 'waiting_approval'
    case 'completed':
    case 'reused':
      return 'completed'
    case 'failed':
    case 'timeout':
    case 'outcome_unknown':
      return 'failed'
    default:
      return 'pending'
  }
}

export const LIGHT_DOT: Record<Light, string> = {
  pending: 'bg-zinc-300 dark:bg-zinc-600',
  running: 'bg-sky-500 animate-pulse',
  completed: 'bg-emerald-500',
  waiting_approval: 'bg-amber-500',
  failed: 'bg-rose-500',
}
export const LIGHT_BADGE: Record<Light, string> = {
  pending: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  waiting_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
}
/** 卡片外框：等你確認時要「浮起來」 */
export const LIGHT_CARD: Record<Light, string> = {
  pending: '',
  running: 'ring-2 ring-sky-400 dark:ring-sky-500',
  completed: '',
  waiting_approval: 'ring-2 ring-amber-400 shadow-lg dark:ring-amber-500',
  failed: 'ring-2 ring-rose-400 dark:ring-rose-500',
}

type T = (k: string, o?: Record<string, unknown>) => string

/** 誰做這一站：AI 員工挑得出人就顯示人，挑不出就講「你」或「系統」。 */
export function whoOf(node: WfNode, kind: NodeKind, agents: Agent[], t: T): string {
  if (kind === 'gate') return t('wf.station.who_.human')
  if (kind === 'delivery' || kind === 'loop') return t('wf.station.who_.system')
  if (kind === 'coding-agent') return `${node.tool ?? 'claude-code'}${node.cwd ? ` · ${node.cwd}` : ''}`
  if (kind === 'condition' && node.mode !== 'ai') return t('wf.station.who_.rule')
  const a = agents.find((x) => x.id === node.agent_id)
  if (a) return a.title ? `${a.name}（${a.title}）` : a.name
  return node.profile || t('wf.station.who_.unset')
}

/** 這一站產出什麼（也是連接線上「帶著：〇〇」的內容）。 */
export function outputOf(node: WfNode, kind: NodeKind, t: T): string {
  const io = (node as { io_mode?: string }).io_mode
  switch (kind) {
    case 'hermes':
      return io === 'doc' ? t('wf.station.out.doc') : t('wf.station.out.text')
    case 'coding-agent':
      return t('wf.station.out.files', { cwd: node.cwd || '~' })
    case 'gate':
      return t('wf.station.out.passthrough')
    case 'condition':
      return t('wf.station.out.branch')
    case 'loop':
      return t('wf.station.out.repeat', { n: node.max_iterations ?? 3 })
    case 'delivery':
      if (node.channel === 'line') return t('wf.station.out.line', { to: node.to || '—' })
      if (node.channel === 'webhook') return t('wf.station.out.webhook', { url: node.url || '—' })
      return t('wf.station.out.file', { path: node.path || 'out/{run_id}.md' })
    default:
      return t('wf.station.out.text')
  }
}

/** 完成條件（沒設就回 null，卡片上不佔位）。 */
export function doneOf(node: WfNode, kind: NodeKind, t: T): string | null {
  if (kind === 'loop') {
    const until = node.until
    return until ? t('wf.station.done.until', { op: until.op, value: until.value ?? until.path ?? '' }) : t('wf.station.done.countOnly', { n: node.max_iterations ?? 3 })
  }
  if (node.done_check) return t('wf.station.done.selfCheck', { n: node.done_check_max_rounds ?? 3 })
  return null
}

/** 有沒有「指令」可以直接在卡片上改。 */
export const HAS_PROMPT: NodeKind[] = ['hermes', 'coding-agent', 'condition']
/** 可以在卡片上換 AI 員工的站。 */
export const HAS_AGENT: NodeKind[] = ['hermes', 'condition']

export const STATION_KINDS: NodeKind[] = ['hermes', 'coding-agent', 'gate', 'condition', 'loop', 'delivery']
