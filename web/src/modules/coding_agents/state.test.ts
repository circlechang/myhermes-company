import { addUserMessage, applyEvent, emptyState, fromMessages, parseUnifiedDiff, type CodingEvent } from './state'

const base = { session_id: 's1', run_id: 'r1' }

describe('coding state', () => {
  it('串流：delta 合併、工具卡開合、完成帶 diff', () => {
    let s = addUserMessage(emptyState(), 'do it')
    expect(s.running).toBe(true)
    s = applyEvent(s, { type: 'run.started', ...base, command: 'claude -p …' })
    s = applyEvent(s, { type: 'session.init', ...base, external_session_id: 'ext-1' })
    s = applyEvent(s, { type: 'tool.started', ...base, name: 'Bash', args: { command: 'ls' }, call_id: 'c1' })
    s = applyEvent(s, { type: 'log', ...base, text: 'warn', stream: 'stderr' })
    s = applyEvent(s, { type: 'tool.completed', ...base, name: 'Bash', result: 'a.txt', call_id: 'c1' })
    s = applyEvent(s, { type: 'message.delta', ...base, delta: 'hel' })
    s = applyEvent(s, { type: 'message.delta', ...base, delta: 'lo' })
    const diff = { before: '', after: 'diff --git a/x b/x\n+++ b/x\n@@ -0,0 +1 @@\n+hi\n', files: [{ status: '??', path: 'x' }], is_git: true }
    s = applyEvent(s, { type: 'run.completed', ...base, output: 'hello', usage: { output_tokens: 3 }, diff })
    expect(s.running).toBe(false)
    expect(s.externalSessionId).toBe('ext-1')
    expect(s.command).toContain('claude')
    const kinds = s.items.map((i) => i.kind)
    expect(kinds).toEqual(['text', 'tool', 'log', 'text'])
    const tool = s.items[1]
    expect(tool.kind === 'tool' && tool.status === 'done' && tool.result === 'a.txt').toBe(true)
    const last = s.items[3]
    expect(last.kind === 'text' && last.content === 'hello' && !last.streaming).toBe(true)
    expect(s.diff?.files).toHaveLength(1)
    expect(s.usage).toEqual({ output_tokens: 3 })
  })

  it('失敗與中止會加通知並停止；completed 沒 delta 時補 output', () => {
    let s = applyEvent(addUserMessage(emptyState(), 'x'), { type: 'run.failed', ...base, error: 'boom' } as CodingEvent)
    expect(s.running).toBe(false)
    expect(s.items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'boom' })
    s = applyEvent(addUserMessage(emptyState(), 'x'), { type: 'run.cancelled', ...base })
    expect(s.items.at(-1)).toMatchObject({ kind: 'notice', level: 'info' })
    s = applyEvent(addUserMessage(emptyState(), 'x'), { type: 'run.completed', ...base, output: 'final' })
    expect(s.items.at(-1)).toMatchObject({ kind: 'text', role: 'assistant', content: 'final' })
  })

  it('歷史訊息還原', () => {
    const s = fromMessages([
      { id: 'm1', role: 'user', content: 'q', created_at: '' },
      { id: 'm2', role: 'tool', content: '', tool_name: 'Write', tool_args: { a: 1 }, created_at: '' },
      { id: 'm3', role: 'assistant', content: 'a', created_at: '' },
    ])
    expect(s.items.map((i) => i.kind)).toEqual(['text', 'tool', 'text'])
  })

  it('unified diff 解析', () => {
    const files = parseUnifiedDiff('diff --git a/a.py b/a.py\nindex 1..2 100644\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n-old\n+new\n same\ndiff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+hi\n')
    expect(files.map((f) => f.path)).toEqual(['a.py', 'b.txt'])
    expect(files[0].lines.filter((l) => l.kind === 'add')).toHaveLength(1)
    expect(files[0].lines.filter((l) => l.kind === 'del')).toHaveLength(1)
    expect(files[0].lines.find((l) => l.kind === 'ctx')?.text).toBe('same')
    expect(files[1].lines.filter((l) => l.kind === 'add')[0].text).toBe('hi')
  })
})
