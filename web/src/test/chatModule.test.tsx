// 聊天模組前端測試：不經 App/registry（其他模組可能還在裝依賴），直接掛 WorkbenchPage。
import i18n from 'i18next'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { chatApi, type ChatSession } from '../api/sessions'
import { bucketOf, groupSessions, sectionsOf, shortTime, sortSessions } from '../components/chat/SessionSidebar'
import { Markdown, extractFilePaths } from '../components/chat/Markdown'
import { ToolCard } from '../components/chat/ToolCard'
import chatMod from '../modules/chat'
import { state as mockState } from '../mock/fetch'
import { MockWebSocket } from '../mock/MockWebSocket'
import { WorkbenchPage } from '../pages/WorkbenchPage'
import { applyEvent, emptyChat, fromMessages } from '../ws/chatState'
import { renderApp, setupMocks } from './utils'

beforeAll(() => {
  for (const [lng, res] of Object.entries(chatMod.i18n!)) i18n.addResourceBundle(lng, 'translation', res, true, true)
})

const mk = (o: Partial<ChatSession>): ChatSession => ({
  id: 'x', agent_id: 'a1', title: 't', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z', source: 'workbench',
  archived: false, category_id: null, model: '', provider: '', running: false, run_status: '',
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, context_tokens: 0 }, ...o,
})

describe('session 分組與排序（純函式）', () => {
  it('進行中置頂，其餘依最後訊息時間新→舊', () => {
    const list = [
      mk({ id: 'old', last_message_at: '2026-08-01T00:00:00Z' }),
      mk({ id: 'new', last_message_at: '2026-08-20T00:00:00Z' }),
      mk({ id: 'run', last_message_at: '2026-07-01T00:00:00Z', running: true }),
    ]
    expect(sortSessions(list).map((s) => s.id)).toEqual(['run', 'new', 'old'])
  })
  it('依來源分組，workbench/studio/web 合併，固定順序後接其他', () => {
    const g = groupSessions([mk({ id: '1', source: 'telegram' }), mk({ id: '2', source: 'studio' }), mk({ id: '3', source: 'zzz' }), mk({ id: '4', source: 'cli' }), mk({ id: '5', source: 'web' })], (k) => k)
    expect(g.map((x) => [x.key, x.items.length])).toEqual([['workbench', 2], ['cli', 1], ['telegram', 1], ['zzz', 1]])
  })
})

describe('側欄時間分組（純函式）', () => {
  // 以本地時間 2026-08-31 14:00 當「現在」，避免測試隨執行時間漂移
  const now = new Date(2026, 7, 31, 14, 0, 0).getTime()
  const at = (d: Date) => d.toISOString()

  it('用日曆日而不是 24 小時切桶：凌晨 0:05 仍算今天', () => {
    expect(bucketOf(new Date(2026, 7, 31, 0, 5).getTime(), now)).toBe('today')
    expect(bucketOf(new Date(2026, 7, 30, 23, 55).getTime(), now)).toBe('yesterday')
    expect(bucketOf(new Date(2026, 7, 27, 9, 0).getTime(), now)).toBe('week')
    expect(bucketOf(new Date(2026, 6, 1, 9, 0).getTime(), now)).toBe('older')
  })

  it('空的桶不產生區段，進行中的對話一律留在今天', () => {
    const secs = sectionsOf([
      mk({ id: 'a', last_message_at: at(new Date(2026, 7, 31, 9, 0)) }),
      mk({ id: 'b', last_message_at: at(new Date(2026, 6, 1, 9, 0)) }),
      mk({ id: 'c', last_message_at: at(new Date(2026, 6, 1, 9, 0)), running: true }),
    ], now)
    expect(secs.map((x) => [x.key, x.items.map((i) => i.id)])).toEqual([['today', ['a', 'c']], ['older', ['b']]])
  })

  it('時間戳：今天給時刻、昨天不重複標示、更早給日期', () => {
    expect(shortTime(new Date(2026, 7, 31, 9, 5).getTime(), 'zh-TW', now)).toBe('09:05')
    expect(shortTime(new Date(2026, 7, 30, 9, 5).getTime(), 'zh-TW', now)).toBe('')
    expect(shortTime(new Date(2026, 6, 1, 9, 5).getTime(), 'zh-TW', now)).toMatch(/07/)
  })
})

