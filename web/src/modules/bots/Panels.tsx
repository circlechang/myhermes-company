// 右側面板：Bot 設定、群組資訊、文件（閱讀／編輯／版本）、討論串、群組文件清單、例行。
import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronLeft, Copy, EyeOff, FileText, Github, Pause, Play, Plus, RefreshCw, Trash2, UserPlus, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { DiffView } from '../docs/DiffView'
import { docsApi, useDoc, useDocDiff, useDocVersions } from '../docs/api'
import { bk, botsApi, useGithubLink, useJobs, useRoomDocs, useThread, type Bot, type Msg, type Room, type Skill } from './api'
import { BlobAvatar } from './Avatar'
import { Composer } from './Composer'
import { AvatarPicker } from './Dialogs'
import { applyMessage, useRoomLive } from './live'
import { Md } from './MessageItem'
import { MessageList } from './Conversation'
import type { MsgCtx } from './MessageItem'
import { btn, Confirm, field, Toggle } from './ui'
import { listTime } from './util'

export function PanelShell({ title, onBack, onClose, children, testId }: { title: ReactNode; onBack?: () => void; onClose: () => void; children: ReactNode; testId?: string }) {
  return (
    <aside className="gb-arrive fixed inset-0 z-40 flex flex-col bg-[var(--gb-panel)] md:static md:z-auto md:w-[380px] md:shrink-0 md:border-l md:border-[var(--gb-line)]" data-testid={testId}>
      <div className="flex h-14 shrink-0 items-center gap-1 px-2">
        {onBack ? <button type="button" className={btn.icon} aria-label="上一層" onClick={onBack}><ChevronLeft size={18} /></button> : <span className="w-8" />}
        <div className="min-w-0 flex-1 truncate text-center text-[0.9375rem] font-semibold">{title}</div>
        <button type="button" className={btn.icon} aria-label="關閉面板" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">{children}</div>
    </aside>
  )
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--gb-mute)]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/** 失焦就存的欄位（設定面板不放儲存鈕，改到哪存到哪） */
function AutoField({ label, value, onSave, multiline = false, testId }: { label: string; value: string; onSave: (v: string) => Promise<unknown>; multiline?: boolean; testId?: string }) {
  const [v, setV] = useState(value)
  const [state, setState] = useState<'' | 'saving' | 'saved'>('')
  useEffect(() => setV(value), [value])
  const commit = async () => {
    if (v === value) return
    setState('saving')
    try {
      await onSave(v)
      setState('saved')
      setTimeout(() => setState(''), 1500)
    } catch {
      setState('')
      setV(value)
    }
  }
  const id = `af-${label}`
  return (
    <div className="mt-3">
      <label className="mb-1 flex items-center justify-between text-xs text-[var(--gb-sub)]" htmlFor={id}>
        {label}
        {state && <span className="text-[var(--gb-mute)]">{state === 'saving' ? '儲存中…' : '已儲存'}</span>}
      </label>
      {multiline ? (
        <textarea id={id} data-testid={testId} className={`${field} min-h-[140px] leading-relaxed`} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} />
      ) : (
        <input id={id} data-testid={testId} className={field} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      )}
    </div>
  )
}

function useNotifyPref(key: string): [boolean, (v: boolean) => void] {
  const k = `gb.notify.${key}`
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(k) !== '0'
    } catch {
      return true
    }
  })
  const set = (v: boolean) => {
    setOn(v)
    try {
      localStorage.setItem(k, v ? '1' : '0')
    } catch { /* ignore */ }
    if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined)
  }
  return [on, set]
}

