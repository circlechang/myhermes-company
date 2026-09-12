// 時間顯示（照通訊軟體習慣）與小工具
const pad = (n: number) => String(n).padStart(2, '0')

export function toDate(s?: string | null): Date {
  if (!s) return new Date(NaN)
  // 後端存的是 UTC 但不帶時區（models.now()）→ 補 Z 再轉本地時間
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z')
}

export function clock(d: Date): string {
  const h = d.getHours()
  const ap = h < 12 ? '上午' : '下午'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${ap} ${h12}:${pad(d.getMinutes())}`
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 側欄列右側的時間：今天→時刻；昨天→「昨天」；一週內→星期；更早→月/日 */
export function listTime(s?: string | null, now = new Date()): string {
  const d = toDate(s)
  if (Number.isNaN(d.getTime())) return ''
  if (sameDay(d, now)) return clock(d)
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (sameDay(d, y)) return '昨天'
  const diff = (now.getTime() - d.getTime()) / 86400000
  if (diff < 7) return ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][d.getDay()]
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 對話中置中的時間分隔：「今天 下午 1:47」「昨天 上午 9:02」「9月3日 下午 2:10」 */
export function dayLabel(s?: string | null, now = new Date()): string {
  const d = toDate(s)
  if (Number.isNaN(d.getTime())) return ''
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  const day = sameDay(d, now) ? '今天' : sameDay(d, y) ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`
  return `${day} ${clock(d)}`
}

/** 兩則訊息之間要不要插時間分隔（間隔超過 15 分鐘或跨日） */
export function needsDivider(prev: string | undefined, cur: string): boolean {
  if (!prev) return true
  const a = toDate(prev)
  const b = toDate(cur)
  return !sameDay(a, b) || b.getTime() - a.getTime() > 15 * 60 * 1000
}

export function clip(s: string, n = 80): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 側欄預覽：去掉 Markdown 記號 */
export function previewText(s: string): string {
  return clip(
    (s ?? '')
      .replace(/```[\s\S]*?```/g, '［程式碼］')
      .replace(/[#*_>`~]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'),
    60,
  )
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const modKey = isMac ? '⌘' : 'Ctrl'
/** 建 Bot 快捷鍵提示：瀏覽器會吃掉 ⌘/Ctrl+N（開新視窗），網頁版以 ⌥N／Alt+N 為準 */
export const newBotKey = isMac ? '⌥N' : 'Alt+N'
