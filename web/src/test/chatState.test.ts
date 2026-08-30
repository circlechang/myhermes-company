import { addUserMessage, applyEvent, emptyChat, fromMessages } from '../ws/chatState'

const base = { session_id: 's1', run_id: 'r1' }

describe('chatState reducer', () => {
  it('累積 message.delta 成一則串流訊息，run.completed 後結束串流', () => {
    let s = addUserMessage(emptyChat(), 'hi')
    s = applyEvent(s, { type: 'run.started', ...base })
    s = applyEvent(s, { type: 'message.delta', ...base, delta: '你' })
    s = applyEvent(s, { type: 'message.delta', ...base, delta: '好' })
    expect(s.items).toHaveLength(2)
    expect(s.items[1]).toMatchObject({ kind: 'text', role: 'assistant', content: '你好', streaming: true })
    s = applyEvent(s, { type: 'run.completed', ...base, output: '你好', usage: { input_tokens: 1 } })
    expect(s.running).toBe(false)
    expect(s.items[1]).toMatchObject({ content: '你好', streaming: false })
    expect(s.usage).toEqual({ input_tokens: 1 })
  })

  it('工具呼叫 started/completed 配對成一張卡', () => {
    let s = applyEvent(emptyChat(), { type: 'tool.started', ...base, name: 'web_search', args: { q: 'x' } })
    s = applyEvent(s, { type: 'tool.completed', ...base, name: 'web_search', result: { hits: 1 } })
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ kind: 'tool', name: 'web_search', status: 'done', result: { hits: 1 } })
  })

  it('工具呼叫會切斷正在串流的訊息，後續 delta 開新訊息', () => {
    let s = applyEvent(emptyChat(), { type: 'message.delta', ...base, delta: 'A' })
    s = applyEvent(s, { type: 'tool.started', ...base, name: 't' })
    s = applyEvent(s, { type: 'message.delta', ...base, delta: 'B' })
    expect(s.items.map((i) => i.kind)).toEqual(['text', 'tool', 'text'])
  })

  it('run.completed 只有 output 沒 delta 時補一則訊息', () => {
    const s = applyEvent(emptyChat(), { type: 'run.completed', ...base, output: 'done' })
    expect(s.items[0]).toMatchObject({ kind: 'text', content: 'done' })
  })

  it('run.failed 產生錯誤提示並停止 running', () => {
    const s = applyEvent(addUserMessage(emptyChat(), 'x'), { type: 'run.failed', ...base, error: 'boom' })
    expect(s.running).toBe(false)
    expect(s.items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'boom' })
  })

  it('背景委派 subagent.start/complete 配對成一張卡，complete 帶摘要與 token', () => {
    let s = applyEvent(emptyChat(), { type: 'message.delta', ...base, delta: '我去查' })
    s = applyEvent(s, { type: 'subagent.start', ...base, subagent_id: 'sa_1', goal: '查資料', task_index: 0, task_count: 2, model: 'gpt-x' })
    expect(s.items.map((i) => i.kind)).toEqual(['text', 'subagent'])
    expect(s.items[1]).toMatchObject({ kind: 'subagent', status: 'running', goal: '查資料', task_count: 2 })
    s = applyEvent(s, { type: 'subagent.complete', ...base, subagent_id: 'sa_1', status: 'completed', summary: '找到 3 筆', output_tokens: 5, duration_seconds: 1.5 })
    expect(s.items).toHaveLength(2)
    expect(s.items[1]).toMatchObject({ kind: 'subagent', status: 'completed', summary: '找到 3 筆', output_tokens: 5, duration_seconds: 1.5 })
    // 真機 0.20.5 只送 start 不送 complete：run 結束時把執行中的委派卡收成 completed（失敗時 failed），不會永遠轉圈
    let s2 = applyEvent(emptyChat(), { type: 'subagent.start', ...base, subagent_id: 'sa_9', goal: 'x' })
    s2 = applyEvent(s2, { type: 'run.completed', ...base, output: '2' })
    expect(s2.items[0]).toMatchObject({ kind: 'subagent', status: 'completed' })
    let s3 = applyEvent(emptyChat(), { type: 'subagent.start', ...base, subagent_id: 'sa_9', goal: 'x' })
    s3 = applyEvent(s3, { type: 'run.failed', ...base, error: 'boom' })
    expect(s3.items[0]).toMatchObject({ kind: 'subagent', status: 'failed' })
    // 沒 start 只有 complete（例如重連後）也要有卡
    s = applyEvent(s, { type: 'subagent.complete', ...base, subagent_id: 'sa_2', goal: '另一件', status: 'failed' })
    expect(s.items[2]).toMatchObject({ kind: 'subagent', status: 'failed', goal: '另一件' })
    // 歷史：tool_name=subagent 的訊息轉回委派卡
    const h = fromMessages([{ id: 'm1', session_id: 's', role: 'tool', content: '', tool_name: 'subagent', tool_args: { goal: '查資料', subagent_id: 'sa_1' }, tool_result: { status: 'completed', summary: '找到 3 筆' }, created_at: '' } as never])
    expect(h.items[0]).toMatchObject({ kind: 'subagent', goal: '查資料', summary: '找到 3 筆', status: 'completed' })
  })

  it('fromMessages 把歷史 tool 訊息轉成已完成工具卡', () => {
    const s = fromMessages([
      { id: '1', role: 'user', content: 'q', created_at: '' },
      { id: '2', role: 'tool', content: '', tool_name: 'fs', tool_args: {}, tool_result: 'ok', created_at: '' },
    ])
    expect(s.items[1]).toMatchObject({ kind: 'tool', name: 'fs', status: 'done' })
  })
})