function SetupNote({ bot, what, onRetry }: { bot: Bot; what: string; onRetry?: () => void }) {
  if (bot.setup_state === 'preparing') {
    return (
      <div className="rounded-2xl border border-[#1d9bf044] bg-[#1d9bf00d] px-4 py-3 text-xs leading-relaxed text-[var(--gb-sub)]" data-testid="setup-preparing">
        <span className="gb-shimmer">正在準備它專屬的 Hermes 設定檔</span>（複製設定、金鑰、技能，大約 30–60 秒）。
        現在就可以跟它說話，這段期間先借 default 的通道回話；{what}要等準備好、而且 Hermes 重新啟動後才會出現。
      </div>
    )
  }
  if (bot.setup_state === 'failed') {
    return (
      <div className="rounded-2xl border border-[#ef444455] bg-[#ef44440d] px-4 py-3 text-xs leading-relaxed text-[var(--gb-sub)]" data-testid="setup-failed">
        <div className="text-[var(--gb-red)]">設定檔沒建成功：{bot.setup_error || '原因不明'}</div>
        <div className="mt-1">Bot 和對話都還在，它會借 default 的通道回話。</div>
        {onRetry && <button type="button" className={`${btn.soft} mt-2`} onClick={onRetry} data-testid="retry-setup">再試一次</button>}
      </div>
    )
  }
  return (
    <div className="rounded-2xl border border-[#f59e0b44] bg-[#f59e0b0d] px-4 py-3 text-xs leading-relaxed text-[var(--gb-sub)]" data-testid="pending-restart">
      Hermes 還沒認得這個 Bot 的設定檔，所以{what}現在讀不到。已經幫它登記好了，
      在終端機跑 <code className="rounded bg-black/40 px-1">hermes gateway restart</code> 之後就會出現。
      這段期間聊天照常，它會先借 default 的通道回話。
    </div>
  )
}

