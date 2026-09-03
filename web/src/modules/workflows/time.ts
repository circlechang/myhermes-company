// 老闆看得懂的時間：今天 08:00／昨天 21:30／週三 09:00／9/1 08:00；花多久：40 秒／3 分鐘／1 小時 5 分。
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

const dayDiff = (a: Date, b: Date) => {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((da - db) / 86_400_000)
}

/** 相對的短時間：跟「現在」比，今天／明天／昨天／一週內用週幾，再遠給月/日。 */
export function shortTime(iso?: string | null, now: Date = new Date()): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const diff = dayDiff(d, now)
  const t = hhmm(d)
  if (diff === 0) return `今天 ${t}`
  if (diff === 1) return `明天 ${t}`
  if (diff === -1) return `昨天 ${t}`
  if (Math.abs(diff) < 7) return `週${WEEKDAY[d.getDay()]} ${t}`
  return `${d.getMonth() + 1}/${d.getDate()} ${t}`
}

/** 同一天只給 HH:MM（「今天 08:00 開始 · 08:04 完成」的第二個時間） */
export function sameDayTime(iso?: string | null, ref?: string | null, now: Date = new Date()): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  if (ref) {
    const r = new Date(ref)
    if (!Number.isNaN(r.getTime()) && dayDiff(d, r) === 0) return hhmm(d)
  }
  return shortTime(iso, now)
}

/** 兩個時間差，講成人話；缺一邊就回 null（畫面上不佔位） */
export function durationText(start?: string | null, end?: string | null): string | null {
  if (!start || !end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分鐘`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h} 小時 ${rm} 分` : `${h} 小時`
}

export function usd(n?: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null
  return `$${n < 1 ? n.toFixed(2) : n.toFixed(2).replace(/\.?0+$/, '')}`
}

/** 輸出的第一行，截到 max 個字（清單／時間軸那一行「」裡的內容） */
export function firstLine(text?: string | null, max = 80): string {
  if (!text) return ''
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
/** ① ② ③…（超過 20 就退回數字） */
export function circled(n: number): string {
  return n >= 1 && n <= 20 ? CIRCLED[n - 1] : `${n}.`
}

/** cron 五欄講成人話；認不出來就原樣回（工程師自己看得懂） */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [min, hour, dom, mon, dow] = parts
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || dom !== '*' || mon !== '*') return cron
  const t = `${pad(Number(hour))}:${pad(Number(min))}`
  if (dow === '*') return `每天 ${t}`
  if (dow === '1-5') return `週一到週五 ${t}`
  const days = dow.split(',').map((x) => x.trim())
  if (days.every((x) => /^[0-6]$/.test(x))) return `每${days.map((x) => `週${WEEKDAY[Number(x)]}`).join('、')} ${t}`
  return cron
}
