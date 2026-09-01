// /packs/:name：階段視圖。左：主題資料夾清單（狀態燈）；中：階段卡橫排；右：負責員工與最近一次 run。手機縱排。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../../components/EmptyState'
import { PageHeader } from '../../components/PageHeader'
import { CollapsiblePanel, WorkArea } from '../../components/layout/index'
import { ErrorBox, Loading } from '../../components/QueryState'
import { FilePreview, guessKind } from '../../components/preview'
import { ConversationModal } from '../workflows/Conversation'
import { packsApi, packsQk, type StageFile, type StageStatus, type TopicStage } from './api'

const LIGHT: Record<StageStatus, string> = {
  draft: 'bg-zinc-300 dark:bg-zinc-700',
  running: 'bg-sky-500 animate-pulse',
  review: 'bg-amber-500',
  done: 'bg-emerald-500',
  failed: 'bg-rose-500',
  archived: 'bg-zinc-500',
  skipped: 'bg-zinc-200 dark:bg-zinc-800',
}
const BADGE: Record<StageStatus, string> = {
  draft: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  review: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  archived: 'bg-zinc-300 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200',
  skipped: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400',
}

function fmt(s: string | null | undefined) {
  if (!s) return ''
  const d = new Date(s)
  return isNaN(d.getTime()) ? s : d.toLocaleString()
}

function StageFilePreview({ pack, topic, path, onClose }: { pack: string; topic: string; path: string; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: [...packsQk.topic(pack, topic), 'file', path], queryFn: () => packsApi.file(pack, topic, path) })
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  useEffect(() => { if (q.data) setText(q.data.content) }, [q.data])
  const save = useMutation({
    mutationFn: () => packsApi.saveFile(pack, topic, path, text),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: packsQk.topic(pack, topic) }) },
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose} data-testid="pack-file-preview">
      <div className="card flex max-h-[85vh] w-full max-w-3xl flex-col p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate text-xs" title={path}>{path}</code>
          {q.data && <span className="shrink-0 text-xs text-zinc-600 dark:text-zinc-400">{q.data.size} B</span>}
          <div className="ml-auto flex shrink-0 gap-1">
            {!editing && !q.data?.binary && <button className="btn-outline !py-0.5 text-xs" onClick={() => setEditing(true)}>{t('packs.board.edit')}</button>}
            {editing && <button className="btn-primary !py-0.5 text-xs" disabled={save.isPending} onClick={() => save.mutate()}>{t('packs.board.save')}</button>}
            <button className="btn-ghost !py-0.5 text-xs" onClick={onClose}>{t('packs.board.close')}</button>
          </div>
        </div>
        {q.isLoading && <Loading />}
        {q.error && <ErrorBox error={q.error} />}
        {q.data?.binary && <div className="text-xs text-zinc-600 dark:text-zinc-400">binary</div>}
        {q.data && !q.data.binary && (editing ? (
          <textarea className="input min-h-[50vh] flex-1 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden rounded border border-zinc-200 dark:border-zinc-800">
            <FilePreview
              source={{ kind: 'inline', text: q.data.content, title: path.split('/').pop() ?? path, format: guessKind(path) }}
              title={path.split('/').pop() ?? path}
            />
          </div>
        ))}
        {save.error && <div className="mt-1 text-xs text-rose-600 dark:text-rose-400">{String(save.error)}</div>}
      </div>
    </div>
  )
}

