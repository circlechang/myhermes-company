import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useSearchParams } from 'react-router-dom'
import { useAgents } from '../../api/hooks'
import { useAuth } from '../../auth/AuthContext'
import { PageHeader } from '../../components/PageHeader'
import { EmptyState } from '../../components/EmptyState'
import { ErrorBox, Loading } from '../../components/QueryState'
import '../../guide/i18n'
import { MicButton, SpeakButton } from '../voice/components'
import { VOICE_INPUT_EVENT } from '../voice/speech'
import { gk, useRoom, useRoomContext, useRoomMessages, useRoomMutations, useRooms, type Policy, type Room, type RoomMember, type RoomMessage } from './api'
import { useGroupchatSocket, type GcEvent } from './socket'

interface LiveDraft {
  memberId: string
  name: string
  runId?: string
  text: string
  tool?: string
  phase: 'typing' | 'streaming'
}

const colorFor = (name: string) => {
  const palette = ['text-indigo-700 dark:text-indigo-400', 'text-emerald-700 dark:text-emerald-400', 'text-amber-700 dark:text-amber-400', 'text-rose-700 dark:text-rose-400', 'text-sky-700 dark:text-sky-400', 'text-violet-700 dark:text-violet-400']
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

export function GroupChatPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const roomId = params.get('room') ?? undefined
  const rooms = useRooms()
  const [showList, setShowList] = useState(true)
  const [showSettings, setShowSettings] = useState(false)

  const select = (id?: string) => {
    setParams(id ? { room: id } : {})
    setShowList(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-2 sm:p-4">
      <PageHeader
        title={t('groupchat.title')}
        subtitle={t('groupchat.subtitle')}
        actions={
          <div className="flex gap-1">
            <button className="btn-ghost sm:hidden" onClick={() => setShowList((v) => !v)} aria-label={t('groupchat.rooms')}>☰</button>
            {roomId && <button className="btn-outline" onClick={() => setShowSettings((v) => !v)}>{t('groupchat.settings')}</button>}
          </div>
        }
      />
      <div className="relative flex min-h-0 flex-1 gap-3">
        <aside className={`${showList || !roomId ? 'flex' : 'hidden'} absolute inset-0 z-10 w-full flex-col bg-white dark:bg-zinc-950 sm:static sm:flex sm:w-64 sm:shrink-0`} data-testid="room-list">
          <RoomList rooms={rooms.data ?? []} loading={rooms.isLoading} error={rooms.error} retry={() => rooms.refetch()} active={roomId} onSelect={select} />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {roomId ? <RoomView key={roomId} roomId={roomId} onDeleted={() => select(undefined)} showSettings={showSettings} onCloseSettings={() => setShowSettings(false)} /> : (
            <div className="flex flex-1 items-center justify-center text-sm text-zinc-600 dark:text-zinc-400">{t('groupchat.pickRoom')}</div>
          )}
        </section>
      </div>
    </div>
  )
}

function RoomList({ rooms, loading, error, retry, active, onSelect }: { rooms: Room[]; loading: boolean; error: unknown; retry: () => void; active?: string; onSelect: (id?: string) => void }) {
  const { t } = useTranslation()
  const agents = useAgents()
  const m = useRoomMutations()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState<Policy>('none')
  const [picked, setPicked] = useState<string[]>([])
  const [code, setCode] = useState('')

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    const r = await m.create.mutateAsync({ name: name.trim(), no_mention_policy: policy, agent_ids: picked })
    setName(''); setPicked([]); setCreating(false)
    onSelect(r.id)
  }
  const join = async (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim()) return
    try {
      const r = await m.join.mutateAsync(code.trim())
      setCode('')
      onSelect(r.id)
    } catch {
      // 錯誤已由 m.join.error 顯示在表單下方；不要讓 rejection 漏成 unhandled
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex gap-1">
        <button className="btn-primary flex-1" onClick={() => setCreating((v) => !v)}>+ {t('groupchat.newRoom')}</button>
      </div>
      {creating && (
        <form onSubmit={create} className="card space-y-2 p-2 text-sm" data-testid="create-room-form">
          <input className="input" placeholder={t('groupchat.roomName')} value={name} onChange={(e) => setName(e.target.value)} aria-label={t('groupchat.roomName')} />
          <label className="block text-xs text-zinc-600 dark:text-zinc-400">{t('groupchat.policy')}
            <select className="input mt-1" value={policy} onChange={(e) => setPolicy(e.target.value as Policy)} aria-label={t('groupchat.policy')}>
              {(['none', 'round_robin', 'host'] as Policy[]).map((p) => <option key={p} value={p}>{t(`groupchat.policies.${p}`)}</option>)}
            </select>
          </label>
          <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('groupchat.pickAgents')}</div>
          <div className="max-h-32 space-y-1 overflow-auto">
            {agents.data?.filter((a) => a.enabled).map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, a.id] : p.filter((x) => x !== a.id)))} />
                {a.name} <span className="text-zinc-600 dark:text-zinc-400">({a.profile})</span>
              </label>
            ))}
          </div>
          <button className="btn-primary w-full" type="submit" disabled={m.create.isPending}>{t('common.create')}</button>
        </form>
      )}
      <form onSubmit={join} className="flex gap-1">
        <input className="input" placeholder={t('groupchat.inviteCode')} value={code} onChange={(e) => setCode(e.target.value)} aria-label={t('groupchat.inviteCode')} />
        <button className="btn-outline" type="submit" disabled={m.join.isPending}>{t('groupchat.join')}</button>
      </form>
      {m.join.error ? <div className="text-xs text-rose-600 dark:text-rose-400">{String((m.join.error as Error).message)}</div> : null}
      {loading && <Loading />}
      {error ? <ErrorBox error={error} onRetry={retry} /> : null}
      <ul className="min-h-0 flex-1 space-y-1 overflow-auto">
        {rooms.map((r) => (
          <li key={r.id}>
            <button
              className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${active === r.id ? 'bg-zinc-200 dark:bg-zinc-800' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'}`}
              onClick={() => onSelect(r.id)}
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium" title={r.name}>{r.name}</span>
                <span className="shrink-0 whitespace-nowrap text-[10px] text-zinc-600 dark:text-zinc-400">{r.members.filter((x) => x.kind === 'ai').length} AI</span>
              </div>
              {r.last_message && <div className="truncate text-xs text-zinc-600 dark:text-zinc-400" title={`${r.last_message.sender_name}: ${r.last_message.content}`}>{r.last_message.sender_name}: {r.last_message.content}</div>}
            </button>
          </li>
        ))}
        {!loading && rooms.length === 0 && !creating && (
          <li><EmptyState compact testId="empty-rooms" title={t('guide.empty.rooms.title')} body={t('guide.empty.rooms.body')} action={{ label: t('guide.empty.rooms.action'), onClick: () => setCreating(true) }} /></li>
        )}
      </ul>
    </div>
  )
}

