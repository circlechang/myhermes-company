// 對話主畫面：標頭（頭像＋名稱）、訊息列（置中時間分隔、連續合併、串流泡泡）、輸入框。
// 討論串面板也用 MessageList＋Composer，只是資料換成那一串。
import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, FileText, Info, PanelRight, Settings2 } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { bk, botsApi, useRoomDocs, type Bot, type Msg, type Room, type Skill } from './api'
import { BlobAvatar, RoomAvatar } from './Avatar'
import { Composer } from './Composer'
import { applyMessage, useRoomLive, type LiveRun } from './live'
import { MessageItem, Md, ToolsLine, type MsgCtx } from './MessageItem'
import { dayLabel, needsDivider, toDate } from './util'
import { btn } from './ui'

export function LiveBubbles({ runs, routing, isGroup, avatarOfRm, threadRootId = '' }: {
  runs: LiveRun[]
  routing: boolean
  isGroup: boolean
  avatarOfRm: (rm?: string | null) => string | undefined
  threadRootId?: string
}) {
  const mine = runs.filter((r) => (r.threadRootId ?? '') === threadRootId)
  return (
    <>
      {routing && !threadRootId && (
        <div className="mt-3 flex justify-center text-xs text-[var(--gb-mute)]" data-testid="routing">
          <span className="gb-shimmer">正在找最適合接手的 Bot…</span>
        </div>
      )}
      {mine.map((r) => (
        <div key={r.key} className="gb-arrive mt-3" data-testid="live-bubble" data-sender={r.name}>
          {isGroup && <div className="mb-0.5 ml-[42px] text-xs text-[var(--gb-sub)]">{r.name}</div>}
          <div className="flex items-start gap-2">
            {isGroup && <BlobAvatar avatar={avatarOfRm(r.memberId)} seed={r.name} size={30} busy />}
            <div className="flex min-w-0 max-w-[min(740px,82%)] flex-col items-start">
              <ToolsLine items={r.tools} live />
              <div className="rounded-[20px] bg-[var(--gb-bot)] px-4 py-2.5">
                {r.text ? <Md text={r.text.replace(/```doc[\s\S]*$/m, '\n\n*（正在寫文件…）*')} /> : <span className="gb-typing" aria-label={`${r.name} 正在輸入`}><i /><i /><i /></span>}
              </div>
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

export function MessageList({ messages, ctx, runs, routing, threadRootId, emptyHint, scrollKey }: {
  messages: Msg[]
  ctx: MsgCtx
  runs: LiveRun[]
  routing: boolean
  threadRootId?: string
  emptyHint?: ReactNode
  scrollKey: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const liveLen = runs.reduce((n, r) => n + r.text.length + r.tools.length, 0)
  const onScroll = () => {
    const el = ref.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  useLayoutEffect(() => {
    stick.current = true
  }, [scrollKey])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages.length, liveLen, routing, scrollKey])

  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4 sm:px-6" data-testid="message-list">
      <div className="mx-auto w-full max-w-[860px]">
        {messages.length === 0 && !runs.length && emptyHint}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const divider = needsDivider(prev?.created_at, m.created_at)
          const showHeader =
            divider || !prev || prev.sender_id !== m.sender_id || prev.attachments.some((a) => a.type === 'handoff') ||
            toDate(m.created_at).getTime() - toDate(prev.created_at).getTime() > 3 * 60 * 1000
          return (
            <div key={m.id}>
              {divider && <div className="mb-2 mt-5 text-center text-xs text-[var(--gb-mute)]" data-testid="day-divider">{dayLabel(m.created_at)}</div>}
              <MessageItem m={m} ctx={ctx} showHeader={showHeader} />
            </div>
          )
        })}
        <LiveBubbles runs={runs} routing={routing} isGroup={ctx.isGroup} avatarOfRm={ctx.botAvatarByRm} threadRootId={threadRootId} />
      </div>
    </div>
  )
}

export function Conversation({
  room, messages, bots, myRmIds, skills, onBack, panelOpen, onTogglePanel, onOpenDoc, onOpenThread, onOpenDocs, replyTo, setReplyTo, focusDoc, setFocusDoc, onError,
}: {
  room: Room
  messages: Msg[]
  bots: Bot[]
  myRmIds: Set<string>
  skills: Skill[]
  onBack: () => void
  panelOpen: boolean
  onTogglePanel: () => void
  onOpenDoc: (docId: string, version?: number) => void
  onOpenThread: (m: Msg) => void
  onOpenDocs: () => void
  replyTo: Msg | null
  setReplyTo: (m: Msg | null) => void
  focusDoc: { doc_id: string; title: string; version?: number } | null
  setFocusDoc: (d: { doc_id: string; title: string; version?: number } | null) => void
  onError: (msg: string) => void
}) {
  const qc = useQueryClient()
  const live = useRoomLive(room.id)
  const runs = Object.values(live.runs)
  const isGroup = room.kind === 'group'
  const botById = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots])
  const avatarByAgent = useCallback((id?: string | null) => (id ? botById.get(id)?.avatar : undefined), [botById])
  const avatarByRm = useCallback(
    (rm?: string | null) => avatarByAgent(room.members.find((m) => m.id === rm)?.agent_id),
    [room.members, avatarByAgent],
  )
  const dmBot = room.kind === 'dm' ? botById.get(room.dm_agent_id) : undefined
  const roomDocs = useRoomDocs(room.id).data ?? []
  const docsCount = roomDocs.length

  const react = useCallback(async (m: Msg, emoji: string) => {
    try {
      const r = await botsApi.react(room.id, m.id, emoji)
      const f = (old?: Msg[]) => old?.map((x) => (x.id === m.id ? { ...x, reactions: r.reactions } : x))
      qc.setQueryData<Msg[]>(bk.messages(room.id), f)
      qc.setQueriesData<Msg[]>({ queryKey: ['bots', 'thread', room.id] }, f)
    } catch (e) {
      onError((e as Error).message)
    }
  }, [room.id, qc, onError])
  const approve = useCallback(async (m: Msg, choice: 'once' | 'always' | 'deny') => {
    try {
      applyMessage(qc, await botsApi.approve(room.id, m.id, choice))
    } catch (e) {
      onError((e as Error).message)
    }
  }, [room.id, qc, onError])

  const ctx: MsgCtx = useMemo(() => ({
    myRmIds, isGroup, botAvatarByRm: avatarByRm, botAvatarByAgent: avatarByAgent,
    onReply: (m) => setReplyTo(m), onThread: onOpenThread, onReact: react, onOpenDoc, onApprove: approve,
  }), [myRmIds, isGroup, avatarByRm, avatarByAgent, setReplyTo, onOpenThread, react, onOpenDoc, approve])

  const send = async (text: string) => {
    try {
      const m = await botsApi.send(room.id, { content: text, reply_to_id: replyTo?.id, doc_id: focusDoc?.doc_id })
      applyMessage(qc, m)
      setReplyTo(null)
    } catch (e) {
      onError((e as Error).message)
    }
  }
  const stop = async () => {
    try {
      await botsApi.stop(room.id)
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const ais = room.members.filter((m) => m.kind === 'ai')
  const subtitle = isGroup ? `${ais.length} 個 Bot` : dmBot?.title || ''
  const emptyHint = (
    <div className="flex flex-col items-center py-16 text-center" data-testid="empty-room">
      <RoomAvatar kind={room.kind} name={room.name} avatar={room.avatar} members={room.members} botAvatar={avatarByAgent} size={72} />
      <div className="mt-4 text-lg font-semibold">{room.name}</div>
      <p className="mt-1 max-w-sm text-sm text-[var(--gb-sub)]">
        {isGroup
          ? `群組裡有 ${ais.map((a) => a.display_name).join('、')}。直接說要做什麼，它們會自己決定誰接；要指定就 @ 它。`
          : dmBot?.description
            ? `從一個具體任務開始。${dmBot.name} 會記得描述裡的長期規則。`
            : '從一個具體任務開始：要什麼成果、用哪些資料、什麼時候要。'}
      </p>
    </div>
  )

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-[var(--gb-bg)]" data-testid="conversation">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--gb-line)] px-3">
        <button type="button" className={`${btn.icon} md:hidden`} aria-label="回清單" onClick={onBack}><ChevronLeft size={20} /></button>
        <RoomAvatar kind={room.kind} name={room.name} avatar={room.avatar} members={room.members} botAvatar={avatarByAgent} size={26} busy={runs.length > 0} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.9375rem] font-semibold" data-testid="room-title">{room.name}</div>
          {subtitle && <div className="truncate text-xs text-[var(--gb-mute)]">{subtitle}</div>}
        </div>
        {docsCount > 0 && (
          <button type="button" className={`${btn.ghost} inline-flex items-center gap-1.5 text-[var(--gb-sub)]`} onClick={onOpenDocs} data-testid="open-docs">
            <FileText size={15} /> {docsCount}
          </button>
        )}
        <button type="button" className={btn.icon} aria-label={isGroup ? '群組資訊' : 'Bot 設定'} aria-pressed={panelOpen} onClick={onTogglePanel} data-testid="toggle-panel">
          {panelOpen ? <PanelRight size={18} /> : isGroup ? <Info size={18} /> : <Settings2 size={18} />}
        </button>
      </header>
      <MessageList messages={messages} ctx={ctx} runs={runs} routing={live.routing} emptyHint={emptyHint} scrollKey={room.id} />
      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-6">
        <div className="mx-auto w-full max-w-[860px]">
          <Composer
            placeholder={`傳訊息給 ${room.name}`}
            members={room.members}
            skills={skills}
            running={runs.length > 0 || live.routing}
            onSend={send}
            onStop={stop}
            replyTo={replyTo ? { name: replyTo.sender_name, text: replyTo.content || '（文件）' } : null}
            onClearReply={() => setReplyTo(null)}
            focusDoc={focusDoc ? { ...focusDoc, version: roomDocs.find((d) => d.doc_id === focusDoc.doc_id)?.version ?? focusDoc.version } : null}
            onClearDoc={() => setFocusDoc(null)}
            botAvatar={avatarByAgent}
            botTitle={(id) => (id ? botById.get(id)?.title : undefined)}
            docs={roomDocs}
            onPickDoc={(id) => {
              const d = roomDocs.find((x) => x.doc_id === id)
              if (d) setFocusDoc({ doc_id: d.doc_id, title: d.title, version: d.version })
            }}
            autoFocusKey={room.id}
          />
        </div>
      </div>
    </section>
  )
}
