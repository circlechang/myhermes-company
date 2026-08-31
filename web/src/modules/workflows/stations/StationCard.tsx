// 一張站卡回答四件事：誰做／做什麼／產出什麼／完成條件。跑起來時同一張卡就地變色、長出產出與核准鈕。
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '../../../api/types'
import { DoneRounds, NodeHints, NodeOutputPreview, SpillViewer } from '../NodeExtras'
import type { NodeState, WfNode, WorkflowEnv } from '../types'
import { HAS_AGENT, LIGHT_BADGE, LIGHT_CARD, LIGHT_DOT, doneOf, lightOf, outputOf, whoOf } from './describe'
import type { Station } from './stationGraph'

type LiveState = NodeState & { streaming?: string; tool?: string }

export interface StationCardProps {
  station: Station
  agents: Agent[]
  env?: WorkflowEnv
  state?: LiveState
  approval?: { approval_id: string; payload: string }
  runId?: string
  /** 整條線正在跑（跑的時候不給改結構） */
  running: boolean
  busy: boolean
  canReorder: boolean
  onPatch: (patch: Partial<WfNode>) => void
  onRemove: () => void
  onRerun: () => void
  onApprove: (comment: string) => void
  onReject: (comment: string) => void
  onOpenConversation?: (sessionId: string) => void
  onAdvanced: () => void
}

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-2" data-testid={testId}>
      <span className="pt-1 text-[11px] text-zinc-600 dark:text-zinc-400">{label}</span>
      <div className="min-w-0 text-xs">{children}</div>
    </div>
  )
}

