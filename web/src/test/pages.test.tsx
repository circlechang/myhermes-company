import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { mockHermesStatus } from '../mock/data'
import { renderApp, setupMocks } from './utils'
import { setEngineerMode } from '../prefs/engineerMode'

describe('其他頁面（mock）', () => {
  beforeEach(() => setupMocks({ loggedIn: true }))

  it('AI 員工：編輯並儲存 SOUL.md', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByText('研究員'))
    await user.click(await screen.findByTestId('agent-tab-soul'))  // 預設分頁是人事檔案
    const ta = (await screen.findByLabelText('SOUL.md')) as HTMLTextAreaElement
    await waitFor(() => expect(ta.value).toContain('你先找證據'))
    await user.type(ta, '\n- 新規則')
    await user.click(screen.getByRole('button', { name: '儲存 SOUL.md' }))
    expect(await screen.findByText('已儲存')).toBeInTheDocument()
    // 每個 AI 員工的 SOUL 卡都有「版本歷史」連結，帶 profile 進 soul_history 頁
    const link = screen.getByTestId('soul-history-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toMatch(/^\/soul-history\?profile=/)
  })

  it('看板：六欄與搬移卡片', async () => {
    renderApp(<App />, { route: '/kanban' })
    const user = userEvent.setup()
    const todo = await screen.findByTestId('col-todo')
    expect(await within(todo).findByText('寫 LINE 週報文案')).toBeInTheDocument()
    for (const c of ['todo', 'ready', 'running', 'review', 'blocked', 'done']) expect(screen.getByTestId(`col-${c}`)).toBeInTheDocument()
    const card = within(todo).getByTestId('card-t2')
    await user.selectOptions(within(card).getByLabelText('移到'), 'done')
    expect(await within(screen.getByTestId('col-done')).findByText('寫 LINE 週報文案')).toBeInTheDocument()
  })

  it('流程：清單一條一張卡，選範本建立、新流程沒跑過就落在「怎麼跑」、步驟預設收起', async () => {
    renderApp(<App />, { route: '/workflows' })
    const user = userEvent.setup()
    expect(await screen.findByText('每日熱點內容產線')).toBeInTheDocument()
    // 「等你確認」不再是這頁的按鈕
    expect(screen.queryByRole('link', { name: /等你確認|等我看/ })).toBeNull()
    await user.click(await screen.findByRole('button', { name: /選範本/ }))
    await user.click(await screen.findByTestId('template-content'))
    await user.type(screen.getByLabelText('這條流程叫什麼'), '測試流程')
    await user.click(screen.getByTestId('template-create'))
    const nameInput = (await screen.findByLabelText('名稱')) as HTMLInputElement
    expect(nameInput.value).toBe('測試流程')
    // 沒跑過 → 怎麼跑；三步都收成一行，中間那步是「你」
    expect(await screen.findByTestId('stations-view')).toBeInTheDocument()
    expect(screen.getByTestId('station-s1')).toHaveAttribute('data-expanded', '0')
    expect(screen.getByTestId('station-s2-summary')).toHaveTextContent('你')
    await user.click(screen.getByTestId('station-s1-row'))
    expect(screen.getByTestId('station-s1-title')).toHaveValue('找題材')
  })

  it('設定頁：工程師模式開才看得到 Hermes 狀態', async () => {
    setEngineerMode(false)
    renderApp(<App />, { route: '/settings' })
    expect(await screen.findByTestId('engineer-mode-toggle')).not.toBeChecked()
    expect(screen.queryByTestId('settings-hermes-status')).not.toBeInTheDocument()
    await userEvent.setup().click(screen.getByTestId('engineer-mode-toggle'))
    expect(await screen.findByTestId('settings-hermes-status')).toBeInTheDocument()
    expect(await screen.findByText('0.20.5')).toBeInTheDocument()
    expect(screen.getByText('researcher')).toBeInTheDocument()
    expect(screen.getByText('正常')).toBeInTheDocument()
  })

  it('設定頁：key 被拒時顯示「API key 錯誤」橫幅，工程師模式關著也看得到', async () => {
    setEngineerMode(false)
    mockHermesStatus.gateway_ok = false
    mockHermesStatus.auth_error = true
    try {
      renderApp(<App />, { route: '/settings' })
      expect(await screen.findByText('API key 錯誤')).toBeInTheDocument()
      expect(screen.getByTestId('gateway-auth-error')).toHaveTextContent('gateway_auth_failed')
      expect(screen.queryByText('無法連線')).not.toBeInTheDocument()
    } finally {
      mockHermesStatus.gateway_ok = true
      mockHermesStatus.auth_error = false
    }
  })
})
