import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApprovalDecision } from '../../api/types'
import type { Attachment } from '../../api/sessions'
import type { ChatItem, SubagentItem, TextItem } from '../../ws/chatState'
import { ApprovalCard } from './ApprovalCard'
import { ToolCard } from './ToolCard'
import { CopyButton, FileChip, Markdown } from './Markdown'

export interface MessageActions {
  onReply?: (item: TextItem) => void
  onEdit?: (item: TextItem) => void
  onRegenerate?: () => void
  onOpenFile?: (path: string) => void
}

const fmtBytes = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

export function AttachmentChips({ items, onOpenFile }: { items: Attachment[]; onOpenFile?: (p: string) => void }) {
  return (
    <div className="mb-1 flex flex-wrap gap-1" data-testid="attachments">
      {items.map((a) => (
        <button
          key={a.path}
          type="button"
          className="inline-flex max-w-[16rem] items-center gap-1 rounded border border-current/20 bg-white/20 px-1.5 py-0.5 text-xs hover:bg-white/40 dark:bg-black/20"
          title={a.path}
          onClick={() => onOpenFile?.(a.path)}
        >
          <span aria-hidden>{a.mime?.startsWith('image/') ? '🖼' : '📄'}</span>
          <span className="min-w-0 truncate">{a.name}</span>
          {a.size > 0 && <span className="shrink-0 whitespace-nowrap opacity-70">{fmtBytes(a.size)}</span>}
        </button>
      ))}
    </div>
  )
}

function Quote({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <div className="mb-1 border-l-2 border-current/40 pl-2 text-xs opacity-80" data-testid="quote">
      <div className="opacity-70">{t('chat.replyingTo')}</div>
      <div className="line-clamp-3 whitespace-pre-wrap">{text}</div>
    </div>
  )
}

