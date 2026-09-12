// 左側欄：頂端「＋」、搜尋、單一聊天清單（私訊＋群組，釘選在前、依最後訊息時間排序）、左下後台與帳號。
import { Bot as BotIcon, Eye, EyeOff, LayoutDashboard, MessageCirclePlus, MoreHorizontal, Pin, PinOff, Plus, Search, Trash2, Users } from 'lucide-react'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Bot, Room } from './api'
import { BlobAvatar, RoomAvatar } from './Avatar'
import { listTime, modKey, newBotKey, previewText, toDate } from './util'
import { btn, MenuButton, MenuList, type MenuItem } from './ui'

export function sortRooms(rooms: Room[]): Room[] {
  // 用時間值比，不用字串比：WS 送來的時間是「2026-09-11 11:05」、REST 是「2026-09-11T11:05」，字串比會亂排
  const t = (r: Room) => toDate(r.last_message?.created_at ?? r.updated_at ?? r.created_at).getTime() || 0
  return [...rooms].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || t(b) - t(a))
}

function lastLine(r: Room, myName: string): string {
  const m = r.last_message
  if (!m) return r.kind === 'dm' ? '開始對話吧' : `${r.members.filter((x) => x.kind === 'ai').length} 個 Bot 在這裡`
  const doc = m.attachments?.find((a) => a.type === 'doc')
  const appr = m.attachments?.find((a) => a.type === 'approval')
  let body = m.content ? previewText(m.content) : doc ? `📄 ${doc.title} v${doc.version}` : appr ? '🔒 需要你核准' : ''
  if (m.status === 'failed') body = '回覆失敗'
  const who = m.sender_kind === 'human' ? (m.sender_name === myName ? '你' : m.sender_name) : r.kind === 'group' ? m.sender_name : ''
  return who ? `${who}：${body}` : body
}

