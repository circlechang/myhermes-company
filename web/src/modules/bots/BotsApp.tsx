// Bots 訊息介面（全螢幕深色殼）：左側聊天清單、中間對話、右側面板。
// 網址：/bots、/bots/:roomId?p=settings|info|docs|doc:<id>|thread:<msgId>
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { bk, botsApi, useBots, useMessages, useRooms, useSkills, type Msg, type Room } from './api'
import { assignAvatars, BlobAvatar } from './Avatar'
import { CommandPalette } from './CommandPalette'
import { Conversation } from './Conversation'
import { NewBotDialog, NewGroupDialog, TEMPLATES } from './Dialogs'
import { useBusyRooms, useMessengerSocket } from './live'
import { BotSettingsPanel, DocPanel, DocsPanel, GroupPanel, ThreadPanel } from './Panels'
import { Sidebar } from './Sidebar'
import { btn, Confirm } from './ui'
import type { MsgCtx } from './MessageItem'
import './bots.css'

type ConfirmState = { title: string; body: string; confirm: string; run: () => Promise<unknown> } | null

export function BotsApp() {
  const { member } = useAuth()
  const myName = member?.username ?? '我'
  const qc = useQueryClient()
  const nav = useNavigate()
  const { roomId } = useParams()
  const [sp, setSp] = useSearchParams()
  const panel = sp.get('p') ?? ''
  const setPanel = useCallback((p: string) => {
    const next = new URLSearchParams(sp)
    if (p) next.set('p', p)
    else next.delete('p')
    setSp(next, { replace: false })
  }, [sp, setSp])

  const roomsQ = useRooms()
  const botsQ = useBots()
  const rooms = useMemo(() => roomsQ.data ?? [], [roomsQ.data])
  const bots = useMemo(() => assignAvatars(botsQ.data ?? []), [botsQ.data])
  const room = rooms.find((r) => r.id === roomId)
  const msgsQ = useMessages(room?.id)
  const busy = useBusyRooms()

  const [dialog, setDialog] = useState<'' | 'bot' | 'group' | 'palette'>('')
  const [busyAct, setBusyAct] = useState(false)
  const [err, setErr] = useState('')
  const [toast, setToast] = useState('')
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [replyTo, setReplyTo] = useState<Msg | null>(null)
  const [focusDoc, setFocusDoc] = useState<{ doc_id: string; title: string; version?: number } | null>(null)
  const [jump, setJump] = useState('')
  const [creating, setCreating] = useState('')  // 正在建立的建議角色 key（歡迎頁要顯示狀態）

  const flash = useCallback((m: string) => {
    setToast(m)
    window.setTimeout(() => setToast(''), 4000)
  }, [])

  // 已讀：打開房間、或在房間裡收到新訊息
  const markRead = useCallback((rid: string, seq?: number) => {
    qc.setQueryData<Room[]>(bk.rooms, (old) => old?.map((r) => (r.id === rid ? { ...r, unread: 0 } : r)))
    botsApi.read(rid, seq).catch(() => undefined)
  }, [qc])
  useEffect(() => {
    if (room?.id) markRead(room.id)
    setReplyTo(null)
    setFocusDoc(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room?.id])

  const myRmIds = useMemo(() => new Set(rooms.flatMap((r) => r.members.filter((m) => m.member_id === member?.id).map((m) => m.id))), [rooms, member?.id])
  const roomIds = useMemo(() => rooms.map((r) => r.id), [rooms])
  // 桌面通知：Bot 做完或需要你（核准卡）時；看得到那個對話就不吵。每個 Bot 的開關在設定面板（localStorage gb.notify.<botId>）
  const notify = useCallback((m: Msg) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (!document.hidden && m.room_id === room?.id) return
    const r = rooms.find((x) => x.id === m.room_id)
    const agentId = r?.members.find((x) => x.id === m.sender_id)?.agent_id ?? ''
    try {
      if (localStorage.getItem(`gb.notify.${agentId}`) === '0') return
    } catch { /* ignore */ }
    const needsYou = m.attachments.some((a) => a.type === 'approval')
    const n = new Notification(needsYou ? `${m.sender_name} 需要你核准` : `${m.sender_name}${r?.kind === 'group' ? `（${r.name}）` : ''}`, {
      body: needsYou ? '打開對話看要做什麼' : (m.content || m.attachments.map((a) => (a.type === 'doc' ? `📄 ${a.title} v${a.version}` : '')).join(' ')).slice(0, 140),
      tag: m.room_id,
    })
    n.onclick = () => { window.focus(); nav(`/bots/${m.room_id}`) }
  }, [room?.id, rooms, nav])
  useMessengerSocket(roomIds, { activeRoomId: room?.id, myName, myRmIds, onRead: markRead, onBotMessage: notify })

  const dmBot = room?.kind === 'dm' ? bots.find((b) => b.id === room.dm_agent_id) : undefined
  // 群組取第一個「Hermes 認得的」成員的技能（不然第一位是新 Bot 時整個群組都沒技能選單）
  const skillBotId = dmBot?.id
    ?? room?.members.filter((m) => m.kind === 'ai').map((m) => bots.find((b) => b.id === m.agent_id))
      .find((b) => b && b.runtime === 'hermes' && b.served)?.id
    ?? undefined
  // 技能清單要打 Hermes：設定檔還沒被服務（新 Bot、等重啟）就別打，免得一直 502
  const skillBot = bots.find((b) => b.id === skillBotId)
  const skills = useSkills(skillBot?.runtime === 'hermes' && skillBot.served ? skillBotId : undefined).data ?? []
  const botName = useCallback((authorId: string, kind: string) => {
    if (kind === 'human') return authorId === member?.id ? '你' : '成員'
    return bots.find((b) => b.profile === authorId)?.name ?? authorId ?? 'Bot'
  }, [bots, member?.id])

  // 快捷鍵：⌘/Ctrl+K 指令面板；⌘/Ctrl+N 或 ⌥N 建 Bot；Esc 關面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setDialog('palette') }
      else if ((mod && !e.shiftKey && e.key.toLowerCase() === 'n') || (e.altKey && (e.code === 'KeyN'))) { e.preventDefault(); setDialog('bot') }
      else if (e.key === 'Escape' && !dialog && panel) setPanel('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, panel, setPanel])

  // 從搜尋跳到某則訊息：載入後捲過去並閃一下
  useEffect(() => {
    if (!jump || !msgsQ.data) return
    const t = window.setTimeout(() => {
      const el = document.querySelector(`[data-msg-id="${jump}"]`)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        el.classList.add('ring-2', 'ring-[#1d9bf0]', 'rounded-2xl')
        window.setTimeout(() => el.classList.remove('ring-2', 'ring-[#1d9bf0]', 'rounded-2xl'), 1600)
      }
      setJump('')
    }, 120)
    return () => window.clearTimeout(t)
  }, [jump, msgsQ.data])

  const open = useCallback((id: string, p = '') => nav(`/bots/${id}${p ? `?p=${encodeURIComponent(p)}` : ''}`), [nav])
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: bk.rooms })
    qc.invalidateQueries({ queryKey: bk.bots })
  }
  const createBot = async (b: { name: string; title: string; description: string; avatar: string }) => {
    setBusyAct(true)
    setErr('')
    try {
      const r = await botsApi.createBot(b)
      qc.setQueryData<Room[]>(bk.rooms, (old) => [r.room, ...(old ?? []).filter((x) => x.id !== r.room.id)])
      refreshAll()
      setDialog('')
      open(r.room.id)
      if (r.gateway?.hint) flash(r.gateway.hint)
    } catch (e) {
      setErr((e as Error).message)
      flash((e as Error).message)  // 歡迎頁沒有對話框，錯誤只能用 toast
    } finally {
      setBusyAct(false)
      setCreating('')
    }
  }
  const createGroup = async (name: string, ids: string[]) => {
    setBusyAct(true)
    setErr('')
    try {
      const r = await botsApi.createGroup(name, ids)
      qc.setQueryData<Room[]>(bk.rooms, (old) => [r, ...(old ?? [])])
      refreshAll()
      setDialog('')
      open(r.id)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusyAct(false)
    }
  }
  const startDm = async (agentId: string) => {
    try {
      const r = await botsApi.openDm(agentId)
      qc.setQueryData<Room[]>(bk.rooms, (old) => (old?.some((x) => x.id === r.id) ? old : [r, ...(old ?? [])]))
      refreshAll()
      open(r.id)
    } catch (e) {
      flash((e as Error).message)
    }
  }
  const setPref = async (r: Room, body: { pinned?: boolean; hidden?: boolean }) => {
    qc.setQueryData<Room[]>(bk.rooms, (old) => old?.map((x) => (x.id === r.id ? { ...x, ...body } : x)))
    try {
      await botsApi.prefs(r.id, body)
    } catch (e) {
      flash((e as Error).message)
      refreshAll()
    }
    if (body.hidden && r.id === roomId) nav('/bots')
  }
  const askDeleteBot = (agentId: string, name: string) =>
    setConfirm({
      title: `刪除 ${name}？`, confirm: '刪除',
      body: '私訊紀錄會刪掉、它也會離開所有群組。它做過的文件會留著；Hermes 設定檔也會留在電腦上，之後可以再接回來。',
      run: async () => {
        await botsApi.deleteBot(agentId)
        refreshAll()
        nav('/bots')
      },
    })
  const duplicateBot = async (agentId: string) => {
    try {
      const r = await botsApi.duplicateBot(agentId)
      refreshAll()
      flash(r.gateway?.hint ? `已複製成「${r.bot.name}」。${r.gateway.hint}` : `已複製成「${r.bot.name}」`)
      open(r.room.id)
    } catch (e) {
      flash((e as Error).message)
    }
  }

  const threadRoot = panel.startsWith('thread:') ? panel.slice(7) : ''
  const docId = panel.startsWith('doc:') ? panel.slice(4) : ''
  const threadMsg = threadRoot ? msgsQ.data?.find((m) => m.id === threadRoot) : undefined

  const ctxForThread: MsgCtx | null = room
    ? {
        myRmIds, isGroup: room.kind === 'group',
        botAvatarByRm: (rm) => bots.find((b) => b.id === room.members.find((m) => m.id === rm)?.agent_id)?.avatar,
        botAvatarByAgent: (id) => bots.find((b) => b.id === id)?.avatar,
        onReply: (m) => setReplyTo(m),
        onThread: () => undefined,
        onReact: (m, e) => { botsApi.react(room.id, m.id, e).then(() => qc.invalidateQueries({ queryKey: ['bots', 'thread', room.id] })).catch((x) => flash(x.message)) },
        onOpenDoc: (id) => setPanel(`doc:${id}`),
        onApprove: (m, c) => { botsApi.approve(room.id, m.id, c).catch((x) => flash(x.message)) },
      }
    : null

  const panelEl = (() => {
    if (!room || !panel) return null
    const close = () => setPanel('')
    if (docId) {
      return (
        <DocPanel room={room} docId={docId} onClose={close} onBack={() => setPanel('docs')} botName={botName} onError={flash}
          onAsk={(id, title, version) => { setFocusDoc({ doc_id: id, title, version }); if (window.innerWidth < 768) setPanel('') }} />
      )
    }
    if (threadRoot && ctxForThread) {
      return <ThreadPanel room={room} rootId={threadRoot} rootHint={threadMsg} ctx={ctxForThread} skills={skills} onClose={close} onError={flash} botAvatar={(id) => bots.find((b) => b.id === id)?.avatar} />
    }
    if (panel === 'docs') return <DocsPanel room={room} onClose={close} onOpen={(id) => setPanel(`doc:${id}`)} botName={botName} />
    if (room.kind === 'dm' && dmBot) {
      return (
        <BotSettingsPanel bot={dmBot} room={room} onClose={close} onOpenDoc={(id) => setPanel(`doc:${id}`)} botName={botName}
          onDuplicate={() => duplicateBot(dmBot.id)} onHide={() => setPref(room, { hidden: true })} onDelete={() => askDeleteBot(dmBot.id, dmBot.name)} />
      )
    }
    if (room.kind === 'group') {
      return <GroupPanel room={room} bots={bots} onClose={close} onOpenDoc={(id) => setPanel(`doc:${id}`)} onDeleted={() => nav('/bots')} botName={botName} onError={flash} />
    }
    return null
  })()

  const welcome = (
    <section className="hidden min-w-0 flex-1 flex-col items-center justify-center px-6 text-center md:flex" data-testid="welcome">
      {rooms.length ? (
        <>
          <div className="flex gap-[-8px]">
            {bots.slice(0, 3).map((b) => <BlobAvatar key={b.id} avatar={b.avatar} seed={b.name} size={56} className="-mx-1" />)}
          </div>
          <p className="mt-4 text-sm text-[var(--gb-sub)]">從左邊選一個對話，或按「＋」建立 Bot、開群組。</p>
        </>
      ) : (
        <>
          <div className="text-xl font-semibold">認識你的第一個隊友</div>
          <p className="mt-2 max-w-md text-sm text-[var(--gb-sub)]">每個 Bot 有自己的名字、職責和長期規則。建幾個之後拉進同一個群組，它們會自己分工、互相交棒。</p>
          <div className="mt-6 grid max-w-xl grid-cols-2 gap-2 sm:grid-cols-3">
            {TEMPLATES.map((t) => (
              <button key={t.key} type="button" data-testid={`welcome-${t.key}`}
                className={`flex flex-col items-center gap-2 rounded-2xl border p-4 ${creating === t.key ? 'border-[var(--gb-accent)] bg-[#1d9bf014]' : 'border-[var(--gb-line2)] hover:bg-[var(--gb-hover)]'} disabled:opacity-50`}
                onClick={() => { setCreating(t.key); createBot({ name: t.name, title: t.title, description: t.description, avatar: t.avatar }) }} disabled={busyAct}>
                <BlobAvatar avatar={t.avatar} seed={t.name} size={44} busy={creating === t.key} />
                <span className="text-sm font-medium">{t.name}</span>
                <span className="text-xs text-[var(--gb-mute)]">{creating === t.key ? '建立中…' : t.title}</span>
              </button>
            ))}
          </div>
          <button type="button" className={`${btn.soft} mt-4`} onClick={() => setDialog('bot')} disabled={busyAct}>自己設定</button>
          {busyAct && (
            <p className="mt-3 text-xs text-[var(--gb-sub)]" data-testid="creating-note">
              正在幫它複製一份 Hermes 設定檔（設定、金鑰、技能），第一次大約要 30–60 秒，完成後會自動進到它的私訊。
            </p>
          )}
        </>
      )}
    </section>
  )

  return (
    <div className="gb fixed inset-0 flex overflow-hidden" data-theme="dark" data-testid="bots-app">
      <Sidebar
        className={room ? 'hidden md:flex' : 'flex'}
        rooms={rooms}
        bots={bots}
        activeId={room?.id}
        busy={busy}
        myName={myName}
        onOpen={(id) => open(id)}
        onNewBot={() => { setErr(''); setDialog('bot') }}
        onNewGroup={() => { setErr(''); setDialog('group') }}
        onStartDm={startDm}
        onPalette={() => setDialog('palette')}
        onPin={(r, v) => setPref(r, { pinned: v })}
        onHide={(r, v) => setPref(r, { hidden: v })}
        onEditBot={(r) => open(r.id, 'settings')}
        onDeleteBot={(r) => askDeleteBot(r.dm_agent_id, r.name)}
        onDeleteRoom={(r) => setConfirm({ title: `刪除「${r.name}」？`, confirm: '刪除', body: '群組裡的訊息會一起刪掉；Bot 和文件都會留著。', run: async () => { await botsApi.deleteRoom(r.id); refreshAll(); if (r.id === roomId) nav('/bots') } })}
      />
      {room ? (
        <Conversation
          key={room.id}
          room={room}
          messages={msgsQ.data ?? []}
          bots={bots}
          myRmIds={myRmIds}
          skills={skills}
          onBack={() => nav('/bots')}
          panelOpen={!!panel}
          onTogglePanel={() => setPanel(panel ? '' : room.kind === 'dm' ? 'settings' : 'info')}
          onOpenDoc={(id) => setPanel(`doc:${id}`)}
          onOpenThread={(m) => setPanel(`thread:${m.id}`)}
          onOpenDocs={() => setPanel('docs')}
          replyTo={replyTo}
          setReplyTo={setReplyTo}
          focusDoc={focusDoc}
          setFocusDoc={setFocusDoc}
          onError={flash}
        />
      ) : roomId && roomsQ.isSuccess ? (
        <section className="flex flex-1 items-center justify-center text-sm text-[var(--gb-mute)]">這個對話不存在或已刪除。</section>
      ) : (
        welcome
      )}
      {panelEl}

      {dialog === 'bot' && <NewBotDialog onClose={() => setDialog('')} onCreate={createBot} busy={busyAct} error={err} />}
      {dialog === 'group' && <NewGroupDialog bots={bots} onClose={() => setDialog('')} onCreate={createGroup} busy={busyAct} error={err}
        preselect={room?.kind === 'dm' ? [room.dm_agent_id] : []} />}
      {dialog === 'palette' && (
        <CommandPalette rooms={rooms.filter((r) => !r.hidden)} bots={bots} onClose={() => setDialog('')} onStartDm={startDm}
          onOpenRoom={(id) => open(id)}
          onOpenMessage={(rid, mid, root) => { if (root) open(rid, `thread:${root}`); else { open(rid); setJump(mid) } }}
          onOpenDoc={(rid, did) => open(rid, `doc:${did}`)}
          onNewBot={() => setDialog('bot')} onNewGroup={() => setDialog('group')} />
      )}
      {confirm && (
        <Confirm title={confirm.title} body={confirm.body} confirm={confirm.confirm} danger onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.run().catch((e) => flash(e.message)) }} />
      )}
      {toast && (
        <div role="status" className="gb-arrive fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-[var(--gb-elev2)] px-4 py-2 text-sm shadow-xl ring-1 ring-[var(--gb-line2)]" data-testid="toast">
          {toast}
        </div>
      )}
    </div>
  )
}
