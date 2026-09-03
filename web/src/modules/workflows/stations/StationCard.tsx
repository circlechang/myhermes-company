// 一步一張卡。預設收起來只有一行：「① 研究員 · 找出今天三個熱點」＋狀態籤＋試跑；點那一行才展開。
// 展開後只問兩件事：誰做／做什麼（送出去那一步問「送到哪」）。其他欄位全收在「工程師選項」，工程師模式才長出來。
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '../../../api/types'
import { useEngineerMode } from '../../../prefs/engineerMode'
import { wfApi } from '../api'
import { DoneRounds, NodeHints, NodeOutputPreview } from '../NodeExtras'
import { circled } from '../time'
import type { NodeKind, NodeOutput, NodeState, WfNode, WorkflowEnv } from '../types'
import { HAS_AGENT, LIGHT_BADGE, LIGHT_CARD, LIGHT_DOT, codingToolOf, doneOf, lightOf, outputOf, whatShort, whoShort } from './describe'
import type { Station } from './stationGraph'

type LiveState = NodeState & { streaming?: string; tool?: string }

export interface StationCardProps {
  station: Station
  agents: Agent[]
  env?: WorkflowEnv
  state?: LiveState
  approval?: { approval_id: string; payload: string }
  runId?: string
  /** 這一步的試跑（trigger=try）：有的話「這一步的產出」優先顯示它，正式跑的狀態燈／等我看不受影響 */
  tryState?: LiveState
  tryRunId?: string
  /** 試跑還在跑（按鈕要鎖住） */
  trying?: boolean
  /** 整條流程正在跑（跑的時候不給改結構） */
  running: boolean
  busy: boolean
  canReorder: boolean
  /** 展開＝編輯表單；收起＝一行摘要 */
  expanded: boolean
  /** keepOthers＝shift 點：別張卡不收起 */
  onToggle: (keepOthers: boolean) => void
  onPatch: (patch: Partial<WfNode>) => void
  onRemove: () => void
  onRerun: () => void
  onTry?: () => void
  onApprove: (comment: string) => void
  onReject: (comment: string) => void
  onOpenConversation?: (sessionId: string) => void
  onAdvanced: () => void
}

function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-[4.5rem_minmax(0,1fr)] sm:gap-2" data-testid={testId}>
      <span className="pt-1 text-xs text-zinc-600 dark:text-zinc-400">{label}</span>
      <div className="min-w-0 text-xs">{children}</div>
    </div>
  )
}

const TRIABLE: NodeKind[] = ['hermes', 'coding-agent', 'delivery']
const stop = (e: React.SyntheticEvent) => e.stopPropagation()

