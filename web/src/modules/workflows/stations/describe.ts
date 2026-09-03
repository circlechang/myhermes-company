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
  if (kind === 'condition' && node.mode !== 'ai') return t('wf.station.who_.rule')
  const a = agents.find((x) => x.id === node.agent_id)
  if (a) {
    const suffix = a.runtime && a.runtime !== 'hermes' ? `（${a.runtime_name ?? a.runtime}）` : a.title ? `（${a.title}）` : ''
    return `${a.name}${suffix}`
  }
  // 跑程式的那一步沒綁員工：退回顯示工具名
  if (kind === 'coding-agent') return `${node.tool ?? 'claude-code'}${node.cwd ? ` · ${node.cwd}` : ''}`
  return node.profile || t('wf.station.who_.unset')
}

/** 收起來那一行的「誰」：只要名字，不帶職稱（研究員／你／送到 LINE） */
export function whoShort(node: WfNode, kind: NodeKind, agents: Agent[], t: T): string {
  if (kind === 'gate') return t('wf.station.who_.human')
  if (kind === 'delivery') {
    const ch = node.channel ?? 'file'
    const target = ch === 'line' ? node.to : ch === 'webhook' ? node.url : node.path
    return `${t(`wf.station.deliver.${ch}`)}${target ? ` · ${target}` : ''}`
  }
  if (kind === 'loop') return t('wf.station.who_.system')
  if (kind === 'condition' && node.mode !== 'ai') return t('wf.station.who_.rule')
  const a = agents.find((x) => x.id === node.agent_id)
  if (a) return a.name
  if (kind === 'coding-agent') return node.tool ?? 'claude-code'
  return node.profile || t('wf.station.who_.unset')
}

/** 收起來那一行的「做什麼」：指令第一行（≤ max 字），沒指令就用步名 */
export function whatShort(node: WfNode, kind: NodeKind, max = 60): string {
  // 送出去／等我看的「誰」已經把去向講完了（送到 LINE · 行銷組），不再重複步名
  if (kind === 'delivery' || kind === 'gate') return ''
  const src = kind === 'hermes' || kind === 'coding-agent' || (kind === 'condition' && node.mode === 'ai') ? node.prompt : ''
  const line = (src ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  const text = line || node.title || ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 清單卡片上的參與者鏈：研究員 → 你 → 小編 → LINE */
export function participantOf(node: WfNode, kind: NodeKind, agents: Agent[], t: T): string {
  if (kind === 'gate') return t('wf.list.you')
  if (kind === 'delivery') return t(`wf.list.${node.channel ?? 'file'}`)
  if (kind === 'loop') return t('wf.list.repeat')
  if (kind === 'condition' && node.mode !== 'ai') return t('wf.list.branch')
  const a = agents.find((x) => x.id === node.agent_id)
  if (a) return a.name
  if (kind === 'coding-agent') return node.tool ?? 'claude-code'
  return node.profile || t('wf.list.unset')
}

/** 這位員工的 runtime 是不是 coding CLI（挑到它，這一步就自動變成「跑程式」） */
export const CODING_RUNTIMES = ['claude-code', 'codex', 'pi'] as const
export function codingToolOf(a?: Agent): WfNode['tool'] | undefined {
  return a?.runtime && (CODING_RUNTIMES as readonly string[]).includes(a.runtime) ? (a.runtime as WfNode['tool']) : undefined
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
/** 可以在卡片上換 AI 員工的站（跑程式那一步也在同一個下拉裡挑員工）。 */
export const HAS_AGENT: NodeKind[] = ['hermes', 'coding-agent', 'condition']

/** 老闆看得到的三種動作；分岔／迴圈只有工程師模式才出現 */
export const STATION_KINDS: NodeKind[] = ['hermes', 'gate', 'delivery']
export const ENGINEER_KINDS: NodeKind[] = ['condition', 'loop']
