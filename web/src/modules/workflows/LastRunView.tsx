// 流程頁預設分頁「最近一次」：唯讀時間軸。頭一行講幾點開始、幾點完成、花多少；
// 底下一步一行：誰、做什麼、狀態（花多久／你選了什麼／錯在哪）、產出第一行。
// 等你看的那一步就地給「可以／退回」；跑到一半時 WS 事件會一直更新同一份 live。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '../../api/types'
import { isTerminal, type LiveRun } from './runState'
import { OutputRail, whoShort, whatShort, type Station } from './stations'
import { circled, durationText, firstLine, sameDayTime, shortTime, usd } from './time'
import type { RunSummary } from './types'

export interface LastRunViewProps {
  stations: Station[]
  agents: Agent[]
  live?: LiveRun
  runs?: RunSummary[]
  busy: boolean
  loading?: boolean
  onLoadRun: (runId: string) => void
  onApprove: (approvalId: string, comment: string) => void
  onReject: (approvalId: string, comment: string) => void
  onRun: () => void
  onGoHow: () => void
}

const statusWord = (t: (k: string) => string, s?: string) => {
  switch (s) {
    case 'completed': return t('wf.last.finished')
    case 'running':
    case 'pending': return t('wf.last.running')
    case 'waiting_approval': return t('wf.last.waiting')
    case 'stopped': return t('wf.last.stopped')
    default: return t(`wf.status.${s ?? 'pending'}`)
  }
}

