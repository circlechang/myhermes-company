// 範例工作流：熱點 → 選題 → 審批閘門 → 文案（USER_GUIDE §5）
import i18n from 'i18next'
import type { Agent } from '../../api/types'
import type { WfEdge, WfNode } from './types'
import '../../guide/i18n'

export function exampleWorkflow(agents: Agent[] = []): { name: string; nodes: WfNode[]; edges: WfEdge[]; viewport: { x: number; y: number; zoom: number } } {
  const t = (k: string) => i18n.t(`guide.template.${k}`)
  const pool = agents.filter((a) => a.enabled)
  const pick = (i: number) => pool[i % Math.max(pool.length, 1)] ?? agents[0]
  const ag = (i: number) => { const a = pick(i); return a ? { agent_id: a.id, profile: a.profile } : {} }
  const nodes: WfNode[] = [
    { id: 'hot', kind: 'hermes', title: t('hot'), ...ag(0), prompt: t('hotPrompt'), position: { x: 40, y: 120 } },
    { id: 'topic', kind: 'hermes', title: t('topic'), ...ag(1), prompt: t('topicPrompt'), position: { x: 320, y: 120 } },
    { id: 'gate', kind: 'gate', title: t('gate'), position: { x: 600, y: 120 } },
    { id: 'copy', kind: 'hermes', title: t('copy'), ...ag(2), prompt: t('copyPrompt'), position: { x: 880, y: 120 } },
  ]
  const edges: WfEdge[] = [
    { id: 'hot->topic:output', source: 'hot', target: 'topic', sourceHandle: 'output', targetHandle: 'input', on: 'always' },
    { id: 'topic->gate:output', source: 'topic', target: 'gate', sourceHandle: 'output', targetHandle: 'input', on: 'always' },
    { id: 'gate->copy:output', source: 'gate', target: 'copy', sourceHandle: 'output', targetHandle: 'input', on: 'always' },
  ]
  return { name: t('name'), nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } }
}
