import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { StudioModule } from '../registry'
import { PageHeader } from '../../components/PageHeader'
import { API_BASE, getToken, request } from '../../api/client'

export interface ThemeSettings {
  mode: 'light' | 'dark' | 'system'
  style: 'rounded' | 'square'
  density: 'comfortable' | 'compact'
  font_size: number
  text_color: string
  primary: string
  background_opacity: number
}
export interface ThemeResponse {
  settings: ThemeSettings
  has_background: boolean
  updated_at: string | null
}
export const THEME_DEFAULTS: ThemeSettings = { mode: 'system', style: 'rounded', density: 'comfortable', font_size: 16, text_color: '', primary: '#4f46e5', background_opacity: 0.12 }
const CACHE_KEY = 'mhc.theme'
const STYLE_ID = 'studio-theme-style'

const themeApi = {
  get: () => request<ThemeResponse>('/theme'),
  put: (settings: Partial<ThemeSettings>) => request<ThemeResponse>('/theme', { method: 'PUT', body: JSON.stringify({ settings }) }),
  reset: () => request<ThemeResponse>('/theme', { method: 'DELETE' }),
  upload: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${API_BASE}/theme/background`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
    if (!res.ok) throw new Error((await res.json())?.error?.message ?? res.statusText)
    return (await res.json()) as ThemeResponse
  },
  removeBackground: () => request<ThemeResponse>('/theme/background', { method: 'DELETE' }),
  backgroundBlob: async () => {
    const res = await fetch(`${API_BASE}/theme/background`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
    if (!res.ok) return null
    return res.blob()
  },
}

/** 以 CSS 變數套在 <html>（不改 Layout）；mode 用 data-theme 交給 tailwind darkMode variant。 */
export function applyTheme(s: ThemeSettings, backgroundUrl?: string | null) {
  const root = document.documentElement
  root.style.setProperty('--studio-font-size', `${s.font_size}px`)
  root.style.setProperty('--studio-primary', s.primary || THEME_DEFAULTS.primary)
  root.style.setProperty('--studio-text', s.text_color || '')
  root.style.setProperty('--studio-radius', s.style === 'square' ? '2px' : '8px')
  root.style.setProperty('--studio-density', s.density === 'compact' ? '0.75' : '1')
  root.style.setProperty('--studio-bg-opacity', String(s.background_opacity))
  if (s.mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', s.mode)
  root.style.colorScheme = s.mode === 'system' ? 'light dark' : s.mode
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  const bg = backgroundUrl ? `body::before{content:"";position:fixed;inset:0;z-index:-1;background:url("${backgroundUrl}") center/cover no-repeat;opacity:var(--studio-bg-opacity);pointer-events:none}` : ''
  el.textContent = [
    `html{font-size:var(--studio-font-size)}`,
    s.text_color ? `body{color:var(--studio-text)}` : '',
    `.btn-primary{background-color:var(--studio-primary)}.btn-primary:hover{filter:brightness(1.1);background-color:var(--studio-primary)}`,
    `.input:focus{--tw-ring-color:var(--studio-primary)}`,
    `.card,.btn,.input{border-radius:var(--studio-radius)}`,
    s.density === 'compact' ? `.btn{padding-top:.2rem;padding-bottom:.2rem}.input{padding-top:.2rem;padding-bottom:.2rem}.card{--tw-space-y-reverse:0}` : '',
    bg,
  ].join('\n')
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

export function loadCachedTheme(): ThemeSettings | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? { ...THEME_DEFAULTS, ...(JSON.parse(raw) as Partial<ThemeSettings>) } : null
  } catch {
    return null
  }
}

let bgObjectUrl: string | null = null
async function syncFromServer() {
  if (!getToken()) return
  try {
    const r = await themeApi.get()
    let url: string | null = null
    if (r.has_background) {
      const blob = await themeApi.backgroundBlob()
      if (blob) {
        if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl)
        bgObjectUrl = URL.createObjectURL(blob)
        url = bgObjectUrl
      }
    }
    applyTheme({ ...THEME_DEFAULTS, ...r.settings }, url)
  } catch {
    /* not logged in / offline: keep cache */
  }
}

// 模組載入即套用快取，並在有 token 時向伺服器同步（登入後由 storage/自訂事件觸發）。
if (typeof window !== 'undefined' && !/jsdom/i.test(navigator.userAgent)) {
  const cached = loadCachedTheme()
  if (cached) applyTheme(cached)
  void syncFromServer()
  window.addEventListener('mhc:login', () => void syncFromServer())
  window.addEventListener('mhc:unauthorized', () => {
    /* keep cached look */
  })
}

const zhTW = {
  nav: { theme: '外觀' },
  theme: {
    title: '外觀主題',
    subtitle: '亮／暗、介面風格、字級、顏色與背景圖；存在你的帳號，跨裝置同步（本機另有快取）',
    mode: '亮／暗',
    light: '亮色',
    dark: '暗色',
    system: '跟隨系統',
    style: '介面風格',
    rounded: '圓角',
    square: '方角',
    density: '密度',
    comfortable: '舒適',
    compact: '緊湊',
    fontSize: '字級',
    textColor: '文字色',
    primary: '主色',
    background: '背景圖',
    bgOpacity: '背景透明度',
    upload: '上傳背景圖',
    removeBg: '移除背景',
    reset: '重設為預設',
    saved: '已儲存',
    preview: '預覽',
    previewText: '這是預覽文字。按鈕、輸入框與卡片會即時反映設定。',
  },
}
const en = { nav: { theme: 'Theme' }, theme: { title: 'Theme', mode: 'Mode', light: 'Light', dark: 'Dark', system: 'System', reset: 'Reset', saved: 'Saved' } }

export function ThemePage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['theme'], queryFn: themeApi.get })
  const [s, setS] = useState<ThemeSettings>(loadCachedTheme() ?? THEME_DEFAULTS)
  const [msg, setMsg] = useState<string | null>(null)
  const bgUrl = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!q.data) return
    setS({ ...THEME_DEFAULTS, ...q.data.settings })
    if (q.data.has_background) themeApi.backgroundBlob().then((b) => { if (b) { bgUrl.current = URL.createObjectURL(b); applyTheme({ ...THEME_DEFAULTS, ...q.data!.settings }, bgUrl.current) } })
    else { bgUrl.current = null; applyTheme({ ...THEME_DEFAULTS, ...q.data.settings }, null) }
  }, [q.data])
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2000) }
  const save = useMutation({ mutationFn: (patch: Partial<ThemeSettings>) => themeApi.put(patch), onSuccess: () => { flash(t('theme.saved')); qc.invalidateQueries({ queryKey: ['theme'] }) }, onError: (e) => flash(String((e as Error).message)) })
  const upload = useMutation({ mutationFn: (f: File) => themeApi.upload(f), onSuccess: () => qc.invalidateQueries({ queryKey: ['theme'] }), onError: (e) => flash(String((e as Error).message)) })
  const removeBg = useMutation({ mutationFn: themeApi.removeBackground, onSuccess: () => qc.invalidateQueries({ queryKey: ['theme'] }) })
  const reset = useMutation({ mutationFn: themeApi.reset, onSuccess: () => { setS(THEME_DEFAULTS); applyTheme(THEME_DEFAULTS, null); qc.invalidateQueries({ queryKey: ['theme'] }) } })

  const update = (patch: Partial<ThemeSettings>) => {
    const next = { ...s, ...patch }
    setS(next)
    applyTheme(next, bgUrl.current) // 即時預覽
    save.mutate(patch)
  }
  const Radio = <K extends keyof ThemeSettings>({ k, v, label }: { k: K; v: ThemeSettings[K]; label: string }) => (
    <label className="flex items-center gap-1 text-sm">
      <input type="radio" name={String(k)} checked={s[k] === v} onChange={() => update({ [k]: v } as Partial<ThemeSettings>)} /> {label}
    </label>
  )
  return (
    <div className="mx-auto max-w-3xl p-4">
      <PageHeader title={t('theme.title')} subtitle={t('theme.subtitle')} actions={<button className="btn-outline" onClick={() => reset.mutate()}>{t('theme.reset')}</button>} />
      {msg && <div role="status" className="mb-2 text-xs text-emerald-700 dark:text-emerald-300">{msg}</div>}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card space-y-3 p-4">
          <fieldset><legend className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">{t('theme.mode')}</legend><div className="flex gap-3"><Radio k="mode" v="light" label={t('theme.light')} /><Radio k="mode" v="dark" label={t('theme.dark')} /><Radio k="mode" v="system" label={t('theme.system')} /></div></fieldset>
          <fieldset><legend className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">{t('theme.style')}</legend><div className="flex gap-3"><Radio k="style" v="rounded" label={t('theme.rounded')} /><Radio k="style" v="square" label={t('theme.square')} /></div></fieldset>
          <fieldset><legend className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">{t('theme.density')}</legend><div className="flex gap-3"><Radio k="density" v="comfortable" label={t('theme.comfortable')} /><Radio k="density" v="compact" label={t('theme.compact')} /></div></fieldset>
          <label className="block text-sm"><span className="text-xs text-zinc-600 dark:text-zinc-400">{t('theme.fontSize')}：{s.font_size}px</span>
            <input type="range" min={12} max={20} value={s.font_size} aria-label={t('theme.fontSize')} onChange={(e) => update({ font_size: Number(e.target.value) })} className="w-full" /></label>
          <div className="flex gap-4">
            <label className="text-sm"><span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('theme.primary')}</span><input type="color" aria-label={t('theme.primary')} value={s.primary || '#4f46e5'} onChange={(e) => update({ primary: e.target.value })} /></label>
            <label className="text-sm"><span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('theme.textColor')}</span>
              <div className="flex items-center gap-1"><input type="color" aria-label={t('theme.textColor')} value={s.text_color || '#18181b'} onChange={(e) => update({ text_color: e.target.value })} /><button className="btn-ghost text-xs" onClick={() => update({ text_color: '' })}>auto</button></div></label>
          </div>
          <div>
            <span className="block text-xs text-zinc-600 dark:text-zinc-400">{t('theme.background')}</span>
            <div className="flex items-center gap-2">
              <button className="btn-outline" onClick={() => fileInput.current?.click()}>{t('theme.upload')}</button>
              <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden aria-label={t('theme.upload')} onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
              {q.data?.has_background && <button className="btn-ghost" onClick={() => removeBg.mutate()}>{t('theme.removeBg')}</button>}
            </div>
            <label className="mt-1 block text-xs text-zinc-600 dark:text-zinc-400">{t('theme.bgOpacity')}：{Math.round(s.background_opacity * 100)}%
              <input type="range" min={0} max={1} step={0.05} value={s.background_opacity} onChange={(e) => update({ background_opacity: Number(e.target.value) })} className="w-full" /></label>
          </div>
        </div>
        <div className="card p-4" data-testid="theme-preview">
          <div className="panel-title">{t('theme.preview')}</div>
          <p className="mb-3 text-sm">{t('theme.previewText')}</p>
          <div className="flex gap-2"><button className="btn-primary">Primary</button><button className="btn-outline">Outline</button></div>
          <input className="input mt-3" defaultValue="input" />
        </div>
      </div>
    </div>
  )
}

const mod: StudioModule = {
  name: 'theme',
  routes: [{ path: '/theme', element: <ThemePage /> }],
  nav: [{ to: '/theme', key: 'theme', order: 95, group: 'settings', icon: 'Palette', hidden: true }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
