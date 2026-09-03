// 一句話建流程：打字 → 排成流程 → 看到四步 → 建立（POST /workflows ＋ 排程）→ onCreated；錯誤時給人看得懂的話
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import '../../../i18n'
import { setFetchImpl, setToken } from '../../../api/client'
import { MOCK_TOKEN, mockFetch, resetMockState } from '../../../mock/fetch'
import { DraftDialog } from '../DraftDialog'
import { en, zhTW } from '../i18n'

i18n.addResourceBundle('zh-TW', 'translation', zhTW, true, true)
i18n.addResourceBundle('en', 'translation', en, true, true)

type Call = { method: string; path: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
/** 攔在 mockFetch 前面：記錄每次呼叫，並讓測試蓋掉特定路徑的回應（可回錯誤碼） */
let overrides: Record<string, (c: Call) => Response> = {}
const res = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  resetMockState()
  calls = []
  overrides = {}
  setToken(MOCK_TOKEN)
  setFetchImpl((async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String(input)
    const c: Call = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: new URL(url, 'http://localhost').pathname.replace(/^\/api/, ''),
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    }
    calls.push(c)
    const key = `${c.method} ${c.path}`
    if (overrides[key]) return overrides[key](c)
    return mockFetch(input, init)
  }) as unknown as typeof fetch)
})

const TEXT = '每天早上找三個循環包裝的熱點，我挑一個，小編寫成 LINE 貼文發到行銷組'

const mount = (over: { open?: boolean } = {}) => {
  const props = { open: true, onClose: vi.fn(), onCreated: vi.fn<(id: string) => void>(), onPickTemplate: vi.fn(), ...over }
  render(<DraftDialog {...props} />)
  return props
}

describe('DraftDialog', () => {
  it('closed → renders nothing', () => {
    mount({ open: false })
    expect(screen.queryByTestId('draft-dialog')).toBeNull()
  })

  it('type → draft → 4 steps → create posts workflow (4 nodes / 3 edges) then schedule, and calls onCreated', async () => {
    const user = userEvent.setup()
    const props = mount()
    // 空的時候不能送
    expect(screen.getByTestId('draft-submit')).toBeDisabled()
    await user.type(screen.getByTestId('draft-text'), TEXT)
    await user.click(screen.getByTestId('draft-submit'))

    const steps = await screen.findByTestId('draft-steps')
    const rows = within(steps).getAllByTestId('draft-step')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('研究員')
    expect(rows[0]).toHaveTextContent('找出今天三個熱點')
    expect(rows[1]).toHaveTextContent('你')
    expect(rows[2]).toHaveTextContent('小編')
    expect(rows[3]).toHaveTextContent('送到 LINE')
    expect(rows[3]).toHaveTextContent('行銷組')
    // 老闆的原話送到後端
    const draftCall = calls.find((c) => c.method === 'POST' && c.path === '/workflows/draft')
    expect(draftCall?.body?.text).toBe(TEXT)
    // 提案的名字可以改；排程顯示 label
    expect(screen.getByTestId('draft-name')).toHaveValue('每日熱點內容產線')
    expect(screen.getByTestId('draft-schedule')).toHaveTextContent('每天 08:00')

    await user.click(screen.getByTestId('draft-create'))
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledTimes(1))

    const created = calls.find((c) => c.method === 'POST' && c.path === '/workflows')
    expect(created).toBeTruthy()
    expect((created!.body!.nodes as unknown[]).length).toBe(4)
    expect((created!.body!.edges as unknown[]).length).toBe(3)
    expect(created!.body!.name).toBe('每日熱點內容產線')
    const id = props.onCreated.mock.calls[0][0]
    const sched = calls.find((c) => c.method === 'POST' && c.path === `/workflows/${id}/schedules`)
    expect(sched?.body?.cron).toBe('0 8 * * *')
    // 排程在流程之後才建
    expect(calls.indexOf(created!)).toBeLessThan(calls.indexOf(sched!))
  })

  it('unticking the schedule skips the schedule POST; 改一下描述 keeps the text', async () => {
    const user = userEvent.setup()
    const props = mount()
    await user.type(screen.getByTestId('draft-text'), TEXT)
    await user.click(screen.getByTestId('draft-submit'))
    await screen.findByTestId('draft-steps')

    await user.click(screen.getByTestId('draft-back'))
    expect(screen.getByTestId('draft-text')).toHaveValue(TEXT)
    await user.click(screen.getByTestId('draft-submit'))
    await screen.findByTestId('draft-steps')

    await user.click(within(screen.getByTestId('draft-schedule')).getByRole('checkbox'))
    await user.click(screen.getByTestId('draft-create'))
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledTimes(1))
    expect(calls.some((c) => c.method === 'POST' && /\/schedules$/.test(c.path))).toBe(false)
  })

  it('no_agent → tells the boss to enable a Hermes staff member', async () => {
    const user = userEvent.setup()
    overrides['POST /workflows/draft'] = () => res({ error: { code: 'no_agent', message: '沒有可用的 Hermes 員工' } }, 422)
    mount()
    await user.type(screen.getByTestId('draft-text'), TEXT)
    await user.click(screen.getByTestId('draft-submit'))
    expect(await screen.findByTestId('draft-error')).toHaveTextContent('先在「AI 員工」啟用一位 Hermes 員工')
    expect(screen.queryByTestId('draft-steps')).toBeNull()
    // 文字還在，可以改了再送
    expect(screen.getByTestId('draft-text')).toHaveValue(TEXT)
  })

  it('draft_failed → shows retry; retry re-posts', async () => {
    const user = userEvent.setup()
    let n = 0
    overrides['POST /workflows/draft'] = () => {
      n += 1
      return res({ error: { code: 'draft_failed', message: 'AI 回的不是 JSON', detail: '我不太確定' } }, 422)
    }
    mount()
    await user.type(screen.getByTestId('draft-text'), TEXT)
    await user.click(screen.getByTestId('draft-submit'))
    const err = await screen.findByTestId('draft-error')
    expect(err).toHaveTextContent('AI 沒排出來，換個說法再試')
    await user.click(within(err).getByRole('button'))
    await waitFor(() => expect(n).toBe(2))
  })

  it('或選範本 → onPickTemplate then onClose', async () => {
    const user = userEvent.setup()
    const props = mount()
    await user.click(screen.getByTestId('draft-template'))
    expect(props.onPickTemplate).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
