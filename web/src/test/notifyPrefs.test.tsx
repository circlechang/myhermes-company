import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { mockNotifyStatus } from '../mock/data'
import { notifyMock } from '../mock/fetch'
import { renderApp, setupMocks } from './utils'

describe('設定頁：有事找我（LINE 通知）', () => {
  beforeEach(() => setupMocks({ loggedIn: true }))

  it('顯示卡片、儲存會 PUT 表單、測試按鈕顯示「已送出」', async () => {
    renderApp(<App />, { route: '/settings' })
    const user = userEvent.setup()
    expect(await screen.findByText('有事找我')).toBeInTheDocument()
    const enabled = (await screen.findByTestId('notify-enabled')) as HTMLInputElement
    expect(enabled).not.toBeChecked()
    expect(screen.queryByTestId('notify-status')).not.toBeInTheDocument()  // LINE 已接好就不提示
    // 沒填對象前測試鈕是灰的
    expect(screen.getByTestId('notify-test')).toBeDisabled()

    await user.type(screen.getByTestId('notify-line-to'), 'Uboss')
    await user.type(screen.getByTestId('notify-public-url'), 'https://studio.example.com')
    await user.click(enabled)
    await user.click(screen.getByTestId('notify-on_failed'))
    await user.click(screen.getByTestId('notify-save'))
    expect(await screen.findByTestId('notify-saved')).toHaveTextContent('已儲存')
    expect(notifyMock.puts).toHaveLength(1)
    expect(notifyMock.puts[0]).toMatchObject({ enabled: true, line_to: 'Uboss', public_url: 'https://studio.example.com', on_waiting: true, on_failed: false, on_chat_approval: true, quiet_hours: '' })

    await user.click(screen.getByTestId('notify-test'))
    expect(await screen.findByTestId('notify-test-result')).toHaveTextContent('已送出')
    expect(notifyMock.tests).toEqual([{ line_to: 'Uboss' }])
  })

  it('灌入既有偏好；LINE 沒接好時提示去頻道', async () => {
    notifyMock.prefs = { ...notifyMock.prefs, enabled: true, line_to: 'Cgroup', public_url: 'https://x.example', quiet_hours: '23-07' }
    mockNotifyStatus.line_configured = false
    try {
      renderApp(<App />, { route: '/settings' })
      await waitFor(() => expect(screen.getByTestId('notify-line-to')).toHaveValue('Cgroup'))
      expect(screen.getByTestId('notify-enabled')).toBeChecked()
      expect(screen.getByTestId('notify-quiet-hours')).toHaveValue('23-07')
      const hint = await screen.findByTestId('notify-status')
      expect(hint).toHaveTextContent('LINE token')
      expect(hint.querySelector('a')).toHaveAttribute('href', '/channels')
    } finally {
      mockNotifyStatus.line_configured = true
    }
  })
})
