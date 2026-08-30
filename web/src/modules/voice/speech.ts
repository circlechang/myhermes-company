// 語音基礎：瀏覽器 Web Speech API 優先，後端 /voice/* 為後備。
// 事件契約：
//   window 派發 CustomEvent('studio:voice-input', {detail:{text, final:boolean, source:'browser'|'server'}})
//     → 聊天模組把 text 塞進輸入框（本模組不改 WorkbenchPage）
//   window 監聽 CustomEvent('studio:voice-speak', {detail:{text}}) → 朗讀
import { request } from '../../api/client'

export const VOICE_INPUT_EVENT = 'studio:voice-input'
export const VOICE_SPEAK_EVENT = 'studio:voice-speak'

export interface VoiceCapabilities {
  stt: { available: boolean; engine?: string | null; model?: string | null; needs_ffmpeg?: boolean }
  tts: { available: boolean; engine?: string | null; default_voice?: string }
  browser_first: boolean
}

export const voiceApi = {
  capabilities: () => request<VoiceCapabilities>('/voice/capabilities'),
  voices: (locale = 'zh') => request<{ name: string; gender: string; locale: string }[]>(`/voice/voices?locale=${encodeURIComponent(locale)}`),
  speak: async (text: string, voice?: string, rate?: string): Promise<Blob> => {
    const { API_BASE, getToken } = await import('../../api/client')
    const res = await fetch(new URL(`${API_BASE}/voice/speak`, location.origin).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
      body: JSON.stringify({ text, voice, rate }),
    })
    if (!res.ok) throw new Error(`speak failed: ${res.status}`)
    return res.blob()
  },
  transcribe: async (blob: Blob, language = 'zh'): Promise<{ text: string; language: string }> => {
    const { API_BASE, getToken } = await import('../../api/client')
    const fd = new FormData()
    fd.append('file', blob, blob.type.includes('wav') ? 'audio.wav' : 'audio.webm')
    fd.append('language', language)
    const res = await fetch(new URL(`${API_BASE}/voice/transcribe`, location.origin).toString(), { method: 'POST', headers: { Authorization: `Bearer ${getToken() ?? ''}` }, body: fd })
    if (!res.ok) throw new Error(`transcribe failed: ${res.status}`)
    return res.json()
  },
}

// ---- 瀏覽器能力偵測 ----
type SR = typeof window extends { SpeechRecognition: infer T } ? T : unknown
export function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR }
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null
}
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: ((ev: { error: string }) => void) | null
  start(): void
  stop(): void
  abort(): void
}
export const hasBrowserSTT = () => getSpeechRecognition() !== null
export const hasBrowserTTS = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'

export function dispatchVoiceInput(text: string, final = true, source: 'browser' | 'server' = 'browser') {
  window.dispatchEvent(new CustomEvent(VOICE_INPUT_EVENT, { detail: { text, final, source } }))
}
export function requestSpeak(text: string) {
  window.dispatchEvent(new CustomEvent(VOICE_SPEAK_EVENT, { detail: { text } }))
}

// ---- 朗讀（瀏覽器優先 → 後端 mp3）----
let currentAudio: HTMLAudioElement | null = null
export function stopSpeaking() {
  if (hasBrowserTTS()) window.speechSynthesis.cancel()
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }
}

export function pickBrowserVoice(lang = 'zh-TW'): SpeechSynthesisVoice | undefined {
  if (!hasBrowserTTS()) return undefined
  const vs = window.speechSynthesis.getVoices()
  return vs.find((v) => v.lang === lang) ?? vs.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))
}

/** 純文字化：去掉 markdown 符號，讓朗讀不念「星號」。 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '（程式碼略）')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export interface SpeakOptions {
  lang?: string
  rate?: number
  prefer?: 'browser' | 'server'
  serverVoice?: string
  onEnd?: () => void
}

export async function speak(text: string, opts: SpeakOptions = {}): Promise<'browser' | 'server'> {
  const clean = stripMarkdown(text)
  if (!clean) return 'browser'
  stopSpeaking()
  const lang = opts.lang ?? 'zh-TW'
  const useBrowser = opts.prefer !== 'server' && hasBrowserTTS()
  if (useBrowser) {
    await new Promise<void>((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(clean)
      u.lang = lang
      u.rate = opts.rate ?? 1
      const v = pickBrowserVoice(lang)
      if (v) u.voice = v
      u.onend = () => resolve()
      u.onerror = (e) => reject(new Error(e.error))
      window.speechSynthesis.speak(u)
    }).catch(() => undefined)
    opts.onEnd?.()
    return 'browser'
  }
  const blob = await voiceApi.speak(clean, opts.serverVoice, opts.rate ? `${Math.round((opts.rate - 1) * 100)}%` : undefined)
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  currentAudio = audio
  await new Promise<void>((resolve) => {
    audio.onended = () => resolve()
    audio.onerror = () => resolve()
    audio.play().catch(() => resolve())
  })
  URL.revokeObjectURL(url)
  if (currentAudio === audio) currentAudio = null
  opts.onEnd?.()
  return 'server'
}

// ---- 錄音（給後端 STT 用）----
export async function recordAudio(maxMs = 30_000, signal?: AbortSignal): Promise<Blob> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const rec = new MediaRecorder(stream)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const done = new Promise<Blob>((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }))
    }
  })
  rec.start()
  const timer = setTimeout(() => rec.state !== 'inactive' && rec.stop(), maxMs)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    if (rec.state !== 'inactive') rec.stop()
  })
  return done
}