export function Sidebar({
  rooms, bots, activeId, busy, myName, onOpen, onNewBot, onNewGroup, onStartDm, onPalette, onPin, onHide, onEditBot, onDeleteBot, onDeleteRoom, className = '',
}: {
  rooms: Room[]
  bots: Bot[]
  activeId?: string
  busy: Set<string>
  myName: string
  onOpen: (id: string) => void
  onNewBot: () => void
  onNewGroup: () => void
  onStartDm: (agentId: string) => void
  onPalette: () => void
  onPin: (r: Room, v: boolean) => void
  onHide: (r: Room, v: boolean) => void
  onEditBot: (r: Room) => void
  onDeleteBot: (r: Room) => void
  onDeleteRoom: (r: Room) => void
  className?: string
}) {
  const [q, setQ] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null)
  const botById = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots])
  const avatarOf = (id?: string | null) => (id ? botById.get(id)?.avatar : undefined)
  const hiddenCount = rooms.filter((r) => r.hidden).length
  const list = useMemo(() => {
    const term = q.trim().toLowerCase()
    return sortRooms(rooms).filter((r) => {
      if (!!r.hidden !== showHidden) return false
      if (!term) return true
      const bot = r.kind === 'dm' ? botById.get(r.dm_agent_id) : undefined
      return [r.name, bot?.title ?? '', r.last_message?.content ?? '', ...r.members.map((m) => m.display_name)].some((s) => s.toLowerCase().includes(term))
    })
  }, [rooms, q, showHidden, botById])
  const noDm = bots.filter((b) => !b.dm_room_id && !rooms.some((r) => r.kind === 'dm' && r.dm_agent_id === b.id))
  const term = q.trim().toLowerCase()
  const idleBots = showHidden ? [] : noDm.filter((b) => !term || `${b.name} ${b.title} ${b.profile}`.toLowerCase().includes(term))
  useEffect(() => {
    if (showHidden && hiddenCount === 0) setShowHidden(false) // 取消隱藏最後一個 → 自動回到對話清單
  }, [showHidden, hiddenCount])

  const itemsFor = (r: Room): MenuItem[] => [
    { label: r.pinned ? '取消釘選' : '釘選到最上面', icon: r.pinned ? <PinOff size={15} /> : <Pin size={15} />, onSelect: () => onPin(r, !r.pinned), testId: 'row-pin' },
    { label: r.hidden ? '取消隱藏' : '從清單隱藏', icon: r.hidden ? <Eye size={15} /> : <EyeOff size={15} />, onSelect: () => onHide(r, !r.hidden), testId: 'row-hide' },
    ...(r.kind === 'dm'
      ? [
          { label: '編輯 Bot 資料', icon: <BotIcon size={15} />, onSelect: () => onEditBot(r) },
          { label: '刪除 Bot', icon: <Trash2 size={15} />, danger: true, onSelect: () => onDeleteBot(r) },
        ]
      : [{ label: '刪除群組', icon: <Trash2 size={15} />, danger: true, onSelect: () => onDeleteRoom(r) }]),
  ]

  return (
    <nav className={`flex min-h-0 w-full flex-col bg-[var(--gb-side)] md:w-[330px] md:shrink-0 md:border-r md:border-[var(--gb-line)] ${className}`} aria-label="對話清單" data-testid="sidebar">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <span className="flex-1 text-[0.9375rem] font-semibold tracking-tight">Bots</span>
        <MenuButton label="新增" trigger={<Plus size={20} />} items={[
          { label: '建立新 Bot', icon: <BotIcon size={15} />, hint: newBotKey, onSelect: onNewBot, testId: 'menu-new-bot' },
          { label: '新群組', icon: <Users size={15} />, onSelect: onNewGroup, testId: 'menu-new-group' },
          ...noDm.slice(0, 6).map((b) => ({ label: `私訊 ${b.name}`, icon: <MessageCirclePlus size={15} />, onSelect: () => onStartDm(b.id) })),
        ]} />
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-xl bg-[var(--gb-elev)] px-3 py-2 text-[var(--gb-mute)] focus-within:ring-1 focus-within:ring-[#333]">
          <Search size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋" aria-label="搜尋對話"
            onKeyDown={(e) => { if (e.key === 'Enter' && q.trim()) onPalette() }}
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--gb-text)] placeholder:text-[var(--gb-mute)] outline-none" data-testid="sidebar-search" />
          <button type="button" onClick={onPalette} className="rounded-md px-1.5 text-[11px] text-[var(--gb-mute)] ring-1 ring-[#2e2e2e] hover:text-[var(--gb-text)]" aria-label="開啟指令面板">{modKey}K</button>
        </div>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2" data-testid="room-list">
        {list.map((r) => {
          const bot = r.kind === 'dm' ? botById.get(r.dm_agent_id) : undefined
          const unread = r.unread ?? 0
          const active = r.id === activeId
          return (
            <li key={r.id} className="relative">
              <div
                role="button"
                tabIndex={0}
                data-testid="room-row"
                data-room-id={r.id}
                data-kind={r.kind}
                aria-current={active ? 'true' : undefined}
                onClick={() => onOpen(r.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen(r.id))}
                onContextMenu={(e: MouseEvent) => { e.preventDefault(); setCtx({ id: r.id, x: e.clientX, y: e.clientY }) }}
                className={`group flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 ${active ? 'bg-[var(--gb-sel)]' : 'hover:bg-[var(--gb-hover)]'}`}
              >
                <RoomAvatar kind={r.kind} name={r.name} avatar={r.avatar} members={r.members} botAvatar={avatarOf} size={40} busy={busy.has(r.id)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate text-[0.9375rem] ${unread ? 'font-semibold text-white' : 'font-medium'}`} data-testid="row-name">{r.name}</span>
                    {bot?.title && <span className="max-w-[90px] shrink-0 truncate rounded-md bg-[var(--gb-elev2)] px-1.5 text-[11px] text-[var(--gb-sub)]">{bot.title}</span>}
                    {r.pinned && <Pin size={12} className="shrink-0 text-[var(--gb-mute)]" aria-label="已釘選" data-testid="row-pinned" />}
                    <span className="ml-auto shrink-0 text-xs text-[var(--gb-mute)] group-hover:invisible" data-testid="row-time">{listTime(r.last_message?.created_at ?? r.updated_at)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-[13px] ${unread ? 'text-[var(--gb-text)]' : 'text-[var(--gb-sub)]'}`} data-testid="row-preview">
                      {busy.has(r.id) ? <span className="gb-shimmer">正在處理…</span> : lastLine(r, myName)}
                    </span>
                    {unread > 0 && (
                      <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--gb-accent)] px-1.5 text-[11px] font-semibold text-white" data-testid="row-unread">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </div>
                </div>
                <div className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <MenuButton label={`${r.name} 選項`} trigger={<MoreHorizontal size={16} />} items={itemsFor(r)} className="rounded-full bg-[var(--gb-sel)]" />
                </div>
              </div>
              {ctx?.id === r.id && (
                <div className="fixed inset-0 z-40" onMouseDown={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null) }}>
                  <div className="absolute" style={{ left: ctx.x, top: ctx.y }} onMouseDown={(e) => e.stopPropagation()}>
                    <MenuList items={itemsFor(r)} align="left" onDone={() => setCtx(null)} style={{ position: 'relative' }} />
                  </div>
                </div>
              )}
            </li>
          )
        })}
        {idleBots.length > 0 && (
          <li className="px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-[var(--gb-mute)]" aria-hidden="true">還沒聊過</li>
        )}
        {idleBots.map((b) => (
          <li key={`bot:${b.id}`}>
            <div role="button" tabIndex={0} data-testid="bot-row" data-agent-id={b.id}
              onClick={() => onStartDm(b.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onStartDm(b.id))}
              className="flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 hover:bg-[var(--gb-hover)]">
              <BlobAvatar avatar={b.avatar} seed={b.name} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[0.9375rem] font-medium">{b.name}</span>
                  {b.title && <span className="max-w-[110px] shrink-0 truncate rounded-md bg-[var(--gb-elev2)] px-1.5 text-[11px] text-[var(--gb-sub)]">{b.title}</span>}
                </div>
                <div className="truncate text-[13px] text-[var(--gb-mute)]">點一下開始私訊</div>
              </div>
            </div>
          </li>
        ))}
        {!list.length && !idleBots.length && (
          <li className="px-4 py-10 text-center text-sm text-[var(--gb-mute)]">
            {q ? '沒有符合的對話' : showHidden ? '沒有隱藏的對話' : '還沒有對話。按右上角「＋」建立第一個 Bot。'}
          </li>
        )}
      </ul>
      <div className="shrink-0 space-y-0.5 border-t border-[var(--gb-line)] px-2 py-2">
        {hiddenCount > 0 && (
          <button type="button" className={`${btn.ghost} flex w-full items-center gap-2.5 text-[var(--gb-sub)]`} onClick={() => setShowHidden((v) => !v)} data-testid="toggle-hidden">
            {showHidden ? <Eye size={16} /> : <EyeOff size={16} />} {showHidden ? '回到對話清單' : `已隱藏（${hiddenCount}）`}
          </button>
        )}
        <Link to="/today" className={`${btn.ghost} flex w-full items-center gap-2.5 text-[var(--gb-sub)]`}>
          <LayoutDashboard size={16} /> 後台（流程、看板、設定）
        </Link>
        <div className="flex items-center gap-2.5 px-3 py-1.5 text-sm text-[var(--gb-sub)]">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#333] text-xs text-[var(--gb-text)]">{myName.slice(0, 1).toUpperCase()}</span>
          <span className="truncate">{myName}</span>
        </div>
      </div>
    </nav>
  )
}
