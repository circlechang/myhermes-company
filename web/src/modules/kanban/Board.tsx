import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCorners, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBox, Loading } from '../../components/QueryState'
import '../../guide/i18n'
import { COLUMNS, columnOf, resolveDrop, useBoard, useKanbanMutations, type Card, type Column, type HermesStatus, type PriorityLabel } from './api'
import { CardDrawer } from './CardDrawer'

const prioColor: Record<PriorityLabel, string> = {
  low: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
  medium: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  high: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  urgent: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
}

export function KanbanBoard() {
  const { t } = useTranslation()
  const [assignee, setAssignee] = useState('')
  const [archived, setArchived] = useState(false)
  const q = useBoard(assignee || undefined, archived)
  const m = useKanbanMutations()
  const [showForm, setShowForm] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [active, setActive] = useState<Card | null>(null)
  const [form, setForm] = useState({ title: '', body: '', assignee: '', priority: 'medium' as PriorityLabel, tags: '' })
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))

  const cards = q.data?.tasks ?? []
  const byCol = useMemo(() => {
    const map: Record<Column, Card[]> = { todo: [], ready: [], running: [], review: [], blocked: [], done: [] }
    for (const c of cards) {
      const col = columnOf(c.status)
      if (col) map[col].push(c)
    }
    return map
  }, [cards])
  const stuck = cards.filter((c) => (c.diagnostics ?? []).length > 0)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.title.trim()) return
    await m.create.mutateAsync({ title: form.title.trim(), body: form.body || undefined, assignee: form.assignee || undefined, priority: form.priority, tags: form.tags.split(/[,，\s]+/).filter(Boolean) })
    setForm({ title: '', body: '', assignee: '', priority: 'medium', tags: '' })
    setShowForm(false)
  }
  const onDragStart = (e: DragStartEvent) => setActive(cards.find((c) => c.id === e.active.id) ?? null)
  const onDragEnd = (e: DragEndEvent) => {
    setActive(null)
    const card = cards.find((c) => c.id === e.active.id)
    const target = resolveDrop(card, e.over?.id ? String(e.over.id) : null)
    if (card && target) move(card, target)
  }
  const move = (card: Card, status: HermesStatus) => {
    const extra: { reason?: string; result?: string } = {}
    if (status === 'blocked') extra.reason = prompt(t('kanban.blockReason')) ?? ''
    m.move.mutate({ id: card.id, status, extra })
  }

  return (
    <div className="flex h-full flex-col p-2 sm:p-4">
      <PageHeader
        title={t('kanban.title')}
        subtitle={t('kanban.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select className="input w-auto" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label={t('kanban.filterProfile')}>
              <option value="">{t('kanban.allProfiles')}</option>
              {q.data?.profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <label className="flex shrink-0 items-center gap-1 whitespace-nowrap text-xs"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />{t('kanban.showArchived')}</label>
            <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>+ {t('kanban.newTask')}</button>
          </div>
        }
      />
      {m.move.error ? <div className="mb-2 rounded bg-rose-50 p-2 text-xs text-rose-700 dark:bg-rose-950/40" data-testid="move-error">{(m.move.error as Error).message}</div> : null}
      {stuck.length > 0 && (
        <div className="mb-2 rounded bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200" data-testid="diagnostics-banner">
          ⚠ {t('kanban.stuckCards', { n: stuck.length })}：{stuck.map((c) => <button key={c.id} className="mr-2 max-w-[16rem] truncate align-bottom underline" title={c.title} onClick={() => setOpen(c.id)}>{c.title}</button>)}
        </div>
      )}
      {showForm && (
        <form onSubmit={submit} className="card mb-3 grid grid-cols-1 items-end gap-2 p-3 text-sm sm:grid-cols-[1fr_1fr_140px_100px_140px_auto]">
          <label><span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('kanban.taskTitle')}</span><input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label>
          <label><span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('kanban.taskBody')}</span><input className="input" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></label>
          <label><span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('kanban.assignee')}</span>
            <select className="input" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
              <option value="">{t('kanban.unassigned')}</option>
              {q.data?.profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label><span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('kanban.priority')}</span>
            <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as PriorityLabel })}>
              {(['low', 'medium', 'high', 'urgent'] as const).map((p) => <option key={p} value={p}>{t(`kanban.priorities.${p}`)}</option>)}
            </select>
          </label>
          <label><span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('kanban.tags')}</span><input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="a, b" /></label>
          <button className="btn-primary" type="submit" disabled={m.create.isPending}>{t('common.create')}</button>
        </form>
      )}
      {q.isLoading && <Loading />}
      {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : null}
      {q.data && cards.length === 0 && !showForm && (
        <EmptyState testId="empty-cards" title={t('guide.empty.cards.title')} body={t('guide.empty.cards.body')} action={{ label: t('guide.empty.cards.action'), onClick: () => setShowForm(true) }} />
      )}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActive(null)}>
        <div className="grid min-h-0 flex-1 auto-cols-[minmax(220px,1fr)] grid-flow-col gap-3 overflow-x-auto" data-testid="board">
          {COLUMNS.map((col) => (
            <ColumnView key={col} col={col} cards={byCol[col]} onOpen={setOpen} onMove={move} />
          ))}
        </div>
        <DragOverlay>{active ? <CardView card={active} overlay /> : null}</DragOverlay>
      </DndContext>
      {open && <CardDrawer id={open} profiles={q.data?.profiles ?? []} onClose={() => setOpen(null)} />}
    </div>
  )
}

