import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../../components/PageHeader'
import { MicButton, SpeakButton } from './components'
import { useVoiceCapabilities } from './hooks'
import { hasBrowserSTT, hasBrowserTTS, speak, VOICE_INPUT_EVENT } from './speech'

export function VoicePage() {
  const { t } = useTranslation()
  const caps = useVoiceCapabilities()
  const [text, setText] = useState('')
  const [tts, setTts] = useState('你好，這是 Hermes Studio 的語音測試。')
  const [log, setLog] = useState<string[]>([])
  const [lastEngine, setLastEngine] = useState<string>('')

  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ text: string; final: boolean; source: string }>).detail
      setLog((l) => [`${new Date().toLocaleTimeString()} [${d.source}${d.final ? '/final' : ''}] ${d.text}`, ...l].slice(0, 20))
    }
    window.addEventListener(VOICE_INPUT_EVENT, h)
    return () => window.removeEventListener(VOICE_INPUT_EVENT, h)
  }, [])

  const Row = ({ label, ok, note }: { label: string; ok: boolean; note?: string }) => (
    <div className="flex items-center gap-2 text-sm">
      <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
      <span className="w-40">{label}</span>
      <span className="text-zinc-600 dark:text-zinc-400">{ok ? t('voice.available') : t('voice.unavailable')}{note ? ` · ${note}` : ''}</span>
    </div>
  )

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <PageHeader title={t('voice.title')} subtitle={t('voice.subtitle')} />
      <section className="card space-y-2 p-3">
        <div className="panel-title">{t('voice.engines')}</div>
        <Row label={t('voice.browserStt')} ok={hasBrowserSTT()} />
        <Row label={t('voice.browserTts')} ok={hasBrowserTTS()} />
        <Row label={t('voice.serverStt')} ok={!!caps.data?.stt.available} note={caps.data?.stt.model ?? undefined} />
        <Row label={t('voice.serverTts')} ok={!!caps.data?.tts.available} note={caps.data?.tts.default_voice} />
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('voice.priorityNote')}</p>
      </section>
      <section className="card space-y-2 p-3">
        <div className="panel-title">{t('voice.sttTest')}</div>
        <div className="flex gap-2">
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('voice.sttPlaceholder')} />
          <MicButton onText={(tx) => setText(tx)} />
        </div>
        <ul className="max-h-40 overflow-auto text-xs text-zinc-600 dark:text-zinc-400" data-testid="voice-log">
          {log.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      </section>
      <section className="card space-y-2 p-3">
        <div className="panel-title">{t('voice.ttsTest')}</div>
        <div className="flex gap-2">
          <input className="input" value={tts} onChange={(e) => setTts(e.target.value)} />
          <SpeakButton text={tts} id="voice-page" />
          <button
            className="btn-outline"
            disabled={!caps.data?.tts.available}
            onClick={() => speak(tts, { prefer: 'server' }).then((e) => setLastEngine(e)).catch((e) => setLastEngine(String(e)))}
          >
            {t('voice.serverSpeak')}
          </button>
        </div>
        {lastEngine && <div className="text-xs text-zinc-600 dark:text-zinc-400">{t('voice.lastEngine')}: {lastEngine}</div>}
      </section>
      <section className="card p-3 text-xs text-zinc-600 dark:text-zinc-400">
        <div className="panel-title">{t('voice.integration')}</div>
        <pre className="whitespace-pre-wrap">{`window.addEventListener('studio:voice-input', e => input.value = e.detail.text)\nwindow.dispatchEvent(new CustomEvent('studio:voice-speak', { detail: { text } }))`}</pre>
      </section>
    </div>
  )
}
