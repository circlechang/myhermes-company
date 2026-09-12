// 建 Bot（建議角色或自訂）、建群組（勾 2–6 個 Bot）、換頭像
import { Check, Shuffle } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Bot } from './api'
import { avatarString, BLOB_COLORS, BLOB_SHAPES, BlobAvatar, parseAvatar } from './Avatar'
import { btn, field, Modal } from './ui'

export interface Template {
  key: string
  name: string
  title: string
  description: string
  avatar: string
}

// 建議角色：名字＋職稱＋長期規則（描述寫的是「每次都要遵守」的事，一次性的任務寫在訊息裡）
export const TEMPLATES: Template[] = [
  { key: 'research', name: '研究員', title: '市場與競品研究', avatar: avatarString(1, '#8b5cf6'),
    description: '只用公開來源。\n每個重點都附來源連結。\n分清楚事實和推論。\n不對外發送任何東西。' },
  { key: 'copy', name: '文案', title: '行銷文案與社群貼文', avatar: avatarString(0, '#f97316'),
    description: '口語、短句，不用艱澀詞。\n每次給 3 個版本讓人挑。\n不誇大功效、不保證效果。' },
  { key: 'plan', name: '企劃', title: '專案企劃與提案', avatar: avatarString(3, '#0ea5e9'),
    description: '先講結論，再講理由。\n列出時程、負責人、風險。\n文件一律做成可以直接轉寄的樣子。' },
  { key: 'review', name: '審稿', title: '校對與審稿', avatar: avatarString(2, '#22c55e'),
    description: '指出錯字、邏輯漏洞、前後數字不一致。\n給修改建議，除非被要求，不要整篇重寫。\n改文件時只動需要動的地方。' },
  { key: 'chief', name: '秘書長', title: '協調其他 Bot、追進度', avatar: avatarString(4, '#eab308'),
    description: '把大任務拆成小任務，@ 對的 Bot 去做。\n追進度，彙整大家的結果給使用者。\n需要使用者決定的事，整理成選擇題。' },
  { key: 'quote', name: '報價助理', title: '報價單與成本估算', avatar: avatarString(0, '#14b8a6'),
    description: '報價一律用表格，寫清楚單位與幣別。\n列出所有假設與不含的項目。\n金額有疑問就先問，不要自己編。' },
]

export function AvatarPicker({ value, seed, onChange }: { value: string; seed: string; onChange: (v: string) => void }) {
  const cur = parseAvatar(value, seed)
  return (
    <div className="space-y-2" data-testid="avatar-picker">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: BLOB_SHAPES }, (_, i) => (
          <button key={i} type="button" aria-label={`形狀 ${i + 1}`} aria-pressed={cur.shape === i}
            className={`rounded-xl p-1 ${cur.shape === i ? 'bg-[var(--gb-elev2)] ring-1 ring-[#555]' : 'hover:bg-[var(--gb-hover)]'}`}
            onClick={() => onChange(avatarString(i, cur.color))}>
            <BlobAvatar avatar={avatarString(i, cur.color)} seed={seed} size={32} />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {BLOB_COLORS.map((c) => (
          <button key={c} type="button" aria-label={`顏色 ${c}`} aria-pressed={cur.color === c}
            className={`h-6 w-6 rounded-full ${cur.color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-[var(--gb-elev)]' : ''}`}
            style={{ background: c }} onClick={() => onChange(avatarString(cur.shape, c))} />
        ))}
      </div>
    </div>
  )
}

function randomAvatar() {
  return avatarString(Math.floor(Math.random() * BLOB_SHAPES), BLOB_COLORS[Math.floor(Math.random() * BLOB_COLORS.length)])
}

