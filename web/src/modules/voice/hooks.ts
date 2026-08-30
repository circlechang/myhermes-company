import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  dispatchVoiceInput, getSpeechRecognition, hasBrowserSTT, recordAudio, speak, stopSpeaking, voiceApi,
  type SpeechRecognitionLike,
} from './speech'

export const useVoiceCapabilities = () =>
  useQuery({ queryKey: ['voice', 'capabilities'], queryFn: voiceApi.capabilities, staleTime: 60_000, retry: false })

export type ListenState = 'idle' | 'listening' | 'processing' | 'unavailable'

/**
 * 語音輸入：瀏覽器 SpeechRecognition 優先；沒有就錄音丟後端 /voice/transcribe；都沒有 → unavailable。
 * onText 會拿到即時（interim）與最終文字；同時派發 studio:voice-input 事件給其他模組。
 */
export function useVoiceInput(onText?: (text: string, final: boolean) => void, lang = 'zh-TW') {
  const [state, setState] = useState<ListenState>('idle')
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const caps = useVoiceCapabilities()
  const serverOk = caps.data?.stt.available ?? false
  const browserOk = hasBrowserSTT()
  const available = browserOk || serverOk

  const stop = useCallback(() => {
    recRef.current?.stop()
    abortRef.current?.abort()
  }, [])

  const start = useCallback(async () => {
    setError(null)
    if (browserOk) {
      const Ctor = getSpeechRecognition()!
      const rec = new Ctor()
      recRef.current = rec
      rec.lang = lang
      rec.continuous = false
      rec.interimResults = true
      let finalText = ''
      rec.onresult = (ev) => {
        let interim = ''
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i]
          if (r.isFinal) finalText += r[0].transcript
          else interim += r[0].transcript
        }
        const text = finalText || interim
        onText?.(text, false)
        dispatchVoiceInput(text, false)
      }
      rec.onerror = (e) => setError(e.error)
      rec.onend = () => {
        setState('idle')
        recRef.current = null
        if (finalText) {
          onText?.(finalText, true)
          dispatchVoiceInput(finalText, true)
        }
      }
      setState('listening')
      rec.start()
      return
    }
    if (serverOk) {
      const ac = new AbortController()
      abortRef.current = ac
      setState('listening')
      try {
        const blob = await recordAudio(30_000, ac.signal)
        setState('processing')
        const r = await voiceApi.transcribe(blob, lang.slice(0, 2))
        onText?.(r.text, true)
        dispatchVoiceInput(r.text, true, 'server')
      } catch (e) {
        setError(String((e as Error).message ?? e))
      } finally {
        setState('idle')
        abortRef.current = null
      }
      return
    }
    setState('unavailable')
  }, [browserOk, serverOk, lang, onText])

  useEffect(() => () => stop(), [stop])
  return { state, error, available, browserOk, serverOk, start, stop, toggle: () => (state === 'listening' ? stop() : start()) }
}

export function useSpeak() {
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const caps = useVoiceCapabilities()
  const serverOk = caps.data?.tts.available ?? false
  const say = useCallback(
    async (text: string, id = 'default') => {
      if (speakingId === id) {
        stopSpeaking()
        setSpeakingId(null)
        return
      }
      setSpeakingId(id)
      try {
        await speak(text, { onEnd: () => setSpeakingId((cur) => (cur === id ? null : cur)) })
      } catch {
        setSpeakingId(null)
      }
    },
    [speakingId],
  )
  return { say, speakingId, stop: () => { stopSpeaking(); setSpeakingId(null) }, serverOk }
}
