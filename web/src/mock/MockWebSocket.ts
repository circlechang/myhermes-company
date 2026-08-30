// 假 WebSocket：模擬 /ws/chat 事件流（串流文字、工具呼叫、審批卡）。
// 送出的訊息若含「審批」或「approve」會先發 approval.request；含「錯誤」會 run.failed。
import type { WsClientMessage, WsServerEvent } from '../api/types'

type Listener = (ev: MessageEvent) => void

export interface MockWsOptions {
  /** 每段 delta 的間隔 ms；測試可設 0 */
  delayMs?: number
  /** 自訂腳本；回傳要依序送出的事件（不含 session_id/run_id） */
  script?: (input: string) => Omit<WsServerEvent, 'session_id' | 'run_id'>[]
}

let runSeq = 0

export class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  static options: MockWsOptions = { delayMs: 40 }

  readyState = MockWebSocket.CONNECTING
  url: string
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onmessage: Listener | null = null
  sent: WsClientMessage[] = []
  private listeners: Record<string, Set<(ev: Event) => void>> = {}
  private timers: ReturnType<typeof setTimeout>[] = []
  private pendingApproval: { runId: string; sessionId: string; input: string } | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN
      this.dispatch('open', new Event('open'))
    }, 0)
  }

  addEventListener(type: string, fn: (ev: Event) => void) {
    ;(this.listeners[type] ??= new Set()).add(fn)
  }
  removeEventListener(type: string, fn: (ev: Event) => void) {
    this.listeners[type]?.delete(fn)
  }
  private dispatch(type: string, ev: Event) {
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`]
    if (typeof handler === 'function') (handler as (e: Event) => void)(ev)
    this.listeners[type]?.forEach((fn) => fn(ev))
  }

  /** 由伺服器端推事件（測試也可直接呼叫） */
  emit(event: WsServerEvent) {
    this.dispatch('message', new MessageEvent('message', { data: JSON.stringify(event) }))
  }

  send(raw: string) {
    const msg = JSON.parse(raw) as WsClientMessage
    this.sent.push(msg)
    const m = msg as unknown as { type: string; session_id: string; input?: string; run_id: string; decision: string }
    if (m.type === 'run') this.handleRun(m.session_id, m.input ?? '')
    else if (m.type === 'regenerate') { this.emit({ type: 'messages.removed', session_id: m.session_id, ids: [] } as WsServerEvent); this.handleRun(m.session_id, '（重新生成）') }
    else if (m.type === 'edit') { this.emit({ type: 'messages.removed', session_id: m.session_id, ids: [] } as WsServerEvent); this.handleRun(m.session_id, m.input ?? '') }
    else if (m.type === 'steer') this.emit({ type: 'steer.ack', session_id: this.currentSession, run_id: m.run_id } as WsServerEvent)
    else if (msg.type === 'approval') this.handleApproval(msg.run_id, msg.decision)
    else if (msg.type === 'stop') {
      this.clearTimers()
      this.emit({ type: 'run.cancelled', session_id: this.currentSession, run_id: msg.run_id })
    }
  }

  close() {
    this.clearTimers()
    this.readyState = MockWebSocket.CLOSED
    this.dispatch('close', new CloseEvent('close'))
  }

  private currentSession = ''
  private clearTimers() {
    this.timers.forEach(clearTimeout)
    this.timers = []
  }

  private schedule(events: WsServerEvent[]) {
    const delay = MockWebSocket.options.delayMs ?? 40
    events.forEach((e, i) => {
      this.timers.push(setTimeout(() => this.emit(e), delay * (i + 1)))
    })
  }

  private handleRun(sessionId: string, input: string) {
    const runId = `run-${++runSeq}`
    this.currentSession = sessionId
    const base = { session_id: sessionId, run_id: runId }
    this.emit({ type: 'run.started', ...base })
    const needsApproval = /審批|approve|rm |刪除/.test(input)
    if (needsApproval) {
      this.pendingApproval = { runId, sessionId, input }
      this.schedule([
        { type: 'approval.request', ...base, approval_id: `ap-${runId}`, command: 'rm -rf ./tmp/cache', context: '模型想清掉暫存資料夾' },
      ])
      return
    }
    this.schedule(this.replyEvents(base, input))
  }

  private replyEvents(base: { session_id: string; run_id: string }, input: string): WsServerEvent[] {
    if (MockWebSocket.options.script) {
      return MockWebSocket.options.script(input).map((e) => ({ ...e, ...base }) as WsServerEvent)
    }
    if (/錯誤|fail/.test(input)) return [{ type: 'run.failed', ...base, error: 'mock: gateway timeout' }]
    const text = `收到「${input}」。這是 mock 回覆，示範串流輸出與工具卡。`
    const chunks = text.match(/.{1,4}/g) ?? [text]
    return [
      { type: 'tool.started', ...base, name: 'web_search', args: { q: input } },
      { type: 'tool.completed', ...base, name: 'web_search', result: { hits: 3, took_ms: 120 } },
      ...chunks.map((delta) => ({ type: 'message.delta', ...base, delta }) as WsServerEvent),
      { type: 'run.completed', ...base, output: text, usage: { input_tokens: 120, output_tokens: 48 } },
    ]
  }

  private handleApproval(runId: string, decision: string) {
    const p = this.pendingApproval
    if (!p || p.runId !== runId) return
    this.pendingApproval = null
    const base = { session_id: p.sessionId, run_id: runId }
    this.emit({ type: 'approval.responded', ...base, approval_id: `ap-${runId}`, decision: decision as never })
    if (decision === 'deny') {
      this.schedule([
        { type: 'message.delta', ...base, delta: '好的，我不執行該指令。' },
        { type: 'run.completed', ...base, output: '好的，我不執行該指令。' },
      ])
    } else {
      this.schedule([
        { type: 'tool.started', ...base, name: 'terminal', args: { cmd: 'rm -rf ./tmp/cache' } },
        { type: 'tool.completed', ...base, name: 'terminal', result: 'ok' },
        { type: 'message.delta', ...base, delta: '已清除暫存。' },
        { type: 'run.completed', ...base, output: '已清除暫存。' },
      ])
    }
  }
}
