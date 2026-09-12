// Bot 頭像：圓潤色塊的小怪物（兩道斜斜的眼睛）。avatar 字串格式 `blob:<形狀 0-4>|<#色碼>`；
// 空字串依名字雜湊自動產生。人類成員用字母圓圈。群組疊三個小頭像。
import type { Member } from './api'

export const BLOB_COLORS = ['#8b5cf6', '#f97316', '#22c55e', '#0ea5e9', '#ec4899', '#eab308', '#14b8a6', '#ef4444', '#a3a3a3', '#6366f1']
export const BLOB_SHAPES = 5

// 100x100 viewBox 的外形：圓、雲、小山、方糖、水滴
const SHAPES = [
  'M50 8C74 8 92 26 92 52C92 76 74 92 50 92C26 92 8 76 8 52C8 26 26 8 50 8Z',
  'M30 30C30 16 42 8 54 12C62 4 80 8 82 24C94 28 96 46 88 54C94 70 82 88 64 84C56 94 36 94 30 82C14 82 6 66 14 56C4 46 12 30 30 30Z',
  'M50 10C58 10 62 16 68 28L90 72C96 84 88 92 76 92H24C12 92 4 84 10 72L32 28C38 16 42 10 50 10Z',
  'M22 12H78C88 12 92 18 92 28V72C92 84 86 90 74 90H26C14 90 8 84 8 72V28C8 18 12 12 22 12Z',
  'M50 6C62 24 88 40 88 62C88 80 72 94 50 94C28 94 12 80 12 62C12 40 38 24 50 6Z',
]
// 眼睛位置（每種外形略調）
const EYES: [number, number, number, number][] = [
  [40, 38, 58, 34],
  [42, 44, 60, 40],
  [42, 50, 58, 46],
  [40, 38, 58, 34],
  [40, 50, 58, 46],
]

export function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function parseAvatar(avatar: string | undefined, seed: string): { shape: number; color: string } {
  const m = /^blob:(\d+)\|(#[0-9a-fA-F]{3,8})$/.exec(avatar ?? '')
  if (m) return { shape: Number(m[1]) % BLOB_SHAPES, color: m[2] }
  const h = hashCode(seed || 'bot')
  return { shape: h % BLOB_SHAPES, color: BLOB_COLORS[(h >> 3) % BLOB_COLORS.length] }
}

/** 沒自訂頭像的 Bot 依建立順序配「形狀×顏色」不重複的組合（50 組內不撞）；有自訂的保留，且把它用掉的組合避開 */
export function assignAvatars<T extends { id: string; name: string; avatar: string }>(bots: T[]): T[] {
  const used = new Set(bots.map((b) => b.avatar).filter((a) => /^blob:/.test(a)))
  let i = 0
  const next = () => {
    for (; i < BLOB_SHAPES * BLOB_COLORS.length; i++) {
      const cand = avatarString(i % BLOB_SHAPES, BLOB_COLORS[(i * 3) % BLOB_COLORS.length])
      if (!used.has(cand)) {
        used.add(cand)
        i++
        return cand
      }
    }
    return ''
  }
  return bots.map((b) => (b.avatar ? b : { ...b, avatar: next() }))
}

export function avatarString(shape: number, color: string) {
  return `blob:${shape}|${color}`
}

export function BlobAvatar({ avatar, seed, size = 40, busy = false, className = '' }: { avatar?: string; seed: string; size?: number; busy?: boolean; className?: string }) {
  const { shape, color } = parseAvatar(avatar, seed)
  const [x1, y1, x2, y2] = EYES[shape]
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }} data-testid="blob-avatar">
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <path d={SHAPES[shape]} fill={color} />
        <path d={SHAPES[shape]} fill="url(#gb-shine)" opacity="0.35" />
        <line x1={x1} y1={y1} x2={x1 + 5} y2={y1 + 13} stroke="#111" strokeWidth="9" strokeLinecap="round" />
        <line x1={x2} y1={y2} x2={x2 + 5} y2={y2 + 13} stroke="#111" strokeWidth="9" strokeLinecap="round" />
        <defs>
          <radialGradient id="gb-shine" cx="0.3" cy="0.25" r="0.8">
            <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
      </svg>
      {busy && (
        <span className="gb-busy absolute -bottom-0.5 -right-0.5 flex h-3.5 items-center gap-[2px] rounded-full bg-[var(--gb-side)] px-[3px]" aria-label="工作中">
          <i /><i /><i />
        </span>
      )}
    </span>
  )
}

export function LetterAvatar({ name, size = 40 }: { name: string; size?: number }) {
  const h = hashCode(name)
  const color = BLOB_COLORS[h % BLOB_COLORS.length]
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {(name || '?').slice(0, 1).toUpperCase()}
    </span>
  )
}

/** 房間頭像：私訊＝那個 Bot；群組＝最多三個成員疊在一起 */
export function RoomAvatar({
  kind, name, avatar, members, botAvatar, size = 40, busy = false,
}: { kind: 'group' | 'dm'; name: string; avatar?: string; members: Member[]; botAvatar: (agentId?: string | null) => string | undefined; size?: number; busy?: boolean }) {
  if (kind === 'dm') {
    const ai = members.find((m) => m.kind === 'ai')
    return <BlobAvatar avatar={botAvatar(ai?.agent_id)} seed={ai?.display_name ?? name} size={size} busy={busy} />
  }
  if (avatar) return <BlobAvatar avatar={avatar} seed={name} size={size} busy={busy} />
  const ais = members.filter((m) => m.kind === 'ai').slice(0, 3)
  const s = Math.round(size * 0.62)
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} data-testid="group-avatar">
      {ais.map((m, i) => (
        <span
          key={m.id}
          className="absolute rounded-full ring-2 ring-[var(--gb-side)]"
          style={{ left: i === 0 ? 0 : i === 1 ? size - s : (size - s) / 2, top: i === 0 ? 0 : i === 1 ? size * 0.18 : size - s, width: s, height: s }}
        >
          <BlobAvatar avatar={botAvatar(m.agent_id)} seed={m.display_name} size={s} />
        </span>
      ))}
      {busy && (
        <span className="gb-busy absolute -bottom-0.5 -right-0.5 flex h-3.5 items-center gap-[2px] rounded-full bg-[var(--gb-side)] px-[3px]" aria-label="工作中">
          <i /><i /><i />
        </span>
      )}
    </span>
  )
}

/** 交棒提示用的小疊圖 */
export function StackedAvatars({ items, size = 18 }: { items: { seed: string; avatar?: string }[]; size?: number }) {
  return (
    <span className="inline-flex items-center">
      {items.slice(0, 4).map((it, i) => (
        <span key={i} className="rounded-full ring-2 ring-[var(--gb-bg)]" style={{ marginLeft: i ? -size * 0.35 : 0 }}>
          <BlobAvatar avatar={it.avatar} seed={it.seed} size={size} />
        </span>
      ))}
    </span>
  )
}