function SubagentCard({ item }: { item: SubagentItem }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const running = item.status === 'running'
  const failed = item.status === 'failed' || item.status === 'timeout' || item.status === 'error'
  const meta = [
    item.task_count ? `${(item.task_index ?? 0) + 1}/${item.task_count}` : '',
    item.model ?? '',
    item.duration_seconds != null ? `${item.duration_seconds}s` : '',
    item.tool_count != null ? `${item.tool_count} tools` : '',
    item.input_tokens != null || item.output_tokens != null ? `${item.input_tokens ?? 0}→${item.output_tokens ?? 0} tok` : '',
    item.cost_usd != null ? `$${item.cost_usd}` : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className="card my-1 min-w-0 max-w-full text-sm sm:max-w-3xl" data-testid="subagent-card" data-status={item.status}>
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${running ? 'animate-pulse bg-amber-500' : failed ? 'bg-rose-500' : 'bg-emerald-500'}`} />
        <span className="shrink-0 text-xs text-zinc-600 dark:text-zinc-400">{t('chat.subagent.title')}</span>
        <span className="min-w-0 flex-1 truncate text-xs" title={item.goal || item.subagent_id}>{item.goal || item.subagent_id}</span>
        <span className="ml-auto shrink-0 text-xs text-zinc-600 dark:text-zinc-400">
          {running ? t('chat.subagent.running') : failed ? t('chat.subagent.failed') : t('chat.subagent.done')} · {open ? t('chat.tool.collapse') : t('chat.tool.expand')}
        </span>
      </button>
      {open && (
        <div className="border-t border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
          {meta && <div className="mb-1 text-zinc-600 dark:text-zinc-400">{meta}</div>}
          {item.summary && <div className="whitespace-pre-wrap" data-testid="subagent-summary">{item.summary}</div>}
          {item.output_tail && <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-800">{item.output_tail}</pre>}
          {!item.summary && !item.output_tail && !running && <div className="text-zinc-600 dark:text-zinc-400">—</div>}
        </div>
      )}
    </div>
  )
}

function ReasoningCard({ text }: { text: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1 min-w-0 max-w-full rounded-md border border-dashed border-zinc-300 text-xs sm:max-w-3xl text-zinc-600 dark:text-zinc-400 dark:border-zinc-700" data-testid="reasoning-card">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span aria-hidden>💭</span>
        <span className="shrink-0 whitespace-nowrap">{t('chat.reasoning')}</span>
        {!open && <span className="min-w-0 truncate opacity-70">{text.slice(0, 80)}</span>}
        <span className="ml-auto shrink-0 whitespace-nowrap">{open ? t('chat.tool.collapse') : t('chat.tool.expand')}</span>
      </button>
      {open && <div className="whitespace-pre-wrap border-t border-dashed border-zinc-300 px-3 py-2 dark:border-zinc-700">{text}</div>}
    </div>
  )
}

export function MessageList({
  items, onDecide, actions = {}, running = false,
}: {
  items: ChatItem[]
  onDecide: (runId: string, approvalId: string, d: ApprovalDecision) => void
  actions?: MessageActions
  running?: boolean
}) {
  const { t } = useTranslation()
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [items])
  const byId = new Map<string, TextItem>()
  for (const it of items) if (it.kind === 'text') { byId.set(it.id, it); if (it.message_id) byId.set(it.message_id, it) }
  const lastUser = [...items].reverse().find((i) => i.kind === 'text' && i.role === 'user') as TextItem | undefined
  const lastAssistant = [...items].reverse().find((i) => i.kind === 'text' && i.role === 'assistant') as TextItem | undefined

  return (
    <div className="flex flex-col gap-1 p-4" data-testid="message-list">
      {items.map((it) => {
        if (it.kind === 'tool') return <ToolCard key={it.id} item={it} onOpenFile={actions.onOpenFile} />
        if (it.kind === 'approval') return <ApprovalCard key={it.id} item={it} onDecide={(d) => onDecide(it.run_id, it.approval_id, d)} />
        if (it.kind === 'reasoning') return <ReasoningCard key={it.id} text={it.text} />
        if (it.kind === 'subagent') return <SubagentCard key={it.id} item={it} />
        if (it.kind === 'notice')
          return (
            <div key={it.id} className={`my-1 text-xs ${it.level === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-600 dark:text-zinc-400'}`}>
              {it.level === 'error' ? `${t('workbench.runFailed')}: ${it.text}` : t('workbench.runCancelled')}
            </div>
          )
        const mine = it.role === 'user'
        const quoted = it.reply_to ? byId.get(it.reply_to) : undefined
        const canEdit = mine && !running && it === lastUser && !!actions.onEdit
        const canRegen = !mine && !running && it === lastAssistant && !!actions.onRegenerate
        return (
          <div key={it.id} className={`group flex min-w-0 ${mine ? 'justify-end' : 'justify-start'}`} data-role={it.role} data-message-id={it.message_id ?? it.id}>
            <div className={`relative min-w-0 max-w-full rounded-lg px-3 py-2 text-sm sm:max-w-3xl ${mine ? 'bg-indigo-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800'}`}>
              <div className={`mb-0.5 flex flex-wrap items-center gap-2 text-2xs ${mine ? 'text-indigo-100' : 'text-zinc-600 dark:text-zinc-400'}`}>
                <span>{mine ? t('chat.roleUser') : t('chat.roleAssistant')}</span>
                {it.usage && typeof it.usage.total_tokens === 'number' && <span title={JSON.stringify(it.usage)}>· {String(it.usage.total_tokens)} tok</span>}
              </div>
              {quoted && <Quote text={quoted.content} />}
              {it.attachments && it.attachments.length > 0 && <AttachmentChips items={it.attachments} onOpenFile={actions.onOpenFile} />}
              {mine ? (
                <div className="whitespace-pre-wrap break-words">{it.content}</div>
              ) : (
                <Markdown text={it.content} onOpenFile={actions.onOpenFile} />
              )}
              {it.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" aria-hidden />}
              {!it.streaming && (
                <div className={`mt-1 flex flex-wrap items-center gap-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${mine ? 'text-indigo-100' : 'text-zinc-600 dark:text-zinc-400'}`} data-testid="message-actions">
                  <CopyButton text={it.content} className={mine ? 'text-indigo-100 hover:bg-indigo-500 hover:text-white' : ''} />
                  {actions.onReply && (
                    <button type="button" className="rounded px-1.5 py-0.5 hover:bg-black/10 dark:hover:bg-white/10" onClick={() => actions.onReply!(it)}>
                      {t('chat.reply')}
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className="rounded px-1.5 py-0.5 hover:bg-black/10" onClick={() => actions.onEdit!(it)}>
                      {t('chat.edit')}
                    </button>
                  )}
                  {canRegen && (
                    <button type="button" className="rounded px-1.5 py-0.5 hover:bg-black/10 dark:hover:bg-white/10" onClick={() => actions.onRegenerate!()}>
                      {t('chat.regenerate')}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
      <div ref={endRef} />
    </div>
  )
}

export { FileChip }
