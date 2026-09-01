// 節點附加資訊：溢出輸出（查看完整／下載）、自檢輪次、效果快取／結果未知提示
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePreview } from '../../components/preview'
import { wfApi } from './api'
import type { NodeOutput, NodeState } from './types'

/** 節點輸出是純文字（不是檔案）→ 走共用預覽元件的 inline 模式。 */
export function NodeOutputPreview({ text, title, className = 'max-h-64' }: { text: string; title: string; className?: string }) {
  return (
    <div className={`mt-1 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 ${className}`} data-testid="node-output-preview">
      <FilePreview source={{ kind: 'inline', text, title, format: 'markdown' }} title={title} compact />
    </div>
  )
}

export function SpillViewer({ runId, nodeId, state }: { runId: string; nodeId: string; state: NodeState }) {
  const { t } = useTranslation()
  const [full, setFull] = useState<NodeOutput | null>(null)
  const [loading, setLoading] = useState(false)
  if (!state.spill) return null
  const open = async () => {
    setLoading(true)
    try {
      setFull(await wfApi.nodeOutput(runId, nodeId))
    } finally {
      setLoading(false)
    }
  }
  const download = () => {
    if (!full) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([full.content], { type: 'text/markdown' }))
    a.download = `${runId}-${nodeId}.output.md`
    a.click()
  }
  return (
    <div className="mt-1 text-xs" data-testid={`spill-${nodeId}`}>
      <span className="rounded bg-amber-100 px-1 py-0.5 text-2xs text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{t('wf.panel.spillBytes', { n: state.spill.bytes })}</span>{' '}
      <button className="btn-ghost !px-1 !py-0 text-xs underline" disabled={loading} onClick={open}>{t('wf.panel.spilled')}</button>
      {full && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6" onClick={() => setFull(null)}>
          <div className="card flex max-h-full w-full max-w-3xl flex-col gap-2 p-3" onClick={(e) => e.stopPropagation()} data-testid="spill-modal">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold">{nodeId}</span>
              <code className="text-zinc-600 dark:text-zinc-400">{full.path ?? ''}</code>
              <span className="text-zinc-600 dark:text-zinc-400">{full.bytes} bytes</span>
              <span className="ml-auto flex gap-1">
                <button className="btn-outline !py-0.5 text-xs" onClick={download}>{t('wf.panel.download')}</button>
                <button className="btn-ghost !py-0.5 text-xs" onClick={() => setFull(null)}>{t('wf.panel.close')}</button>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden rounded border border-zinc-200 dark:border-zinc-800">
              <FilePreview
                source={{ kind: 'inline', text: full.content, title: `${nodeId}.output.md`, format: 'markdown' }}
                title={`${nodeId}.output.md`}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const roundColor: Record<string, string> = {
  complete: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200',
  continue: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200',
  blocked: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200',
}

export function DoneRounds({ state }: { state: NodeState }) {
  const { t } = useTranslation()
  const rounds = state.done_rounds ?? []
  if (!rounds.length) return null
  return (
    <div className="mt-1 text-xs" data-testid="done-rounds">
      <div className="text-zinc-600 dark:text-zinc-400">{t('wf.panel.doneRounds')}</div>
      <ol className="space-y-0.5">
        {rounds.map((r) => (
          <li key={r.round} className="flex flex-wrap items-baseline gap-1">
            <span className="text-zinc-600 dark:text-zinc-400">#{r.round}</span>
            <span className={`rounded px-1 text-2xs ${roundColor[r.status] ?? ''}`}>{r.status}</span>
            {r.evidence && <span className="text-zinc-600 dark:text-zinc-300">{r.evidence}</span>}
            {r.next && <span className="text-zinc-600 dark:text-zinc-400">→ {r.next}</span>}
            {r.warning && <span className="text-amber-700 dark:text-amber-400">［{r.warning}］</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}

export function NodeHints({ state }: { state: NodeState }) {
  const { t } = useTranslation()
  return (
    <>
      {state.status === 'reused' && state.reason?.includes('效果快取') && <div className="mt-1 text-xs text-zinc-600 dark:text-zinc-400" data-testid="reused-cache">↺ {t('wf.panel.reusedCache')}</div>}
      {state.status === 'outcome_unknown' && <div className="mt-1 rounded bg-amber-50 p-1 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{t('wf.panel.unknownHint')}</div>}
    </>
  )
}