export function StationCard(props: StationCardProps) {
  const { station, agents, env, state, approval, runId, running, busy, canReorder, onPatch, onRemove, onRerun, onApprove, onReject, onOpenConversation, onAdvanced } = props
  const { t } = useTranslation()
  const n = station.node
  const kind = station.kind
  const light = lightOf(state?.status)
  const [comment, setComment] = useState('')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: n.id, disabled: !canReorder || running })
  const done = doneOf(n, kind, t)
  // 文件模式（io_mode: doc）：跑完會在 node_states 留 doc_ids，卡片上就地標份數
  const docIds = (state as unknown as { doc_ids?: unknown } | undefined)?.doc_ids
  const docCount = Array.isArray(docIds) ? docIds.length : 0
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : undefined }

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`station-${n.id}`}
      data-light={light}
      className={`card relative flex flex-col gap-2 p-3 ${LIGHT_CARD[light]}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className={`shrink-0 cursor-grab rounded px-1 text-zinc-400 ${canReorder && !running ? 'hover:bg-zinc-100 dark:hover:bg-zinc-800' : 'cursor-not-allowed opacity-40'}`}
          title={canReorder ? t('wf.station.reorder') : t('wf.station.reorderLocked')}
          aria-label={t('wf.station.reorder')}
          data-testid={`station-${n.id}-drag`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400" data-testid={`station-${n.id}-seq`}>{t('wf.station.seq', { n: station.seq })}</span>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${LIGHT_DOT[light]}`} aria-hidden />
        <input
          className="input min-w-0 flex-1 !py-1 font-semibold"
          value={n.title ?? ''}
          aria-label={t('wf.station.stationName')}
          data-testid={`station-${n.id}-title`}
          onChange={(e) => onPatch({ title: e.target.value })}
        />
        <span className={`badge shrink-0 px-1.5 py-0.5 text-[11px] ${LIGHT_BADGE[light]}`} data-testid={`station-${n.id}-status`}>{t(`wf.station.lights.${light}`)}</span>
      </div>

      <Row label={t('wf.station.who')} testId={`station-${n.id}-who`}>
        {HAS_AGENT.includes(kind) && !(kind === 'condition' && n.mode !== 'ai') ? (
          <select
            className="input !py-1"
            value={n.agent_id ?? ''}
            aria-label={t('wf.station.who')}
            data-testid={`station-${n.id}-agent`}
            onChange={(e) => {
              const a = agents.find((x) => x.id === e.target.value)
              onPatch({ agent_id: e.target.value || undefined, profile: a?.profile })
            }}
          >
            <option value="">{t('wf.station.who_.unset')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.title ? `${a.name}（${a.title}）` : a.name}</option>
            ))}
          </select>
        ) : kind === 'coding-agent' ? (
          <select className="input !py-1" value={n.tool ?? 'claude-code'} aria-label={t('wf.station.who')} onChange={(e) => onPatch({ tool: e.target.value as WfNode['tool'] })}>
            {(['claude-code', 'codex', 'pi'] as const).map((tool) => (
              <option key={tool} value={tool}>{tool}{env && env.coding_tools[tool] && !env.coding_tools[tool].installed ? ` — ${t('wf.node.notInstalled')}` : ''}</option>
            ))}
          </select>
        ) : (
          <span className="inline-block pt-1 text-zinc-700 dark:text-zinc-300">{whoOf(n, kind, agents, t)}</span>
        )}
      </Row>

      <Row label={t('wf.station.what')} testId={`station-${n.id}-what`}>
        {kind === 'hermes' || kind === 'coding-agent' || (kind === 'condition' && n.mode === 'ai') ? (
          <textarea
            className="input min-h-[4.5rem] w-full resize-y text-xs"
            value={n.prompt ?? ''}
            placeholder={t('wf.station.promptPlaceholder')}
            aria-label={t('wf.station.what')}
            data-testid={`station-${n.id}-prompt`}
            onChange={(e) => onPatch({ prompt: e.target.value })}
          />
        ) : kind === 'gate' ? (
          <p className="pt-1 text-zinc-700 dark:text-zinc-300">{t('wf.station.kindHints.gate')}</p>
        ) : kind === 'loop' ? (
          <label className="flex items-center gap-2 pt-0.5">
            <span className="text-zinc-600 dark:text-zinc-400">{t('wf.node.maxIterations')}</span>
            <input className="input !w-20 !py-1" type="number" min={1} max={100} value={n.max_iterations ?? 3} aria-label={t('wf.node.maxIterations')} onChange={(e) => onPatch({ max_iterations: Number(e.target.value) })} />
          </label>
        ) : kind === 'delivery' ? (
          <p className="pt-1 text-zinc-700 dark:text-zinc-300">{t('wf.station.kindHints.delivery')}</p>
        ) : (
          <p className="pt-1 text-zinc-700 dark:text-zinc-300">
            {n.rule ? `${n.rule.op} ${n.rule.value ?? n.rule.path ?? ''}` : t('wf.station.kindHints.condition')}
          </p>
        )}
      </Row>

      <Row label={t('wf.station.output')} testId={`station-${n.id}-output`}>
        {docCount > 0 && (
          <span className="badge mr-1 bg-sky-100 text-[10px] text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" data-testid={`station-${n.id}-docs`}>
            {t('wf.station.out.docCount', { n: docCount })}
          </span>
        )}
        {kind === 'delivery' ? (
          <div className="flex flex-wrap items-center gap-1">
            <select className="input !w-auto !py-1" value={n.channel ?? 'file'} aria-label={t('wf.node.channel')} onChange={(e) => onPatch({ channel: e.target.value as WfNode['channel'] })}>
              <option value="file">{t('wf.station.out.file', { path: '' })}</option>
              <option value="line">LINE</option>
              <option value="webhook">webhook</option>
            </select>
            {n.channel === 'line' ? (
              <input className="input min-w-0 flex-1 !py-1" value={n.to ?? ''} placeholder={t('wf.node.lineTo')} aria-label={t('wf.node.lineTo')} onChange={(e) => onPatch({ to: e.target.value })} />
            ) : n.channel === 'webhook' ? (
              <input className="input min-w-0 flex-1 !py-1" value={n.url ?? ''} placeholder="https://…" aria-label={t('wf.node.url')} onChange={(e) => onPatch({ url: e.target.value })} />
            ) : (
              <input className="input min-w-0 flex-1 !py-1" value={n.path ?? ''} placeholder="out/{run_id}.md" aria-label={t('wf.node.path_')} onChange={(e) => onPatch({ path: e.target.value })} />
            )}
          </div>
        ) : (
          <span className="inline-block pt-1 text-zinc-700 dark:text-zinc-300">{outputOf(n, kind, t)}</span>
        )}
      </Row>

      {(kind === 'hermes' || kind === 'coding-agent' || done) && (
        <Row label={t('wf.station.doneLabel')} testId={`station-${n.id}-done`}>
          {kind === 'hermes' || kind === 'coding-agent' ? (
            <label className="flex items-center gap-2 pt-1">
              <input type="checkbox" checked={!!n.done_check} onChange={(e) => onPatch({ done_check: e.target.checked })} aria-label={t('wf.station.doneCheck')} />
              <span className="text-zinc-700 dark:text-zinc-300">{t('wf.station.doneCheck')}</span>
            </label>
          ) : (
            <span className="inline-block pt-1 text-zinc-700 dark:text-zinc-300">{done}</span>
          )}
        </Row>
      )}

      {station.branches && (
        <div className="flex flex-wrap items-center gap-1 rounded bg-violet-50 px-2 py-1 text-[11px] text-violet-800 dark:bg-violet-950/40 dark:text-violet-200" data-testid={`station-${n.id}-branch`}>
          <span>{t('wf.station.hasBranch')} →</span>
          <button type="button" className="underline" onClick={onAdvanced}>{t('wf.station.hasBranchHint')}</button>
        </div>
      )}

      {state?.status === 'running' && state.streaming && (
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-1.5 text-[11px] dark:bg-zinc-800" data-testid={`station-${n.id}-stream`}>{state.streaming.slice(-600)}</pre>
      )}
      {state?.error && <div className="text-xs text-rose-600 dark:text-rose-400">{state.error}</div>}
      {state && <NodeHints state={state} />}
      {state && runId && <SpillViewer runId={runId} nodeId={n.id} state={state} />}
      {state && <DoneRounds state={state} />}

      {approval && (
        <div className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/30" data-testid={`station-${n.id}-approval`}>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">{approval.payload}</pre>
          <textarea className="input min-h-[38px] text-xs" placeholder={t('wf.station.comment')} aria-label={t('wf.station.comment')} value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="flex gap-1">
            <button type="button" className="btn-primary !py-0.5 text-xs" disabled={busy} data-testid={`station-${n.id}-approve`} onClick={() => onApprove(comment)}>{t('wf.station.approve')}</button>
            <button type="button" className="btn-danger !py-0.5 text-xs" disabled={busy} data-testid={`station-${n.id}-reject`} onClick={() => onReject(comment)}>{t('wf.station.reject')}</button>
          </div>
        </div>
      )}

      {state?.output && (
        <div data-testid={`station-${n.id}-result`}>
          <NodeOutputPreview text={state.output} title={t('wf.station.outputTitle', { name: n.title || n.id })} className="max-h-64" />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 pt-0.5">
        {runId && !running && state && state.status !== 'pending' && (
          <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-[11px]" disabled={busy} data-testid={`station-${n.id}-rerun`} onClick={onRerun}>↻ {t('wf.station.rerunStation')}</button>
        )}
        {state?.session_id && onOpenConversation && (
          <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-[11px]" onClick={() => onOpenConversation(state.session_id!)}>{t('wf.station.openConversation')}</button>
        )}
        <button
          type="button"
          className="btn-ghost ml-auto !px-1.5 !py-0.5 text-[11px] text-rose-600 dark:text-rose-400"
          disabled={running}
          data-testid={`station-${n.id}-remove`}
          onClick={() => { if (confirm(t('wf.station.confirmRemove', { name: n.title || n.id }))) onRemove() }}
        >
          {t('wf.station.remove')}
        </button>
      </div>
    </li>
  )
}
