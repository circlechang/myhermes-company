// 老闆看得懂的格式：時間講「剛剛／今天 09:30／昨天／週六／8/29」，錢講 NT$，tokens 講「18 萬」。
// 純函式、不碰 i18next（lang 用參數帶），所以可以單獨測；匯率存 localStorage，讓每台裝置自己設。
import { useCallback, useSyncExternalStore } from 'react'

export type Lang = 'zh-TW' | 'en'
const isZh = (lang: string) => lang !== 'en'

// ---------- 時間 ----------

/** 後端時間多半沒帶時區（其實是 UTC）；預設補 Z 再轉本地。 */
export function parseWhen(v?: string | number | Date | null, assumeUtc = true): Date | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') return isNaN(v) ? null : new Date(v)
  const hasTz = /(Z|[+-]\d\d:?\d\d)$/i.test(v)
  const d = new Date(assumeUtc && !hasTz && /T|\d{2}:\d{2}/.test(v) ? `${v}Z` : v)
  return isNaN(d.getTime()) ? null : d
}

const pad = (n: number) => String(n).padStart(2, '0')
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 兩個時間差幾「天」（以本地日曆算，不是 24 小時） */
export function dayDiff(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((da - db) / 86_400_000)
}

export interface WhenOpts {
  /** 60 分鐘內講「剛剛／5 分鐘前」；關掉就一律「今天 HH:MM」（流程頁的「開始／完成」要固定時刻） */
  relative?: boolean
  /** 一週以外的日期要不要帶時刻（「8/29」vs「8/29 09:00」） */
  farTime?: boolean
  /** 沒時區的字串當 UTC（預設）；舊模組把它當本地時間，延用時傳 false */
  assumeUtc?: boolean
}

/**
 * 剛剛 → 5 分鐘前 → 今天 09:30 → 昨天 14:02 → 週六 08:00（7 天內）→ 8/29（同年）→ 2025/12/03。
 * 未來的時間不講「後」，直接給時刻（明天 08:00）。解析失敗回空字串，畫面不佔位。
 */
export function fmtWhen(iso?: string | number | Date | null, now: Date = new Date(), lang: string = 'zh-TW', opts: WhenOpts = {}): string {
  const d = parseWhen(iso, opts.assumeUtc ?? true)
  if (!d) return ''
  const zh = isZh(lang)
  const diffMs = now.getTime() - d.getTime()
  if (opts.relative !== false && diffMs >= 0) {
    if (diffMs < 60_000) return zh ? '剛剛' : 'just now'
    if (diffMs < 3_600_000) {
      const m = Math.floor(diffMs / 60_000)
      return zh ? `${m} 分鐘前` : `${m} min ago`
    }
  }
  const t = hhmm(d)
  const dd = dayDiff(d, now)
  if (dd === 0) return zh ? `今天 ${t}` : `Today ${t}`
  if (dd === -1) return zh ? `昨天 ${t}` : `Yesterday ${t}`
  if (dd === 1) return zh ? `明天 ${t}` : `Tomorrow ${t}`
  if (Math.abs(dd) < 7) return zh ? `週${WEEKDAY_ZH[d.getDay()]} ${t}` : `${WEEKDAY_EN[d.getDay()]} ${t}`
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  const date = d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
  return opts.farTime ? `${date} ${t}` : date
}

// ---------- 錢 ----------

export const FX_KEY = 'mhc.fxrate'
export const DEFAULT_FX = 32.5
const fxListeners = new Set<() => void>()

export function readFxRate(): number {
  try {
    const v = Number(localStorage.getItem(FX_KEY))
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_FX
  } catch {
    return DEFAULT_FX
  }
}
export function writeFxRate(rate: number) {
  try {
    if (Number.isFinite(rate) && rate > 0) localStorage.setItem(FX_KEY, String(rate))
    else localStorage.removeItem(FX_KEY)
  } catch {
    /* 私密視窗：只影響本次 */
  }
  for (const l of fxListeners) l()
}
function subscribeFx(cb: () => void) {
  fxListeners.add(cb)
  const onStorage = (e: StorageEvent) => { if (e.key === FX_KEY) cb() }
  window.addEventListener('storage', onStorage)
  return () => { fxListeners.delete(cb); window.removeEventListener('storage', onStorage) }
}
/** `const [rate, setRate] = useFxRate()`；存 localStorage，跨分頁同步 */
export function useFxRate(): [number, (rate: number) => void] {
  const rate = useSyncExternalStore(subscribeFx, readFxRate, () => DEFAULT_FX)
  const set = useCallback((r: number) => writeFxRate(r), [])
  return [rate, set]
}

export interface Money { local: string; usd: string; rate: number; currency: string }

/** 美元字串（工程師模式才看）：$0.62；不到一分錢給四位，免得全是 $0.00 */
export function fmtUsd(usd: number): string {
  const n = Number.isFinite(usd) ? usd : 0
  return `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`
}

/** 美元 → 台幣：≥10 取整數（NT$612），<10 留一位小數（NT$6.8）；0 就是 NT$0 */
export function fmtMoney(usd: number, opts: { rate?: number; currency?: string } = {}): Money {
  const rate = opts.rate ?? readFxRate()
  const currency = opts.currency ?? 'NT$'
  const n = (Number.isFinite(usd) ? usd : 0) * rate
  const s = n >= 10 ? Math.round(n).toLocaleString('en-US') : n.toFixed(1).replace(/\.0$/, '')
  return { local: `${currency}${s}`, usd: fmtUsd(usd), rate, currency }
}

// ---------- tokens ----------

/** 中文用萬／億（18 萬 tokens、1.2 億 tokens）；英文用 k／M（184k tokens、1.4M tokens） */
export function fmtTokens(n: number, lang: string = 'zh-TW'): string {
  const v = Number.isFinite(n) ? Math.max(0, n) : 0
  const one = (x: number) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''))
  if (isZh(lang)) {
    if (v >= 1e8) return `${one(v / 1e8)} 億 tokens`
    if (v >= 1e4) return `${one(v / 1e4)} 萬 tokens`
    return `${Math.round(v).toLocaleString('en-US')} tokens`
  }
  if (v >= 1e6) return `${one(v / 1e6)}M tokens`
  if (v >= 1e3) return `${one(v / 1e3)}k tokens`
  return `${Math.round(v)} tokens`
}