describe('Markdown 與工具卡', () => {
  it('渲染 GFM 表格、程式碼區塊有語言與複製鈕、路徑變成可點檔案 chip', async () => {
    const onOpen = vi.fn()
    renderApp(<Markdown text={'# 標題\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nprint(1)\n```\n\n輸出在 /tmp/out/report.pdf 裡，也看 `~/docs/x.md`'} onOpenFile={onOpen} />)
    expect(screen.getByRole('heading', { name: '標題' })).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
    const code = screen.getByTestId('code-block')
    expect(code).toHaveTextContent('python')
    expect(within(code).getByRole('button', { name: '複製' })).toBeInTheDocument()
    const chips = screen.getAllByTestId('file-chip')
    expect(chips.map((c) => c.getAttribute('title'))).toEqual(['/tmp/out/report.pdf', '~/docs/x.md'])
    await userEvent.setup().click(chips[0])
    expect(onOpen).toHaveBeenCalledWith('/tmp/out/report.pdf')
    expect(extractFilePaths('看 /Users/m/a.png 與 http://x.com/y.png')).toEqual(['/Users/m/a.png'])
  })
  it('工具卡：參數／結果可展開，長內容截斷再展開', async () => {
    const user = userEvent.setup()
    const long = 'x'.repeat(3000)
    renderApp(<ToolCard item={{ kind: 'tool', id: 't1', name: 'terminal', args: { cmd: 'ls' }, result: long, status: 'done' }} />)
    await user.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByTestId('tool-args')).toHaveTextContent('"cmd": "ls"')
    const res = screen.getByTestId('tool-result')
    expect(res.textContent!.length).toBeLessThan(1500)
    await user.click(within(res).getByText(/展開全部/))
    expect(res.textContent!.length).toBeGreaterThan(3000)
  })
  it('chatState：reasoning.available 變成推理卡、messages.removed 刪訊息、session_usage 落到狀態', () => {
    let s = fromMessages([{ id: 'm1', role: 'user', content: 'q', created_at: '' }, { id: 'm2', role: 'assistant', content: 'a', created_at: '', reasoning: '想一下' } as never])
    expect(s.items.map((i) => i.kind)).toEqual(['text', 'reasoning', 'text'])
    s = applyEvent(s, { type: 'messages.removed', session_id: 's', ids: ['m2'] } as never)
    expect(s.items.map((i) => i.kind)).toEqual(['text'])
    s = applyEvent(s, { type: 'reasoning.available', session_id: 's', reasoning: '思考' } as never)
    expect(s.items.at(-1)).toMatchObject({ kind: 'reasoning', text: '思考' })
    s = applyEvent(s, { type: 'run.completed', session_id: 's', output: 'ok', session_usage: { total_tokens: 9, context_tokens: 5, input_tokens: 4, output_tokens: 5 }, message_id: 'm9' } as never)
    expect(s.sessionUsage?.total_tokens).toBe(9)
    expect(s.items.at(-1)).toMatchObject({ kind: 'text', content: 'ok', message_id: 'm9' })
    expect(applyEvent(emptyChat(), { type: 'context.compression', session_id: 's', status: 'started' } as never).compression?.status).toBe('started')
  })
})

async function openWorkbench(sessionTitle = '本週熱點選題') {
  renderApp(<WorkbenchPage />)
  const user = userEvent.setup()
  await user.click(await screen.findByText(sessionTitle))
  await screen.findByTestId('message-list')
  await waitFor(() => expect(MockWebSocket.instances.at(-1)?.readyState).toBe(MockWebSocket.OPEN))
  return { user, ws: MockWebSocket.instances.at(-1)! }
}

