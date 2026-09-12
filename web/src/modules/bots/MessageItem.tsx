// 一則訊息：泡泡（自己靠右亮灰、Bot 靠左深灰）、引用、文件卡、核准卡、工具列、交棒提示、反應、討論串摘要、滑過操作列。
import { ChevronRight, Copy, CornerUpLeft, FileText, MessageSquareText, MoreHorizontal, ShieldAlert, SmilePlus, Wrench } from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ApprovalAttachment, DocAttachment, HandoffAttachment, Msg, ToolItem, ToolsAttachment } from './api'
import { BlobAvatar, LetterAvatar, StackedAvatars } from './Avatar'
import { clip, clock, toDate } from './util'
import { MenuList } from './ui'

export const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '✅']

const MENTION_RE = /(^|[\s（(，,])@([\w一-鿿぀-ヿ.-]+)/g
function linkMentions(md: string): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return parts.map((p, i) => (i % 2 ? p : p.replace(MENTION_RE, (_m, pre: string, name: string) => `${pre}[@${name}](mention:${encodeURIComponent(name)})`))).join('')
}
const mdComponents: Components = {
  a: ({ href, children }) =>
    href?.startsWith('mention:') ? <span className="mention">{children}</span> : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
}
export const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="gb-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents} urlTransform={(u) => (u.startsWith('mention:') ? u : defaultUrlTransform(u))}>
        {linkMentions(text)}
      </ReactMarkdown>
    </div>
  )
})

export interface MsgCtx {
  myRmIds: Set<string>
  isGroup: boolean
  botAvatarByRm: (rmId?: string | null) => string | undefined
  botAvatarByAgent: (agentId?: string | null) => string | undefined
  onReply: (m: Msg) => void
  onThread: (m: Msg) => void
  onReact: (m: Msg, emoji: string) => void
  onOpenDoc: (docId: string, version?: number) => void
  onApprove: (m: Msg, choice: 'once' | 'always' | 'deny') => void
  inThread?: boolean
}

export function DocCard({ a, onOpen, mine = false }: { a: DocAttachment; onOpen: () => void; mine?: boolean }) {
  const verb = a.action === 'created' ? '建立' : a.action === 'edited' ? '編輯' : a.action === 'same' ? '檢查（沒有改動）' : '修改'
  return (
    <button type="button" onClick={onOpen} data-testid="doc-card" data-doc-id={a.doc_id} data-version={a.version}
      className="group/doc mt-1.5 flex w-full max-w-[380px] items-start gap-3 rounded-2xl border border-[var(--gb-line2)] bg-[var(--gb-elev)] p-3 text-left hover:border-[#3a3a3a] hover:bg-[#1c1c1c]">
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#1d9bf01f] text-[var(--gb-accent)]">
        <FileText size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-[var(--gb-text)]">{a.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--gb-sub)]">
          <span className="rounded-md bg-[var(--gb-elev2)] px-1.5 py-px font-medium text-[var(--gb-text)]" data-testid="doc-card-version">v{a.version}</span>
          <span>{mine ? '你' : a.author} {verb}</span>
          {a.action !== 'created' && a.action !== 'same' && (
            <span><span className="text-[var(--gb-green)]">+{a.diff_stat.added}</span> <span className="text-[var(--gb-red)]">−{a.diff_stat.removed}</span></span>
          )}
        </span>
        {a.summary && <span className="mt-1 line-clamp-2 block text-xs text-[var(--gb-sub)]">{a.summary}</span>}
      </span>
      <ChevronRight size={16} className="mt-3 shrink-0 text-[var(--gb-mute)] group-hover/doc:text-[var(--gb-text)]" />
    </button>
  )
}

const APPROVAL_LABEL: Record<string, string> = { once: '已允許一次', always: '已設為一律允許', session: '本次對話允許', deny: '已拒絕' }