function Routines({ bot }: { bot: Bot }) {
  const qc = useQueryClient()
  const jobs = useJobs(bot.runtime === 'hermes' && bot.served ? bot.profile : undefined)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', schedule: 'every weekday at 9am', prompt: '' })
  const [err, setErr] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: bk.jobs(bot.profile) })
  const list = jobs.data?.jobs ?? []
  return (
    <Section title="例行" action={bot.served && list.length > 0 && !adding ? <button type="button" className={btn.icon} aria-label="建立例行" onClick={() => setAdding(true)}><Plus size={16} /></button> : undefined}>
      {!bot.served && <SetupNote bot={bot} what="例行" />}
      {bot.served && jobs.isError && <p className="text-xs text-[var(--gb-mute)]">例行排程服務沒有回應（Hermes 沒開？）</p>}
      {list.map((j) => (
        <div key={j.id} className="mb-1.5 flex items-center gap-2 rounded-xl bg-[var(--gb-elev)] px-3 py-2" data-testid="routine">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{j.name}</div>
            <div className="truncate text-xs text-[var(--gb-mute)]">{j.schedule_display}{j.paused ? '・已暫停' : ''}</div>
          </div>
          <button type="button" className={btn.icon} aria-label={j.paused ? '恢復' : '暫停'} onClick={() => botsApi.pauseJob(bot.profile, j.id, !j.paused).then(refresh).catch((e) => setErr(e.message))}>
            {j.paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button type="button" className={btn.icon} aria-label="刪除例行" onClick={() => botsApi.deleteJob(bot.profile, j.id).then(refresh).catch((e) => setErr(e.message))}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {bot.served && !list.length && !adding && !jobs.isLoading && (
        <div className="rounded-2xl px-4 py-6 text-center" data-testid="routines-empty">
          <p className="text-sm text-[var(--gb-sub)]">例行是這個 Bot 固定時間自己做的事。</p>
          <button type="button" className={`${btn.soft} mt-3`} onClick={() => setAdding(true)} data-testid="create-routine">建立例行</button>
        </div>
      )}
      {adding && (
        <form className="space-y-2 rounded-2xl bg-[var(--gb-elev)] p-3" onSubmit={(e) => {
          e.preventDefault()
          setErr('')
          botsApi.createJob(bot.profile, form).then(() => { setAdding(false); setForm({ name: '', schedule: 'every weekday at 9am', prompt: '' }); refresh() }).catch((x) => setErr(x.message))
        }}>
          <input className={field} placeholder="名稱，例如：每日競品快報" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="例行名稱" required />
          <input className={field} placeholder="時間，例如：every weekday at 9am" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} aria-label="時間" required />
          <textarea className={`${field} min-h-[70px]`} placeholder="要做什麼" value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} aria-label="要做什麼" />
          <div className="flex justify-end gap-2">
            <button type="button" className={btn.ghost} onClick={() => setAdding(false)}>取消</button>
            <button type="submit" className={btn.primary}>建立</button>
          </div>
        </form>
      )}
      {err && <p className="mt-1 text-xs text-[var(--gb-red)]" role="alert">{err}</p>}
    </Section>
  )
}

/** GitHub 帳號：一個 Bot 一個 gh 設定目錄。使用者只要做一件事——把那行指令貼到終端機登入。 */
function GithubAccount({ bot }: { bot: Bot }) {
  const qc = useQueryClient()
  const q = useGithubLink(bot.id)
  const [busy, setBusy] = useState('')
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState('')
  const link = q.data
  const refresh = () => qc.invalidateQueries({ queryKey: ['bots', 'github', bot.id] })
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    setErr('')
    try {
      await fn()
      refresh()
      qc.invalidateQueries({ queryKey: bk.bots })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }).catch(() => undefined)
  }
  return (
    <Section title="GitHub 帳號">
      {!link && <p className="text-xs text-[var(--gb-mute)]">讀取中…</p>}
      {link?.mode === 'shared' && (
        <div className="rounded-2xl bg-[var(--gb-elev)] p-3" data-testid="gh-shared">
          <div className="flex items-center gap-2 text-sm"><Github size={15} /> 跟系統共用{link.shared_account ? `（${link.shared_account}）` : ''}</div>
          <p className="mt-1 text-xs text-[var(--gb-sub)]">要讓這個 Bot 用另一個 GitHub 帳號，按下面這顆，會有一行指令要你貼到終端機登入一次。</p>
          <button type="button" className={`${btn.soft} mt-2`} disabled={!!busy} data-testid="gh-setup"
            onClick={() => run('setup', () => botsApi.githubSetup(bot.id))}>
            {busy === 'setup' ? '建立中…' : '給它專屬帳號'}
          </button>
        </div>
      )}
      {link?.mode === 'own' && (
        <div className="rounded-2xl bg-[var(--gb-elev)] p-3" data-testid="gh-own">
          {link.ready ? (
            <div className="flex items-center gap-2 text-sm text-[var(--gb-green)]" data-testid="gh-ready">
              <Check size={15} /> 已連結 {link.account}
            </div>
          ) : (
            <>
              <div className="text-sm">還差一步：在終端機登入</div>
              <p className="mt-1 text-xs text-[var(--gb-sub)]">貼這行進終端機、照畫面授權（會開瀏覽器），完成後回來按「檢查」。</p>
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-black/50 px-3 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-[var(--gb-text)]" data-testid="gh-cmd">{link.login_cmd}</code>
                <button type="button" className={btn.icon} aria-label="複製指令" onClick={() => copy(link.login_cmd ?? '')}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </div>
            </>
          )}
          <p className="mt-2 text-xs text-[var(--gb-mute)]">
            它之後會固定用 <code className="rounded bg-black/40 px-1">{link.bin}/gh</code> 與 <code className="rounded bg-black/40 px-1">{link.bin}/git</code>，
            不會動到你自己的 GitHub 登入。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={btn.soft} disabled={!!busy} data-testid="gh-check"
              onClick={() => run('check', () => botsApi.githubCheck(bot.id))}>
              <RefreshCw size={13} className="mr-1 inline" />{busy === 'check' ? '檢查中…' : link.ready ? '重新檢查' : '我登入好了，檢查'}
            </button>
            <button type="button" className={btn.ghost} disabled={!!busy} data-testid="gh-unlink"
              onClick={() => run('unlink', () => botsApi.githubUnlink(bot.id))}>改回跟系統共用</button>
          </div>
          {link.message && !link.ready && <p className="mt-2 text-xs text-[var(--gb-sub)]">{link.message}</p>}
        </div>
      )}
      {err && <p className="mt-2 text-xs text-[var(--gb-red)]" role="alert">{err}</p>}
    </Section>
  )
}

