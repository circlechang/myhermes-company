// 一句話建流程：老闆打一句話 → POST /workflows/draft 排出草稿鏈 → 人看過名字與步驟 → 才 POST /workflows（＋排程）→ onCreated(id)。
// 草稿只在這個對話框裡活著；沒按「建立」什麼都不會留下。
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HttpError } from '../../api/client'
import { wfApi, type DraftProposal } from './api'

export interface DraftDialogProps {
  open: boolean
  onClose: () => void
  onCreated: (workflowId: string) => void
  /** 讓清單頁可以退回範本選單 */
  onPickTemplate?: () => void
}

type Phase = 'ask' | 'drafting' | 'review' | 'creating'
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'

export function DraftDialog({ open, onClose, onCreated, onPickTemplate }: DraftDialogProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>('ask')
  const [proposal, setProposal] = useState<DraftProposal | null>(null)
  const [name, setName] = useState('')
  const [keepSchedule, setKeepSchedule] = useState(true)
  const [error, setError] = useState<{ code: string; message: string } | null>(null)
  if (!open) return null

  const busy = phase === 'drafting' || phase === 'creating'
  const fail = (e: unknown) => {
    const he = e instanceof HttpError ? e : null
    setError({ code: he?.code ?? 'error', message: he?.message ?? String((e as Error)?.message ?? e) })
  }
  const errorText = (err: { code: string; message: string }) => {
    if (err.code === 'no_agent') return t('wf.draft.errNoAgent')
    if (err.code === 'draft_failed') return t('wf.draft.errFailed')
    return err.message
  }

  const submit = async () => {
    if (!text.trim() || busy) return
    setError(null)
    setPhase('drafting')
    try {
      const d = await wfApi.draft(text.trim())
      setProposal(d)
      setName(d.name)
      setKeepSchedule(!!d.schedule)
      setPhase('review')
    } catch (e) {
      fail(e)
      setPhase('ask')
    }
  }

  const create = async () => {
    if (!proposal || busy) return
    setError(null)
    setPhase('creating')
    try {
      const w = await wfApi.create({ name: name.trim() || proposal.name, nodes: proposal.nodes, edges: proposal.edges })
      if (keepSchedule && proposal.schedule) {
        // 排程建不起來不擋流程建立：流程已經在了，排程可以到「怎麼跑」再補
        try {
          await wfApi.createSchedule(w.id, proposal.schedule.cron)
        } catch {
          /* ignore */
        }
      }
      onCreated(w.id)
    } catch (e) {
      fail(e)
      setPhase('review')
    }
  }

  const back = () => {
    setError(null)
    setProposal(null)
    setPhase('ask')
  }

  // 顯示用的一行摘要：後端有 steps 就用；沒有就從 nodes 湊
  const rows = proposal
    ? proposal.steps?.length
      ? proposal.steps.map((s) => ({ id: s.id, who: s.who, detail: s.detail }))
      : proposal.nodes.map((n) => ({ id: n.id, who: n.kind === 'gate' ? '你' : n.kind === 'delivery' ? `→ ${n.channel ?? ''}` : (n.agent_id ?? ''), detail: n.title }))
    : []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onClick={busy ? undefined : onClose} data-testid="draft-dialog">
      <div className="card flex max-h-[88vh] w-full max-w-2xl flex-col gap-3 overflow-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-base font-semibold">{t('wf.draft.title')}</h2>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('wf.draft.helper')}</p>
        </div>

        {phase !== 'review' && phase !== 'creating' && (
          <>
            <textarea
              className="input min-h-28 resize-y"
              data-testid="draft-text"
              aria-label={t('wf.draft.helper')}
              placeholder={t('wf.draft.placeholder')}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
              }}
            />
            {phase === 'drafting' && <div className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="draft-loading">{t('wf.draft.drafting')}</div>}
            {error && (
              <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400" data-testid="draft-error">
                <span>{errorText(error)}</span>
                {error.code === 'draft_failed' && (
                  <button type="button" className="btn-ghost text-xs" onClick={() => void submit()}>{t('wf.draft.retry')}</button>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>{t('wf.draft.cancel')}</button>
              {onPickTemplate && (
                <button
                  type="button"
                  className="btn-ghost"
                  data-testid="draft-template"
                  disabled={busy}
                  onClick={() => {
                    onPickTemplate()
                    onClose()
                  }}
                >
                  {t('wf.draft.template')}
                </button>
              )}
              <button type="button" className="btn-primary" data-testid="draft-submit" disabled={!text.trim() || busy} onClick={() => void submit()}>
                {t('wf.draft.submit')}
              </button>
            </div>
          </>
        )}

        {(phase === 'review' || phase === 'creating') && proposal && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs text-zinc-600 dark:text-zinc-400">{t('wf.draft.nameLabel')}</span>
              <input className="input" data-testid="draft-name" value={name} onChange={(e) => setName(e.target.value)} aria-label={t('wf.draft.nameLabel')} />
            </label>
            <div>
              <div className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">{t('wf.draft.stepsLabel')}</div>
              <ol className="flex flex-col gap-1 text-sm" data-testid="draft-steps">
                {rows.map((r, i) => (
                  <li key={r.id} className="rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-800" data-testid="draft-step">
                    <span className="mr-1" aria-hidden>{CIRCLED[i] ?? `${i + 1}.`}</span>
                    <span className="font-medium">{r.who}</span>
                    <span className="mx-1 text-zinc-500">·</span>
                    <span>{r.detail}</span>
                  </li>
                ))}
              </ol>
            </div>
            {proposal.schedule && (
              <label className="flex items-center gap-2 text-sm" data-testid="draft-schedule">
                <input type="checkbox" checked={keepSchedule} onChange={(e) => setKeepSchedule(e.target.checked)} />
                <span>{t('wf.draft.when', { label: proposal.schedule.label })}</span>
                <span className="text-xs text-zinc-500">（{t('wf.draft.keepSchedule')}）</span>
              </label>
            )}
            {error && <div className="text-xs text-rose-600 dark:text-rose-400" data-testid="draft-error">{errorText(error)}</div>}
            <div className="flex items-center justify-end gap-2">
              <button type="button" className="btn-ghost" data-testid="draft-back" onClick={back} disabled={busy}>{t('wf.draft.back')}</button>
              <button type="button" className="btn-primary" data-testid="draft-create" onClick={() => void create()} disabled={busy}>
                {phase === 'creating' ? t('wf.draft.creating') : t('wf.draft.create')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
