import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { MockWebSocket } from '../mock/MockWebSocket'
import { renderApp, setupMocks } from './utils'
import { setEngineerMode } from '../prefs/engineerMode'

async function openSession(user: ReturnType<typeof userEvent.setup>, title = '本週熱點選題') {
  await user.click(await screen.findByText(title))
  const list = await screen.findByTestId('message-list')
  // 等歷史訊息載完（s1 有訊息；其他 session 為空，等空狀態文字）
  // 只在訊息區裡找：側欄的 session-preview 也會出現同一句，不能拿它當「載完」
  if (title === '本週熱點選題') await within(list).findByText(/^本週三個熱點/)
  else await screen.findByText(/開始跟/)
  await waitFor(() => expect(MockWebSocket.instances.at(-1)?.readyState).toBe(MockWebSocket.OPEN))
  return MockWebSocket.instances.at(-1)!
}

describe('工作臺聊天（假 WebSocket）', () => {
  beforeEach(() => setupMocks({ loggedIn: true, wsDelayMs: 0 }))

  it('載入歷史訊息並顯示工具卡', async () => {
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    await openSession(user)
    // 側欄 session-preview 也有這句，只認訊息區的
    expect(within(screen.getByTestId('message-list')).getByText(/^本週三個熱點/)).toBeInTheDocument()
    const card = screen.getByTestId('tool-card')
    expect(card).toHaveTextContent('web_search')
    await user.click(within(card).getByRole('button'))
    expect(card).toHaveTextContent('"q": "本週 熱點"')
  })

  it('送出訊息後逐段串流渲染，並送出正確的 run 事件', async () => {
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    const ws = await openSession(user)
    const ta = screen.getByPlaceholderText(/輸入訊息/)
    await user.type(ta, '哈囉{Enter}')

    expect(ws.sent[0]).toMatchObject({ type: 'run', session_id: 's1', input: '哈囉' })
    expect(await screen.findByText('哈囉')).toBeInTheDocument()
    // delta 逐段合併成一則 assistant 訊息
    expect(await screen.findByText(/收到「哈囉」。這是 mock 回覆/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('回覆中…')).not.toBeInTheDocument())
    // 工具卡兩張：歷史一張＋這次一張
    expect(screen.getAllByTestId('tool-card')).toHaveLength(2)
  })

  it('可用 emit 直接推事件，delta 累積在同一泡泡', async () => {
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    const ws = await openSession(user, 'LINE 貼文草稿')
    ws.emit({ type: 'run.started', session_id: 's2', run_id: 'rX' })
    ws.emit({ type: 'message.delta', session_id: 's2', run_id: 'rX', delta: '第一' })
    ws.emit({ type: 'message.delta', session_id: 's2', run_id: 'rX', delta: '段' })
    expect(await screen.findByText('第一段')).toBeInTheDocument()
    ws.emit({ type: 'run.failed', session_id: 's2', run_id: 'rX', error: 'oops' })
    expect(await screen.findByText(/執行失敗: oops/)).toBeInTheDocument()
  })

  it('審批卡：四個按鈕，按下後送 approval 事件並鎖定', async () => {
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    const ws = await openSession(user, 'LINE 貼文草稿')
    await user.type(screen.getByPlaceholderText(/輸入訊息/), '請刪除暫存{Enter}')
    const card = await screen.findByTestId('approval-card')
    expect(card).toHaveTextContent('rm -rf ./tmp/cache')
    const names = ['僅此一次', '本次對話', '永遠允許', '拒絕']
    for (const n of names) expect(within(card).getByRole('button', { name: n })).toBeEnabled()

    await user.click(within(card).getByRole('button', { name: '本次對話' }))
    expect(ws.sent.at(-1)).toMatchObject({ type: 'approval', decision: 'session', run_id: expect.stringMatching(/^run-/) })
    for (const n of names) expect(within(card).getByRole('button', { name: n })).toBeDisabled()
    expect(card).toHaveTextContent('已回覆：本次對話')
    expect(await screen.findByText('已清除暫存。')).toBeInTheDocument()
  })

  it('審批卡：拒絕', async () => {
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    const ws = await openSession(user, 'LINE 貼文草稿')
    await user.type(screen.getByPlaceholderText(/輸入訊息/), 'approve this{Enter}')
    const card = await screen.findByTestId('approval-card')
    await user.click(within(card).getByRole('button', { name: '拒絕' }))
    expect(ws.sent.at(-1)).toMatchObject({ type: 'approval', decision: 'deny' })
    expect(await screen.findByText('好的，我不執行該指令。')).toBeInTheDocument()
  })
})

describe('工作臺右欄：工程師模式', () => {
  beforeEach(() => setupMocks({ loggedIn: true, wsDelayMs: 0 }))

  it('預設藏 Session ID／Run ID／模型，開了工程師模式才出現', async () => {
    setEngineerMode(false)
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    await openSession(user)
    const info = screen.getByTestId('session-info')
    expect(within(info).getByText('這個對話')).toBeInTheDocument()
    expect(within(info).queryByText('Session ID')).not.toBeInTheDocument()
    expect(within(info).queryByText('Run ID')).not.toBeInTheDocument()
    expect(within(info).getByText('AI 員工')).toBeInTheDocument()
    act(() => setEngineerMode(true))
    expect(await within(info).findByText('Session ID')).toBeInTheDocument()
    expect(within(info).getByText('Run ID')).toBeInTheDocument()
    expect(within(info).getByText('Session 資訊')).toBeInTheDocument()
  })
})