function RoomView({ roomId, onDeleted, showSettings, onCloseSettings }: { roomId: string; onDeleted: () => void; showSettings: boolean; onCloseSettings: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const room = useRoom(roomId)
  const msgs = useRoomMessages(roomId)
  const [live, setLive] = useState<Record<string, LiveDraft>>({})
  const [humanTyping, setHumanTyping] = useState<Record<string, number>>({})
  const [summaryBusy, setSummaryBusy] = useState(false)
  const [input, setInput] = useState('')
  const [mention, setMention] = useState<{ q: string; idx: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const onEvent = useCallback((ev: GcEvent) => {
    if ('room_id' in ev && ev.room_id && ev.room_id !== roomId) return
    switch (ev.type) {
      case 'message.new':
        qc.setQueryData<RoomMessage[]>(gk.messages(roomId), (old) => (old?.some((m) => m.id === ev.message.id) ? old : [...(old ?? []), ev.message]))
        if (ev.message.sender_kind === 'ai' && ev.message.sender_id) setLive((l) => { const n = { ...l }; delete n[ev.message.sender_id!]; return n })
        qc.invalidateQueries({ queryKey: gk.rooms })
        break
      case 'ai.typing':
        setLive((l) => ({ ...l, [ev.member_id]: { memberId: ev.member_id, name: ev.name, text: '', phase: 'typing' } }))
        break
      case 'ai.started':
        setLive((l) => ({ ...l, [ev.member_id]: { ...(l[ev.member_id] ?? { memberId: ev.member_id, name: '', text: '' }), runId: ev.run_id, phase: 'streaming' } }))
        break
      case 'ai.delta':
        setLive((l) => ({ ...l, [ev.member_id]: { ...(l[ev.member_id] ?? { memberId: ev.member_id, name: '', phase: 'streaming' }), text: (l[ev.member_id]?.text ?? '') + ev.delta, phase: 'streaming' } }))
        break
      case 'ai.tool':
        setLive((l) => (l[ev.member_id] ? { ...l, [ev.member_id]: { ...l[ev.member_id], tool: ev.tool } } : l))
        break
      case 'ai.failed':
        setLive((l) => { const n = { ...l }; delete n[ev.member_id]; return n })
        qc.setQueryData<RoomMessage[]>(gk.messages(roomId), (old) => (old?.some((m) => m.id === ev.message.id) ? old : [...(old ?? []), ev.message]))
        break
      case 'ai.done':
        break
      case 'human.typing':
        setHumanTyping((h) => ({ ...h, [ev.name]: Date.now() }))
        break
      case 'summary.started':
        setSummaryBusy(true)
        break
      case 'summary.updated':
      case 'summary.failed':
        setSummaryBusy(false)
        qc.invalidateQueries({ queryKey: gk.context(roomId) })
        break
      default:
        break
    }
  }, [qc, roomId])
  const ws = useGroupchatSocket(roomId, onEvent)

  // 自動捲到底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.data?.length, live])
  // 人類輸入中指示過期
  useEffect(() => {
    const id = setInterval(() => setHumanTyping((h) => Object.fromEntries(Object.entries(h).filter(([, ts]) => Date.now() - ts < 4000))), 1500)
    return () => clearInterval(id)
  }, [])
  // 語音輸入事件 → 塞進輸入框
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; final: boolean }>).detail
      if (d?.final && document.activeElement !== inputRef.current) setInput((v) => (v ? `${v} ${d.text}` : d.text))
    }
    window.addEventListener(VOICE_INPUT_EVENT, h)
    return () => window.removeEventListener(VOICE_INPUT_EVENT, h)
  }, [])

  const members = room.data?.members ?? []
  const aiMembers = members.filter((m) => m.kind === 'ai')
  const mentionMatches = useMemo(() => (mention ? members.filter((m) => m.display_name.toLowerCase().startsWith(mention.q.toLowerCase())) : []), [mention, members])

  const send = () => {
    const text = input.trim()
    if (!text) return
    if (!ws.sendMessage(text)) return
    setInput('')
    setMention(null)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionMatches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMention({ ...mention, idx: (mention.idx + 1) % mentionMatches.length }); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMention({ ...mention, idx: (mention.idx - 1 + mentionMatches.length) % mentionMatches.length }); return }
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); applyMention(mentionMatches[mention.idx]); return }
      if (e.key === 'Escape') { setMention(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }
  const onChange = (v: string) => {
    setInput(v)
    const m = /(?:^|\s)@([\w一-鿿.-]*)$/.exec(v)
    setMention(m ? { q: m[1], idx: 0 } : null)
    ws.typing()
  }
  const applyMention = (m: RoomMember) => {
    setInput((v) => v.replace(/@([\w一-鿿.-]*)$/, `@${m.display_name} `))
    setMention(null)
    inputRef.current?.focus()
  }

  if (room.isLoading) return <Loading />
  if (room.error) return <ErrorBox error={room.error} onRetry={() => room.refetch()} />
  const r = room.data!

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 pb-2 text-sm dark:border-zinc-800">
        <span className="font-semibold">{r.name}</span>
        <span className="text-xs text-zinc-600 dark:text-zinc-400">{t(`groupchat.policies.${r.no_mention_policy}`)}</span>
        <span className={`text-[10px] ${ws.status === 'open' ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-600 dark:text-zinc-400'}`} data-testid="ws-status">
          {ws.status === 'open' ? t('groupchat.connected') : ws.status === 'connecting' ? t('groupchat.connecting') : t('groupchat.disconnected')}
        </span>
        <div className="ml-auto flex flex-wrap gap-1">
          {members.map((m) => (
            <span key={m.id} className={`rounded-full border px-2 py-0.5 text-[11px] ${m.kind === 'ai' ? 'border-indigo-300' : 'border-zinc-300'} ${colorFor(m.display_name)}`} title={m.kind === 'ai' ? `${m.profile} ${m.model}` : ''}>
              {m.kind === 'ai' ? '🤖 ' : '👤 '}{m.display_name}
            </span>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-auto py-2" data-testid="message-list">
          {msgs.isLoading && <Loading />}
          {msgs.data?.map((m) => <MessageRow key={m.id} m={m} />)}
          {Object.values(live).map((d) => (
            <div key={d.memberId} className="rounded-lg bg-indigo-50 p-2 text-sm dark:bg-indigo-950/30" data-testid="live-draft">
              <div className={`text-xs font-medium ${colorFor(d.name)}`}>
                🤖 {d.name} <span className="text-zinc-600 dark:text-zinc-400">{d.phase === 'typing' ? t('groupchat.thinking') : d.tool ? t('groupchat.usingTool', { tool: d.tool }) : t('groupchat.replying')}</span>
                <span className="ml-1 inline-block animate-pulse">●</span>
              </div>
              {d.text && <div className="whitespace-pre-wrap">{d.text}</div>}
            </div>
          ))}
          {Object.keys(humanTyping).length > 0 && (
            <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('groupchat.humanTyping', { names: Object.keys(humanTyping).join('、') })}</div>
          )}
          {summaryBusy && <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('groupchat.compressing')}</div>}
          {!msgs.isLoading && !msgs.data?.length && <div className="p-4 text-center text-sm text-zinc-600 dark:text-zinc-400">{t('groupchat.empty', { n: aiMembers.length })}</div>}
        </div>
        {showSettings && <RoomSettings room={r} onClose={onCloseSettings} onDeleted={onDeleted} />}
      </div>
      <div className="relative border-t border-zinc-200 pt-2 dark:border-zinc-800">
        {mention && mentionMatches.length > 0 && (
          <ul className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-md border border-zinc-200 bg-white p-1 text-sm shadow dark:border-zinc-700 dark:bg-zinc-900" role="listbox" data-testid="mention-menu">
            {mentionMatches.map((m, i) => (
              <li key={m.id} role="option" aria-selected={i === mention.idx} className={`cursor-pointer rounded px-2 py-1 ${i === mention.idx ? 'bg-zinc-200 dark:bg-zinc-800' : ''}`} onMouseDown={(e) => { e.preventDefault(); applyMention(m) }}>
                {m.kind === 'ai' ? '🤖' : '👤'} {m.display_name}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-1">
          <div className="flex gap-1 sm:hidden">
            {aiMembers.slice(0, 3).map((m) => (
              <button key={m.id} className="btn-ghost px-2 text-xs" onClick={() => setInput((v) => `${v}@${m.display_name} `)} aria-label={`@${m.display_name}`}>@{m.display_name.slice(0, 4)}</button>
            ))}
          </div>
          <textarea
            ref={inputRef}
            className="input min-h-[2.5rem] flex-1 resize-none"
            rows={1}
            value={input}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('groupchat.inputPlaceholder')}
            aria-label={t('groupchat.input')}
          />
          <MicButton onText={(tx, final) => final && setInput((v) => (v ? `${v} ${tx}` : tx))} />
          <button className="btn-primary" onClick={send} disabled={!input.trim() || ws.status !== 'open'}>{t('groupchat.send')}</button>
        </div>
      </div>
    </div>
  )
}

function MessageRow({ m }: { m: RoomMessage }) {
  const { t } = useTranslation()
  const isAi = m.sender_kind === 'ai'
  const time = new Date(m.created_at.endsWith('Z') ? m.created_at : m.created_at + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`group rounded-lg p-2 text-sm ${isAi ? 'bg-zinc-100 dark:bg-zinc-900' : m.sender_kind === 'system' ? 'text-center text-xs text-zinc-600 dark:text-zinc-400' : ''} ${m.status === 'failed' ? 'border border-rose-300' : ''}`} data-testid={`msg-${m.sender_kind}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className={`font-medium ${colorFor(m.sender_name)}`}>{isAi ? '🤖 ' : m.sender_kind === 'human' ? '👤 ' : ''}{m.sender_name}</span>
        <span className="text-zinc-600 dark:text-zinc-400">{time}</span>
        {m.depth > 1 && <span className="rounded bg-zinc-200 px-1 text-[10px] dark:bg-zinc-800" title={t('groupchat.depthHint')}>↳{m.depth}</span>}
        <SpeakButton text={m.content} id={m.id} className="ml-auto opacity-0 group-hover:opacity-100 sm:opacity-60" />
      </div>
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
      </div>
    </div>
  )
}

function RoomSettings({ room, onClose, onDeleted }: { room: Room; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation()
  const { member } = useAuth()
  const agents = useAgents()
  const m = useRoomMutations(room.id)
  const ctx = useRoomContext(room.id)
  const [addAgent, setAddAgent] = useState('')
  const [editing, setEditing] = useState<RoomMember | null>(null)
  const ais = room.members.filter((x) => x.kind === 'ai')
  const canDelete = member && (member.id === room.created_by || member.role !== 'member')

  return (
    <aside className="absolute inset-0 z-10 flex w-full flex-col gap-3 overflow-auto bg-white p-3 text-sm dark:bg-zinc-950 sm:static sm:w-80 sm:shrink-0 sm:border-l sm:border-zinc-200 sm:dark:border-zinc-800" data-testid="room-settings">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{t('groupchat.settings')}</span>
        <button className="btn-ghost" onClick={onClose}>{t('common.close')}</button>
      </div>
      <section className="space-y-1">
        <div className="panel-title px-0">{t('groupchat.inviteCode')}</div>
        <div className="flex items-center gap-2">
          <code className="rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-800" data-testid="invite-code">{room.invite_code}</code>
          <button className="btn-ghost text-xs" onClick={() => navigator.clipboard?.writeText(room.invite_code)}>{t('groupchat.copy')}</button>
          <button className="btn-ghost text-xs" onClick={() => m.regen.mutate()}>{t('groupchat.regenerate')}</button>
        </div>
      </section>
      <section className="space-y-1">
        <div className="panel-title px-0">{t('groupchat.policy')}</div>
        <select className="input" value={room.no_mention_policy} onChange={(e) => m.patch.mutate({ no_mention_policy: e.target.value as Policy })} aria-label={t('groupchat.policy')}>
          {(['none', 'round_robin', 'host'] as Policy[]).map((p) => <option key={p} value={p}>{t(`groupchat.policies.${p}`)}</option>)}
        </select>
        {room.no_mention_policy === 'host' && (
          <select className="input" value={room.host_member_id ?? ''} onChange={(e) => m.patch.mutate({ host_member_id: e.target.value || null })} aria-label={t('groupchat.host')}>
            <option value="">{t('groupchat.pickHost')}</option>
            {ais.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
          </select>
        )}
        <label className="flex items-center justify-between text-xs">{t('groupchat.historyN')}
          <input type="number" className="input w-20" defaultValue={room.history_n} min={2} max={200} onBlur={(e) => Number(e.target.value) !== room.history_n && m.patch.mutate({ history_n: Number(e.target.value) })} />
        </label>
        <label className="flex items-center justify-between text-xs">{t('groupchat.threshold')}
          <input type="number" className="input w-24" defaultValue={room.compress_threshold_tokens} min={50} step={500} onBlur={(e) => Number(e.target.value) !== room.compress_threshold_tokens && m.patch.mutate({ compress_threshold_tokens: Number(e.target.value) })} />
        </label>
        <label className="flex items-center justify-between text-xs">{t('groupchat.maxDepth')}
          <input type="number" className="input w-20" defaultValue={room.max_ai_depth} min={0} max={10} onBlur={(e) => Number(e.target.value) !== room.max_ai_depth && m.patch.mutate({ max_ai_depth: Number(e.target.value) })} />
        </label>
      </section>
      <section className="space-y-1">
        <div className="panel-title px-0">{t('groupchat.context')}</div>
        {ctx.data && (
          <div className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="context-stats">
            {t('groupchat.contextStats', { n: ctx.data.messages_since_summary, tokens: ctx.data.estimated_tokens, threshold: ctx.data.threshold })}
            {ctx.data.summary && <details className="mt-1"><summary>{t('groupchat.summaryBy', { by: ctx.data.summary.made_by })}</summary><div className="whitespace-pre-wrap">{ctx.data.summary.content}</div></details>}
          </div>
        )}
        <button className="btn-outline text-xs" onClick={() => m.compress.mutate()} disabled={m.compress.isPending || ais.length === 0}>{t('groupchat.compressNow')}</button>
        {m.compress.error ? <div className="text-xs text-rose-600 dark:text-rose-400">{(m.compress.error as Error).message}</div> : null}
      </section>
      <section className="space-y-1">
        <div className="panel-title px-0">{t('groupchat.members')}</div>
        <ul className="space-y-1" data-testid="member-list">
          {room.members.map((x) => (
            <li key={x.id} className="flex items-center gap-1 text-xs">
              <span className="flex-1 truncate">{x.kind === 'ai' ? '🤖' : '👤'} {x.display_name} {x.kind === 'ai' && <span className="text-zinc-600 dark:text-zinc-400">{x.profile}{x.model ? ` · ${x.model}` : ''}</span>}</span>
              {x.kind === 'ai' && <button className="btn-ghost px-1" onClick={() => setEditing(x)} aria-label={t('common.edit')}>✎</button>}
              <button className="btn-ghost px-1 text-rose-600 dark:text-rose-400" onClick={() => m.removeMember.mutate(x.id)} aria-label={t('groupchat.remove', { name: x.display_name })}>✕</button>
            </li>
          ))}
        </ul>
        <div className="flex gap-1">
          <select className="input" value={addAgent} onChange={(e) => setAddAgent(e.target.value)} aria-label={t('groupchat.addAgent')}>
            <option value="">{t('groupchat.addAgent')}</option>
            {agents.data?.filter((a) => !room.members.some((x) => x.agent_id === a.id)).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.profile})</option>)}
          </select>
          <button className="btn-outline" disabled={!addAgent} onClick={() => { m.addMember.mutate({ agent_id: addAgent }); setAddAgent('') }}>{t('groupchat.add')}</button>
        </div>
      </section>
      {editing && (
        <MemberEditor member={editing} agents={agents.data ?? []} onSave={(body) => { m.patchMember.mutate({ rm: editing.id, body }); setEditing(null) }} onCancel={() => setEditing(null)} />
      )}
      {canDelete && (
        <button className="btn-danger mt-auto" onClick={() => { if (confirm(t('groupchat.confirmDelete'))) m.remove.mutate(room.id, { onSuccess: onDeleted }) }}>{t('groupchat.deleteRoom')}</button>
      )}
    </aside>
  )
}

function MemberEditor({ member, agents, onSave, onCancel }: { member: RoomMember; agents: { id: string; name: string; profile: string }[]; onSave: (b: { display_name: string; model: string; system_prompt: string; agent_id?: string }) => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const [f, setF] = useState({ display_name: member.display_name, model: member.model, system_prompt: member.system_prompt, agent_id: member.agent_id ?? '' })
  return (
    <form className="card space-y-2 p-2 text-xs" onSubmit={(e) => { e.preventDefault(); onSave({ ...f, agent_id: f.agent_id || undefined }) }} data-testid="member-editor">
      <label className="block">{t('groupchat.displayName')}<input className="input mt-1" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></label>
      <label className="block">{t('groupchat.profile')}
        <select className="input mt-1" value={f.agent_id} onChange={(e) => setF({ ...f, agent_id: e.target.value })}>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.profile})</option>)}
        </select>
      </label>
      <label className="block">{t('groupchat.model')}<input className="input mt-1" value={f.model} placeholder={t('groupchat.modelDefault')} onChange={(e) => setF({ ...f, model: e.target.value })} /></label>
      <label className="block">{t('groupchat.rolePrompt')}<textarea className="input mt-1" rows={4} value={f.system_prompt} onChange={(e) => setF({ ...f, system_prompt: e.target.value })} /></label>
      <div className="flex justify-end gap-1">
        <button type="button" className="btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="btn-primary">{t('common.save')}</button>
      </div>
    </form>
  )
}