function StageCard({ pack, topic, st, active, onSelect, onPreview }: {
  pack: string; topic: string; st: TopicStage; active: boolean; onSelect: () => void; onPreview: (p: string) => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [comment, setComment] = useState('')
  const [to, setTo] = useState(st.id)
  const [err, setErr] = useState<string | null>(null)
  const done = () => { setErr(null); qc.invalidateQueries({ queryKey: packsQk.topic(pack, topic) }); qc.invalidateQueries({ queryKey: packsQk.topics(pack) }) }
  const run = useMutation({ mutationFn: () => packsApi.run(pack, topic, st.id), onSuccess: done, onError: (e: Error) => setErr(e.message) })
  const approve = useMutation({ mutationFn: () => packsApi.approve(pack, topic, st.id, comment), onSuccess: done, onError: (e: Error) => setErr(e.message) })
  const reject = useMutation({ mutationFn: () => packsApi.reject(pack, topic, st.id, comment, to), onSuccess: done, onError: (e: Error) => setErr(e.message) })
  const toggle = useMutation({ mutationFn: () => packsApi.setEnabled(pack, topic, st.id, st.status === 'skipped'), onSuccess: done, onError: (e: Error) => setErr(e.message) })
  const busy = run.isPending || approve.isPending || reject.isPending || toggle.isPending || st.status === 'running'
  const targets = (st.rollback_targets ?? []).filter((t) => t !== st.id)
  return (
    <div className={`card flex w-full shrink-0 flex-col gap-2 p-3 lg:w-64 ${active ? 'ring-2 ring-indigo-500' : ''}`} data-testid={`stage-${st.id}`}
         onClick={onSelect} role="button" tabIndex={0}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${LIGHT[st.status]}`} />
        <span className="min-w-0 flex-1 font-semibold" title={st.title}>{st.title}</span>
        <span className={`badge ml-auto px-1.5 py-0.5 text-xs font-medium ${BADGE[st.status]}`} data-testid={`stage-${st.id}-status`}>
          {t(`packs.board.status.${st.status}`)}
        </span>
      </div>
      {st.gate && <div className="text-xs text-amber-700 dark:text-amber-300">✋ {t('packs.board.gate')}</div>}
      <p className="text-xs text-zinc-600 dark:text-zinc-300">{st.description}</p>
      {(st.criteria || st.role || st.deliverables?.length) ? (
        <dl className="space-y-0.5 text-xs" data-testid={`stage-${st.id}-spec`}>
          {st.role && <div><dt className="inline font-medium text-zinc-600 dark:text-zinc-400">{t('packs.board.role')}：</dt><dd className="inline">{st.role}</dd></div>}
          {st.criteria && <div><dt className="inline font-medium text-zinc-600 dark:text-zinc-400">{t('packs.board.criteria')}：</dt><dd className="inline">{st.criteria}</dd></div>}
          {st.deliverables?.length ? (
            <div><dt className="font-medium text-zinc-600 dark:text-zinc-400">{t('packs.board.deliverables')}：</dt>
              <dd><ul className="list-disc pl-4">{st.deliverables.map((x) => <li key={x}>{x}</li>)}</ul></dd></div>
          ) : null}
        </dl>
      ) : null}
      {st.branch_result && st.branch_result.score != null && (
        <div className="text-xs text-zinc-600 dark:text-zinc-300">{t('packs.board.score')}：{st.branch_result.score}／{st.branch_result.min}</div>
      )}
      {st.status === 'archived' && st.archived_reason && (
        <div className="rounded bg-zinc-100 p-1.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{t('packs.board.archivedReason')}：{st.archived_reason}</div>
      )}
      {st.status === 'review' && st.review_hint && (
        <div className="rounded bg-amber-50 p-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" data-testid={`hint-${st.id}`}>{t('packs.board.aiHint')}：{st.review_hint}</div>
      )}
      <div>
        <div className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('packs.board.files')}</div>
        <ul className="space-y-0.5 text-xs">
          {st.files.map((f: StageFile) => (
            <li key={f.path} className="flex items-center gap-1">
              {f.exists ? (
                <button className="min-w-0 truncate text-left font-mono text-indigo-700 hover:underline dark:text-indigo-300" title={f.path} onClick={(e) => { e.stopPropagation(); onPreview(f.path) }} data-testid={`file-${f.path}`}>
                  {f.path}
                </button>
              ) : (
                <span className="min-w-0 truncate font-mono text-zinc-600 dark:text-zinc-400" title={f.path}>{f.path} <span className="text-2xs">({t('packs.board.missing')})</span></span>
              )}
            </li>
          ))}
        </ul>
      </div>
      {st.feedback && <div className="rounded bg-amber-50 p-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('packs.board.feedback')}：{st.feedback}</div>}
      {st.error && st.status === 'failed' && <div className="rounded bg-rose-50 p-1.5 text-xs text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{t('packs.board.error')}：{st.error}</div>}
      <div className="mt-auto flex flex-col gap-1" onClick={(e) => e.stopPropagation()}>
        {st.status === 'review' ? (
          <>
            <input className="input text-xs" placeholder={t('packs.board.rejectComment')} value={comment} onChange={(e) => setComment(e.target.value)} />
            {targets.length > 0 && (
              <label className="flex min-w-0 items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                {t('packs.board.rejectTo')}
                <select className="input !py-0.5 text-xs" value={to} onChange={(e) => setTo(e.target.value)} data-testid={`reject-to-${st.id}`}>
                  <option value={st.id}>{st.title}</option>
                  {targets.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
            )}
            <div className="flex gap-1">
              <button className="btn-primary flex-1 text-xs" disabled={busy} onClick={() => approve.mutate()} data-testid={`approve-${st.id}`}>{t('packs.board.approve')}</button>
              <button className="btn-danger flex-1 text-xs" disabled={busy || !comment.trim()} onClick={() => reject.mutate()} data-testid={`reject-${st.id}`}>{t('packs.board.reject')}</button>
            </div>
          </>
        ) : st.status === 'skipped' ? null : (
          <button className="btn-outline text-xs" disabled={busy || !st.can_run} title={!st.can_run && st.status !== 'running' ? t('packs.board.blocked') : ''}
                  onClick={() => run.mutate()} data-testid={`run-${st.id}`}>
            {st.status === 'running' ? t('packs.board.running') : st.status === 'done' || st.status === 'failed' || st.status === 'archived' ? t('packs.board.rerun') : t('packs.board.run')}
          </button>
        )}
        {st.optional && (
          <button className="btn-ghost text-xs" disabled={busy || st.can_toggle === false} onClick={() => toggle.mutate()} data-testid={`toggle-${st.id}`}>
            {st.status === 'skipped' ? t('packs.board.enable') : t('packs.board.disable')}
          </button>
        )}
        {err && <div className="text-xs text-rose-600 dark:text-rose-400">{err}</div>}
      </div>
    </div>
  )
}

export function StageBoard() {
  const { t } = useTranslation()
  const { name = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const topicId = params.get('topic') ?? ''
  const stageId = params.get('stage') ?? ''
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [conv, setConv] = useState<string | null>(null)

  const pack = useQuery({ queryKey: packsQk.pack(name), queryFn: () => packsApi.get(name), enabled: !!name })
  const installed = !!(pack.data?.installed ?? pack.data?.status?.installed)
  const topics = useQuery({ queryKey: packsQk.topics(name), queryFn: () => packsApi.topics(name), enabled: installed })
  const topic = useQuery({
    queryKey: packsQk.topic(name, topicId), queryFn: () => packsApi.topic(name, topicId), enabled: installed && !!topicId,
    refetchInterval: (q) => (q.state.data?.stage_list.some((s) => s.status === 'running') ? 2000 : false),
  })
  const create = useMutation({
    mutationFn: () => packsApi.createTopic(name, { title, notes }),
    onSuccess: (d) => { setCreating(false); setTitle(''); setNotes(''); qc.invalidateQueries({ queryKey: packsQk.topics(name) }); setParams({ topic: d.id }) },
  })
  // 沒選主題時選第一個
  useEffect(() => {
    if (!topicId && topics.data && topics.data.length > 0) setParams({ topic: topics.data[0].id }, { replace: true })
  }, [topicId, topics.data, setParams])
  const activeStage = useMemo(() => {
    const list = topic.data?.stage_list ?? []
    return list.find((s) => s.id === stageId) ?? list.find((s) => s.id === topic.data?.current_stage) ?? list[list.length - 1]
  }, [topic.data, stageId])
  const agentOf = (profile: string) => pack.data?.status.agents.find((a) => a.profile === profile)

  if (pack.isLoading) return <Loading />
  if (pack.error) return <ErrorBox error={pack.error} onRetry={() => pack.refetch()} />
  if (!pack.data) return null
  if (!installed) {
    return (
      <div className="p-4">
        <PageHeader title={pack.data.title} />
        <EmptyState title={t('packs.board.notInstalled')} action={{ label: t('packs.board.goInstall'), to: '/packs' }} />
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col p-4">
      <PageHeader title={pack.data.title} subtitle={pack.data.description}
                  actions={<Link to="/packs" className="btn-ghost text-xs">{t('packs.title')}</Link>} />
      <div className="flex min-h-0 flex-1">
        {/* 左：主題清單 */}
        <CollapsiblePanel id="packs.topics" side="left" title={t('panels.topics')} icon="ListTree" defaultWidth={260} min={200} max={420}
                          bodyClassName="flex min-h-0 flex-col overflow-auto p-3" data-testid="topic-list">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{t('packs.board.topics')}</span>
            <button className="btn-primary !py-0.5 text-xs" onClick={() => setCreating(true)} data-testid="new-topic">{t('packs.board.newTopic')}</button>
          </div>
          {creating && (
            <form className="mb-2 space-y-1" onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate() }}>
              <input className="input text-sm" placeholder={t('packs.board.newTopicTitle')} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus data-testid="topic-title" />
              <textarea className="input text-xs" rows={2} placeholder={t('packs.board.newTopicNotes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <div className="flex flex-wrap gap-1">
                <button type="submit" className="btn-primary flex-1 text-xs" disabled={create.isPending || !title.trim()} data-testid="topic-create">{t('packs.board.create')}</button>
                <button type="button" className="btn-ghost text-xs" onClick={() => setCreating(false)}>{t('packs.board.cancel')}</button>
              </div>
              {create.error && <div className="text-xs text-rose-600 dark:text-rose-400">{String(create.error)}</div>}
            </form>
          )}
          {topics.isLoading && <Loading />}
          {topics.data && topics.data.length === 0 && !creating && <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('packs.board.noTopics')}</div>}
          <ul className="min-h-0 flex-1 space-y-1 overflow-auto">
            {topics.data?.map((tp) => (
              <li key={tp.id}>
                <button className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 ${tp.id === topicId ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}
                        onClick={() => setParams({ topic: tp.id })} data-testid={`topic-${tp.id}`}>
                  <div className="truncate font-medium" title={tp.title}>{tp.title}</div>
                  <div className="mt-1 flex items-center gap-1">
                    {tp.lights.map((l, i) => <span key={i} className={`h-2 w-2 shrink-0 rounded-full ${LIGHT[l]}`} title={pack.data!.stages[i]?.title} />)}
                    <code className="ml-auto shrink-0 font-mono text-2xs text-zinc-600 dark:text-zinc-400">{tp.id.slice(0, 8)}</code>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </CollapsiblePanel>

        {/* 中：階段卡 */}
        <WorkArea className="overflow-auto px-4">
          {!topicId && <EmptyState title={t('packs.board.selectTopic')} compact />}
          {topic.isLoading && <Loading />}
          {topic.error && <ErrorBox error={topic.error} onRetry={() => topic.refetch()} />}
          {topic.data && (
            <>
              <div className="mb-2 flex min-w-0 flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{topic.data.title}</span>
                <span className="min-w-0">{t('packs.board.folder')}：<code className="path-text inline" title={topic.data.dir}>{topic.data.dir}</code></span>
              </div>
              <div className="flex flex-col gap-3 lg:flex-row lg:overflow-x-auto lg:pb-2" data-testid="stage-row">
                {topic.data.stage_list.map((s) => (
                  <StageCard key={s.id} pack={name} topic={topic.data!.id} st={s} active={activeStage?.id === s.id}
                             onSelect={() => setParams({ topic: topic.data!.id, stage: s.id })} onPreview={setPreview} />
                ))}
              </div>
            </>
          )}
        </WorkArea>

        {/* 右：負責員工與最近一次 run */}
        <CollapsiblePanel id="packs.stageSide" side="right" title={t('panels.stageAgent')} icon="Users" defaultWidth={260} min={200} max={420}
                          bodyClassName="overflow-auto p-3 text-sm" data-testid="stage-side">
          {activeStage ? (
            <>
              <div className="mb-2 font-semibold">{activeStage.title}</div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('packs.board.agent')}</div>
              <div className="mb-3">
                <div className="truncate font-medium" title={agentOf(activeStage.agent)?.name ?? activeStage.agent}>{agentOf(activeStage.agent)?.name ?? activeStage.agent}</div>
                <code className="id-text block text-xs text-zinc-600 dark:text-zinc-400" title={activeStage.agent}>{activeStage.agent}</code>
                {agentOf(activeStage.agent)?.title && <div className="text-xs text-zinc-600 dark:text-zinc-400">{agentOf(activeStage.agent)!.title}</div>}
                {agentOf(activeStage.agent)?.agent_id && (
                  <Link to={`/agents?id=${agentOf(activeStage.agent)!.agent_id}`} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline dark:text-indigo-300">SOUL.md</Link>
                )}
              </div>
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{t('packs.board.lastRun')}</div>
              {activeStage.run_id ? (
                <div className="space-y-1">
                  <div className="text-xs">{fmt(activeStage.updated_at)} · <span className={`badge px-1 py-0.5 text-xs ${BADGE[activeStage.status]}`}>{t(`packs.board.status.${activeStage.status}`)}</span></div>
                  <div className="flex flex-wrap gap-1">
                    {activeStage.session_id && (
                      <button className="btn-outline !py-0.5 text-xs" onClick={() => setConv(activeStage.session_id)} data-testid="open-conversation">{t('packs.board.conversation')}</button>
                    )}
                    <Link to={`/workflows/runs/${activeStage.run_id}`} className="btn-outline !py-0.5 text-xs">{t('packs.board.runPage')}</Link>
                  </div>
                  <code className="id-text block text-2xs text-zinc-600 dark:text-zinc-400" title={activeStage.run_id}>{activeStage.run_id}</code>
                </div>
              ) : (
                <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('packs.board.noRun')}</div>
              )}
            </>
          ) : (
            <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('packs.board.selectTopic')}</div>
          )}
        </CollapsiblePanel>
      </div>
      {preview && topic.data && <StageFilePreview pack={name} topic={topic.data.id} path={preview} onClose={() => setPreview(null)} />}
      {conv && <ConversationModal sessionId={conv} onClose={() => setConv(null)} />}
    </div>
  )
}
