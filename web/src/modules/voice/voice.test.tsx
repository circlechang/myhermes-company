import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../registry'
import { setFetchImpl } from '../../api/client'
import { MicButton, SpeakButton } from './components'
import { hasBrowserSTT, hasBrowserTTS, speak, stripMarkdown, VOICE_INPUT_EVENT } from './speech'

class FakeRecognition {
  static last: FakeRecognition | null = null
  lang = ''
  continuous = false
  interimResults = false
  onresult: ((ev: unknown) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((ev: { error: string }) => void) | null = null
  started = false
  constructor() { FakeRecognition.last = this }
  start() { this.started = true }
  stop() { this.onend?.() }
  abort() { this.onend?.() }
  result(text: string, isFinal: boolean) {
    const r = Object.assign([{ transcript: text }], { isFinal })
    this.onresult?.({ resultIndex: 0, results: [r] })
  }
}

const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)

describe('語音（modules/voice）', () => {
  beforeEach(() => {
    const stub = async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/voice/capabilities')) return new Response(JSON.stringify({ stt: { available: false }, tts: { available: true, default_voice: 'zh-TW-HsiaoChenNeural' }, browser_first: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.includes('/voice/speak')) return new Response(new Blob([new Uint8Array([73, 68, 51])], { type: 'audio/mpeg' }), { status: 200 })
      return new Response('{}', { status: 404 })
    }
    setFetchImpl(stub as typeof fetch)
    vi.stubGlobal('fetch', stub)
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition
    delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition
  })

  it('stripMarkdown 去掉符號、程式碼', () => {
    expect(stripMarkdown('# 標題\n\n**粗體** 與 `code`\n\n```js\nx\n```\n[連結](http://x)')).toBe('標題\n粗體 與 code\n（程式碼略）\n連結')
  })

  it('沒有瀏覽器 STT 也沒有後端 STT → 麥克風不顯示', async () => {
    expect(hasBrowserSTT()).toBe(false)
    wrap(<MicButton />)
    await waitFor(() => expect(screen.queryByTestId('mic-button')).not.toBeInTheDocument())
  })

  it('瀏覽器 SpeechRecognition：按下開始、結果回呼並派發 studio:voice-input 事件', async () => {
    ;(window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition
    const onText = vi.fn()
    const events: { text: string; final: boolean }[] = []
    window.addEventListener(VOICE_INPUT_EVENT, (e) => events.push((e as CustomEvent).detail))
    wrap(<MicButton onText={onText} />)
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('mic-button'))
    const rec = FakeRecognition.last!
    expect(rec.started && rec.lang === 'zh-TW').toBe(true)
    expect(screen.getByTestId('mic-button')).toHaveAttribute('aria-pressed', 'true')
    act(() => rec.result('你好', false))
    act(() => rec.result('你好世界', true))
    act(() => rec.stop())
    expect(onText).toHaveBeenLastCalledWith('你好世界', true)
    expect(events.at(-1)).toEqual({ text: '你好世界', final: true, source: 'browser' })
    await waitFor(() => expect(screen.getByTestId('mic-button')).toHaveAttribute('aria-pressed', 'false'))
  })

  it('朗讀：無瀏覽器 TTS 時走後端 mp3', async () => {
    expect(hasBrowserTTS()).toBe(false)
    const play = vi.fn().mockResolvedValue(undefined)
    const origAudio = window.Audio
    let inst: { onended?: () => void } = {}
    // @ts-expect-error 測試用假 Audio
    window.Audio = class { play = () => { play(); setTimeout(() => inst.onended?.(), 0); return Promise.resolve() } ; set onended(f: () => void) { inst.onended = f } ; onerror = null }
    window.URL.createObjectURL = vi.fn(() => 'blob:x')
    window.URL.revokeObjectURL = vi.fn()
    const engine = await speak('**嗨**')
    expect(engine).toBe('server')
    expect(play).toHaveBeenCalled()
    window.Audio = origAudio
  })

  it('SpeakButton 顯示朗讀鈕', async () => {
    wrap(<SpeakButton text="測試" id="x" />)
    expect(screen.getByRole('button', { name: '朗讀' })).toBeInTheDocument()
  })
})
