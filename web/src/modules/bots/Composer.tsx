// 輸入框：底部膠囊形，左「＋」、右圓形送出（有 Bot 在跑且沒打字＝停止）。
// 打 @ 跳成員選單（含 @everyone）、開頭打 / 跳技能選單；鍵盤 ↑↓ 選、Enter/Tab 插入、Esc 關閉。
import { ArrowUp, AtSign, FileText, Plus, Slash, Square, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Member, Skill } from './api'
import { BlobAvatar } from './Avatar'
import { clip } from './util'
import { MenuList } from './ui'

export interface ComposerRef {
  focus: () => void
}

interface Opt {
  key: string
  label: string
  sub?: string
  insert: string
  avatar?: { avatar?: string; seed: string }
}

export function Composer({
  placeholder, members, skills, running, onSend, onStop, replyTo, onClearReply, focusDoc, onClearDoc, botAvatar, botTitle, docs, onPickDoc, autoFocusKey, testId = 'composer',
}: {
  placeholder: string
  members: Member[]
  skills: Skill[]
  running: boolean
  onSend: (text: string) => void
  onStop: () => void
  replyTo?: { name: string; text: string } | null
  onClearReply?: () => void
  focusDoc?: { title: string; version?: number } | null
  onClearDoc?: () => void
  botAvatar: (agentId?: string | null) => string | undefined
  botTitle?: (agentId?: string | null) => string | undefined
  docs?: { doc_id: string; title: string; version: number }[]
  onPickDoc?: (docId: string) => void
  autoFocusKey?: string
  testId?: string
}) {
  const [text, setText] = useState('')
  const [sel, setSel] = useState(0)
  const [caret, setCaret] = useState(0)
  const [plus, setPlus] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ta.current?.focus()
  }, [autoFocusKey])
  useEffect(() => {
    if (replyTo || focusDoc) ta.current?.focus()
  }, [replyTo, focusDoc])
  // 高度跟著內容長（最多約 8 行）
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [text])

  const trigger = useMemo(() => {
    const before = text.slice(0, caret)
    const at = /(^|\s)@([\w一-鿿぀-ヿ.-]*)$/.exec(before)
    if (at) return { kind: 'at' as const, q: at[2], start: caret - at[2].length - 1 }
    const sl = /^\/([\w.-]*)$/.exec(before)
    if (sl) return { kind: 'slash' as const, q: sl[1], start: 0 }
    return null
  }, [text, caret])

  const opts: Opt[] = useMemo(() => {
    if (!trigger) return []
    const q = trigger.q.toLowerCase()
    if (trigger.kind === 'at') {
      const ais = members.filter((m) => m.kind === 'ai')
      const list: Opt[] = ais.map((m) => ({ key: m.id, label: m.display_name, sub: botTitle?.(m.agent_id) || (m.profile !== m.display_name ? m.profile : undefined), insert: `@${m.display_name} `, avatar: { avatar: botAvatar(m.agent_id), seed: m.display_name } }))
      if (ais.length > 1) list.push({ key: 'everyone', label: 'everyone', sub: '群組裡所有 Bot（少用）', insert: '@everyone ' })
      return list.filter((o) => !q || o.label.toLowerCase().includes(q) || (o.sub ?? '').toLowerCase().includes(q)).slice(0, 8)
    }
    return skills
      .filter((s) => s.enabled && (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)))
      .slice(0, 8)
      .map((s) => ({ key: s.name, label: `/${s.name}`, sub: clip(s.description, 60), insert: `/${s.name} ` }))
  }, [trigger, members, skills, botAvatar, botTitle])

  const menuKey = trigger ? `${trigger.kind}:${trigger.start}` : null
  const menuOpen = !!trigger && opts.length > 0 && dismissed !== menuKey
  useEffect(() => setSel(0), [menuKey, opts.length])

  const insert = (o: Opt) => {
    if (!trigger) return
    const next = text.slice(0, trigger.start) + o.insert + text.slice(caret)
    const pos = trigger.start + o.insert.length
    setText(next)
    requestAnimationFrame(() => {
      ta.current?.focus()
      ta.current?.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }
  const send = () => {
    const v = text.trim()
    if (!v) return
    onSend(v)
    setText('')
    setCaret(0)
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return // 注音／倉頡選字中不送出
    if (menuOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % opts.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + opts.length) % opts.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(opts[sel]); return }
      if (e.key === 'Escape') { e.preventDefault(); setDismissed(menuKey); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }
  const hasText = !!text.trim()
  const showStop = running && !hasText

  return (
    <div className="relative" data-testid={testId}>
      {(replyTo || focusDoc) && (
        <div className="mb-1.5 flex flex-wrap gap-1.5 px-2">
          {replyTo && (
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--gb-elev2)] py-1 pl-3 pr-1 text-xs text-[var(--gb-sub)]" data-testid="reply-chip">
              回覆 <b className="font-medium text-[var(--gb-text)]">{replyTo.name}</b>：<span className="truncate">{clip(replyTo.text, 40)}</span>
              <button type="button" aria-label="取消回覆" className="rounded-full p-0.5 hover:bg-[#333]" onClick={onClearReply}><X size={13} /></button>
            </span>
          )}
          {focusDoc && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#1d9bf01f] py-1 pl-3 pr-1 text-xs text-[#9fd3fb]" data-testid="doc-chip">
              <FileText size={13} /> 在談〈{focusDoc.title}〉{focusDoc.version ? ` v${focusDoc.version}` : ''}
              <button type="button" aria-label="不談這份文件" className="rounded-full p-0.5 hover:bg-[#1d9bf033]" onClick={onClearDoc}><X size={13} /></button>
            </span>
          )}
        </div>
      )}
      {menuOpen && (
        <div role="listbox" data-testid={trigger?.kind === 'at' ? 'mention-menu' : 'skill-menu'}
          className="gb-arrive absolute bottom-full left-2 z-30 mb-2 w-[min(360px,90%)] overflow-hidden rounded-2xl border border-[var(--gb-line2)] bg-[var(--gb-elev2)] py-1 shadow-2xl">
          <div className="px-3 pb-1 pt-1.5 text-[11px] uppercase tracking-wide text-[var(--gb-mute)]">{trigger?.kind === 'at' ? '點名' : '技能'}</div>
          {opts.map((o, i) => (
            <button key={o.key} type="button" role="option" aria-selected={i === sel}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${i === sel ? 'bg-[#333]' : 'hover:bg-[#2c2c2c]'}`}
              onMouseEnter={() => setSel(i)} onMouseDown={(e) => { e.preventDefault(); insert(o) }}>
              {o.avatar ? <BlobAvatar avatar={o.avatar.avatar} seed={o.avatar.seed} size={24} /> : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#333] text-[var(--gb-sub)]">{trigger?.kind === 'at' ? <AtSign size={13} /> : <Slash size={13} />}</span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--gb-text)]">{o.label}</span>
                {o.sub && <span className="block truncate text-xs text-[var(--gb-mute)]">{o.sub}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1 rounded-[28px] border border-[var(--gb-line2)] bg-[var(--gb-elev)] p-1.5 focus-within:border-[#3a3a3a]">
        <div className="relative">
          <button type="button" aria-label="更多功能" aria-expanded={plus} onClick={() => setPlus((v) => !v)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--gb-sub)] hover:bg-[var(--gb-hover)] hover:text-[var(--gb-text)]">
            <Plus size={20} />
          </button>
          {plus && (
            <div className="absolute bottom-full left-0 mb-2">
              <MenuList align="left" onDone={() => setPlus(false)} style={{ bottom: 0, top: 'auto' }}
                items={[
                  { label: '點名 Bot', icon: <AtSign size={15} />, hint: '@', onSelect: () => { setText((t) => (t && !t.endsWith(' ') ? t + ' @' : t + '@')); requestAnimationFrame(() => { ta.current?.focus(); const n = ta.current?.value.length ?? 0; ta.current?.setSelectionRange(n, n); setCaret(n) }) } },
                  { label: '使用技能', icon: <Slash size={15} />, hint: '/', onSelect: () => { setText('/'); requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(1, 1); setCaret(1) }) } },
                  ...(docs ?? []).slice(0, 5).map((d) => ({ label: `談〈${clip(d.title, 18)}〉`, icon: <FileText size={15} />, hint: `v${d.version}`, onSelect: () => onPickDoc?.(d.doc_id) })),
                ]} />
            </div>
          )}
        </div>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          aria-label="訊息"
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setDismissed(null) }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={onKey}
          className="max-h-[220px] min-h-[36px] flex-1 resize-none bg-transparent px-1 py-[7px] text-[0.9375rem] leading-[22px] text-[var(--gb-text)] placeholder:text-[var(--gb-mute)] outline-none"
        />
        {showStop ? (
          <button type="button" aria-label="停止" onClick={onStop} data-testid="stop-btn"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--gb-text)] text-black hover:bg-white">
            <Square size={13} fill="currentColor" />
          </button>
        ) : (
          <button type="button" aria-label="送出" onClick={send} disabled={!hasText} data-testid="send-btn"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--gb-text)] text-black hover:bg-white disabled:bg-[#3a3a3a] disabled:text-[#777]">
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  )
}
