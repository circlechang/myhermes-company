// ⌘K 指令面板：切換 Bot／群組（本地即時篩選）＋ 搜訊息與文件（打後端）＋ 常用動作。↑↓ 選、Enter 開、Esc 關。
import { Bot as BotIcon, FileText, MessageSquare, Search, Users } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { botsApi, type Bot, type Room, type SearchResult } from './api'
import { BlobAvatar, RoomAvatar } from './Avatar'
import { clip, newBotKey } from './util'

interface Item {
  key: string
  group: string
  label: string
  sub?: string
  icon: ReactNode
  run: () => void
}

export function CommandPalette({ rooms, bots, initial = '', onClose, onOpenRoom, onOpenMessage, onOpenDoc, onNewBot, onNewGroup, onStartDm }: {
  rooms: Room[]
  bots: Bot[]
  initial?: string
  onClose: () => void
  onOpenRoom: (id: string) => void
  onOpenMessage: (roomId: string, messageId: string, threadRootId: string) => void
  onOpenDoc: (roomId: string, docId: string) => void
  onNewBot: () => void
  onNewGroup: () => void
  onStartDm: (agentId: string) => void
}) {
  const [q, setQ] = useState(initial)
  const [sel, setSel] = useState(0)
  const [res, setRes] = useState<SearchResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const botById = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots])
  const avatarOf = (id?: string | null) => (id ? botById.get(id)?.avatar : undefined)

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => {
    const term = q.trim()
    if (term.length < 1) {
      setRes(null)
      return
    }
    const t = setTimeout(() => botsApi.search(term).then(setRes).catch(() => setRes(null)), 180)
    return () => clearTimeout(t)
  }, [q])

  const items: Item[] = useMemo(() => {
    const term = q.trim().toLowerCase()
    const out: Item[] = []
    const rs = rooms.filter((r) => !term || r.name.toLowerCase().includes(term) || (botById.get(r.dm_agent_id)?.title ?? '').toLowerCase().includes(term))
    for (const r of rs.slice(0, term ? 8 : 6)) {
      out.push({
        key: `room:${r.id}`, group: '對話', label: r.name,
        sub: r.kind === 'dm' ? botById.get(r.dm_agent_id)?.title || '私訊' : `群組・${r.members.filter((m) => m.kind === 'ai').length} 個 Bot`,
        icon: <RoomAvatar kind={r.kind} name={r.name} avatar={r.avatar} members={r.members} botAvatar={avatarOf} size={26} />,
        run: () => onOpenRoom(r.id),
      })
    }
    // 還沒聊過的 Bot 也找得到：Enter 直接開私訊
    const withDm = new Set(rooms.filter((r) => r.kind === 'dm').map((r) => r.dm_agent_id))
    const idle = bots.filter((b) => !withDm.has(b.id) && (!term || `${b.name} ${b.title} ${b.profile}`.toLowerCase().includes(term)))
    for (const b of idle.slice(0, term ? 6 : 3)) {
      out.push({ key: `bot:${b.id}`, group: '對話', label: b.name, sub: `${b.title || b.profile}・開始私訊`,
        icon: <BlobAvatar avatar={b.avatar} seed={b.name} size={26} />, run: () => onStartDm(b.id) })
    }
    if (res) {
      for (const d of res.docs) out.push({ key: `doc:${d.doc_id}`, group: '文件', label: d.title, sub: d.room_name, icon: <FileText size={18} className="text-[var(--gb-accent)]" />, run: () => onOpenDoc(d.room_id, d.doc_id) })
      for (const m of res.messages) out.push({ key: `msg:${m.id}`, group: '訊息', label: clip(m.content, 70), sub: `${m.room_name}・${m.sender_name}`, icon: <MessageSquare size={18} className="text-[var(--gb-sub)]" />, run: () => onOpenMessage(m.room_id, m.id, m.thread_root_id) })
    }
    const acts: Item[] = [
      { key: 'act:bot', group: '動作', label: '建立新 Bot', sub: newBotKey, icon: <BotIcon size={18} className="text-[var(--gb-sub)]" />, run: onNewBot },
      { key: 'act:group', group: '動作', label: '新群組', icon: <Users size={18} className="text-[var(--gb-sub)]" />, run: onNewGroup },
    ]
    out.push(...acts.filter((a) => !term || a.label.toLowerCase().includes(term) || '建立 新增 new'.includes(term)))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, rooms, res, botById])

  useEffect(() => setSel(0), [q, res])
  const run = (it?: Item) => {
    if (!it) return
    onClose()
    it.run()
  }
  let lastGroup = ''
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="指令面板" data-testid="command-palette"
        className="gb-arrive w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--gb-line2)] bg-[var(--gb-elev)] shadow-2xl">
        <div className="flex items-center gap-3 border-b border-[var(--gb-line)] px-4">
          <Search size={18} className="text-[var(--gb-mute)]" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="切換對話、搜尋訊息與文件…" aria-label="搜尋"
            className="h-12 min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-[var(--gb-mute)]"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]) }
              else if (e.key === 'Escape') { e.preventDefault(); onClose() }
            }} />
          <span className="text-[11px] text-[var(--gb-mute)]">Esc</span>
        </div>
        <div className="max-h-[56vh] overflow-y-auto py-1" role="listbox">
          {items.map((it, i) => {
            const head = it.group !== lastGroup
            lastGroup = it.group
            return (
              <div key={it.key}>
                {head && <div className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-[var(--gb-mute)]">{it.group}</div>}
                <button type="button" role="option" aria-selected={i === sel} data-testid="palette-item"
                  onMouseEnter={() => setSel(i)} onClick={() => run(it)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left ${i === sel ? 'bg-[var(--gb-sel)]' : ''}`}>
                  <span className="flex w-7 shrink-0 justify-center">{it.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{it.label}</span>
                    {it.sub && <span className="block truncate text-xs text-[var(--gb-mute)]">{it.sub}</span>}
                  </span>
                </button>
              </div>
            )
          })}
          {!items.length && <div className="px-4 py-8 text-center text-sm text-[var(--gb-mute)]">找不到「{q}」</div>}
        </div>
      </div>
    </div>
  )
}
