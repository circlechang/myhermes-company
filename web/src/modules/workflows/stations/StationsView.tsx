// 生產線視圖（預設視圖）：垂直的站卡片清單，站與站之間標「帶著：〇〇」，hover 出現「＋ 在這裡插一站」。
// 編輯與執行是同一個畫面：跑起來就是這條線亮起來，不跳到別的面板。
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '../../../api/types'
import { EmptyState } from '../../../components/EmptyState'
import type { LiveRun } from '../runState'
import type { NodeKind, WfNode, WorkflowEnv } from '../types'
import { AddStationMenu } from './AddStationMenu'
import { outputOf } from './describe'
import { StationCard } from './StationCard'
import { insertAfter, isLinear, moveStation, orderStations, patchStation, removeStation, type Graph, type Station } from './stationGraph'

export interface StationsViewProps {
  graph: Graph
  agents: Agent[]
  env?: WorkflowEnv
  live?: LiveRun
  running: boolean
  busy: boolean
  onChange: (g: Graph) => void
  onRerun: (fromNode: string) => void
  onApprove: (approvalId: string, comment: string) => void
  onReject: (approvalId: string, comment: string) => void
  onOpenConversation?: (sessionId: string) => void
  onAdvanced: () => void
}

/** 站與站之間：一條線 ＋「帶著：〇〇」＋ hover 才出現的「＋ 在這裡插一站」。 */
function StationLink({ from, onInsert, disabled }: { from: Station; onInsert: (k: NodeKind) => void; disabled: boolean }) {
  const { t } = useTranslation()
  return (
    // z-10：插站選單要蓋在下一張站卡上面（站卡是 relative、z-auto）
    <li className="group relative z-10 flex items-center gap-2 py-1 pl-6" data-testid={`link-after-${from.node.id}`}>
      <span className="absolute left-[1.4rem] top-0 h-full w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden />
      <span className="relative z-[1] rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        {t('wf.station.carries', { what: outputOf(from.node, from.kind, t) })}
      </span>
      {/* 一直在，只是淡；滑過或聚焦才轉深（用 opacity 藏會做出堆疊脈絡，選單會被下一張卡蓋住） */}
      {!disabled && (
        <span className="text-zinc-500 group-focus-within:text-zinc-900 group-hover:text-zinc-900 dark:text-zinc-500 dark:group-focus-within:text-zinc-100 dark:group-hover:text-zinc-100">
          <AddStationMenu onPick={onInsert} label={t('wf.station.insertHere')} testId={`insert-after-${from.node.id}`} variant="ghost" />
        </span>
      )}
    </li>
  )
}

export function StationsView({ graph, agents, env, live, running, busy, onChange, onRerun, onApprove, onReject, onOpenConversation, onAdvanced }: StationsViewProps) {
  const { t } = useTranslation()
  const stations = useMemo(() => orderStations(graph), [graph])
  const linear = useMemo(() => isLinear(graph), [graph])
  const [dragErr, setDragErr] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const titles = useMemo(() => Object.fromEntries((['hermes', 'coding-agent', 'gate', 'condition', 'loop', 'delivery'] as NodeKind[]).map((k) => [k, t(`wf.station.kinds.${k}`)])), [t])

  const add = (afterId: string | null, kind: NodeKind) => onChange(insertAfter(graph, afterId, kind, titles).graph)
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
                  running={running}
                  busy={busy}
                  canReorder={linear}
                  onPatch={(patch: Partial<WfNode>) => onChange(patchStation(graph, s.node.id, patch))}
                  onRemove={() => onChange(removeStation(graph, s.node.id))}
                  onRerun={() => onRerun(s.node.id)}
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
