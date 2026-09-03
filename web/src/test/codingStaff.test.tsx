import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { renderApp, setupMocks } from './utils'
import { setEngineerMode } from '../prefs/engineerMode'

describe('AI 員工＝Coding Agent（前端）', () => {
  beforeEach(() => setupMocks({ loggedIn: true }))

  it('員工清單：Hermes 與 Claude Code 各有自己的徽章，coding 員工顯示工作目錄', async () => {
    renderApp(<App />, { route: '/agents' })
    await screen.findByText('工程師')
    const list = screen.getByTestId('agents-list')
    expect(within(list).getAllByTestId('runtime-badge-hermes')).toHaveLength(3)
    const coding = within(list).getByTestId('runtime-badge-claude-code')
    expect(coding).toHaveTextContent('Claude Code')
    expect(within(list).getByText('/Users/me/code/demo')).toBeInTheDocument()
  })

  it('選到 coding 員工：沒有 SOUL.md，改顯示 coding 設定與「開啟工作目錄」', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByText('工程師'))
    await user.click(await screen.findByTestId('agent-tab-soul'))  // 預設分頁是人事檔案；分頁狀態跨員工保留
    expect(await screen.findByTestId('coding-no-soul')).toBeInTheDocument()
    expect(screen.queryByLabelText('SOUL.md')).not.toBeInTheDocument()
    const panel = screen.getByTestId('coding-settings')
    expect(within(panel).getByText('/Users/me/code/demo')).toBeInTheDocument()
    expect(within(panel).getByText('acceptEdits', { exact: false })).toBeInTheDocument()
    const link = screen.getByTestId('open-workspace') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/files?path=extra%3Acode%2Fdemo')
    // Hermes 員工照樣有 SOUL.md（既有行為不退步）
    await user.click(screen.getByText('研究員'))
    expect(await screen.findByLabelText('SOUL.md')).toBeInTheDocument()
  })

  it('新增員工：runtime 選單標出未安裝的、選了就擋住建立並給安裝指令', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('new-agent'))
    const dialog = await screen.findByTestId('create-agent-dialog')
    const runtime = within(dialog).getByTestId('new-agent-runtime') as HTMLSelectElement
    await waitFor(() => expect(runtime.options).toHaveLength(4))
    expect([...runtime.options].map((o) => o.textContent)).toEqual([
      'Hermes', 'Claude Code', 'Codex CLI', 'Pi — 未安裝',
    ])
    // 預設 Hermes → 選 profile
    expect(within(dialog).getByTestId('new-agent-profile')).toBeInTheDocument()

    await user.type(within(dialog).getByTestId('new-agent-name'), 'pibot')
    await user.selectOptions(runtime, 'pi')
    expect(await within(dialog).findByTestId('runtime-not-installed')).toHaveTextContent('npm i -g @mariozechner/pi-coding-agent')
    expect(within(dialog).getByTestId('new-agent-submit')).toBeDisabled()
  })

  it('新增 Claude Code 員工：填工作目錄後建立，清單立刻多一位帶徽章的員工', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('new-agent'))
    const dialog = await screen.findByTestId('create-agent-dialog')
    await user.type(within(dialog).getByTestId('new-agent-name'), 'devbot')
    await waitFor(() => expect((within(dialog).getByTestId('new-agent-runtime') as HTMLSelectElement).options).toHaveLength(4))
    await user.selectOptions(within(dialog).getByTestId('new-agent-runtime'), 'claude-code')
    // 允許的根目錄可以一鍵帶入
    await user.click(within(within(dialog).getByTestId('workspace-roots')).getByText('/Users/me/code'))
    expect(within(dialog).getByTestId('new-agent-workspace')).toHaveValue('/Users/me/code')
    await user.click(within(dialog).getByTestId('new-agent-submit'))
    await waitFor(() => expect(screen.queryByTestId('create-agent-dialog')).not.toBeInTheDocument())
    const list = await screen.findByTestId('agents-list')
    expect(within(list).getByText('devbot')).toBeInTheDocument()
    expect(within(list).getAllByTestId('runtime-badge-claude-code')).toHaveLength(2)
  })

  it('新增 coding 員工：工作目錄不在允許清單內時，後端擋下並顯示原因', async () => {
    renderApp(<App />, { route: '/agents' })
    const user = userEvent.setup()
    await user.click(await screen.findByTestId('new-agent'))
    const dialog = await screen.findByTestId('create-agent-dialog')
    await user.type(within(dialog).getByTestId('new-agent-name'), 'badbot')
    await waitFor(() => expect((within(dialog).getByTestId('new-agent-runtime') as HTMLSelectElement).options).toHaveLength(4))
    await user.selectOptions(within(dialog).getByTestId('new-agent-runtime'), 'claude-code')
    await user.type(within(dialog).getByTestId('new-agent-workspace'), '/etc')
    await user.click(within(dialog).getByTestId('new-agent-submit'))
    expect(await within(dialog).findByText(/工作目錄不在允許清單內/)).toBeInTheDocument()
  })

  it('工作臺：coding 員工在員工列表有徽章，選到他時右欄（工程師模式）顯示工作目錄而不是 profile', async () => {
    setEngineerMode(true)
    renderApp(<App />, { route: '/workbench' })
    const user = userEvent.setup()
    const sidebar = await screen.findByTestId('sidebar-desktop')
    await user.click(await within(sidebar).findByText('工程師'))
    expect(within(sidebar).getByTestId('runtime-badge-claude-code')).toBeInTheDocument()
    const info = screen.getByTestId('session-info')
    expect(within(info).getByText('工作目錄')).toBeInTheDocument()
    expect(within(info).getAllByText('/Users/me/code/demo').length).toBeGreaterThan(0)
  })
})
