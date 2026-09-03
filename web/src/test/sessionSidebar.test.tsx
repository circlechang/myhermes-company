import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ChatSession } from '../api/sessions'
import { SessionSidebar, subtitleOf } from '../components/chat/SessionSidebar'

const base = (over: Partial<ChatSession>): ChatSession => ({
  id: 'x', agent_id: 'a1', title: '幫我整理本週熱點', created_at: '2026-09-01T01:00:00Z', updated_at: '2026-09-01T01:00:00Z',
  source: 'workbench', archived: false, category_id: null, model: '', provider: '', running: false, run_status: 'completed',
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, context_tokens: 0 }, ...over,
})

const noop = () => {}
function renderSidebar(sessions: ChatSession[]) {
  return render(
    <SessionSidebar sessions={sessions} categories={[]} onSelect={noop} onNew={noop} onRename={noop} onDelete={noop} onArchive={noop}
      onAssignCategory={noop} showArchived={false} onToggleArchived={noop} onManageCategories={noop} onOpenSearch={noop} />,
  )
}

describe('側欄：一句話標題＋一行結果', () => {
  it('有結果就顯示結果（✓），沒結果才退回開場白', () => {
    renderSidebar([
      base({ id: 's1', title: '幫我整理本週熱點', result: '本週三個熱點', result_kind: 'ok', preview: '幫我整理本週熱點' }),
      base({ id: 's2', title: '還沒回', result: '', result_kind: '', preview: '只有開場白' }),
    ])
    const rows = screen.getAllByTestId('session-row')
    const ok = within(rows[0]).getByTestId('session-preview')
    expect(ok).toHaveAttribute('data-result-kind', 'ok')
    expect(ok).toHaveTextContent('✓')
    expect(ok).toHaveTextContent('本週三個熱點')
    const pv = within(rows[1]).getByTestId('session-preview')
    expect(pv).toHaveAttribute('data-result-kind', 'preview')
    expect(pv).toHaveTextContent('只有開場白')
  })

  it('失敗顯示 ⚠ 紅字；文件模式顯示 📄；進行中顯示回覆中', () => {
    renderSidebar([
      base({ id: 'f', title: '會失敗', run_status: 'failed', result: '失敗：gateway unreachable', result_kind: 'failed' }),
      base({ id: 'd', title: '規格書', doc_id: 'doc1', result: '文件已更新到 v3', result_kind: 'doc' }),
      base({ id: 'r', title: '跑著', running: true, run_status: 'running', result: '上一輪的結果', result_kind: 'ok' }),
    ])
    const byTitle = (t: string) => screen.getAllByTestId('session-row').find((r) => r.textContent?.includes(t))!
    const failed = within(byTitle('會失敗')).getByTestId('session-preview')
    expect(failed).toHaveAttribute('data-result-kind', 'failed')
    expect(failed).toHaveTextContent('⚠')
    expect(failed).toHaveTextContent('失敗：gateway unreachable')
    expect(failed.className).toContain('text-rose-600')
    const doc = within(byTitle('規格書')).getByTestId('session-preview')
    expect(doc).toHaveAttribute('data-result-kind', 'doc')
    expect(doc).toHaveTextContent('📄')
    const running = within(byTitle('跑著')).getByTestId('session-preview')
    expect(running).toHaveAttribute('data-result-kind', 'running')
    expect(running).toHaveTextContent('回覆中')
    expect(running).not.toHaveTextContent('上一輪的結果')
  })

  it('subtitleOf：後端沒給 result_kind 時用 run_status 推', () => {
    expect(subtitleOf(base({ run_status: 'failed', result: '失敗' }))).toEqual({ kind: 'failed', text: '失敗' })
    expect(subtitleOf(base({ result: '好的' }))).toEqual({ kind: 'ok', text: '好的' })
    expect(subtitleOf(base({}))).toBeNull()
  })
})

describe('狀態一眼看得出來', () => {
  it('標題列有「進行中 N」籤，點了只看進行中；每列有 data-status 與對應記號', async () => {
    const user = (await import('@testing-library/user-event')).default.setup()
    renderSidebar([
      base({ id: 'r', title: '跑著', running: true, run_status: 'running' }),
      base({ id: 'd', title: '做完了', result: '結果', result_kind: 'ok' }),
      base({ id: 'f', title: '壞了', run_status: 'failed', result: '失敗：逾時', result_kind: 'failed' }),
    ])
    const chip = screen.getByTestId('running-count')
    expect(chip).toHaveTextContent('進行中 1')
    const rows = () => screen.getAllByTestId('session-row')
    expect(rows().map((r) => r.getAttribute('data-status'))).toEqual(['running', 'done', 'failed'])
    expect(within(rows()[0]).getByTestId('running-spinner')).toBeInTheDocument()
    expect(within(rows()[1]).getByTestId('status-done')).toHaveTextContent('✓')
    expect(within(rows()[2]).getByTestId('status-failed')).toHaveTextContent('⚠')
    await user.click(chip)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveAttribute('data-status', 'running')
    await user.click(chip)
    expect(rows()).toHaveLength(3)
  })
})
