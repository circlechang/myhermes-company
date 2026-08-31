// 建工作流時先選範本：選完直接能跑，之後每一站都能改（漸進揭露第 ①  層）。
// 只產生後端認得的 { name, nodes, edges }；站的順序就是畫面上的順序。
import i18n from 'i18next'
import type { Agent } from '../../../api/types'
import { relayout, mkEdge } from '../stations/stationGraph'
import type { NodeKind, WfEdge, WfNode } from '../types'

export interface TemplateStep {
  kind: NodeKind
  /** i18n 後綴：wf.tpl.<key>.<titleKey> */
  titleKey: string
  promptKey?: string
  extra?: Partial<WfNode>
}

export interface WfTemplate {
  key: string
  steps: TemplateStep[]
}

export const WF_TEMPLATES: WfTemplate[] = [
  {
    key: 'content',
    steps: [
      { kind: 'hermes', titleKey: 's1', promptKey: 'p1' },
      { kind: 'gate', titleKey: 's2' },
      { kind: 'hermes', titleKey: 's3', promptKey: 'p3' },
    ],
  },
  {
    key: 'research',
    steps: [
      { kind: 'hermes', titleKey: 's1', promptKey: 'p1' },
      { kind: 'hermes', titleKey: 's2', promptKey: 'p2' },
      { kind: 'hermes', titleKey: 's3', promptKey: 'p3' },
    ],
  },
  {
    key: 'spec',
    steps: [
      { kind: 'hermes', titleKey: 's1', promptKey: 'p1' },
      { kind: 'hermes', titleKey: 's2', promptKey: 'p2' },
      { kind: 'gate', titleKey: 's3' },
      { kind: 'delivery', titleKey: 's4', extra: { channel: 'file', path: 'out/{run_id}.md' } },
    ],
  },
  {
    key: 'blank',
    steps: [{ kind: 'hermes', titleKey: 's1', promptKey: 'p1' }],
  },
]

export const templateByKey = (key: string) => WF_TEMPLATES.find((x) => x.key === key)

/** 範本用的 AI 員工：優先用啟用中的，輪流分配，沒有員工就留空（進去再挑）。 */
function picker(agents: Agent[]) {
  const pool = agents.filter((a) => a.enabled)
  const list = pool.length ? pool : agents
  return (i: number) => {
    const a = list.length ? list[i % list.length] : undefined
    return a ? { agent_id: a.id, profile: a.profile } : {}
  }
}

export function buildTemplate(key: string, agents: Agent[] = [], name?: string): { name: string; nodes: WfNode[]; edges: WfEdge[]; viewport: { x: number; y: number; zoom: number } } {
  const tpl = templateByKey(key) ?? WF_TEMPLATES[WF_TEMPLATES.length - 1]
  const t = (k: string) => i18n.t(`wf.tpl.${tpl.key}.${k}`)
  const ag = picker(agents)
  let ai = 0
  const nodes: WfNode[] = tpl.steps.map((s, i) => {
    const base: WfNode = { id: `s${i + 1}`, kind: s.kind, title: t(s.titleKey), position: { x: 0, y: 0 } }
    if (s.kind === 'hermes') {
      Object.assign(base, ag(ai++), { prompt: s.promptKey ? t(s.promptKey) : '', skills: [], attachments: [] })
    } else if (s.kind === 'coding-agent') {
      Object.assign(base, { tool: 'claude-code', prompt: s.promptKey ? t(s.promptKey) : '', cwd: '' })
    }
    if (s.extra) Object.assign(base, s.extra)
    return base
  })
  const edges: WfEdge[] = nodes.slice(0, -1).map((n, i) => mkEdge(n.id, nodes[i + 1].id))
  const g = relayout({ nodes, edges })
  return { name: (name ?? '').trim() || i18n.t(`wf.tpl.${tpl.key}.name`), nodes: g.nodes, edges: g.edges, viewport: { x: 0, y: 0, zoom: 1 } }
}

/** 給選單顯示用：名稱、說明、站名一串。 */
export function templateSummary(key: string): { name: string; desc: string; steps: string[] } {
  const tpl = templateByKey(key) ?? WF_TEMPLATES[WF_TEMPLATES.length - 1]
  const t = (k: string) => i18n.t(`wf.tpl.${tpl.key}.${k}`)
  return { name: t('name'), desc: t('desc'), steps: tpl.steps.map((s) => t(s.titleKey)) }
}