export function ApprovalCard({ a, onChoose }: { a: ApprovalAttachment; onChoose: (c: 'once' | 'always' | 'deny') => void }) {
  const pending = a.status === 'pending'
  return (
    <div className="mt-1.5 w-full max-w-[460px] rounded-2xl border border-[#f59e0b44] bg-[#f59e0b0d] p-3" data-testid="approval-card" data-status={a.status}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ShieldAlert size={16} className="text-[var(--gb-amber)]" />
        <span className="flex-1">需要你核准</span>
        <span className={`rounded-full px-2 py-0.5 text-xs ${pending ? 'bg-[#f59e0b26] text-[var(--gb-amber)]' : a.status === 'deny' ? 'bg-[#ef444426] text-[var(--gb-red)]' : 'bg-[#22c55e26] text-[var(--gb-green)]'}`}>
          {pending ? '等你決定' : APPROVAL_LABEL[a.status] ?? a.status}
        </span>
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        {a.tool && <div className="flex gap-2"><dt className="w-10 shrink-0 text-[var(--gb-mute)]">工具</dt><dd>{a.tool}</dd></div>}
        {a.command && (
          <div className="flex gap-2"><dt className="w-10 shrink-0 text-[var(--gb-mute)]">要做</dt>
            <dd className="min-w-0 flex-1"><code className="block overflow-x-auto whitespace-pre rounded-lg bg-black/50 px-2 py-1 font-mono text-[var(--gb-text)]">{a.command}</code></dd>
          </div>
        )}
        {a.description && <div className="flex gap-2"><dt className="w-10 shrink-0 text-[var(--gb-mute)]">原因</dt><dd className="text-[var(--gb-sub)]">{a.description}</dd></div>}
      </dl>
      {pending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="rounded-full bg-[var(--gb-text)] px-3.5 py-1.5 text-sm font-medium text-black hover:bg-white" onClick={() => onChoose('once')}>允許一次</button>
          <button type="button" className="rounded-full bg-[var(--gb-elev2)] px-3.5 py-1.5 text-sm hover:bg-[#2c2c2c]" onClick={() => onChoose('always')}>一律允許</button>
          <button type="button" className="rounded-full px-3.5 py-1.5 text-sm text-[var(--gb-red)] ring-1 ring-[#ef444455] hover:bg-[#ef44441a]" onClick={() => onChoose('deny')}>拒絕</button>
        </div>
      ) : (
        a.decided_by && <p className="mt-2 text-xs text-[var(--gb-mute)]">{a.decided_by} 決定</p>
      )}
    </div>
  )
}