function DocsList({ roomId, onOpen, botName }: { roomId: string; onOpen: (id: string) => void; botName: (authorId: string, kind: string) => string }) {
  const docs = useRoomDocs(roomId)
  const list = docs.data ?? []
  if (!list.length) return <p className="text-sm text-[var(--gb-mute)]">還沒有文件。請 Bot「做一份…」，文件就會出現在這裡。</p>
  return (
    <div className="space-y-1.5" data-testid="docs-list">
      {list.map((d) => (
        <button key={d.doc_id} type="button" onClick={() => onOpen(d.doc_id)} className="flex w-full items-center gap-3 rounded-xl bg-[var(--gb-elev)] px-3 py-2.5 text-left hover:bg-[#1c1c1c]">
          <FileText size={18} className="shrink-0 text-[var(--gb-accent)]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{d.title}</span>
            <span className="block truncate text-xs text-[var(--gb-mute)]">v{d.version}・{botName(d.author_id, d.author_kind)}・{listTime(d.updated_at)}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export function BotSettingsPanel({ bot, room, onClose, onOpenDoc, onDuplicate, onHide, onDelete, botName }: {
  bot: Bot
  room: Room
  onClose: () => void
  onOpenDoc: (id: string) => void
  onDuplicate: () => void
  onHide: () => void
  onDelete: () => void
  botName: (authorId: string, kind: string) => string
}) {
  const qc = useQueryClient()
  const [notify, setNotify] = useNotifyPref(bot.id)
  const [pickAvatar, setPickAvatar] = useState(false)
  const save = async (body: Partial<Pick<Bot, 'name' | 'title' | 'description' | 'avatar'>>) => {
    await botsApi.patchBot(bot.id, body)
    qc.invalidateQueries({ queryKey: bk.bots })
    qc.invalidateQueries({ queryKey: bk.rooms })
  }
  return (
    <PanelShell title="設定" onClose={onClose} testId="bot-settings">
      <div className="flex flex-col items-center pt-2">
        <button type="button" aria-label="換頭像" onClick={() => setPickAvatar((v) => !v)} className="rounded-3xl p-1 hover:bg-[var(--gb-hover)]" data-testid="change-avatar">
          <BlobAvatar avatar={bot.avatar} seed={bot.name} size={88} />
        </button>
        {pickAvatar && <div className="mt-3 w-full rounded-2xl bg-[var(--gb-elev)] p-3"><AvatarPicker value={bot.avatar} seed={bot.name} onChange={(a) => save({ avatar: a })} /></div>}
      </div>
      {!bot.served && (
        <div className="mt-4">
          <SetupNote bot={bot} what="技能與例行"
            onRetry={() => botsApi.retrySetup(bot.id).then(() => qc.invalidateQueries({ queryKey: bk.bots })).catch(() => undefined)} />
        </div>
      )}
      <AutoField label="名稱" value={bot.name} onSave={(v) => save({ name: v })} testId="bot-name" />
      <AutoField label="職稱" value={bot.title} onSave={(v) => save({ title: v })} testId="bot-title" />
      <AutoField label="描述（長期規則）" value={bot.description} onSave={(v) => save({ description: v })} multiline testId="bot-desc" />
      <div className="mt-4 flex items-center gap-3 rounded-2xl bg-[var(--gb-elev)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm">通知</div>
          <div className="text-xs text-[var(--gb-sub)]">這個 Bot 做完或需要你時通知我</div>
        </div>
        <Toggle checked={notify} onChange={setNotify} label="通知" />
      </div>
      <GithubAccount bot={bot} />
      <Routines bot={bot} />
      <Section title="文件"><DocsList roomId={room.id} onOpen={onOpenDoc} botName={botName} /></Section>
      <Section title="管理">
        <div className="flex flex-col gap-1">
          <button type="button" className={`${btn.ghost} flex items-center gap-2 text-left`} onClick={onDuplicate} data-testid="dup-bot"><Copy size={15} /> 複製這個 Bot（不含對話與記憶）</button>
          <button type="button" className={`${btn.ghost} flex items-center gap-2 text-left`} onClick={onHide}><EyeOff size={15} /> 從清單隱藏</button>
          <button type="button" className={`${btn.ghost} flex items-center gap-2 text-left text-[var(--gb-red)]`} onClick={onDelete} data-testid="delete-bot"><Trash2 size={15} /> 刪除 Bot</button>
        </div>
        <p className="mt-2 text-xs text-[var(--gb-mute)]">Hermes 設定檔：{bot.profile || (bot.setup_state === 'preparing' ? '準備中…' : '—')}・模型：{bot.model || '預設'}</p>
      </Section>
    </PanelShell>
  )
}

export function GroupPanel({ room, bots, onClose, onOpenDoc, onDeleted, botName, onError }: {
  room: Room
  bots: Bot[]
  onClose: () => void
  onOpenDoc: (id: string) => void
  onDeleted: () => void
  botName: (authorId: string, kind: string) => string
  onError: (m: string) => void
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const inRoom = new Set(room.members.map((m) => m.agent_id).filter(Boolean))
  const addable = bots.filter((b) => !inRoom.has(b.id))
  const ais = room.members.filter((m) => m.kind === 'ai')
  const botOf = (agentId?: string | null) => bots.find((b) => b.id === agentId)
  const refresh = () => {
    qc.invalidateQueries({ queryKey: bk.rooms })
  }
  const act = (p: Promise<unknown>) => p.then(refresh).catch((e) => onError(e.message))
  return (
    <PanelShell title="群組資訊" onClose={onClose} testId="group-panel">
      <AutoField label="群組名稱" value={room.name} onSave={(v) => botsApi.patchRoom(room.id, { name: v }).then(refresh)} testId="group-name" />
      <Section title={`成員（${ais.length} 個 Bot）`} action={addable.length && ais.length < 6 ? (
        <button type="button" className={btn.icon} aria-label="加成員" onClick={() => setAdding((v) => !v)} data-testid="add-member"><UserPlus size={16} /></button>
      ) : undefined}>
        <div className="space-y-1" data-testid="member-list">
          {room.members.map((m) => {
            const b = botOf(m.agent_id)
            return (
              <div key={m.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-[var(--gb-hover)]">
                {m.kind === 'ai' ? <BlobAvatar avatar={b?.avatar} seed={m.display_name} size={32} /> : (
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#333] text-sm">{m.display_name.slice(0, 1).toUpperCase()}</span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{m.display_name}{m.kind === 'human' ? '（你）' : ''}</span>
                  {b?.title && <span className="block truncate text-xs text-[var(--gb-mute)]">{b.title}</span>}
                </span>
                {m.kind === 'ai' && ais.length > 1 && (
                  <button type="button" className={btn.icon} aria-label={`移除 ${m.display_name}`} onClick={() => act(botsApi.removeMember(room.id, m.id))}><X size={15} /></button>
                )}
              </div>
            )
          })}
        </div>
        {adding && (
          <div className="mt-2 space-y-1 rounded-2xl bg-[var(--gb-elev)] p-2" data-testid="addable">
            {addable.map((b) => (
              <button key={b.id} type="button" className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-[#222]"
                onClick={() => { setAdding(false); act(botsApi.addMember(room.id, b.id)) }}>
                <BlobAvatar avatar={b.avatar} seed={b.name} size={28} />
                <span className="truncate text-sm">{b.name}</span>
              </button>
            ))}
          </div>
        )}
      </Section>
      <Section title="文件"><DocsList roomId={room.id} onOpen={onOpenDoc} botName={botName} /></Section>
      <Section title="管理">
        <button type="button" className={`${btn.ghost} flex items-center gap-2 text-[var(--gb-red)]`} onClick={() => setConfirm(true)}><Trash2 size={15} /> 刪除群組</button>
      </Section>
      {confirm && (
        <Confirm title="刪除群組？" danger confirm="刪除" onCancel={() => setConfirm(false)}
          body="群組裡的訊息會一起刪掉；Bot 本身和文件都會留著。"
          onConfirm={() => { setConfirm(false); botsApi.deleteRoom(room.id).then(() => { refresh(); onDeleted() }).catch((e) => onError(e.message)) }} />
      )}
    </PanelShell>
  )
}

export function DocsPanel({ room, onClose, onOpen, botName }: { room: Room; onClose: () => void; onOpen: (id: string) => void; botName: (authorId: string, kind: string) => string }) {
  return (
    <PanelShell title="文件" onClose={onClose} testId="docs-panel">
      <p className="mb-3 mt-1 text-xs text-[var(--gb-mute)]">這個{room.kind === 'dm' ? '對話' : '群組'}裡流過的文件，新的在上面。</p>
      <DocsList roomId={room.id} onOpen={onOpen} botName={botName} />
    </PanelShell>
  )
}

export function DocPanel({ room, docId, onBack, onClose, botName, onAsk, onError }: {
  room: Room
  docId: string
  onBack?: () => void
  onClose: () => void
  botName: (authorId: string, kind: string) => string
  onAsk: (docId: string, title: string, version?: number) => void
  onError: (m: string) => void
}) {
  const qc = useQueryClient()
  const doc = useDoc(docId)
  const versions = useDocVersions(docId)
  const [tab, setTab] = useState<'read' | 'edit' | 'history'>('read')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [cmp, setCmp] = useState<number | null>(null)
  const latest = doc.data?.latest_version ?? 0
  const diff = useDocDiff(docId, cmp ?? undefined, latest || undefined, tab === 'history' && cmp !== null && cmp !== latest)
  useEffect(() => {
    if (tab === 'edit') setDraft(doc.data?.content ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])
  useEffect(() => {
    setTab('read')
    setCmp(null)
  }, [docId])
  const vs = useMemo(() => [...(versions.data ?? [])].sort((a, b) => b.version - a.version), [versions.data])
  const save = async () => {
    setSaving(true)
    try {
      await botsApi.editDoc(room.id, docId, draft)
      qc.invalidateQueries({ queryKey: ['docs'] })
      qc.invalidateQueries({ queryKey: bk.docs(room.id) })
      setTab('read')
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const d = doc.data
  const isHtml = d?.format === 'html'
  const tabBtn = (k: typeof tab, label: string) => (
    <button type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
      className={`rounded-full px-3 py-1 text-sm ${tab === k ? 'bg-[var(--gb-elev2)] text-[var(--gb-text)]' : 'text-[var(--gb-sub)] hover:text-[var(--gb-text)]'}`}>{label}</button>
  )
  return (
    <PanelShell title={d?.title ?? '文件'} onBack={onBack} onClose={onClose} testId="doc-panel">
      <div className="sticky top-0 z-10 -mx-4 mb-3 flex items-center gap-1 bg-[var(--gb-panel)] px-4 pb-2" role="tablist">
        {tabBtn('read', '閱讀')}
        {tabBtn('edit', '編輯')}
        {tabBtn('history', `版本 ${latest ? `(${latest})` : ''}`)}
        <span className="flex-1" />
        {d && <span className="rounded-md bg-[var(--gb-elev2)] px-1.5 py-px text-xs" data-testid="doc-panel-version">v{latest}</span>}
      </div>
      {doc.isLoading && <p className="text-sm text-[var(--gb-mute)]">載入中…</p>}
      {doc.isError && <p className="text-sm text-[var(--gb-red)]">這份文件打不開（可能已刪除）。</p>}
      {d && tab === 'read' && (
        <>
          {d.latest && (
            <p className="mb-3 text-xs text-[var(--gb-mute)]">
              最新 v{d.latest.version}・{botName(d.latest.author_id, d.latest.author_kind)}・{listTime(d.latest.created_at)}{d.latest.summary ? `・${d.latest.summary}` : ''}
            </p>
          )}
          {isHtml ? (
            <iframe title={d.title} sandbox="" srcDoc={d.content ?? ''} className="h-[60vh] w-full rounded-xl bg-white" />
          ) : (
            <div className="gb-doc" data-testid="doc-body"><Md text={d.content ?? ''} /></div>
          )}
        </>
      )}
      {d && tab === 'edit' && (
        <div>
          <textarea aria-label="文件內容" data-testid="doc-editor" value={draft} onChange={(e) => setDraft(e.target.value)}
            className={`${field} min-h-[50vh] font-mono text-[13px] leading-relaxed`} />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className={btn.ghost} onClick={() => setTab('read')}>取消</button>
            <button type="button" className={btn.primary} disabled={saving || draft === (d.content ?? '')} onClick={save} data-testid="doc-save">
              {saving ? '儲存中…' : '存成新版本'}
            </button>
          </div>
        </div>
      )}
      {d && tab === 'history' && (
        <div className="space-y-1.5" data-testid="doc-history">
          {vs.map((v) => (
            <button key={v.version} type="button" onClick={() => setCmp(v.version === latest ? null : v.version)} aria-pressed={cmp === v.version}
              className={`flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left ${cmp === v.version ? 'bg-[var(--gb-sel)]' : 'bg-[var(--gb-elev)] hover:bg-[#1c1c1c]'}`}>
              <span className="mt-0.5 rounded-md bg-[var(--gb-elev2)] px-1.5 py-px text-xs">v{v.version}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{v.summary || '（沒有說明）'}</span>
                <span className="block text-xs text-[var(--gb-mute)]">
                  {botName(v.author_id, v.author_kind)}・{listTime(v.created_at)}・<span className="text-[var(--gb-green)]">+{v.diff_stat.added}</span> <span className="text-[var(--gb-red)]">−{v.diff_stat.removed}</span>
                </span>
              </span>
            </button>
          ))}
          <p className="pt-1 text-xs text-[var(--gb-mute)]">點一個舊版本，看它跟最新版差在哪。</p>
          {cmp !== null && (
            <div className="mt-2" data-testid="doc-compare">
              <div className="mb-1 text-xs text-[var(--gb-sub)]">v{cmp} → v{latest}</div>
              {diff.data ? <DiffView text={diff.data.diff} /> : <p className="text-xs text-[var(--gb-mute)]">比較中…</p>}
              <button type="button" className={`${btn.soft} mt-2`} onClick={() => {
                docsApi.revert(docId, cmp).then(() => { qc.invalidateQueries({ queryKey: ['docs'] }); setCmp(null) }).catch((e) => onError(e.message))
              }}>還原成 v{cmp}</button>
            </div>
          )}
        </div>
      )}
      {d && (
        <div className="mt-5 rounded-2xl border border-[var(--gb-line2)] p-3">
          <div className="text-sm">請 Bot 改這份</div>
          <p className="mt-0.5 text-xs text-[var(--gb-mute)]">在對話裡 @ 一個 Bot 說要怎麼改，它會帶著這份全文，改完出新版本。</p>
          <button type="button" className={`${btn.soft} mt-2`} onClick={() => onAsk(docId, d.title, latest)} data-testid="ask-bot-doc">在對話裡談這份</button>
        </div>
      )}
    </PanelShell>
  )
}

export function ThreadPanel({ room, rootId, rootHint, ctx, skills, onClose, onError, botAvatar }: {
  room: Room
  rootId: string
  rootHint?: Msg
  ctx: MsgCtx
  skills: Skill[]
  onClose: () => void
  onError: (m: string) => void
  botAvatar: (agentId?: string | null) => string | undefined
}) {
  const qc = useQueryClient()
  const thread = useThread(room.id, rootId)
  const live = useRoomLive(room.id)
  const runs = Object.values(live.runs).filter((r) => r.threadRootId === rootId)
  const msgs = thread.data ?? (rootHint ? [rootHint] : [])
  const send = async (text: string) => {
    try {
      applyMessage(qc, await botsApi.send(room.id, { content: text, thread_root_id: rootId }))
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <PanelShell title="討論串" onClose={onClose} testId="thread-panel">
      <div className="-mx-4 flex h-full min-h-0 flex-col">
        <MessageList messages={msgs} ctx={{ ...ctx, inThread: true }} runs={runs} routing={false} threadRootId={rootId} scrollKey={rootId} />
        <div className="px-3 pb-1">
          <Composer placeholder="在討論串回覆…" members={room.members} skills={skills} running={runs.length > 0} onSend={send}
            onStop={() => botsApi.stop(room.id).catch(() => undefined)} botAvatar={botAvatar} autoFocusKey={rootId} testId="thread-composer" />
        </div>
      </div>
    </PanelShell>
  )
}
