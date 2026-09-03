// 「怎麼跑」分頁：一步一張卡，預設全部收起（一行一行看完整條流程），點一張才展開。
// 手風琴：一次只開一張；shift 點可以多開；新加的那一步直接展開。編輯與跑是同一個畫面。
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Fragment, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '../../../api/types'
import { EmptyState } from '../../../components/EmptyState'
import { isTerminal, type LiveRun } from '../runState'
import type { NodeKind, WfNode, WorkflowEnv } from '../types'
import { AddStationMenu } from './AddStationMenu'
import { StationCard } from './StationCard'
import { insertAfter, isLinear, moveStation, orderStations, patchStation, removeStation, type Graph, type Station } from './stationGraph'

export interface StationsViewProps {
  graph: Graph
  agents: Agent[]
  env?: WorkflowEnv
  live?: LiveRun
  /** 每一步自己的試跑 run（node_id → LiveRun），跟正式跑的 `live` 分開放 */
  tries?: Record<string, LiveRun>
  running: boolean
  busy: boolean
  onChange: (g: Graph) => void
  onRerun: (fromNode: string) => void
  onTry?: (nodeId: string) => void
  onApprove: (approvalId: string, comment: string) => void
  onReject: (approvalId: string, comment: string) => void
  onOpenConversation?: (sessionId: string) => void
  onAdvanced: () => void
}

/** 兩步之間：一條線 ＋ hover 才出現的「＋ 在這裡插一步」。不再標「帶著：〇〇」——每條線都一樣，沒有資訊量。 */
function StationLink({ from, onInsert, disabled }: { from: Station; onInsert: (k: NodeKind) => void; disabled: boolean }) {
  const { t } = useTranslation()
  return (
    // z-10：插步選單要蓋在下一張卡上面（卡是 relative、z-auto）
    <li className="group relative z-10 flex h-6 items-center gap-2 pl-7" data-testid={`link-after-${from.node.id}`}>
      <span className="absolute left-[1.55rem] top-0 h-full w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden />
      {/* 一直在，只是淡；滑過或聚焦才轉深（用 opacity 藏會做出堆疊脈絡，選單會被下一張卡蓋住） */}
      {!disabled && (
        <span className="relative z-[1] text-zinc-400 group-focus-within:text-zinc-900 group-hover:text-zinc-900 dark:text-zinc-600 dark:group-focus-within:text-zinc-100 dark:group-hover:text-zinc-100">
          <AddStationMenu onPick={onInsert} label={t('wf.station.insertHere')} testId={`insert-after-${from.node.id}`} variant="ghost" />
        </span>
      )}
    </li>
  )
}

export function StationsView({ graph, agents, env, live, tries, running, busy, onChange, onRerun, onTry, onApprove, onReject, onOpenConversation, onAdvanced }: StationsViewProps) {
  const { t } = useTranslation()
  const stations = useMemo(() => orderStations(graph), [graph])
  const linear = useMemo(() => isLinear(graph), [graph])
  const [dragErr, setDragErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const titles = useMemo(() => Object.fromEntries((['hermes', 'coding-agent', 'gate', 'condition', 'loop', 'delivery'] as NodeKind[]).map((k) => [k, t(`wf.station.kinds.${k}`)])), [t])

  const toggle = useCallback((id: string, keepOthers: boolean) => {
    setExpanded((cur) => {
      const next = keepOthers ? new Set(cur) : new Set<string>()
      if (cur.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const expand = useCallback((id: string) => setExpanded((cur) => (cur.has(id) ? cur : new Set([...cur, id]))), [])

  const add = (afterId: string | null, kind: NodeKind) => {
    const r = insertAfter(graph, afterId, kind, titles)
    onChange(r.graph)
    setExpanded(new Set([r.id])) // 新加的那一步要馬上填「誰做／做什麼」
  }
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    if (!linear) { setDragErr(t('wf.station.reorderLocked')); return }
    const from = stations.findIndex((s) => s.node.id === active.id)
    const to = stations.findIndex((s) => s.node.id === over.id)
    if (from < 0 || to < 0) return
    setDragErr(null)
    onChange(moveStation(graph, from, to))
  }

  if (!stations.length) {
    return (
      <div className="p-6" data-testid="stations-empty">
        <EmptyState
          testId="empty-stations"
          title={t('wf.station.empty.title')}
          body={t('wf.station.empty.body')}
          secondary={<AddStationMenu onPick={(k) => add(null, k)} label={t('wf.station.addFirst')} testId="add-first-station" />}
        />
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-3 sm:p-4" data-testid="stations-view">
      {!linear && <p className="mb-2 rounded bg-violet-50 px-2 py-1 text-xs text-violet-800 dark:bg-violet-950/40 dark:text-violet-200">{t('wf.station.advancedHint')}</p>}
      {dragErr && <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">{dragErr}</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={stations.map((s) => s.node.id)} strategy={verticalListSortingStrategy}>
          <ol className="space-y-0">
            {stations.map((s, i) => (
              <Fragment key={s.node.id}>
                <StationCard
                  station={s}
                  agents={agents}
                  env={env}
                  state={live?.nodes[s.node.id]}
                  approval={live?.pendingApprovals[s.node.id]}
                  runId={live?.runId}
                  tryState={tries?.[s.node.id]?.nodes[s.node.id]}
                  tryRunId={tries?.[s.node.id]?.runId}
                  trying={!!tries?.[s.node.id] && !isTerminal(tries[s.node.id].status)}
                  running={running}
                  busy={busy}
                  canReorder={linear}
                  expanded={expanded.has(s.node.id)}
                  onToggle={(keep) => toggle(s.node.id, keep)}
                  onPatch={(patch: Partial<WfNode>) => onChange(patchStation(graph, s.node.id, patch))}
                  onRemove={() => onChange(removeStation(graph, s.node.id))}
                  onRerun={() => onRerun(s.node.id)}
                  onTry={onTry ? () => { expand(s.node.id); onTry(s.node.id) } : undefined}
                  onApprove={(c) => { const ap = live?.pendingApprovals[s.node.id]; if (ap) onApprove(ap.approval_id, c) }}
                  onReject={(c) => { const ap = live?.pendingApprovals[s.node.id]; if (ap) onReject(ap.approval_id, c) }}
                  onOpenConversation={onOpenConversation}
                  onAdvanced={onAdvanced}
                />
                {i < stations.length - 1 && <StationLink from={s} disabled={running} onInsert={(k) => add(s.node.id, k)} />}
              </Fragment>
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className="mt-3 flex justify-center">
        <AddStationMenu onPick={(k) => add(stations[stations.length - 1].node.id, k)} testId="add-station" />
      </div>
    </div>
  )
}
