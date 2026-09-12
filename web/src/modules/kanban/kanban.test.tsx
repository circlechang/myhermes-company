import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../App'
import { renderApp, setupMocks } from '../../test/utils'
import { state } from '../../mock/fetch'
import { COLUMNS, columnOf, resolveDrop, type Card } from './api'
import { KanbanBoard } from './Board'
import { setEngineerMode } from '../../prefs/engineerMode'
import { bossCopyViolations } from '../../test/bossCopy'

const mk = (status: Card['status']): Card => ({ id: 'x', title: 'x', status, priority_label: 'medium', tags: [], diagnostics: [] })

describe('看板（modules/kanban）', () => {
  beforeEach(() => { setupMocks({ loggedIn: true }); setEngineerMode(false) })

  it('欄位對應與拖拉落點（純函式）', () => {
    expect(COLUMNS).toEqual(['todo', 'ready', 'running', 'review', 'blocked', 'done'])
    expect(columnOf('triage')).toBe('todo')
    expect(columnOf('scheduled')).toBe('blocked')
    expect(columnOf('archived')).toBeNull()
    // 跨欄拖拉 → 目標狀態；同欄 → null；拖到 running → null（dispatcher 決定）；沒有 over → null
    expect(resolveDrop(mk('todo'), 'col-done')).toBe('done')
    expect(resolveDrop(mk('triage'), 'col-todo')).toBeNull()
    expect(resolveDrop(mk('todo'), 'col-running')).toBeNull()
    expect(resolveDrop(mk('todo'), null)).toBeNull()
    expect(resolveDrop(mk('todo'), 't9')).toBeNull()
    expect(resolveDrop(undefined, 'col-done')).toBeNull()
  })

  it('板面：診斷橫幅、員工篩選、建卡帶標籤', async () => {
    renderApp(<App />, { route: '/kanban' })
    const user = userEvent.setup()
    expect(await screen.findByTestId('diagnostics-banner')).toHaveTextContent('1 張卡片需要處理')
    expect(within(screen.getByTestId('col-running')).getByText('競品價格表')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('依員工篩選'), 'editor')
    await waitFor(() => expect(screen.queryByText('競品價格表')).not.toBeInTheDocument())
    expect(await screen.findByText('寫 LINE 週報文案')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('依員工篩選'), '')

    await user.click(screen.getByRole('button', { name: /新增卡片/ }))
    await user.type(screen.getByLabelText('標題'), '測試卡')
    await user.type(screen.getByLabelText('標籤'), '急件, demo')
    await user.click(screen.getByRole('button', { name: '建立' }))
    const todo = screen.getByTestId('col-todo')
    expect(await within(todo).findByText('測試卡')).toBeInTheDocument()
    expect(within(todo).getByText('#急件')).toBeInTheDocument()
    expect(state.tasks.at(-1)?.title).toBe('測試卡')
  })

  it('拖拉手把存在；抽屜：留言、指派、派工、封存', async () => {
    renderApp(<App />, { route: '/kanban' })
    const user = userEvent.setup()
    const todo = await screen.findByTestId('col-todo')
    expect(await within(todo).findByLabelText('拖拉 寫 LINE 週報文案')).toBeInTheDocument()
    await user.click(within(todo).getByRole('button', { name: '寫 LINE 週報文案' }))
    const drawer = await screen.findByTestId('card-drawer')
    expect(await within(drawer).findByText('第一則留言')).toBeInTheDocument()
    await user.type(within(drawer).getByLabelText('留言'), '第二則')
    await user.click(within(drawer).getByRole('button', { name: '送出' }))
    await user.selectOptions(within(drawer).getByLabelText('執行者'), 'researcher')
    await user.click(within(drawer).getByRole('button', { name: '派工' }))
    expect(await within(drawer).findByTestId('dispatch-result')).toHaveTextContent('"spawned": 1')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(within(drawer).getByRole('button', { name: '封存' }))
    await waitFor(() => expect(screen.queryByTestId('card-drawer')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.queryByText('寫 LINE 週報文案')).not.toBeInTheDocument())
  })

  it('老闆模式：欄名與狀態全中文、指派人顯示員工名、沒有系統詞；工程師模式副標題才提 hermes kanban', async () => {
    renderApp(<KanbanBoard />)
    await screen.findByTestId('col-todo')
    for (const [c, label] of [['todo', '待處理'], ['ready', '就緒'], ['running', '執行中'], ['review', '審核'], ['blocked', '卡住'], ['done', '完成']] as const) {
      expect(within(screen.getByTestId(`col-${c}`)).getByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText('派給員工的任務板；拖卡片換狀態')).toBeInTheDocument()
    const statuses = (await screen.findAllByTestId('card-status')).map((el) => el.textContent)
    expect(statuses.length).toBeGreaterThan(0)
    for (const st of statuses) expect(['待分類', '待處理', '就緒', '執行中', '審核', '卡住', '排程', '完成', '封存']).toContain(st)
    await waitFor(() => expect(screen.getAllByTestId('card-assignee').some((el) => ['研究員', '小編', '客服'].includes(el.textContent ?? ''))).toBe(true))
    const assignees = screen.getAllByTestId('card-assignee').map((el) => el.textContent)
    expect(assignees.some((a) => a === '研究員' || a === '小編' || a === '客服')).toBe(true)
    expect(assignees.some((a) => a?.startsWith('@'))).toBe(false)
    const filter = screen.getByLabelText('依員工篩選')
    expect(await within(filter).findByRole('option', { name: '研究員' })).toBeInTheDocument()
    expect(bossCopyViolations()).toEqual([])
    setEngineerMode(true)
    expect(await screen.findByText(/與 hermes kanban 同一份資料/)).toBeInTheDocument()
  })
})
