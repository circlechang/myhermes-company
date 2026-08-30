import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { getToken } from '../api/client'
import { renderApp, setupMocks } from './utils'

describe('登入流程', () => {
  beforeEach(() => setupMocks({ loggedIn: false }))

  it('未登入時導向 /login，錯誤密碼顯示錯誤', async () => {
    renderApp(<App />, { route: '/' })
    expect(await screen.findByRole('heading', { name: '登入' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('帳號'), 'admin')
    await user.type(screen.getByLabelText('密碼'), 'wrong')
    await user.click(screen.getByRole('button', { name: '登入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('登入失敗')
    expect(getToken()).toBeNull()
  })

  it('正確帳密登入後進入工作臺並存 token', async () => {
    renderApp(<App />, { route: '/' })
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('帳號'), 'admin')
    await user.type(screen.getByLabelText('密碼'), 'admin')
    await user.click(screen.getByRole('button', { name: '登入' }))
    await waitFor(() => expect(getToken()).toBe('mock-jwt-token'))
    expect(await screen.findByRole('link', { name: '工作臺' })).toBeInTheDocument()
    expect(await screen.findByText('小編')).toBeInTheDocument()
  })

  it('語言切換到英文', async () => {
    renderApp(<App />, { route: '/login' })
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByLabelText('語言'), 'en')
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Language'), 'zh-TW')
    expect(await screen.findByRole('heading', { name: '登入' })).toBeInTheDocument()
  })
})
