import type { StudioModule } from '../registry'
import { VoicePage } from './VoicePage'

export { MicButton, SpeakButton, SpeakEventListener } from './components'
export { useSpeak, useVoiceInput, useVoiceCapabilities } from './hooks'
export { speak, stopSpeaking, dispatchVoiceInput, requestSpeak, VOICE_INPUT_EVENT, VOICE_SPEAK_EVENT } from './speech'

const zhTW = {
  nav: { voice: '語音' },
  voice: {
    title: '語音與媒體',
    subtitle: '瀏覽器語音優先；伺服器端 whisper.cpp／edge-tts 為後備',
    engines: '可用引擎',
    browserStt: '瀏覽器語音辨識',
    browserTts: '瀏覽器朗讀',
    serverStt: '伺服器語音辨識',
    serverTts: '伺服器朗讀（mp3）',
    available: '可用',
    unavailable: '不可用',
    priorityNote: '順序：瀏覽器 Web Speech → 伺服器；伺服器 STT 需要本機 whisper-cli 與模型檔，TTS 需要 pip 套件 edge-tts。',
    sttTest: '語音輸入測試',
    sttPlaceholder: '按麥克風說話，文字會出現在這裡',
    ttsTest: '朗讀測試',
    serverSpeak: '用伺服器朗讀',
    lastEngine: '上次使用',
    integration: '整合方式（給其他模組）',
    startListening: '語音輸入',
    stopListening: '停止聆聽',
    processing: '辨識中…',
    speak: '朗讀',
    stopSpeaking: '停止朗讀',
  },
}
const en = {
  nav: { voice: 'Voice' },
  voice: {
    title: 'Voice & Media', subtitle: 'Browser speech first; whisper.cpp / edge-tts on the server as fallback',
    engines: 'Engines', browserStt: 'Browser STT', browserTts: 'Browser TTS', serverStt: 'Server STT', serverTts: 'Server TTS (mp3)',
    available: 'available', unavailable: 'unavailable',
    priorityNote: 'Order: browser Web Speech → server. Server STT needs whisper-cli + a model; TTS needs the edge-tts pip package.',
    sttTest: 'Speech input test', sttPlaceholder: 'Press the mic and talk', ttsTest: 'Read-aloud test', serverSpeak: 'Speak via server',
    lastEngine: 'Last engine', integration: 'Integration (for other modules)',
    startListening: 'Voice input', stopListening: 'Stop listening', processing: 'Transcribing…', speak: 'Read aloud', stopSpeaking: 'Stop',
  },
}

const mod: StudioModule = {
  name: 'voice',
  routes: [{ path: '/voice', element: <VoicePage /> }],
  nav: [{ to: '/voice', key: 'voice', order: 82, group: 'system', icon: 'Mic' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