export function NewBotDialog({ onClose, onCreate, busy, error }: {
  onClose: () => void
  onCreate: (b: { name: string; title: string; description: string; avatar: string }) => void
  busy: boolean
  error?: string
}) {
  const [step, setStep] = useState<'pick' | 'form'>('pick')
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState(randomAvatar)
  const pick = (t: Template | null) => {
    if (t) {
      setName(t.name)
      setTitle(t.title)
      setDescription(t.description)
      setAvatar(t.avatar)
    }
    setStep('form')
  }
  return (
    <Modal title={step === 'pick' ? '認識你的新隊友' : '建立新 Bot'} onClose={onClose} wide testId="new-bot-dialog">
      {step === 'pick' ? (
        <div className="px-5 pb-5">
          <p className="mb-4 text-sm text-[var(--gb-sub)]">選一個建議角色，或自己設定。之後隨時可以改。</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TEMPLATES.map((t) => (
              <button key={t.key} type="button" data-testid={`tpl-${t.key}`}
                className="flex items-start gap-3 rounded-2xl border border-[var(--gb-line2)] p-3 text-left hover:border-[#3a3a3a] hover:bg-[var(--gb-hover)]"
                onClick={() => pick(t)}>
                <BlobAvatar avatar={t.avatar} seed={t.name} size={40} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{t.name}</span>
                  <span className="block text-xs text-[var(--gb-sub)]">{t.title}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <button type="button" className={btn.soft} onClick={() => pick(null)} data-testid="tpl-custom">自己設定</button>
            <button type="button" className={btn.ghost} disabled={busy} data-testid="quick-create"
              onClick={() => onCreate({ name: '新 Bot', title: '', description: '', avatar: randomAvatar() })}>
              {busy ? '建立中…' : '直接建立，之後再改'}
            </button>
          </div>
          {error && <p className="mt-3 text-sm text-[var(--gb-red)]" role="alert">{error}</p>}
        </div>
      ) : (
        <form className="px-5 pb-5" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onCreate({ name: name.trim(), title, description, avatar }) }}>
          <div className="mb-4 flex items-center gap-4">
            <BlobAvatar avatar={avatar} seed={name || 'bot'} size={64} />
            <div className="flex-1"><AvatarPicker value={avatar} seed={name || 'bot'} onChange={setAvatar} /></div>
            <button type="button" className={btn.icon} aria-label="隨機頭像" onClick={() => setAvatar(randomAvatar())}><Shuffle size={16} /></button>
          </div>
          <label className="mb-1 block text-xs text-[var(--gb-sub)]" htmlFor="nb-name">名字</label>
          <input id="nb-name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：研究員" autoFocus maxLength={80} />
          <label className="mb-1 mt-3 block text-xs text-[var(--gb-sub)]" htmlFor="nb-title">職稱（主要負責什麼）</label>
          <input id="nb-title" className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：競品研究" maxLength={120} />
          <label className="mb-1 mt-3 block text-xs text-[var(--gb-sub)]" htmlFor="nb-desc">描述（每次都要遵守的長期規則）</label>
          <textarea id="nb-desc" className={`${field} min-h-[120px]`} value={description} onChange={(e) => setDescription(e.target.value)}
            placeholder={'例如：\n只用公開來源。\n不對外發送任何東西。'} />
          {error && <p className="mt-3 text-sm text-[var(--gb-red)]" role="alert">{error}</p>}
          {busy && <p className="mt-3 text-xs text-[var(--gb-sub)]" data-testid="creating-note">正在複製一份 Hermes 設定檔（設定、金鑰、技能），大約 30–60 秒。</p>}
          <div className="mt-4 flex justify-between gap-2">
            <button type="button" className={btn.ghost} onClick={() => setStep('pick')}>上一步</button>
            <button type="submit" className={btn.primary} disabled={busy || !name.trim()} data-testid="create-bot">
              {busy ? '建立中…' : '建立 Bot'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

export function NewGroupDialog({ bots, onClose, onCreate, busy, error, preselect = [] }: {
  bots: Bot[]
  onClose: () => void
  onCreate: (name: string, ids: string[]) => void
  busy: boolean
  error?: string
  preselect?: string[]
}) {
  const [sel, setSel] = useState<string[]>(preselect)
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const usable = bots.filter((b) => b.runtime === 'hermes' || b.runtime === '' || b.enabled)
  const auto = useMemo(() => sel.map((id) => bots.find((b) => b.id === id)?.name ?? '').filter(Boolean).join('、'), [sel, bots])
  const shown = touched ? name : auto
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 6 ? s : [...s, id]))
  const ok = sel.length >= 2 && sel.length <= 6
  return (
    <Modal title="新群組" onClose={onClose} testId="new-group-dialog">
      <div className="px-5 pb-2">
        <p className="mb-3 text-sm text-[var(--gb-sub)]">選 2 到 6 個 Bot。它們會一起接手、互相交棒，需要你判斷時才找你。</p>
        <div className="max-h-[42vh] space-y-1 overflow-y-auto pr-1">
          {usable.map((b) => {
            const on = sel.includes(b.id)
            return (
              <button key={b.id} type="button" aria-pressed={on} data-testid={`pick-${b.profile || b.id}`}
                className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left ${on ? 'bg-[var(--gb-sel)]' : 'hover:bg-[var(--gb-hover)]'}`}
                onClick={() => toggle(b.id)}>
                <BlobAvatar avatar={b.avatar} seed={b.name} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{b.name}</span>
                  <span className="block truncate text-xs text-[var(--gb-sub)]">{b.title || b.profile}</span>
                </span>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${on ? 'border-[var(--gb-accent)] bg-[var(--gb-accent)]' : 'border-[#555]'}`}>
                  {on && <Check size={13} className="text-white" />}
                </span>
              </button>
            )
          })}
          {usable.length === 0 && <p className="py-6 text-center text-sm text-[var(--gb-sub)]">還沒有 Bot，先建立幾個吧。</p>}
        </div>
        <label className="mb-1 mt-4 block text-xs text-[var(--gb-sub)]" htmlFor="ng-name">群組名稱</label>
        <input id="ng-name" className={field} value={shown} placeholder="選了 Bot 會自動命名" maxLength={80}
          onChange={(e) => { setTouched(true); setName(e.target.value) }} />
        <p className="mt-2 text-xs text-[var(--gb-mute)]">已選 {sel.length}／6</p>
        {error && <p className="mt-2 text-sm text-[var(--gb-red)]" role="alert">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--gb-line)] px-5 py-3">
        <button type="button" className={btn.ghost} onClick={onClose}>取消</button>
        <button type="button" className={btn.primary} disabled={!ok || busy} data-testid="create-group"
          onClick={() => onCreate((shown || auto).trim() || '新群組', sel)}>
          {busy ? '建立中…' : '建立群組'}
        </button>
      </div>
    </Modal>
  )
}