function ColumnView({ col, cards, onOpen, onMove }: { col: Column; cards: Card[]; onOpen: (id: string) => void; onMove: (c: Card, s: HermesStatus) => void }) {
  const { t } = useTranslation()
  const { setNodeRef, isOver } = useDroppable({ id: `col-${col}` })
  return (
    <div ref={setNodeRef} className={`flex min-h-0 flex-col rounded-lg bg-zinc-100 dark:bg-zinc-900 ${isOver ? 'ring-2 ring-indigo-400' : ''}`} data-testid={`col-${col}`}>
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
        <span className="min-w-0 truncate">{t(`kanban.col.${col}`)}</span>
        <span className="badge rounded-full bg-zinc-200 dark:bg-zinc-800">{cards.length}</span>
      </div>
      <div className="min-h-[3rem] flex-1 space-y-2 overflow-auto px-2 pb-2">
        {cards.map((c) => <DraggableCard key={c.id} card={c} onOpen={onOpen} onMove={onMove} />)}
      </div>
    </div>
  )
}

function DraggableCard({ card, onOpen, onMove }: { card: Card; onOpen: (id: string) => void; onMove: (c: Card, s: HermesStatus) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: card.id, disabled: card.status === 'archived' })
  const style = transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? 'opacity-40' : ''}>
      <CardView card={card} onOpen={onOpen} onMove={onMove} handle={{ ...attributes, ...listeners }} />
    </div>
  )
}

function CardView({ card, onOpen, onMove, handle, overlay }: { card: Card; onOpen?: (id: string) => void; onMove?: (c: Card, s: HermesStatus) => void; handle?: Record<string, unknown>; overlay?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={`card p-2 text-sm ${overlay ? 'shadow-lg' : ''}`} data-testid={`card-${card.id}`}>
      <div className="flex min-w-0 items-start gap-1">
        <button type="button" className="shrink-0 cursor-grab touch-none select-none text-zinc-600 dark:text-zinc-400" aria-label={t('kanban.dragHandle', { title: card.title })} {...(handle ?? {})}>⠿</button>
        <button type="button" className="line-clamp-2 min-w-0 flex-1 text-left font-medium hover:underline" title={card.title} onClick={() => onOpen?.(card.id)}>{card.title}</button>
        {(card.diagnostics ?? []).length > 0 && <span title={(card.diagnostics ?? []).map((d) => d.title).join('\n')} className="shrink-0 text-amber-700 dark:text-amber-400 dark:text-amber-400">⚠</span>}
      </div>
      {card.body && <div className="mt-1 line-clamp-3 text-xs text-zinc-600 dark:text-zinc-400" title={card.body}>{card.body}</div>}
      {(card.tags ?? []).length > 0 && <div className="mt-1 flex flex-wrap gap-1">{(card.tags ?? []).map((tg) => <span key={tg} className="badge max-w-full truncate bg-indigo-50 px-1 text-[10px] text-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-200" title={tg}>#{tg}</span>)}</div>}
      <div className="mt-2 flex min-w-0 items-center gap-1 text-[10px]">
        <span className={`badge px-1.5 py-0.5 ${prioColor[card.priority_label]}`}>{t(`kanban.priorities.${card.priority_label}`)}</span>
        <span className="min-w-0 truncate text-zinc-600 dark:text-zinc-400" title={card.assignee ?? undefined}>{card.assignee ? `@${card.assignee}` : t('kanban.unassigned')}</span>
        <span className="shrink-0 whitespace-nowrap text-zinc-600 dark:text-zinc-400">{card.status}</span>
        {onMove && (
          <select
            aria-label={t('kanban.moveTo')}
            className="ml-auto shrink-0 rounded border border-zinc-300 bg-transparent px-1 py-0.5 text-[10px] dark:border-zinc-700"
            value={columnOf(card.status) ?? 'todo'}
            onChange={(e) => { const s = e.target.value as HermesStatus; if (s !== 'running') onMove(card, s) }}
          >
            {COLUMNS.map((s) => <option key={s} value={s} disabled={s === 'running'}>{t(`kanban.col.${s}`)}</option>)}
          </select>
        )}
      </div>
    </div>
  )
}
