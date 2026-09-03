// 工作臺左欄：員工清單可收合，狀態記在 localStorage，收起時標題帶目前員工名
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkbenchPage } from '../pages/WorkbenchPage'
import { renderApp, setupMocks } from './utils'

beforeEach(() => {
  setupMocks({ loggedIn: true })
  localStorage.clear()
})

describe('工作臺員工清單', () => {
  it('預設展開；點標題收起，清單消失、標題帶目前員工；重新掛載仍是收起', async () => {
    const user = userEvent.setup()
    const { unmount } = renderApp(<WorkbenchPage />, { route: '/workbench' })
    const toggle = await screen.findByTestId('workbench-agents-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await screen.findByTestId('workbench-agents-list')
    await user.click(toggle)
    await waitFor(() => expect(screen.queryByTestId('workbench-agents-list')).toBeNull())
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('小編')
    expect(localStorage.getItem('mhc.workbench.agents')).toBe('0')
    unmount()
    renderApp(<WorkbenchPage />, { route: '/workbench' })
    expect(await screen.findByTestId('workbench-agents-toggle')).toHaveAttribute('aria-expanded', 'false')
  })
})