export function StationCard(props: StationCardProps) {
  const { station, agents, env, state, approval, runId, tryState, tryRunId, trying, running, busy, canReorder, expanded, onToggle, onPatch, onRemove, onRerun, onTry, onApprove, onReject, onOpenConversation, onAdvanced } = props
  const { t } = useTranslation()
  const engineer = useEngineerMode()
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
  const canTry = !!onTry && TRIABLE.includes(kind)
  const hasAgentSelect = HAS_AGENT.includes(kind) && !(kind === 'condition' && n.mode !== 'ai')
  const hasPrompt = kind === 'hermes' || kind === 'coding-agent' || (kind === 'condition' && n.mode === 'ai')

  // 挑員工：挑到會寫程式的（runtime 是 coding CLI）這一步就變「跑程式」；挑回 Hermes 員工就變回來
  const pickAgent = (id: string) => {
    const a = agents.find((x) => x.id === id)
    const tool = codingToolOf(a)
    const base: Partial<WfNode> = { agent_id: id || undefined, profile: a?.profile }
    if (kind === 'condition') { onPatch(base); return }
    if (tool) onPatch({ ...base, kind: 'coding-agent', tool, cwd: n.cwd || a?.workspace || '' })
    else onPatch({ ...base, kind: 'hermes', tool: undefined })
  }
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(e.shiftKey) }
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`station-${n.id}`}
      data-light={light}
      data-expanded={expanded ? '1' : '0'}
      className={`card relative flex flex-col p-0 ${LIGHT_CARD[light]}`}
    >
      {/* 一行摘要：序號 · 誰 · 做什麼 ｜ 狀態籤 ｜ 試跑 ｜ ▸ */}
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          className={`shrink-0 cursor-grab rounded px-1 text-zinc-400 ${canReorder && !running ? 'hover:bg-zinc-100 dark:hover:bg-zinc-800' : 'cursor-not-allowed opacity-40'}`}
          title={canReorder ? t('wf.station.reorder') : t('wf.station.reorderLocked')}
          aria-label={t('wf.station.reorder')}
          data-testid={`station-${n.id}-drag`}
          onClick={stop}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
          aria-expanded={expanded}
          aria-label={`${t('wf.station.seq', { n: station.seq })}：${expanded ? t('wf.station.collapse') : t('wf.station.expand')}`}
          data-testid={`station-${n.id}-row`}
          onClick={(e) => onToggle(e.shiftKey)}
          onKeyDown={onRowKey}
        >
          <span className="shrink-0 text-base tabular-nums text-zinc-700 dark:text-zinc-300" data-testid={`station-${n.id}-seq`} title={t('wf.station.seq', { n: station.seq })}>{circled(station.seq)}</span>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${LIGHT_DOT[light]}`} aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm" data-testid={`station-${n.id}-summary`}>
            <span className="font-semibold">{whoShort(n, kind, agents, t)}</span>
            {kind !== 'gate' && kind !== 'delivery' && <span className="text-zinc-700 dark:text-zinc-300"> · {whatShort(n, kind)}</span>}
            {(kind === 'gate' || kind === 'delivery') && n.title && n.title !== t(`wf.station.kinds.${kind}`) && <span className="text-zinc-700 dark:text-zinc-300"> · {n.title}</span>}
          </span>
        </button>
        {/* 收起來也能決定：等你看的那一步直接在這一行給「可以／退回」 */}
        {approval && !expanded && (
          <span className="flex shrink-0 gap-1" data-testid={`station-${n.id}-inline-approval`} onClick={stop}>
            <button type="button" className="btn-primary !px-2 !py-0.5 text-xs" disabled={busy} data-testid={`station-${n.id}-approve`} onClick={() => onApprove('')}>{t('wf.station.approve')}</button>
            <button type="button" className="btn-danger !px-2 !py-0.5 text-xs" disabled={busy} data-testid={`station-${n.id}-reject`} onClick={() => onReject('')}>{t('wf.station.reject')}</button>
          </span>
        )}
        <span className={`badge shrink-0 px-1.5 py-0.5 text-xs ${LIGHT_BADGE[light]}`} data-testid={`station-${n.id}-status`}>{t(`wf.station.lights.${light}`)}</span>
        {canTry && (
          <button
            type="button"
            className="btn-ghost shrink-0 !px-1.5 !py-0.5 text-xs"
            disabled={busy || running || !!trying}
            title={t('wf.station.tryHint')}
            aria-label={t('wf.station.tryStation')}
            data-testid={`station-${n.id}-try`}
            onClick={(e) => { stop(e); onTry?.() }}
          >
            {trying ? t('wf.station.trying') : '▶'}
          </button>
        )}
        <span className="shrink-0 text-xs text-zinc-500" aria-hidden>{expanded ? '▾' : '▸'}</span>
      </div>

      {expanded && (
        <div className="flex flex-col gap-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800" data-testid={`station-${n.id}-form`}>
          <Row label={t('wf.station.stationName')}>
            <input
              className="input w-full !py-0.5 text-xs"
              value={n.title ?? ''}
              aria-label={t('wf.station.stationName')}
              data-testid={`station-${n.id}-title`}
              onChange={(e) => onPatch({ title: e.target.value })}
            />
          </Row>

          {hasAgentSelect && (
            <Row label={t('wf.station.who')} testId={`station-${n.id}-who`}>
              <select
                className="input !py-1"
                value={n.agent_id ?? ''}
                aria-label={t('wf.station.who')}
                data-testid={`station-${n.id}-agent`}
                onChange={(e) => pickAgent(e.target.value)}
              >
                <option value="">{t('wf.station.who_.unset')}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id} data-testid={`station-agent-option-${a.id}`}>
                    {(a.title ? `${a.name}（${a.title}）` : a.name) + (a.runtime && a.runtime !== 'hermes' ? ` · ${a.runtime_name ?? a.runtime}` : '')}
                  </option>
                ))}
              </select>
            </Row>
          )}

          {hasPrompt && (
            <Row label={t('wf.station.what')} testId={`station-${n.id}-what`}>
              <textarea
                className="input min-h-[4.5rem] w-full resize-y text-xs"
                value={n.prompt ?? ''}
                placeholder={t('wf.station.promptPlaceholder')}
                aria-label={t('wf.station.what')}
                data-testid={`station-${n.id}-prompt`}
                onChange={(e) => onPatch({ prompt: e.target.value })}
              />
            </Row>
          )}

          {kind === 'gate' && <p className="text-xs text-zinc-700 dark:text-zinc-300" data-testid={`station-${n.id}-what`}>{t('wf.station.kindHints.gate')}</p>}

          {kind === 'delivery' && (
            <Row label={t('wf.station.sendTo')} testId={`station-${n.id}-sendto`}>
              <div className="flex flex-wrap items-center gap-1">
                <select className="input !w-auto !py-1" value={n.channel ?? 'file'} aria-label={t('wf.node.channel')} data-testid={`station-${n.id}-channel`} onChange={(e) => onPatch({ channel: e.target.value as WfNode['channel'] })}>
                  <option value="file">{t('wf.station.deliver.file')}</option>
                  <option value="line">{t('wf.station.deliver.line')}</option>
                  <option value="webhook">{t('wf.station.deliver.webhook')}</option>
                </select>
                {n.channel === 'line' ? (
                  <input className="input min-w-0 flex-1 !py-1" value={n.to ?? ''} placeholder={t('wf.node.lineTo')} aria-label={t('wf.node.lineTo')} onChange={(e) => onPatch({ to: e.target.value })} />
                ) : n.channel === 'webhook' ? (
                  <input className="input min-w-0 flex-1 !py-1" value={n.url ?? ''} placeholder="https://…" aria-label={t('wf.node.url')} onChange={(e) => onPatch({ url: e.target.value })} />
                ) : (
                  <input className="input min-w-0 flex-1 !py-1" value={n.path ?? ''} placeholder="out/{run_id}.md" aria-label={t('wf.node.path_')} onChange={(e) => onPatch({ path: e.target.value })} />
                )}
                {n.channel === 'line' && env && !env.line_configured && <span className="w-full text-2xs text-amber-700 dark:text-amber-400">{t('wf.node.lineNotConfigured')}</span>}
              </div>
            </Row>
          )}

          {kind === 'loop' && (
            <Row label={t('wf.station.what')} testId={`station-${n.id}-what`}>
              <label className="flex items-center gap-2 pt-0.5">
                <span className="text-zinc-600 dark:text-zinc-400">{t('wf.node.maxIterations')}</span>
                <input className="input !w-20 !py-1" type="number" min={1} max={100} value={n.max_iterations ?? 3} aria-label={t('wf.node.maxIterations')} onChange={(e) => onPatch({ max_iterations: Number(e.target.value) })} />
              </label>
            </Row>
          )}
          {kind === 'condition' && n.mode !== 'ai' && (
            <p className="text-xs text-zinc-700 dark:text-zinc-300" data-testid={`station-${n.id}-what`}>
              {n.rule ? `${n.rule.op} ${n.rule.value ?? n.rule.path ?? ''}` : t('wf.station.kindHints.condition')}
            </p>
          )}

          {engineer && (
            <details className="rounded border border-dashed border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700" data-testid={`station-${n.id}-engineer`}>
              <summary className="cursor-pointer select-none text-zinc-600 dark:text-zinc-400">{t('wf.station.engineerOptions')}</summary>
              <div className="mt-2 space-y-2">
                <Row label={t('wf.station.output')} testId={`station-${n.id}-produces`}>
                  <span className="inline-block pt-1 text-zinc-700 dark:text-zinc-300">{outputOf(n, kind, t)}</span>
                </Row>
                {(kind === 'hermes' || kind === 'coding-agent' || done) && (
                  <Row label={t('wf.station.doneLabel')} testId={`station-${n.id}-done`}>
                    {kind === 'hermes' || kind === 'coding-agent' ? (
                      <label className="flex items-center gap-2 pt-1">
                        <input type="checkbox" checked={!!n.done_check} onChange={(e) => onPatch({ done_check: e.target.checked })} aria-label={t('wf.station.doneCheck')} />
                        <span className="text-zinc-700 dark:text-zinc-300">{t('wf.station.doneCheck')}</span>
                        {n.done_check && <input className="input !w-16 !py-0.5" type="number" min={1} max={10} value={n.done_check_max_rounds ?? 3} aria-label={t('wf.node.doneCheckRounds')} onChange={(e) => onPatch({ done_check_max_rounds: Number(e.target.value) })} />}
                      </label>
                    ) : (
                      <span className="inline-block pt-1 text-zinc-700 dark:text-zinc-300">{done}</span>
                    )}
                  </Row>
                )}
                {kind === 'coding-agent' && (
                  <>
                    <Row label={t('wf.node.tool')}>
                      <select className="input !py-1" value={n.tool ?? 'claude-code'} aria-label={t('wf.node.tool')} onChange={(e) => onPatch({ tool: e.target.value as WfNode['tool'] })}>
                        {(['claude-code', 'codex', 'pi'] as const).map((tool) => (
                          <option key={tool} value={tool}>{tool}{env && env.coding_tools[tool] && !env.coding_tools[tool].installed ? ` — ${t('wf.node.notInstalled')}` : ''}</option>
                        ))}
                      </select>
                    </Row>
                    <Row label={t('wf.node.cwd')}>
                      <input className="input w-full !py-1" value={n.cwd ?? ''} aria-label={t('wf.node.cwd')} onChange={(e) => onPatch({ cwd: e.target.value })} />
                    </Row>
                  </>
                )}
                {(kind === 'hermes' || kind === 'condition') && (
                  <>
                    <Row label={t('wf.node.model')}>
                      <input className="input w-full !py-1" value={n.model ?? ''} aria-label={t('wf.node.model')} onChange={(e) => onPatch({ model: e.target.value || undefined })} />
                    </Row>
                    <Row label={t('wf.node.skills')}>
                      <input className="input w-full !py-1" value={(n.skills ?? []).join(', ')} aria-label={t('wf.node.skills')} onChange={(e) => onPatch({ skills: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
                    </Row>
                    <Row label={t('wf.node.system')}>
                      <textarea className="input min-h-[3rem] w-full text-xs" value={n.system ?? ''} aria-label={t('wf.node.system')} onChange={(e) => onPatch({ system: e.target.value })} />
                    </Row>
                    <Row label={t('wf.node.attachments')}>
                      <textarea className="input min-h-[2.5rem] w-full text-xs" value={(n.attachments ?? []).join('\n')} aria-label={t('wf.node.attachments')} onChange={(e) => onPatch({ attachments: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
                    </Row>
                    <Row label={t('wf.node.toolApproval')}>
                      <select className="input !py-1" value={n.tool_approval ?? 'deny'} aria-label={t('wf.node.toolApproval')} onChange={(e) => onPatch({ tool_approval: e.target.value as WfNode['tool_approval'] })}>
                        <option value="deny">{t('wf.node.toolDeny')}</option>
                        <option value="allow">{t('wf.node.toolAllow')}</option>
                      </select>
                    </Row>
                  </>
                )}
                {(kind === 'hermes' || kind === 'coding-agent') && (
                  <Row label={t('wf.node.timeout')}>
                    <input className="input !w-28 !py-1" type="number" min={0} value={n.timeout_seconds ?? ''} aria-label={t('wf.node.timeout')} onChange={(e) => onPatch({ timeout_seconds: e.target.value === '' ? undefined : Number(e.target.value) })} />
                  </Row>
                )}
              </div>
            </details>
          )}

          {station.branches && (
            <div className="flex flex-wrap items-center gap-1 rounded bg-violet-50 px-2 py-1 text-xs text-violet-800 dark:bg-violet-950/40 dark:text-violet-200" data-testid={`station-${n.id}-branch`}>
              <span>{t('wf.station.hasBranch')} →</span>
              <button type="button" className="underline" onClick={onAdvanced}>{t('wf.station.hasBranchHint')}</button>
            </div>
          )}

          {state?.error && <div className="text-xs text-rose-600 dark:text-rose-400">{state.error}</div>}
          {state && <NodeHints state={state} />}
          {state && <DoneRounds state={state} />}

          {approval && (
            <div className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/30" data-testid={`station-${n.id}-approval`}>
              {/* 卡片裡只留一行摘要，全文在右欄的閱讀欄（ReviewPane）看，決定不用離開這張卡 */}
              <div className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate" data-testid={`station-${n.id}-payload`}>{summaryLine(approval.payload)}</span>
                <span className="shrink-0 text-amber-800 dark:text-amber-200">{t('wf.station.reviewFullOnRight')} →</span>
              </div>
              <textarea className="input min-h-[38px] text-xs" placeholder={t('wf.station.comment')} aria-label={t('wf.station.comment')} value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="flex gap-1">
                <button type="button" className="btn-primary !py-0.5 text-xs" disabled={busy} data-testid={`station-${n.id}-approve`} onClick={() => onApprove(comment)}>{t('wf.station.approve')}</button>
                <button type="button" className="btn-danger !py-0.5 text-xs" disabled={busy} data-testid={`station-${n.id}-reject`} onClick={() => onReject(comment)}>{t('wf.station.reject')}</button>
              </div>
            </div>
          )}

          {docCount > 0 && (
            <span className="badge self-start bg-sky-100 text-2xs text-sky-800 dark:bg-sky-900/40 dark:text-sky-200" data-testid={`station-${n.id}-docs`}>
              {t('wf.station.out.docCount', { n: docCount })}
            </span>
          )}
          <StationOutput
            nodeId={n.id}
            title={n.title || n.id}
            state={tryState ?? state}
            runId={tryState ? tryRunId : runId}
            isTry={!!tryState}
            trying={!!trying}
          />

          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {runId && !running && state && state.status !== 'pending' && (
              <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" disabled={busy} data-testid={`station-${n.id}-rerun`} onClick={onRerun}>↻ {t('wf.station.rerunStation')}</button>
            )}
            {state?.session_id && onOpenConversation && (
              <button type="button" className="btn-ghost !px-1.5 !py-0.5 text-xs" onClick={() => onOpenConversation(state.session_id!)}>{t('wf.station.openConversation')}</button>
            )}
            <button
              type="button"
              className="btn-ghost ml-auto !px-1.5 !py-0.5 text-xs text-rose-600 dark:text-rose-400"
              disabled={running}
              data-testid={`station-${n.id}-remove`}
              onClick={() => { if (confirm(t('wf.station.confirmRemove', { name: n.title || n.id }))) onRemove() }}
            >
              {t('wf.station.remove')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

type Chip = 'pending' | 'running' | 'completed' | 'failed' | 'waiting_approval' | 'reused'

/** 站卡上的狀態小籤：比 5 盞燈多一個「沿用上次」（效果快取／重跑沿用）。 */
export function chipOf(status?: string): Chip {
  switch (status) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'waiting_approval':
    case 'reused':
      return status
    case 'timeout':
    case 'outcome_unknown':
      return 'failed'
    default:
      return 'pending'
  }
}
const CHIP_CLASS: Record<Chip, string> = {
  pending: LIGHT_BADGE.pending,
  running: LIGHT_BADGE.running,
  completed: LIGHT_BADGE.completed,
  failed: LIGHT_BADGE.failed,
  waiting_approval: LIGHT_BADGE.waiting_approval,
  reused: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
}

/**
 * 「這一步的產出」：可收合，顯示這一步最新的輸出（正式跑或試跑）、狀態籤、串流中的文字。
 * 輸出溢出到檔案時，展開才去抓完整內容。試跑按鈕在卡片那一行，不在這裡。
 */
function StationOutput({ nodeId, title, state, runId, isTry, trying }: {
  nodeId: string
  title: string
  state?: LiveState
  runId?: string
  isTry: boolean
  trying: boolean
}) {
  const { t } = useTranslation()
  const engineer = useEngineerMode()
  const hasBody = !!(state?.output || state?.streaming || state?.error)
  const [open, setOpen] = useState(hasBody)
  const [full, setFull] = useState<NodeOutput | null>(null)
  const [loading, setLoading] = useState(false)
  const chip = chipOf(state?.status)
  // 有東西出現就自動展開（試跑一按、或串流開始）；使用者收起後不再硬開
  const seen = useRef(hasBody)
  useEffect(() => {
    if (hasBody && !seen.current) setOpen(true)
    seen.current = hasBody
  }, [hasBody])
  useEffect(() => {
    if (trying) setOpen(true)
  }, [trying])
  // 溢出的輸出：展開時才去抓完整檔（換 run／換 attempt 就重抓）
  const spillKey = state?.spill ? `${runId}:${state.attempt ?? 0}` : ''
  useEffect(() => {
    setFull(null)
    if (!open || !spillKey || !runId) return
    let alive = true
    setLoading(true)
    wfApi.nodeOutput(runId, nodeId).then((r) => { if (alive) setFull(r) }).catch(() => {}).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, spillKey, runId, nodeId])

  const text = full?.content ?? state?.output ?? ''
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-800" data-testid={`station-${nodeId}-output`} data-chip={chip} data-try={isTry ? '1' : undefined}>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1 text-xs">
        <button type="button" className="btn-ghost !px-1 !py-0 text-xs" aria-expanded={open} data-testid={`station-${nodeId}-output-toggle`} onClick={() => setOpen((v) => !v)}>
          {open ? '▾' : '▸'} {t('wf.station.stationOutput')}
        </button>
        <span className={`badge px-1.5 py-0.5 text-2xs ${CHIP_CLASS[chip]}`} data-testid={`station-${nodeId}-chip`}>{t(`wf.station.outChip.${chip}`)}</span>
        {isTry && <span className="badge bg-violet-100 px-1.5 py-0.5 text-2xs text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">{t('wf.station.tryTag')}</span>}
        {engineer && runId && <code className="text-2xs text-zinc-500">{runId}</code>}
      </div>
      {open && (
        <div className="space-y-1 border-t border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
          {state?.status === 'running' && state.streaming && (
            <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-1.5 text-xs dark:bg-zinc-800" data-testid={`station-${nodeId}-stream`}>{state.streaming.slice(-600)}</pre>
          )}
          {isTry && state?.error && <div className="text-xs text-rose-600 dark:text-rose-400">{state.error}</div>}
          {loading && <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('wf.station.loadingFull')}</div>}
          {text ? (
            <div data-testid={`station-${nodeId}-result`}>
              {state?.spill && full && <span className="rounded bg-amber-100 px-1 py-0.5 text-2xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('wf.panel.spillBytes', { n: full.bytes })}</span>}
              <NodeOutputPreview text={text} title={t('wf.station.outputTitle', { name: title })} className="max-h-64" />
            </div>
          ) : (
            !state?.streaming && !loading && <div className="text-xs text-zinc-500">{t('wf.station.noOutputYet')}</div>
          )}
        </div>
      )}
    </div>
  )
}

/** 卡片裡的一行摘要：第一個非空行、最多 120 字，全文交給右欄 */
function summaryLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
