// /ws/coding 事件 → 畫面狀態（純函式，vitest 直接測）
import type { CodingMessage } from './api'

export interface DiffPayload {
  before: string
  after: string
  files: { status: string; path: string }[]
  is_git: boolean
}

export type CodingEvent =
  | { type: 'ready'; member_id: string }
  | { type: 'run.started'; session_id: string; run_id: string; command?: string }
  | { type: 'session.init'; session_id: string; run_id: string; external_session_id?: string; model?: string }
  | { type: 'message.delta'; session_id: string; run_id: string; delta: string }
  | { type: 'tool.started'; session_id: string; run_id: string; name: string; args?: unknown; call_id?: string }
  | { type: 'tool.completed'; session_id: string; run_id: string; name: string; result?: unknown; call_id?: string; error?: boolean }
  | { type: 'log'; session_id: string; run_id: string; text: string; stream?: string }
  | { type: 'run.completed'; session_id: string; run_id: string; output: string; usage?: Record<string, unknown>; diff?: DiffPayload; exit_code?: number | null; external_session_id?: string }
  | { type: 'run.failed'; session_id: string; run_id: string; error: string; output?: string; diff?: DiffPayload; exit_code?: number | null }
  | { type: 'run.cancelled'; session_id: string; run_id: string; output?: string; diff?: DiffPayload }
  | { type: 'stop.ack'; run_id: string }
  | { type: 'error'; code: string; message: string; session_id?: string }
  | { type: 'pong' }

export interface TextItem { kind: 'text'; id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean }
export interface ToolItem { kind: 'tool'; id: string; name: string; args?: unknown; result?: unknown; status: 'running' | 'done'; error?: boolean }
export interface LogItem { kind: 'log'; id: string; text: string; stream?: string }
export interface NoticeItem { kind: 'notice'; id: string; level: 'error' | 'info'; text: string }
export type Item = TextItem | ToolItem | LogItem | NoticeItem

export interface CodingState {
  items: Item[]
  runId: string | null
  running: boolean
  command?: string
  usage?: Record<string, unknown>
  diff?: DiffPayload
  externalSessionId?: string
}

export const emptyState = (): CodingState => ({ items: [], runId: null, running: false })

let seq = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`

export function fromMessages(msgs: CodingMessage[]): CodingState {
  const items: Item[] = msgs.map((m) =>
    m.role === 'tool'
      ? { kind: 'tool', id: m.id, name: m.tool_name ?? 'tool', args: m.tool_args, result: m.tool_result, status: 'done' }
      : { kind: 'text', id: m.id, role: m.role, content: m.content },
  )
  return { items, runId: null, running: false }
}

export function addUserMessage(s: CodingState, content: string): CodingState {
  return { ...s, items: [...s.items, { kind: 'text', id: uid('u'), role: 'user', content }], running: true, diff: undefined }
}

function finish(items: Item[]): Item[] {
  return items.map((it) => (it.kind === 'text' && it.streaming ? { ...it, streaming: false } : it))
}

export function applyEvent(s: CodingState, ev: CodingEvent): CodingState {
  switch (ev.type) {
    case 'run.started':
      return { ...s, runId: ev.run_id, running: true, command: ev.command }
    case 'session.init':
      return ev.external_session_id ? { ...s, externalSessionId: ev.external_session_id } : s
    case 'message.delta': {
      const last = s.items[s.items.length - 1]
      if (last && last.kind === 'text' && last.role === 'assistant' && last.streaming) {
        return { ...s, items: [...s.items.slice(0, -1), { ...last, content: last.content + ev.delta }] }
      }
      return { ...s, items: [...s.items, { kind: 'text', id: uid('a'), role: 'assistant', content: ev.delta, streaming: true }] }
    }
    case 'tool.started':
      return { ...s, items: [...finish(s.items), { kind: 'tool', id: ev.call_id ?? uid('t'), name: ev.name, args: ev.args, status: 'running' }] }
    case 'tool.completed': {
      const items = [...s.items]
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'tool' && it.status === 'running' && (ev.call_id ? it.id === ev.call_id : it.name === ev.name)) {
          items[i] = { ...it, result: ev.result, status: 'done', error: ev.error }
          return { ...s, items }
        }
      }
      items.push({ kind: 'tool', id: ev.call_id ?? uid('t'), name: ev.name, result: ev.result, status: 'done', error: ev.error })
      return { ...s, items }
    }
    case 'log':
      return { ...s, items: [...s.items, { kind: 'log', id: uid('l'), text: ev.text, stream: ev.stream }] }
    case 'run.completed': {
      let items = finish(s.items)
      const hasAssistant = items.some((it) => it.kind === 'text' && it.role === 'assistant')
      if (ev.output && !hasAssistant) items = [...items, { kind: 'text', id: uid('a'), role: 'assistant', content: ev.output }]
      return { ...s, items, running: false, usage: ev.usage ?? s.usage, diff: ev.diff, externalSessionId: ev.external_session_id || s.externalSessionId }
    }
    case 'run.failed':
      return { ...s, items: [...finish(s.items), { kind: 'notice', id: uid('n'), level: 'error', text: ev.error }], running: false, diff: ev.diff ?? s.diff }
    case 'run.cancelled':
      return { ...s, items: [...finish(s.items), { kind: 'notice', id: uid('n'), level: 'info', text: 'cancelled' }], running: false, diff: ev.diff ?? s.diff }
    case 'error':
      return { ...s, items: [...s.items, { kind: 'notice', id: uid('n'), level: 'error', text: ev.message }], running: ev.code === 'busy' ? s.running : false }
    default:
      return s
  }
}

// ---------------------------------------------------------------- diff 解析（並排視圖用）
export interface DiffFile { path: string; lines: { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string }[] }

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git')) {
      const m = /b\/(.+)$/.exec(raw)
      cur = { path: m?.[1] ?? raw.slice(11), lines: [] }
      files.push(cur)
      continue
    }
    if (!cur) continue
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file')) {
      cur.lines.push({ kind: 'meta', text: raw })
    } else if (raw.startsWith('@@')) cur.lines.push({ kind: 'meta', text: raw })
    else if (raw.startsWith('+')) cur.lines.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) cur.lines.push({ kind: 'del', text: raw.slice(1) })
    else if (raw.length) cur.lines.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  return files
}