describe('工作臺整合（mock fetch + 假 WebSocket）', () => {
  beforeEach(() => setupMocks({ loggedIn: true, wsDelayMs: 0 }))

  it('側欄依來源分組、可摺疊、進行中顯示 spinner；重新命名與封存', async () => {
    ;(mockState.sessions[1] as unknown as { running: boolean }).running = true
    const { user } = await openWorkbench()
    const wb = screen.getByTestId('group-workbench')
    expect(within(wb).getAllByTestId('session-row')).toHaveLength(2)
    expect(within(wb).getAllByTestId('session-row')[0]).toHaveTextContent('LINE 貼文草稿') // running 置頂
    expect(within(wb).getByTestId('running-spinner')).toBeInTheDocument()
    await user.click(within(wb).getByRole('button', { expanded: true }))
    expect(within(wb).queryAllByTestId('session-row')).toHaveLength(0)
    await user.click(within(wb).getByRole('button', { expanded: false }))
    // rename
    vi.spyOn(window, 'prompt').mockReturnValue('新標題')
    const row = within(wb).getAllByTestId('session-row')[1]
    await user.click(within(row).getByLabelText('更多'))
    await user.click(screen.getByRole('menuitem', { name: '重新命名' }))
    expect(await within(wb).findByText('新標題')).toBeInTheDocument()
    // archive → 從清單消失；勾「封存」回來
    await user.click(within(within(wb).getAllByTestId('session-row')[1]).getByLabelText('更多'))
    await user.click(screen.getByRole('menuitem', { name: '封存' }))
    await waitFor(() => expect(within(wb).queryByText('新標題')).not.toBeInTheDocument())
    await user.click(screen.getByLabelText('封存'))
    expect(await within(screen.getByTestId('group-workbench')).findByText('新標題')).toBeInTheDocument()
  })

  it('Ctrl+K 搜尋標題與訊息內容並切換對話', async () => {
    const { user } = await openWorkbench('LINE 貼文草稿')
    await user.keyboard('{Control>}k{/Control}')
    const pal = await screen.findByTestId('search-palette')
    await user.type(within(pal).getByRole('textbox'), '三個')
    expect(await within(pal).findByText('本週熱點選題')).toBeInTheDocument()
    expect(within(pal).getByText('訊息')).toBeInTheDocument() // 標題沒有「三個」，命中的是訊息內容
    expect(within(pal).getByText(/幫我列本週三個熱點/)).toBeInTheDocument()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByTestId('search-palette')).not.toBeInTheDocument())
    expect(await screen.findByText(/^本週三個熱點/)).toBeInTheDocument()
  })

  it('上傳流程：選檔→待送附件→送出時 run 帶 attachments；貼圖也會上傳', async () => {
    const up = vi.spyOn(chatApi.uploads, 'upload').mockResolvedValue([{ name: 'a.pdf', path: '/up/a.pdf', mime: 'application/pdf', size: 10 }])
    const { user, ws } = await openWorkbench('LINE 貼文草稿')
    const input = screen.getByTestId('file-input') as HTMLInputElement
    await user.upload(input, new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }))
    expect(up).toHaveBeenCalledWith('s2', expect.any(Array))
    expect(await screen.findByTestId('pending-attachments')).toHaveTextContent('a.pdf')
    await user.type(screen.getByPlaceholderText(/輸入訊息/), '看附件{Enter}')
    expect(ws.sent.at(-1)).toMatchObject({ type: 'run', session_id: 's2', input: '看附件', attachments: [{ path: '/up/a.pdf' }] })
    expect(screen.getByTestId('attachments')).toHaveTextContent('a.pdf')
    // paste image
    up.mockResolvedValue([{ name: 'paste.png', path: '/up/paste.png', mime: 'image/png', size: 3 }])
    const ta = screen.getByPlaceholderText(/輸入訊息|插話/)
    const file = new File(['png'], 'image.png', { type: 'image/png' })
    fireEvent.paste(ta, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } })
    await waitFor(() => expect(up).toHaveBeenCalledTimes(2))
    expect((up.mock.calls[1][1][0] as File).name).toMatch(/^paste-.*\.png$/)
  })

  it('模型選擇器：徽章→清單（分供應商、含價格）→選擇後 session.model 更新', async () => {
    const { user } = await openWorkbench('LINE 貼文草稿')
    await user.click(screen.getByTestId('model-badge'))
    const picker = await screen.findByTestId('model-picker')
    expect(await within(picker).findByText(/Nous Portal/)).toBeInTheDocument()
    expect(within(picker).getByText('$3 / $15')).toBeInTheDocument()
    await user.type(within(picker).getByLabelText('篩選模型…'), 'gpt')
    expect(within(picker).queryByText('z-ai/glm-5.3:free')).not.toBeInTheDocument()
    await user.click(within(picker).getByText('openai/gpt-5.5'))
    await waitFor(() => expect(screen.getByTestId('model-badge')).toHaveTextContent('gpt-5.5'))
    expect((mockState.sessions.find((s) => s.id === 's2') as unknown as { model: string }).model).toBe('openai/gpt-5.5')
  })

  it('引用、編輯上一則、重新生成、插話與停止', async () => {
    const { user, ws } = await openWorkbench('LINE 貼文草稿')
    await user.type(screen.getByPlaceholderText(/輸入訊息/), '第一句{Enter}')
    await screen.findByText(/收到「第一句」/)
    await waitFor(() => expect(screen.queryByText('回覆中…')).not.toBeInTheDocument())
    // 引用 assistant
    const assistant = screen.getByText(/收到「第一句」/).closest('[data-role="assistant"]')!
    await user.click(within(assistant as HTMLElement).getByRole('button', { name: '引用' }))
    expect(screen.getByTestId('reply-bar')).toHaveTextContent('收到「第一句」')
    await user.type(screen.getByPlaceholderText(/輸入訊息/), '為什麼{Enter}')
    expect(ws.sent.at(-1)).toMatchObject({ type: 'run', input: '為什麼', reply_to: expect.any(String) })
    expect(screen.getByTestId('quote')).toHaveTextContent('收到「第一句」')
    await waitFor(() => expect(screen.queryByText('回覆中…')).not.toBeInTheDocument())
    // 重新生成最後一則
    const last = screen.getAllByText(/收到「為什麼」/).at(-1)!.closest('[data-role="assistant"]')!
    await user.click(within(last as HTMLElement).getByRole('button', { name: '重新生成' }))
    expect(ws.sent.at(-1)).toMatchObject({ type: 'regenerate', session_id: 's2' })
    await waitFor(() => expect(screen.queryByText('回覆中…')).not.toBeInTheDocument())
    // 編輯上一則使用者訊息
    const mine = screen.getByText('為什麼').closest('[data-role="user"]')!
    await user.click(within(mine as HTMLElement).getByRole('button', { name: '編輯' }))
    expect(screen.getByTestId('edit-bar')).toBeInTheDocument()
    const ta = screen.getByPlaceholderText(/輸入訊息/) as HTMLTextAreaElement
    expect(ta.value).toBe('為什麼')
    await user.clear(ta)
    await user.type(ta, '改成這樣{Enter}')
    expect(ws.sent.at(-1)).toMatchObject({ type: 'edit', session_id: 's2', input: '改成這樣' })
    // 進行中：插話與停止
    ws.emit({ type: 'run.started', session_id: 's2', run_id: 'rr' })
    await screen.findByTestId('steer-btn')
    await user.type(screen.getByPlaceholderText(/插話/), '快一點{Enter}')
    expect(ws.sent.at(-1)).toMatchObject({ type: 'steer', run_id: 'rr', input: '快一點' })
    await user.click(screen.getByRole('button', { name: '停止' }))
    expect(ws.sent.at(-1)).toMatchObject({ type: 'stop', run_id: 'rr' })
  })

  it('點訊息中的檔案路徑開啟內嵌預覽（markdown / csv / html sandbox）', async () => {
    const { user } = await openWorkbench('LINE 貼文草稿')
    const ws = MockWebSocket.instances.at(-1)!
    ws.emit({ type: 'run.started', session_id: 's2', run_id: 'r9' })
    ws.emit({ type: 'run.completed', session_id: 's2', run_id: 'r9', output: '存到 /tmp/out/data.csv 與 /tmp/out/page.html' })
    const chips = await screen.findAllByTestId('file-chip')
    await user.click(chips[0])
    const pv = await screen.findByTestId('file-preview')
    expect(await within(pv).findByTestId('table-preview')).toHaveTextContent('a')
    await user.click(screen.getAllByTestId('file-chip')[1])
    const frame = (await screen.findByTestId('html-preview')) as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toContain('<h1>hi</h1>')
    await user.click(within(pv).getByRole('button', { name: '附回聊天' }))
    expect(await screen.findByTestId('pending-attachments')).toHaveTextContent('page.html')
  })

  it('Hermes 歷史：側欄分組帶 badge → 唯讀瀏覽 → 匯入成 Studio 對話', async () => {
    const { user } = await openWorkbench('LINE 貼文草稿')
    const hg = await screen.findByTestId('group-hermes')
    expect(hg).toHaveTextContent('Hermes 歷史')
    expect(hg).toHaveTextContent('4') // total badge
    // 非工作臺的群組預設收合（Hermes 動輒上千筆），要先展開
    expect(within(hg).queryByText('default')).not.toBeInTheDocument()
    await user.click(within(hg).getByRole('button', { name: /Hermes 歷史/ }))
    await user.click(within(hg).getByText('default'))
    const list = await screen.findByTestId('hermes-list-default')
    expect(within(list).getAllByText('Hermes')).toHaveLength(3)
    await user.click(within(list).getByText('客戶問報價'))
    const view = await screen.findByTestId('hermes-view')
    expect(view).toHaveTextContent('唯讀')
    expect(await within(view).findByText(/1\.4 倍/)).toBeInTheDocument()
    expect(within(view).getByTestId('tool-card')).toHaveTextContent('read_file')
    await user.click(within(view).getByRole('button', { name: '匯入成 Studio 對話' }))
    await waitFor(() => expect(screen.queryByTestId('hermes-view')).not.toBeInTheDocument())
    expect(await screen.findByText(/1\.4 倍/)).toBeInTheDocument()
    const tg = screen.getByTestId('group-telegram')
    await user.click(within(tg).getByRole('button', { name: /telegram|Telegram/i }))
    expect(tg).toHaveTextContent('客戶問報價')
  })

  it('以文件為核心：對話可以開一份 HTML 文件，右側出現可預覽的文件面板', async () => {
    const { user, ws } = await openWorkbench('LINE 貼文草稿')
    // 還沒綁文件：顯示入口，右側是 session 資訊
    expect(screen.getByTestId('workbench-open-doc')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-doc-panel')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('workbench-open-doc'))

    // 綁上之後：入口換成徽章，右側讓給文件本身
    expect(await screen.findByTestId('doc-bound')).toBeInTheDocument()
    const panel = await screen.findByTestId('workbench-doc-panel')
    expect(panel).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-open-doc')).not.toBeInTheDocument()

    // 建出來的是 html 文件（新文件的預設格式）
    const created = mockState.docs.at(-1)!
    expect(created.format).toBe('html')
    expect(created.path).toMatch(/\.html$/)

    // AI 更新文件 → doc.updated 進來 → 面板亮出新版本
    ws.emit({ type: 'doc.updated', session_id: 's2', run_id: 'r1', doc_id: created.id, version: 1, summary: '先給大綱', diff_stat: { added: 12, removed: 0 } })
    expect(await within(panel).findByText(/先給大綱/)).toBeInTheDocument()
  })

  it('手機版：☰ 開抽屜側欄', async () => {
    const { user } = await openWorkbench('LINE 貼文草稿')
    expect(screen.queryByTestId('sidebar-drawer')).not.toBeInTheDocument()
    await user.click(screen.getByLabelText('開啟對話清單'))
    const drawer = await screen.findByTestId('sidebar-drawer')
    expect(within(drawer).getByTestId('session-sidebar')).toBeInTheDocument()
    await user.click(within(drawer).getByText('本週熱點選題'))
    await waitFor(() => expect(screen.queryByTestId('sidebar-drawer')).not.toBeInTheDocument())
  })
})
