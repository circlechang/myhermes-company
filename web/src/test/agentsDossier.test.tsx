import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { setEngineerMode } from '../prefs/engineerMode'
import { renderApp, setupMocks } from './utils'

describe('AI 員工：人事檔案', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    setEngineerMode(false)
  })

  it('選到員工預設看人事檔案：四塊數字＋最近做了什麼', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByText('小編'))
    const chat = await screen.findByTestId('dossier-stat-chat')
    expect(chat).toHaveTextContent('5 場')
    expect(chat).toHaveTextContent('42 則訊息')
    expect(screen.getByTestId('dossier-stat-workflow')).toHaveTextContent('12 站')
    expect(screen.getByTestId('dossier-stat-workflow')).toHaveTextContent('2 失敗')
    expect(screen.getByTestId('dossier-stat-usage')).toHaveTextContent('US$1.87')
    expect(screen.getByTestId('dossier-stat-usage')).toHaveTextContent('123k tokens')
    expect(screen.getByTestId('dossier-stat-approvals')).toHaveTextContent('2 次')
    expect(screen.getByTestId('dossier-stat-approvals')).toHaveTextContent('6 次請求中')
    const recent = screen.getByTestId('dossier-recent')
    const links = within(recent).getAllByRole('link')
    expect(links).toHaveLength(4)
    expect(links[0].getAttribute('href')).toBe('/workflows/runs/wr1')
    expect(links[1].getAttribute('href')).toBe('/workbench?session=s1')
    expect(screen.getByTestId('dossier-docs')).toHaveTextContent('3 版文件')
    // 老闆模式：不露 profile 名／模型 id，也沒有 SOUL 編輯器
    expect(screen.queryByTestId('dossier-system')).not.toBeInTheDocument()
    expect(screen.queryByText('claude-sonnet-4')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('SOUL.md')).not.toBeInTheDocument()
  })

  it('沒做過事的員工顯示空狀態並指向工作臺', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByText('研究員'))
    const empty = await screen.findByTestId('dossier-empty')
    expect(empty).toHaveTextContent('還沒做過事')
    expect(within(empty).getByRole('link').getAttribute('href')).toBe('/workbench')
  })

  it('切到「人設」分頁才看到 SOUL 編輯器', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByText('小編'))
    await screen.findByTestId('dossier-stat-chat')
    await user.click(screen.getByTestId('agent-tab-soul'))
    const ta = (await screen.findByLabelText('SOUL.md')) as HTMLTextAreaElement
    expect(ta).toBeInTheDocument()
    expect(screen.queryByTestId('dossier-stat-chat')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('agent-tab-dossier'))
    expect(await screen.findByTestId('dossier-stat-chat')).toBeInTheDocument()
  })

  it('工程師模式：檔案底部露出 profile 名與模型 id，清單副標帶模型', async () => {
    setEngineerMode(true)
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByText('小編'))
    const sys = await screen.findByTestId('dossier-system')
    expect(sys).toHaveTextContent('editor')
    expect(sys).toHaveTextContent('claude-sonnet-4')
    expect(within(screen.getByTestId('agents-list')).getByText('市場研究 · gpt-5')).toBeInTheDocument()
  })
})
