// 技能頁：老闆模式全中文、下拉顯示員工名；工程師模式才露出 profile／路徑（fake fetch）
import { screen, within } from '@testing-library/react'
import '../registry'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { setEngineerMode } from '../../prefs/engineerMode'
import { bossCopyViolations } from '../../test/bossCopy'
import { renderApp, setupMocks } from '../../test/utils'
import { SkillsPage } from './index'

const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } })
const item = { name: 'web-search', dir: 'web-search', path: '/home/u/.hermes/skills/web-search', source: 'local', category: 'research', description: '上網找資料', version: '1.0', tags: ['web'], mtime: 1700000000, files: 1, enabled: true, profile: 'default', topic: '研究與情報' }

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const p = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0]
  if (p === '/skills') return Promise.resolve(ok({ profile: 'default', items: [item], topics: [{ name: '研究與情報', hint: '查資料', count: 1 }], categories: [{ name: 'research', count: 1 }] }))
  if (p === '/skills/usage') return Promise.resolve(ok({ counts: { 'web-search': 3 }, last_used: { 'web-search': Date.now() / 1000 - 86400 * 2 }, top: [['web-search', 3]], recent: [['web-search', Date.now() / 1000 - 86400 * 2]] }))
  return mockFetch(input, init)
}

describe('技能與記憶（modules/skills）', () => {
  beforeEach(() => {
    setupMocks({ loggedIn: true })
    setFetchImpl(fakeFetch as typeof fetch)
    setEngineerMode(false)
  })

  it('老闆模式：標題／分頁／按鈕全中文，下拉是員工名，主畫面沒有系統詞', async () => {
    renderApp(<SkillsPage />)
    expect(await screen.findByRole('heading', { name: '技能與記憶' })).toBeInTheDocument()
    expect(screen.getByText('每位員工會什麼、記得什麼')).toBeInTheDocument()
    for (const tab of ['技能', '組合', '記憶', '關係圖']) expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '新增技能' })).toBeInTheDocument()
    expect(screen.getByText('選一個技能看說明')).toBeInTheDocument()
    expect(await screen.findByText('web-search')).toBeInTheDocument()
    // profile id → 員工名（mock：researcher＝研究員）
    const select = await screen.findByTestId('skills-profile')
    expect(await within(select).findByRole('option', { name: '研究員' })).toBeInTheDocument()
    expect(within(select).queryByRole('option', { name: 'researcher' })).not.toBeInTheDocument()
    expect(bossCopyViolations()).toEqual([])
  })

  it('工程師模式：副標題改回系統說明，下拉附 profile id', async () => {
    setEngineerMode(true)
    renderApp(<SkillsPage />)
    expect(await screen.findByText(/各 profile 的 skills/)).toBeInTheDocument()
    const select = await screen.findByTestId('skills-profile')
    expect(await within(select).findByRole('option', { name: '研究員（researcher）' })).toBeInTheDocument()
  })
})
