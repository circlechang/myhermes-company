// 把 WS 事件疊成畫面用的訊息串（純函式，方便測試）
import type { ApprovalDecision, Message, WsServerEvent } from '../api/types'
import type { Attachment, ChatMessage, SessionUsage } from '../api/sessions'

export interface ToolItem {
  kind: 'tool'
  id: string
  name: string
  args?: unknown
  result?: unknown
  status: 'running' | 'done'
}
export interface ApprovalItem {
  kind: 'approval'
  id: string
  run_id: string
  approval_id: string
  command: string
  context?: string
  decision?: ApprovalDecision
}
export interface TextItem {
  kind: 'text'
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  /** 後端落庫後的 message id（引用／編輯用）；串流中的暫時 id 與此不同 */
  message_id?: string
  attachments?: Attachment[]
  reply_to?: string | null
  reasoning?: string | null
  usage?: Record<string, unknown> | null
}
export interface NoticeItem {
  kind: 'notice'
  id: string
  level: 'error' | 'info'
  text: string
}
export interface ReasoningItem {
  kind: 'reasoning'
  id: string
  text: string
}
/** 背景委派（delegate_task 子代理）的生命週期卡：gateway 送 subagent.start / subagent.complete */
export interface SubagentItem {
  kind: 'subagent'
  id: string
  subagent_id: string
  goal: string
  status: 'running' | 'completed' | 'failed' | 'timeout' | string
  task_index?: number
  task_count?: number
  model?: string
  summary?: string
  output_tail?: string
  duration_seconds?: number
  input_tokens?: number
  output_tokens?: number
  tool_count?: number
  cost_usd?: number
}
export type ChatItem = ToolItem | ApprovalItem | TextItem | NoticeItem | ReasoningItem | SubagentItem

export interface ChatState {
  items: ChatItem[]
  runId: string | null
  running: boolean
  usage?: Record<string, unknown>
  sessionUsage?: SessionUsage
  /** 上下文壓縮進度（gateway 若有送 compression/compaction 事件） */
  compression?: { status: string; detail?: string }
}

export const emptyChat = (): ChatState => ({ items: [], runId: null, running: false })