export function ToolsLine({ items, live = false }: { items: ToolItem[]; live?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!items.length) return null
  const running = items.find((t) => t.status === 'running')
  const label = running ? `正在使用 ${running.tool}` : `用了 ${items.length} 個工具`
  return (
    <div className="mb-1 text-xs" data-testid="tools-line">
      <button type="button" className="inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 text-[var(--gb-sub)] hover:text-[var(--gb-text)]" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Wrench size={13} />
        <span className={running && live ? 'gb-shimmer' : ''}>{label}</span>
        <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <ul className="ml-5 mt-1 space-y-0.5 border-l border-[var(--gb-line2)] pl-3">
          {items.map((t, i) => (
            <li key={i} className="flex min-w-0 items-center gap-2 text-[var(--gb-sub)]">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.status === 'error' ? 'bg-[var(--gb-red)]' : t.status === 'running' ? 'bg-[var(--gb-amber)]' : 'bg-[var(--gb-green)]'}`} />
              <span className="font-medium text-[var(--gb-text)]">{t.tool}</span>
              {t.preview && <span className="truncate font-mono">{t.preview}</span>}
              {t.status === 'error' && <span className="text-[var(--gb-red)]">沒成功</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function HandoffPill({ a, avatarOf }: { a: HandoffAttachment; avatarOf: (agentId?: string | null) => string | undefined }) {
  return (
    <div className="my-2 flex justify-center" data-testid="handoff">
      <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs text-[var(--gb-sub)]">
        傳訊息給
        <StackedAvatars items={a.to.map((t) => ({ seed: t.name, avatar: avatarOf(t.agent_id) }))} />
        <span className="text-[var(--gb-text)]">{a.to.length > 2 ? `${a.to.length} 位` : a.to.map((t) => t.name).join('、')}</span>
      </span>
    </div>
  )
}

function Actions({ mine, m, ctx, onCopy }: { mine: boolean; m: Msg; ctx: MsgCtx; onCopy: () => void }) {
  const [menu, setMenu] = useState<'more' | 'emoji' | null>(null)
  const btnc = 'inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--gb-sub)] hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]'
  return (
    <div className={`gb-actions relative flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${menu ? 'opacity-100' : ''} ${mine ? 'order-first' : ''}`}
      data-testid="msg-actions">
      <button type="button" className={btnc} aria-label="更多" onClick={() => setMenu(menu === 'more' ? null : 'more')}><MoreHorizontal size={16} /></button>
      <button type="button" className={btnc} aria-label="回覆" onClick={() => ctx.onReply(m)}><CornerUpLeft size={15} /></button>
      <button type="button" className={btnc} aria-label="加上反應" onClick={() => setMenu(menu === 'emoji' ? null : 'emoji')}><SmilePlus size={15} /></button>
      {menu === 'more' && (
        <MenuList align={mine ? 'right' : 'left'} onDone={() => setMenu(null)} style={{ top: '100%' }}
          items={[
            ...(!ctx.inThread ? [{ label: '開討論串', icon: <MessageSquareText size={15} />, onSelect: () => ctx.onThread(m), testId: 'act-thread' }] : []),
            { label: '引用回覆', icon: <CornerUpLeft size={15} />, onSelect: () => ctx.onReply(m) },
            { label: '複製文字', icon: <Copy size={15} />, onSelect: onCopy },
          ]} />
      )}
      {menu === 'emoji' && (
        <div role="menu" className={`gb-arrive absolute top-full z-40 mt-1 flex gap-0.5 rounded-full border border-[var(--gb-line2)] bg-[var(--gb-elev2)] p-1 shadow-xl ${mine ? 'right-0' : 'left-0'}`}>
          {QUICK_EMOJI.map((e) => (
            <button key={e} type="button" role="menuitem" aria-label={`反應 ${e}`} className="h-8 w-8 rounded-full text-lg hover:bg-[#333]"
              onClick={() => { setMenu(null); ctx.onReact(m, e) }}>{e}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function Bubble({ mine, children, failed }: { mine: boolean; children: ReactNode; failed?: boolean }) {
  return (
    <div className={`min-w-0 max-w-full rounded-[20px] px-4 py-2.5 ${mine ? 'bg-[var(--gb-user)] text-white' : 'bg-[var(--gb-bot)] text-[var(--gb-text)]'} ${failed ? 'ring-1 ring-[#ef444466]' : ''}`}
      data-testid={mine ? 'bubble-mine' : 'bubble-bot'}>
      {children}
    </div>
  )
}

export function MessageItem({ m, ctx, showHeader }: { m: Msg; ctx: MsgCtx; showHeader: boolean }) {
  const mine = !!m.sender_id && ctx.myRmIds.has(m.sender_id)
  const docs = m.attachments.filter((a): a is DocAttachment => a.type === 'doc')
  const approval = m.attachments.find((a): a is ApprovalAttachment => a.type === 'approval')
  const tools = m.attachments.find((a): a is ToolsAttachment => a.type === 'tools')
  const handoff = m.attachments.find((a): a is HandoffAttachment => a.type === 'handoff')
  const copy = () => navigator.clipboard?.writeText(m.content).catch(() => undefined)

  // 人在面板改文件：當系統事件置中顯示
  if (m.sender_kind === 'human' && !m.content && docs.length && docs.every((d) => d.action === 'edited')) {
    return (
      <div className="my-2 flex flex-col items-center gap-1" data-testid="system-line">
        <span className="text-xs text-[var(--gb-mute)]">{mine ? '你' : m.sender_name} 編輯了〈{docs[0].title}〉→ v{docs[0].version}</span>
        <div className="w-full max-w-[380px]">{docs.map((d) => <DocCard key={d.doc_id + d.version} a={d} mine={ctx.myRmIds.has(d.author_rm_id)} onOpen={() => ctx.onOpenDoc(d.doc_id, d.version)} />)}</div>
      </div>
    )
  }
  if (m.sender_kind === 'system') {
    return <div className="my-2 text-center text-xs text-[var(--gb-mute)]" data-testid="system-line">{m.content}</div>
  }

  const hasBody = !!m.content.trim()
  const avatar = !mine && ctx.isGroup ? (
    showHeader ? <BlobAvatar avatar={ctx.botAvatarByRm(m.sender_id)} seed={m.sender_name} size={30} /> : <span className="w-[30px] shrink-0" />
  ) : null
  const humanOther = !mine && m.sender_kind === 'human'
  return (
    <div className={`gb-arrive group ${showHeader ? 'mt-3' : 'mt-0.5'}`} data-testid="msg" data-sender={m.sender_name} data-kind={m.sender_kind} data-msg-id={m.id}>
      {showHeader && ctx.isGroup && !mine && (
        <div className="mb-0.5 ml-[42px] text-xs text-[var(--gb-sub)]">{m.sender_name}</div>
      )}
      <div className={`flex items-start gap-2 ${mine ? 'justify-end' : 'justify-start'}`}>
        {avatar && (humanOther ? (showHeader ? <LetterAvatar name={m.sender_name} size={30} /> : <span className="w-[30px] shrink-0" />) : avatar)}
        <div className={`flex min-w-0 max-w-[min(740px,82%)] flex-col ${mine ? 'items-end' : 'items-start'}`}>
          {tools && <ToolsLine items={tools.items} />}
          {(hasBody || m.reply_to) && (
            <div className="flex max-w-full items-center gap-1">
              {mine && <Actions mine m={m} ctx={ctx} onCopy={copy} />}
              <Bubble mine={mine} failed={m.status === 'failed'}>
                {m.reply_to && (
                  <div className={`mb-1.5 border-l-2 pl-2 text-xs ${mine ? 'border-white/50 text-white/75' : 'border-[#555] text-[var(--gb-sub)]'}`} data-testid="quote">
                    <span className="font-medium">{m.reply_to.sender_name}</span>：{m.reply_to.has_doc && !m.reply_to.content ? '（文件）' : clip(m.reply_to.content, 90)}
                  </div>
                )}
                {hasBody && (mine ? <div className="whitespace-pre-wrap break-words text-[0.9375rem] leading-relaxed">{m.content}</div> : <Md text={m.content} />)}
                {m.status === 'stopped' && <div className="mt-1 text-xs text-[var(--gb-mute)]">已停止</div>}
              </Bubble>
              {!mine && <Actions mine={false} m={m} ctx={ctx} onCopy={copy} />}
            </div>
          )}
          {docs.map((d) => <DocCard key={d.doc_id + d.version} a={d} mine={ctx.myRmIds.has(d.author_rm_id)} onOpen={() => ctx.onOpenDoc(d.doc_id, d.version)} />)}
          {approval && <ApprovalCard a={approval} onChoose={(c) => ctx.onApprove(m, c)} />}
          {!hasBody && !m.reply_to && (docs.length > 0 || approval) && (
            <div className="mt-0.5 flex"><Actions mine={mine} m={m} ctx={ctx} onCopy={copy} /></div>
          )}
          {!!m.reactions?.length && (
            <div className="mt-1 flex flex-wrap gap-1" data-testid="reactions">
              {m.reactions.map((r) => (
                <button key={r.emoji} type="button" title={r.names.join('、')} aria-pressed={r.mine} onClick={() => ctx.onReact(m, r.emoji)}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${r.mine ? 'bg-[#1d9bf026] text-[#9fd3fb] ring-1 ring-[#1d9bf066]' : 'bg-[var(--gb-elev2)] text-[var(--gb-sub)] hover:bg-[#2c2c2c]'}`}>
                  <span className="text-sm">{r.emoji}</span>{r.count}
                </button>
              ))}
            </div>
          )}
          {!ctx.inThread && !!m.reply_count && (
            <button type="button" onClick={() => ctx.onThread(m)} data-testid="thread-summary"
              className="mt-1 inline-flex items-center gap-1.5 rounded-full px-1 text-xs font-medium text-[var(--gb-accent)] hover:underline">
              <MessageSquareText size={13} />
              {m.reply_count} 則回覆
              {m.thread_last_at && <span className="font-normal text-[var(--gb-mute)]">· 最後 {clock(toDate(m.thread_last_at))}</span>}
            </button>
          )}
        </div>
      </div>
      {handoff && <HandoffPill a={handoff} avatarOf={ctx.botAvatarByAgent} />}
    </div>
  )
}
