import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../App'
import { renderApp, setupMocks } from '../../test/utils'
import { state } from '../../mock/fetch'
import { COLUMNS, columnOf, resolveDrop, type Card } from './api'

const mk = (status: Card['status']): Card => ({ id: 'x', title: 'x', status, priority_label: 'medium', tags: [], diagnostics: [] })

describe('看板（modules/kanban）', () => {
  beforeEach(() => setupMocks({ loggedIn: true }))

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

  it('板面：診斷橫幅、profile 篩選、建卡帶標籤', async () => {
    renderApp(<App />, { route: '/kanban' })
    const user = userEvent.setup()
    expect(await screen.findByTestId('diagnostics-banner')).toHaveTextContent('1 張卡片需要處理')
    expect(within(screen.getByTestId('col-running')).getByText('競品價格表')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('依 profile 篩選'), 'editor')
    await waitFor(() => expect(screen.queryByText('競品價格表')).not.toBeInTheDocument())
    expect(await screen.findByText('寫 LINE 週報文案')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('依 profile 篩選'), '')

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
})