let seq = 0
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`

export function fromMessages(msgs: (Message | ChatMessage)[]): ChatState {
  const items: ChatItem[] = []
  for (const m of msgs) {
    const cm = m as ChatMessage
    if (m.role === 'tool') {
      if (m.tool_name === 'subagent') {
        // 歷史裡的背景委派結果（chat_ws 把 subagent.complete 存成 tool 訊息）
        const a = (m.tool_args ?? {}) as { goal?: string; subagent_id?: string; model?: string }
        const r = (m.tool_result ?? {}) as Partial<SubagentItem>
        items.push({ kind: 'subagent', id: m.id, subagent_id: a.subagent_id ?? '', goal: a.goal ?? '', model: a.model, status: r.status ?? 'completed',
          summary: r.summary, output_tail: r.output_tail, duration_seconds: r.duration_seconds, input_tokens: r.input_tokens, output_tokens: r.output_tokens, tool_count: r.tool_count, cost_usd: r.cost_usd })
        continue
      }
      items.push({ kind: 'tool', id: m.id, name: m.tool_name ?? 'tool', args: m.tool_args, result: m.tool_result, status: 'done' })
      continue
    }
    if (m.role === 'assistant' && cm.reasoning) items.push({ kind: 'reasoning', id: `${m.id}-r`, text: cm.reasoning })
    items.push({
      kind: 'text', id: m.id, role: m.role, content: m.content, message_id: m.id,
      attachments: cm.attachments?.length ? cm.attachments : undefined, reply_to: cm.reply_to ?? undefined,
      reasoning: cm.reasoning ?? undefined, usage: cm.usage ?? undefined,
    })
  }
  return { items, runId: null, running: false }
}

export function addUserMessage(s: ChatState, content: string, extra: { attachments?: Attachment[]; reply_to?: string | null } = {}): ChatState {
  const item: TextItem = { kind: 'text', id: uid('u'), role: 'user', content }
  if (extra.attachments?.length) item.attachments = extra.attachments
  if (extra.reply_to) item.reply_to = extra.reply_to
  return { ...s, items: [...s.items, item], running: true }
}

export function markApprovalDecided(s: ChatState, approvalId: string, decision: ApprovalDecision): ChatState {
  return {
    ...s,
    items: s.items.map((it) => (it.kind === 'approval' && it.approval_id === approvalId ? { ...it, decision } : it)),
  }
}

/** 找出「最後一則使用者訊息」的 index（重新生成／編輯用） */
export function lastUserIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'text' && it.role === 'user') return i
  }
  return -1
}

export function removeMessages(s: ChatState, ids: string[]): ChatState {
  const set = new Set(ids)
  return { ...s, items: s.items.filter((it) => !(set.has(it.id) || (it.kind === 'text' && it.message_id && set.has(it.message_id)) || (it.kind === 'reasoning' && set.has(it.id.replace(/-r$/, '')))) ) }
}

/** 本地先把最後一輪拿掉（伺服器 messages.removed 到時再對齊一次） */
export function dropLastTurn(s: ChatState, includeUser: boolean): ChatState {
  const i = lastUserIndex(s.items)
  if (i < 0) return s
  return { ...s, items: s.items.slice(0, includeUser ? i : i + 1), running: includeUser ? s.running : true }
}

export function applyEvent(s: ChatState, ev: WsServerEvent): ChatState {
  switch (ev.type) {
    case 'run.started': {
      const e = ev as { run_id?: string; message_id?: string; attachments?: Attachment[]; reply_to?: string | null }
      let items = s.items
      if (e.message_id) {
        // 把後端 id 貼回最後一則使用者訊息（樂觀新增時還沒有 id）
        const i = lastUserIndex(items)
        if (i >= 0) {
          const it = items[i] as TextItem
          items = [...items]
          items[i] = { ...it, message_id: e.message_id, attachments: it.attachments ?? (e.attachments?.length ? e.attachments : undefined), reply_to: it.reply_to ?? e.reply_to ?? undefined }
        }
      }
      return { ...s, items, runId: e.run_id ?? s.runId, running: true }
    }
    case 'message.delta': {
      const delta = String((ev as { delta?: string }).delta ?? '')
      const last = s.items[s.items.length - 1]
      if (last && last.kind === 'text' && last.role === 'assistant' && last.streaming) {
        const items = s.items.slice(0, -1)
        items.push({ ...last, content: last.content + delta })
        return { ...s, items }
      }
      return { ...s, items: [...s.items, { kind: 'text', id: uid('a'), role: 'assistant', content: delta, streaming: true }] }
    }
    case 'reasoning.available': {
      const e = ev as { reasoning?: string; text?: string; content?: string }
      const text = String(e.reasoning ?? e.text ?? e.content ?? '')
      if (!text) return s
      const items = finishStreaming(s.items)
      const last = items[items.length - 1]
      if (last && last.kind === 'reasoning') {
        items[items.length - 1] = { ...last, text: last.text + text }
        return { ...s, items }
      }
      items.push({ kind: 'reasoning', id: uid('r'), text })
      return { ...s, items }
    }
    case 'tool.started': {
      const e = ev as { name: string; args?: unknown; call_id?: string }
      const items = finishStreaming(s.items)
      items.push({ kind: 'tool', id: e.call_id ?? uid('t'), name: e.name, args: e.args, status: 'running' })
      return { ...s, items }
    }
    case 'tool.completed': {
      const e = ev as { name: string; result?: unknown; call_id?: string }
      const items = [...s.items]
      // 從後往前找同名且執行中的工具卡
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'tool' && it.status === 'running' && (e.call_id ? it.id === e.call_id : it.name === e.name)) {
          items[i] = { ...it, result: e.result, status: 'done' }
          return { ...s, items }
        }
      }
      items.push({ kind: 'tool', id: e.call_id ?? uid('t'), name: e.name, result: e.result, status: 'done' })
      return { ...s, items }
    }
    case 'subagent.start': {
      const e = ev as { subagent_id?: string; goal?: string; task_index?: number; task_count?: number; model?: string }
      const items = finishStreaming(s.items)
      items.push({ kind: 'subagent', id: e.subagent_id ? `sa-${e.subagent_id}` : uid('sa'), subagent_id: e.subagent_id ?? '', goal: e.goal ?? '',
        status: 'running', task_index: e.task_index, task_count: e.task_count, model: e.model })
      return { ...s, items }
    }
    case 'subagent.complete': {
      const e = ev as { subagent_id?: string; goal?: string; status?: string; summary?: string; output_tail?: string; duration_seconds?: number; input_tokens?: number; output_tokens?: number; tool_count?: number; cost_usd?: number }
      const patch = { status: e.status ?? 'completed', summary: e.summary, output_tail: e.output_tail, duration_seconds: e.duration_seconds,
        input_tokens: e.input_tokens, output_tokens: e.output_tokens, tool_count: e.tool_count, cost_usd: e.cost_usd }
      const items = [...s.items]
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'subagent' && it.status === 'running' && (e.subagent_id ? it.subagent_id === e.subagent_id : it.goal === (e.goal ?? it.goal))) {
          items[i] = { ...it, ...patch }
          return { ...s, items }
        }
      }
      items.push({ kind: 'subagent', id: uid('sa'), subagent_id: e.subagent_id ?? '', goal: e.goal ?? '', ...patch })
      return { ...s, items }
    }
    case 'approval.request': {
      const e = ev as { approval_id: string; command: string; context?: string | Record<string, unknown>; run_id?: string }
      const items = finishStreaming(s.items)
      const ctx = typeof e.context === 'string' ? e.context : e.context ? (e.context.reason ?? e.context.description ?? JSON.stringify(e.context)) : undefined
      items.push({ kind: 'approval', id: uid('ap'), run_id: e.run_id ?? s.runId ?? '', approval_id: e.approval_id, command: e.command, context: ctx as string | undefined })
      return { ...s, items }
    }
    case 'approval.responded': {
      const e = ev as { approval_id: string; decision: ApprovalDecision }
      return markApprovalDecided(s, e.approval_id, e.decision)
    }
    case 'messages.removed': {
      const e = ev as { ids?: string[] }
      return removeMessages(s, e.ids ?? [])
    }
    case 'run.completed': {
      const e = ev as { output?: string; usage?: Record<string, unknown>; session_usage?: SessionUsage; message_id?: string }
      let items = settleSubagents(finishStreaming(s.items), 'completed')
      // 若後端沒送 delta 只送 output，補一則
      const hasAssistant = items.some((it) => it.kind === 'text' && it.role === 'assistant')
      if (e.output && !hasAssistant) items = [...items, { kind: 'text', id: uid('a'), role: 'assistant', content: e.output }]
      // 把落庫 id / usage 貼到最後一則 assistant
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'text' && it.role === 'assistant') {
          items[i] = { ...it, message_id: e.message_id ?? it.message_id, usage: e.usage ?? it.usage, content: e.output && !it.content ? e.output : it.content }
          break
        }
      }
      return { ...s, items, running: false, usage: e.usage ?? s.usage, sessionUsage: e.session_usage ?? s.sessionUsage, compression: undefined }
    }
    case 'run.failed': {
      const e = ev as { error?: string }
      return { ...s, items: [...settleSubagents(finishStreaming(s.items), 'failed'), { kind: 'notice', id: uid('n'), level: 'error', text: String(e.error ?? 'failed') }], running: false }
    }
    case 'run.cancelled':
      return { ...s, items: [...settleSubagents(finishStreaming(s.items), 'cancelled'), { kind: 'notice', id: uid('n'), level: 'info', text: 'cancelled' }], running: false }
    default: {
      // gateway 若有壓縮／compaction 進度事件，顯示在輸入列上方
      if (/compress|compact/i.test(ev.type)) {
        const e = ev as { status?: string; message?: string; detail?: string }
        return { ...s, compression: { status: e.status ?? ev.type, detail: e.message ?? e.detail } }
      }
      return s
    }
  }
}

/** run 結束時把還在「執行中」的委派卡收掉：真機 gateway 0.20.5 只送 subagent.start，complete 可能不會到（見 parity/chat.md） */
function settleSubagents(items: ChatItem[], status: string): ChatItem[] {
  return items.map((it) => (it.kind === 'subagent' && it.status === 'running' ? { ...it, status } : it))
}

function finishStreaming(items: ChatItem[]): ChatItem[] {
  return items.map((it) => (it.kind === 'text' && it.streaming ? { ...it, streaming: false } : it))
}
