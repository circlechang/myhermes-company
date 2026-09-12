// 模型頁：老闆模式看員工名、按鈕叫「重新整理」、自訂供應商藏在工程師模式後面（fake fetch）
import { screen, within } from '@testing-library/react'
import '../registry'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { setEngineerMode } from '../../prefs/engineerMode'
import { bossCopyViolations } from '../../test/bossCopy'
import { renderApp, setupMocks } from '../../test/utils'
import { ModelsPage, type ProvidersResp } from './index'

const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } })
const providers: ProvidersResp = {
  providers: [{
    id: 'openai', name: 'OpenAI', kind: 'builtin', auth_type: 'api_key', base_url: 'https://api.openai.com/v1', key_envs: ['OPENAI_API_KEY'], key_env_set: 'OPENAI_API_KEY',
    oauth_capable: false, oauth_logged_in: false, credentials: [], configured: true, is_active: true, is_current: true, group: '雲端', hidden_models: [], aliases: {}, enabled: true,
  }],
  active_provider: 'openai', current: { model: 'gpt-5', provider: 'openai', base_url: 'https://api.openai.com/v1' }, groups: ['雲端'],
}

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const p = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0]
  if (p === '/models/providers') return Promise.resolve(ok(providers))
  if (p === '/models/speech') return Promise.resolve(ok({ tts: { provider: '', providers: [] }, stt: { provider: '', enabled: false, providers: [] } }))
  return mockFetch(input, init)
}

describe('模型（modules/models）', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    setFetchImpl(fakeFetch as typeof fetch)
    setEngineerMode(false)
  })

  it('老闆模式：標題「模型」、員工名下拉、「重新整理」、沒有自訂供應商按鈕、沒有系統詞', async () => {
    renderApp(<ModelsPage />)
    expect(await screen.findByRole('heading', { name: '模型' })).toBeInTheDocument()
    expect(screen.getByText('每位員工用哪個腦；金鑰只放在伺服器')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新整理' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新增自訂供應商' })).not.toBeInTheDocument()
    expect(screen.getByTestId('models-custom-hint')).toHaveTextContent('要接自己的供應商，開工程師模式')
    const select = await screen.findByTestId('models-profile')
    expect(await within(select).findByRole('option', { name: '小編' })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: 'editor' })).not.toBeInTheDocument()
    expect(await screen.findByTestId('current-model')).toHaveTextContent('gpt-5')
    expect(await screen.findByTestId('provider-openai')).toHaveTextContent('已設金鑰')
    expect(bossCopyViolations()).toEqual([])
  })

  it('工程師模式：檔案路徑副標題、自訂供應商按鈕與 provider id 都回來', async () => {
    setEngineerMode(true)
    renderApp(<ModelsPage />)
    expect(await screen.findByText(/auth\.json/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新增自訂供應商' })).toBeInTheDocument()
    expect(await screen.findByTestId('provider-openai')).toHaveTextContent('OPENAI_API_KEY')
  })
})
