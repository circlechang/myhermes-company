import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSpeak, useVoiceInput } from './hooks'
import { VOICE_SPEAK_EVENT } from './speech'

/** 麥克風鈕：塞進任何輸入框旁邊。onText 拿到辨識文字；同時派發 studio:voice-input。 */
export function MicButton({ onText, className = '', lang }: { onText?: (t: string, final: boolean) => void; className?: string; lang?: string }) {
  const { t } = useTranslation()
  const v = useVoiceInput(onText, lang)
  if (!v.available && v.state !== 'unavailable') return null
  const label = v.state === 'listening' ? t('voice.stopListening') : v.state === 'processing' ? t('voice.processing') : t('voice.startListening')
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={v.state === 'listening'}
      title={v.error ?? label}
      onClick={v.toggle}
      disabled={v.state === 'processing' || v.state === 'unavailable'}
      className={`btn-outline px-2 ${v.state === 'listening' ? 'animate-pulse border-rose-500 text-rose-600 dark:text-rose-400' : ''} ${className}`}
      data-testid="mic-button"
    >
      {v.state === 'listening' ? '■' : v.state === 'processing' ? '…' : '🎤'}
    </button>
  )
}

/** 朗讀鈕：放在訊息旁。 */
export function SpeakButton({ text, id, className = '' }: { text: string; id?: string; className?: string }) {
  const { t } = useTranslation()
  const s = useSpeak()
  const key = id ?? text.slice(0, 32)
  const active = s.speakingId === key
  return (
    <button
      type="button"
      aria-label={active ? t('voice.stopSpeaking') : t('voice.speak')}
      title={active ? t('voice.stopSpeaking') : t('voice.speak')}
      onClick={() => s.say(text, key)}
      className={`inline-flex shrink-0 items-center rounded px-1 text-xs leading-5 opacity-60 hover:opacity-100 ${active ? 'text-indigo-700 opacity-100 dark:text-indigo-300' : ''} ${className}`}
      data-testid="speak-button"
    >
      {active ? '⏹' : '🔊'}
    </button>
  )
}

/** 監聽 studio:voice-speak 事件的無畫面元件（放在頁面任一處即可）。 */
export function SpeakEventListener() {
  const s = useSpeak()
  useEffect(() => {
    const h = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text
      if (text) void s.say(text, `evt-${Date.now()}`)
    }
    window.addEventListener(VOICE_SPEAK_EVENT, h)
    return () => window.removeEventListener(VOICE_SPEAK_EVENT, h)
  }, [s])
  return null
}
