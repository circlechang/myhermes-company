// 執行面板：開始／停止／重跑、節點即時狀態、審批、用量
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DoneRounds, NodeHints, NodeOutputPreview, SpillViewer } from './NodeExtras'
import type { LiveRun } from './runState'
import { isTerminal } from './runState'
import type { WfNode } from './types'

interface Props {
  nodes: WfNode[]
  live?: LiveRun
  busy?: boolean
  canRun: boolean
  onRun: () => void
  onStop: () => void
  onRerun: (fromNode?: string, force?: boolean) => void
  onApprove: (approvalId: string, comment: string) => void
  onReject: (approvalId: string, comment: string) => void
  onOpenConversation?: (sessionId: string) => void
  onOpenSnapshot?: (runId: string) => void
}

const badge: Record<string, string> = {
  pending: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
  running: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200',
  waiting_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
  skipped: 'bg-zinc-100 text-zinc-600 dark:text-zinc-400 dark:bg-zinc-800',
  reused: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  stopped: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100',
  timeout: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
  budget_exceeded: 'bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200',
  needs_attention: 'bg-amber-200 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100',
  outcome_unknown: 'bg-amber-200 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100',
}
export const StatusBadge = ({ s }: { s?: string }) => {
  const { t } = useTranslation()
  return <span data-testid="status-badge" className={`badge px-1.5 py-0.5 text-[11px] ${badge[s ?? 'pending'] ?? badge.pending}`}>{t(`wf.status.${s ?? 'pending'}`)}</span>
}

export function RunPanel({ nodes, live, busy, canRun, onRun, onStop, onRerun, onApprove, onReject, onOpenConversation, onOpenSnapshot }: Props) {
  const { t } = useTranslation()
  const [comments, setComments] = useState<Record<string, string>>({})
  const running = !!live && !isTerminal(live.status)
  const [open, setOpen] = useState<string | null>(null)
  const [force, setForce] = useState(false)
  return (
    <div className="flex h-full flex-col text-sm" data-testid="run-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 p-2 dark:border-zinc-800">
        <span className="font-semibold">{t('wf.panel.run')}</span>
        {live && <StatusBadge s={live.status} />}
        {live && <code className="text-[10px] text-zinc-600 dark:text-zinc-400">{live.runId}</code>}
        <span className="ml-auto flex gap-1">
          {!running && <button className="btn-primary !py-1 text-xs" disabled={!canRun || busy} onClick={onRun}>▶ {t('wf.run')}</button>}
          {running && <button className="btn-danger !py-1 text-xs" disabled={busy} onClick={onStop}>■ {t('wf.stop')}</button>}
          {live && !running && <button className="btn-outline !py-1 text-xs" disabled={busy} onClick={() => onRerun(undefined, force)}>↻ {t('wf.rerun')}</button>}
          {live && !running && (
            <label className="flex items-center gap-1 text-[10px] text-zinc-600 dark:text-zinc-400" title={t('wf.panel.forceAll')}>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} aria-label={t('wf.panel.forceAll')} /> {t('wf.panel.forceAll')}
            </label>
          )}
          {live && !running && onOpenSnapshot && <button className="btn-outline !py-1 text-xs" onClick={() => onOpenSnapshot(live.runId)}>{t('wf.panel.replay')}</button>}
        </span>
      </div>
      {live?.error && <div className="m-2 rounded bg-rose-50 p-2 text-xs text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{live.error}</div>}
      {!live && <div className="p-3 text-xs text-zinc-600 dark:text-zinc-400">{t('wf.panel.noRun')}</div>}
      {live && (
        <ul className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
          {nodes.map((n) => {
            const st = live.nodes[n.id] ?? { status: 'pending' as const }
            const ap = live.pendingApprovals[n.id]
            const expanded = open === n.id
            return (
              <li key={n.id} className="card p-2" data-testid={`run-node-${n.id}`}>
                <div className="flex items-center gap-2">
                  <button className="truncate text-left font-medium" onClick={() => setOpen(expanded ? null : n.id)}>{n.title || n.id}</button>
                  <StatusBadge s={st.status} />
                  {st.attempt && st.attempt > 1 ? <span className="text-[10px] text-zinc-600 dark:text-zinc-400">×{st.attempt}</span> : null}
                  {st.tool && <span className="text-[10px] text-zinc-600 dark:text-zinc-400">🔧 {st.tool}</span>}
                  {st.usage?.total_tokens ? <span className="ml-auto text-[10px] text-zinc-600 dark:text-zinc-400">{st.usage.total_tokens} tok</span> : null}
                  {!running && st.status !== 'pending' && <button className="btn-ghost !px-1 !py-0 text-[10px]" title={t('wf.rerunFrom')} onClick={() => onRerun(n.id, force)}>↻</button>}
                </div>
                {st.status === 'running' && st.streaming && <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-zinc-100 p-1 text-[11px] dark:bg-zinc-800">{st.streaming.slice(-600)}</pre>}
                {st.error && <div className="mt-1 text-xs text-rose-600 dark:text-rose-400">{st.error}</div>}
                {st.skipped_reason && <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">{st.skipped_reason}</div>}
                <NodeHints state={st} />
                <SpillViewer runId={live.runId} nodeId={n.id} state={st} />
                <DoneRounds state={st} />
                {ap && (
                  <div className="mt-2 space-y-1 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/30" data-testid={`approval-${n.id}`}>
                    <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[11px]">{ap.payload}</pre>
                    <textarea className="input min-h-[40px] text-xs" placeholder={t('wf.panel.comment')} value={comments[n.id] ?? ''} onChange={(e) => setComments({ ...comments, [n.id]: e.target.value })} aria-label={t('wf.panel.comment')} />
                    <div className="flex gap-1">
                      <button className="btn-primary !py-0.5 text-xs" disabled={busy} onClick={() => onApprove(ap.approval_id, comments[n.id] ?? '')}>{t('wf.panel.approve')}</button>
                      <button className="btn-danger !py-0.5 text-xs" disabled={busy} onClick={() => onReject(ap.approval_id, comments[n.id] ?? '')}>{t('wf.panel.reject')}</button>
                    </div>
                  </div>
                )}
                {expanded && (
                  <div className="mt-2 space-y-1">
                    {st.output && <NodeOutputPreview text={st.output} title={`${n.title || n.id}`} className="max-h-72" />}
                    {st.session_id && onOpenConversation && <button className="btn-outline !py-0.5 text-xs" onClick={() => onOpenConversation(st.session_id!)}>{t('wf.panel.conversation')}</button>}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {live?.usage && (
        <div className="border-t border-zinc-200 p-2 text-[11px] text-zinc-600 dark:text-zinc-400 dark:border-zinc-800">
          {t('wf.panel.usage')}: {live.usage.total_tokens ?? 0} tok · ${Number(live.usage.cost_usd ?? 0).toFixed(4)}
        </div>
      )}
    </div>
  )
}
