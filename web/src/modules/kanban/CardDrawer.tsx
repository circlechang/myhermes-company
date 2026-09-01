import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loading } from '../../components/QueryState'
import { useAttachments, useCardDetail, useKanbanMutations, type HermesStatus } from './api'

const fmt = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : '')

export function CardDrawer({ id, profiles, onClose }: { id: string; profiles: string[]; onClose: () => void }) {
  const { t } = useTranslation()
  const d = useCardDetail(id)
  const att = useAttachments(id)
  const m = useKanbanMutations(id)
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState<string | null>(null)
  const [dispatchProfile, setDispatchProfile] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const task = d.data?.task

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/30" onClick={onClose} data-testid="card-drawer">
      <aside className="flex h-full w-full max-w-lg flex-col gap-3 overflow-auto bg-white p-4 text-sm dark:bg-zinc-950" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1 font-semibold" title={task?.title ?? id}>{task?.title ?? id}</span>
          <button className="btn-ghost" onClick={onClose}>{t('common.close')}</button>
        </div>
        {d.isLoading && <Loading />}
        {d.error ? <div className="text-rose-600 dark:text-rose-400">{(d.error as Error).message}</div> : null}
        {task && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <code className="font-mono">{task.id}</code>
              <span className="badge bg-zinc-200 dark:bg-zinc-800">{task.status}</span>
              <span className="whitespace-nowrap">{t(`kanban.priorities.${task.priority_label}`)}（{task.priority ?? 0}）</span>
              <span className="whitespace-nowrap">{fmt(task.created_at)}</span>
            </div>
            {(task.diagnostics ?? []).length > 0 && (
              <div className="rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                {(task.diagnostics ?? []).map((x, i) => <div key={i}><b>{x.title}</b>{x.detail ? ` — ${x.detail}` : ''}</div>)}
              </div>
            )}
            {task.body && <div className="whitespace-pre-wrap rounded bg-zinc-50 p-2 dark:bg-zinc-900">{task.body}</div>}
            {(task.result || d.data?.latest_summary) && <div className="rounded bg-emerald-50 p-2 text-xs dark:bg-emerald-950/30"><b>{t('kanban.result')}</b>：{task.result ?? d.data?.latest_summary}</div>}

            <section className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-xs">{t('kanban.assignee')}
                <select className="input mt-1" value={task.assignee ?? ''} onChange={(e) => m.assign.mutate({ id, profile: e.target.value })}>
                  <option value="">{t('kanban.unassigned')}</option>
                  {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="text-xs">{t('kanban.moveTo')}
                <select className="input mt-1" value={task.status} onChange={(e) => {
                  const s = e.target.value as HermesStatus
                  if (s === 'done') setResult('')
                  else m.move.mutate({ id, status: s, extra: s === 'blocked' ? { reason: prompt(t('kanban.blockReason')) ?? '' } : {} })
                }}>
                  {(['todo', 'ready', 'review', 'blocked', 'scheduled', 'done', 'archived'] as HermesStatus[]).map((s) => <option key={s} value={s}>{t(`kanban.status.${s}`)}</option>)}
                  <option value="running" disabled>{t('kanban.status.running')}</option>
                  <option value="triage" disabled>{t('kanban.status.triage')}</option>
                </select>
              </label>
            </section>
            {result !== null && (
              <div className="flex flex-wrap gap-1">
                <input className="input flex-1 basis-40" placeholder={t('kanban.resultPlaceholder')} value={result} onChange={(e) => setResult(e.target.value)} />
                <button className="btn-primary" onClick={() => { m.move.mutate({ id, status: 'done', extra: { result } }); setResult(null) }}>{t('kanban.complete')}</button>
              </div>
            )}
            {m.move.error ? <div className="text-xs text-rose-600 dark:text-rose-400">{(m.move.error as Error).message}</div> : null}

            <section className="space-y-1">
              <div className="panel-title px-0">{t('kanban.tags')}</div>
              <div className="flex flex-wrap gap-1">
                <input className="input flex-1 basis-40" value={tags ?? (task.tags ?? []).join(', ')} onChange={(e) => setTags(e.target.value)} aria-label={t('kanban.tags')} />
                <button className="btn-outline" disabled={tags === null} onClick={() => { m.tags.mutate({ id, tags: (tags ?? '').split(/[,，\s]+/).filter(Boolean) }); setTags(null) }}>{t('common.save')}</button>
              </div>
            </section>

            <section className="space-y-1">
              <div className="panel-title px-0">{t('kanban.dispatch')}</div>
              <div className="flex flex-wrap gap-1">
                <select className="input flex-1 basis-40" value={dispatchProfile} onChange={(e) => setDispatchProfile(e.target.value)} aria-label={t('kanban.dispatchProfile')}>
                  <option value="">{t('kanban.keepAssignee')}</option>
                  {profiles.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <button className="btn-primary" disabled={m.dispatch.isPending} onClick={() => m.dispatch.mutate({ id, profile: dispatchProfile || undefined })}>{t('kanban.dispatchNow')}</button>
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('kanban.dispatchHint')}</p>
              {m.dispatch.data ? <pre className="max-h-32 overflow-auto rounded bg-zinc-100 p-2 text-2xs dark:bg-zinc-900" data-testid="dispatch-result">{JSON.stringify(m.dispatch.data, null, 1)}</pre> : null}
              {m.dispatch.error ? <div className="text-xs text-rose-600 dark:text-rose-400">{(m.dispatch.error as Error).message}</div> : null}
            </section>

            <section className="space-y-1">
              <div className="panel-title px-0">{t('kanban.comments')}（{d.data?.comments.length ?? 0}）</div>
              <ul className="max-h-48 space-y-1 overflow-auto">
                {d.data?.comments.map((c, i) => (
                  <li key={i} className="rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900"><b>{c.author}</b> <span className="text-zinc-600 dark:text-zinc-400">{fmt(c.created_at)}</span><div className="whitespace-pre-wrap">{c.body}</div></li>
                ))}
              </ul>
              <form className="flex flex-wrap gap-1" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) { m.comment.mutate({ id, text: comment.trim() }); setComment('') } }}>
                <input className="input flex-1 basis-40" value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('kanban.commentPlaceholder')} aria-label={t('kanban.comments')} />
                <button className="btn-outline" type="submit" disabled={m.comment.isPending}>{t('kanban.addComment')}</button>
              </form>
            </section>

            <section className="space-y-1">
              <div className="panel-title px-0">{t('kanban.attachments')}</div>
              <ul className="space-y-1 text-xs">
                {att.data?.map((a) => (
                  <li key={String(a.id)} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={String(a.filename ?? a.name ?? a.id)}>📎 {a.filename ?? a.name ?? a.id}{a.size ? ` (${Math.round(a.size / 1024)} KB)` : ''}</span>
                    <button className="btn-ghost px-1 text-rose-600 dark:text-rose-400" onClick={() => m.deleteAttachment.mutate({ id, att: a.id })}>✕</button>
                  </li>
                ))}
                {att.error ? <li className="text-zinc-600 dark:text-zinc-400">{t('kanban.attachmentsUnavailable')}</li> : null}
              </ul>
              <input ref={fileRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) m.upload.mutate({ id, file: f }); e.target.value = '' }} aria-label={t('kanban.upload')} />
              <button className="btn-outline" onClick={() => fileRef.current?.click()} disabled={m.upload.isPending}>{t('kanban.upload')}</button>
            </section>

            <section className="space-y-1">
              <div className="panel-title px-0">{t('kanban.events')}</div>
              <ul className="max-h-40 overflow-auto text-xs text-zinc-600 dark:text-zinc-400">
                {d.data?.events.slice().reverse().map((e, i) => <li key={i}>{fmt(e.created_at)} · {e.kind}{e.payload && Object.keys(e.payload).length ? ` ${JSON.stringify(e.payload).slice(0, 120)}` : ''}</li>)}
              </ul>
            </section>

            <button className="btn-danger mt-auto" onClick={() => { if (confirm(t('kanban.confirmArchive'))) m.archive.mutate(id, { onSuccess: onClose }) }}>{t('kanban.archive')}</button>
          </>
        )}
      </aside>
    </div>
  )
}