export function LastRunView({ stations, agents, live, runs, busy, loading, onLoadRun, onApprove, onReject, onRun, onGoHow }: LastRunViewProps) {
  const { t } = useTranslation()
  const [showOutput, setShowOutput] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [comments, setComments] = useState<Record<string, string>>({})

  if (!live) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6 text-center text-sm" data-testid="last-run-empty">
        <p className="text-zinc-700 dark:text-zinc-300">{loading ? t('wf.last.loading') : t('wf.last.noRun')}</p>
        {!loading && (
          <div className="mt-3 flex justify-center gap-2">
            <button type="button" className="btn-primary !py-1" disabled={busy} onClick={onRun}>▶ {t('wf.last.runNow')}</button>
            <button type="button" className="btn-outline !py-1" onClick={onGoHow}>{t('wf.last.goHow')}</button>
          </div>
        )}
      </div>
    )
  }

  const started = live.startedAt ?? live.createdAt
  const finished = isTerminal(live.status) ? live.finishedAt : null
  const cost = usd(live.usage?.cost_usd)
  const previous = runs ?? []

  return (
    <div className="mx-auto w-full max-w-3xl p-3 sm:p-4" data-testid="last-run-view" data-run={live.runId}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 text-sm text-zinc-700 dark:text-zinc-300" data-testid="last-run-header">
        <span>{shortTime(started)} {t('wf.last.started')}</span>
        <span>·</span>
        <span>{finished ? `${sameDayTime(finished, started)} ` : ''}{statusWord(t, live.status)}</span>
        {cost && <><span>·</span><span data-testid="last-run-cost">{cost}</span></>}
        {live.error && !live.nodes[Object.keys(live.nodes).find((k) => live.nodes[k].error) ?? '']?.error && <span className="text-rose-600 dark:text-rose-400">⚠ {firstLine(live.error, 80)}</span>}
      </div>

      <ol className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900" data-testid="last-run-steps">
        {stations.map((s) => {
          const id = s.node.id
          const st = live.nodes[id]
          const ap = live.pendingApprovals[id]
          const status = st?.status ?? 'pending'
          const who = whoShort(s.node, s.kind, agents, t)
          const what = s.kind === 'gate' || s.kind === 'delivery' ? (s.node.title && s.node.title !== t(`wf.station.kinds.${s.kind}`) ? s.node.title : '') : whatShort(s.node, s.kind, 60)
          const dur = durationText(st?.started_at, st?.finished_at)
          let statusCell: React.ReactNode
          let outputCell: React.ReactNode = null
          if (ap) {
            statusCell = <span className="font-medium text-amber-700 dark:text-amber-300">⏸ {t('wf.last.waiting')}</span>
          } else if (status === 'failed' || status === 'outcome_unknown') {
            statusCell = <span className="text-rose-600 dark:text-rose-400">⚠ {firstLine(st?.error, 80) || t(`wf.status.${status}`)}</span>
          } else if (status === 'running') {
            statusCell = <span className="text-sky-700 dark:text-sky-300">⏳ {t('wf.status.running')}</span>
            if (st?.streaming) outputCell = <span className="text-zinc-500">{firstLine(st.streaming.slice(-200), 80)}</span>
          } else if (status === 'completed' || status === 'reused') {
            if (s.kind === 'gate') {
              const d = st?.decision
              const word = d === false ? t('wf.last.chosenNo') : t('wf.last.chosenYes')
              statusCell = <span className="text-emerald-700 dark:text-emerald-300">✓ {d === undefined ? '' : t('wf.last.youChose', { d: word, t: sameDayTime(st?.finished_at, started) })}</span>
            } else if (s.kind === 'delivery') {
              statusCell = <span className="text-emerald-700 dark:text-emerald-300">✓ {t('wf.last.sent')}</span>
            } else {
              statusCell = <span className="text-emerald-700 dark:text-emerald-300">✓ {status === 'reused' ? t('wf.status.reused') : dur ?? ''}</span>
            }
            if (st?.output && s.kind !== 'gate' && s.kind !== 'delivery') outputCell = <span className="text-zinc-600 dark:text-zinc-400">「{firstLine(st.output, 80)}」</span>
          } else if (status === 'skipped') {
            statusCell = <span className="text-zinc-500">{t('wf.status.skipped')}</span>
          } else {
            statusCell = <span className="text-zinc-400">· {t('wf.last.notYet')}</span>
          }
          return (
            <li key={id} className="px-3 py-2 text-sm" data-testid={`last-row-${id}`} data-status={ap ? 'waiting_approval' : status}>
              {/* 390px：兩欄（序號｜其餘全疊），狀態疊在標題下；sm 起才展開成四欄 */}
              <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 sm:grid-cols-[1.5rem_7rem_minmax(0,1fr)_minmax(0,1fr)]">
                <span className="text-base tabular-nums text-zinc-700 dark:text-zinc-300">{circled(s.seq)}</span>
                <span className="truncate font-semibold" title={who}>{who}</span>
                <span className="col-start-2 truncate text-zinc-700 sm:col-start-3 dark:text-zinc-300" title={what}>{what}</span>
                <span className="col-start-2 min-w-0 break-words sm:col-start-4" data-testid={`last-status-${id}`}>{statusCell}</span>
                {outputCell && <span className="col-start-2 min-w-0 truncate sm:col-span-3" data-testid={`last-output-${id}`}>{outputCell}</span>}
              </div>
              {ap && (
                <div className="mt-2 space-y-1 rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-700 dark:bg-amber-950/30" data-testid={`last-approval-${id}`}>
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{summaryLine(ap.payload)}</span>
                    <span className="shrink-0 text-amber-800 dark:text-amber-200">{t('wf.station.reviewFullOnRight')} →</span>
                  </div>
                  <textarea className="input min-h-[38px] text-xs" placeholder={t('wf.station.comment')} aria-label={t('wf.station.comment')} value={comments[id] ?? ''} onChange={(e) => setComments({ ...comments, [id]: e.target.value })} />
                  <div className="flex gap-1">
                    <button type="button" className="btn-primary !py-0.5 text-xs" disabled={busy} data-testid={`last-approve-${id}`} onClick={() => onApprove(ap.approval_id, comments[id] ?? '')}>{t('wf.station.approve')}</button>
                    <button type="button" className="btn-danger !py-0.5 text-xs" disabled={busy} data-testid={`last-reject-${id}`} onClick={() => onReject(ap.approval_id, comments[id] ?? '')}>{t('wf.station.reject')}</button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button type="button" className="btn-outline !py-1" aria-expanded={showOutput} data-testid="last-run-full-output" onClick={() => setShowOutput((v) => !v)}>
          {showOutput ? t('wf.last.hideOutput') : t('wf.last.fullOutput')}
        </button>
        <button type="button" className="btn-ghost !py-1" aria-expanded={showHistory} data-testid="last-run-history-toggle" onClick={() => setShowHistory((v) => !v)}>
          {previous.length > 1 ? t('wf.last.previous', { n: previous.length }) : t('wf.last.noPrevious')} {showHistory ? '▴' : '▾'}
        </button>
      </div>
      {showOutput && (
        <div className="mt-2 flex h-[28rem] flex-col overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800" data-testid="last-run-output">
          <OutputRail stations={stations} live={live} />
        </div>
      )}
      {showHistory && (
        <ul className="mt-2 divide-y divide-zinc-200 rounded-lg border border-zinc-200 text-xs dark:divide-zinc-800 dark:border-zinc-800" data-testid="last-run-history">
          {previous.map((r) => {
            const c = usd(r.usage?.cost_usd)
            const cur = r.id === live.runId
            return (
              <li key={r.id}>
                <button type="button" className={`flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 ${cur ? 'font-semibold' : ''}`} data-testid={`last-run-pick-${r.id}`} onClick={() => onLoadRun(r.id)}>
                  <span className="w-24 shrink-0">{shortTime(r.created_at)}</span>
                  <span className="shrink-0">{statusWord(t, r.status)}</span>
                  {c && <span className="text-zinc-500">{c}</span>}
                  {r.error && <span className="min-w-0 truncate text-rose-600 dark:text-rose-400">{firstLine(r.error, 60)}</span>}
                  {cur && <span className="ml-auto shrink-0 text-zinc-500">{t('wf.last.current')}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/** 卡片裡的一行摘要：第一個非空行、最多 120 字，全文交給右欄 */
function summaryLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
