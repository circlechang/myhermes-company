// 頻道頁：老闆模式叫「連線狀態／重新連線」、LINE 三步清單、不露出 env 路徑（fake fetch）
import { screen, within } from '@testing-library/react'
import '../registry'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { setEngineerMode } from '../../prefs/engineerMode'
import { bossCopyViolations } from '../../test/bossCopy'
import { renderApp, setupMocks } from '../../test/utils'
import { ChannelsPage, type ChannelPlatform, type GatewayStatus } from './index'

const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } })
const line: ChannelPlatform = {
  id: 'line', label: 'LINE', description: 'LINE 官方帳號', docs_url: 'https://developers.line.biz', configured: false, plugin: 'line',
  fields: [
    { name: 'LINE_CHANNEL_ACCESS_TOKEN', label: 'Channel access token', required: true, secret: true, kind: 'str', set: false, hint: '', default: '' },
    { name: 'LINE_PUBLIC_URL', label: '對外網址', required: true, secret: false, kind: 'str', set: false, hint: 'https://…', default: '' },
  ],
  config_section: 'line', config_keys: [{ name: 'reply_in_group', label: '群組也回', kind: 'bool', default: false, hint: '' }], config: {},
  webhook_url: 'https://example.com/webhook/line', webhook_path: '/webhook/line', webhook_hint: '',
}
const status: GatewayStatus = { ok: true, running: true, pid: 123, supervised: false, stale_service: false, profiles: [{ name: 'editor', running: true, pid: 1 }], raw: '' }

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const p = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0]
  if (p === '/channels') return Promise.resolve(ok({ platforms: [line], env_path: '~/.hermes/.env', config_path: '~/.hermes/config.yaml' }))
  if (p === '/channels/gateway/status') return Promise.resolve(ok(status))
  return mockFetch(input, init)
}

describe('頻道（modules/channels）', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    setFetchImpl(fakeFetch as typeof fetch)
    setEngineerMode(false)
  })

  it('老闆模式：連線狀態／重新連線、LINE 三步清單與沒有對外網址的提示、員工名、沒有系統詞', async () => {
    renderApp(<ChannelsPage />)
    expect(await screen.findByRole('heading', { name: '接 LINE 與其他平台' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '連線狀態' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新連線' })).toBeInTheDocument()
    expect(await screen.findByText('已連線')).toBeInTheDocument()
    expect(await screen.findByText(/小編/)).toBeInTheDocument()  // 連線狀態卡的員工籤（✓ 小編）
    const list = within(await screen.findByTestId('line-checklist'))
    expect(list.getAllByRole('listitem')).toHaveLength(3)
    expect(list.getByText(/建一個 LINE 官方帳號/)).toBeInTheDocument()
    expect(list.getByText(/貼進下面的欄位/)).toBeInTheDocument()
    expect(list.getByText(/貼回 LINE 後台/)).toBeInTheDocument()
    expect(list.getByText(/沒有對外網址？請工程師幫你開 Cloudflare Tunnel/)).toBeInTheDocument()
    expect(screen.getByTestId('line-webhook')).toHaveTextContent('https://example.com/webhook/line')
    expect(screen.queryByText(/寫入：/)).not.toBeInTheDocument()
    expect(bossCopyViolations()).toEqual([])
  })

  it('工程師模式：Gateway 字樣、PID、env 路徑與欄位名都露出', async () => {
    setEngineerMode(true)
    renderApp(<ChannelsPage />)
    expect(await screen.findByRole('heading', { name: 'Gateway 狀態' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重啟 gateway' })).toBeInTheDocument()
    expect(await screen.findByText(/PID 123/)).toBeInTheDocument()
    expect(await screen.findByText(/寫入：~\/\.hermes\/\.env/)).toBeInTheDocument()
    expect(screen.getByText('LINE_CHANNEL_ACCESS_TOKEN')).toBeInTheDocument()
  })
})
