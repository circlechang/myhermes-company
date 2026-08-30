// React Flow 自訂節點／邊
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath, type EdgeProps, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { sourceHandles } from './graph'
import type { FlowEdge, FlowNode } from './graph'
import type { NodeKind } from './types'

export const KIND_COLORS: Record<NodeKind, string> = {
  hermes: 'border-indigo-400 dark:border-indigo-500',
  'coding-agent': 'border-amber-400 dark:border-amber-500',
  gate: 'border-rose-400 dark:border-rose-500',
  condition: 'border-sky-400 dark:border-sky-500',
  loop: 'border-violet-400 dark:border-violet-500',
  delivery: 'border-emerald-400 dark:border-emerald-500',
}
export const KIND_ICONS: Record<NodeKind, string> = { hermes: '🤖', 'coding-agent': '⌨️', gate: '🛂', condition: '❓', loop: '🔁', delivery: '📤' }

export const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-white dark:bg-zinc-900',
  running: 'bg-indigo-50 dark:bg-indigo-950/50 animate-pulse',
  waiting_approval: 'bg-amber-50 dark:bg-amber-950/50',
  completed: 'bg-emerald-50 dark:bg-emerald-950/40',
  failed: 'bg-rose-50 dark:bg-rose-950/40',
  skipped: 'bg-zinc-100 opacity-60 dark:bg-zinc-800',
  reused: 'bg-zinc-100 dark:bg-zinc-800',
  stopped: 'bg-zinc-100 dark:bg-zinc-800',
}

export function WfNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { t } = useTranslation()
  const n = data.node
  const kind = n.kind as NodeKind
  const st = (data as { status?: string }).status ?? ''
  const stream = (data as { streaming?: string }).streaming
  const handles = sourceHandles(kind)
  const subtitle =
    kind === 'hermes' ? (n.profile || n.agent_id || '') : kind === 'coding-agent' ? `${n.tool} · ${n.cwd || '~'}` : kind === 'condition' ? (n.mode === 'ai' ? 'AI yes/no' : `${n.rule?.op ?? ''} ${n.rule?.value ?? n.rule?.path ?? ''}`) : kind === 'loop' ? `≤ ${n.max_iterations} ×` : kind === 'delivery' ? `${n.channel}${n.channel === 'line' ? ` → ${n.to}` : n.channel === 'file' ? ` → ${n.path}` : ''}` : ''
  return (
    <div
      data-testid={`node-${id}`}
      className={`w-[220px] rounded-lg border-2 px-3 py-2 text-xs shadow-sm ${KIND_COLORS[kind] ?? ''} ${STATUS_STYLE[st] ?? STATUS_STYLE.pending} ${selected ? 'ring-2 ring-indigo-500' : ''}`}
    >
      <Handle type="target" position={Position.Top} id="input" className="!h-2.5 !w-2.5 !bg-zinc-400" />
      <div className="flex items-center gap-1.5">
        <span>{KIND_ICONS[kind]}</span>
        <span className="truncate font-semibold">{n.title || id}</span>
        {st && st !== 'pending' && <span className="ml-auto rounded bg-zinc-200/80 px-1 text-[10px] dark:bg-zinc-700">{t(`wf.status.${st}`)}</span>}
      </div>
      <div className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">{subtitle || t(`wf.kinds.${kind}`)}</div>
      {(n.prompt || stream) && <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] text-zinc-600 dark:text-zinc-400">{stream ? stream.slice(-160) : n.prompt}</div>}
      {handles.length === 1 ? (
        <Handle type="source" position={Position.Bottom} id="output" className="!h-2.5 !w-2.5 !bg-indigo-500" />
      ) : (
        handles.map((h, i) => (
          <Handle key={h} type="source" position={Position.Bottom} id={h} style={{ left: `${30 + i * 40}%` }} className={`!h-2.5 !w-2.5 ${h === 'true' || h === 'body' ? '!bg-emerald-500' : '!bg-rose-500'}`} title={h} />
        ))
      )}
      {handles.length > 1 && (
        <div className="mt-1 flex justify-around text-[9px] text-zinc-600 dark:text-zinc-400">
          {handles.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      )}
    </div>
  )
}

export function WfEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, sourceHandleId, markerEnd }: EdgeProps<FlowEdge>) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const on = data?.on ?? 'always'
  const decision = (data as { decision?: boolean } | undefined)?.decision
  const color = decision === true ? '#10b981' : decision === false ? '#d4d4d8' : on === 'failure' ? '#f43f5e' : on === 'success' ? '#10b981' : data?.loop_back ? '#8b5cf6' : '#71717a'
  const label = [sourceHandleId && sourceHandleId !== 'output' ? sourceHandleId : '', on !== 'always' ? on : '', data?.loop_back ? '↺' : ''].filter(Boolean).join(' · ')
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: color, strokeWidth: selected ? 3 : decision === true ? 2.5 : 1.5, strokeDasharray: data?.loop_back ? '6 4' : decision === false ? '2 4' : undefined }} />
      {label && (
        <EdgeLabelRenderer>
          <div style={{ transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)` }} className="nodrag nopan pointer-events-none absolute rounded bg-white/90 px-1 text-[10px] text-zinc-600 dark:bg-zinc-900/90 dark:text-zinc-300">
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const nodeTypes = { wf: WfNodeView }
export const edgeTypes = { wf: WfEdgeView }
