// 套件清單＋階段視圖（fake fetch）
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import '../registry'
import { setFetchImpl } from '../../api/client'
import { mockFetch } from '../../mock/fetch'
import { renderApp, setupMocks } from '../../test/utils'
import { PacksPage } from './PacksPage'
import { StageBoard } from './StageBoard'
import type { Pack, StageStatus, TopicDetail, TopicSummary } from './api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const calls: { method: string; path: string; body?: any }[] = []
const ok = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } })

const STAGES = [
  { id: 'topics', title: '選題', agent: 'evidence-radar', workflow: 'topics.json', outputs: ['topic.md'], gate: false, description: '蒐集訊號', inputs: [] },
  { id: 'brief', title: 'Brief', agent: 'research-strategist', workflow: 'brief.json', outputs: ['brief.md'], gate: true, description: '一頁 Brief', inputs: ['topic.md'] },
  { id: 'copy', title: '文案', agent: 'content-copywriter', workflow: 'copy.json', outputs: ['copy/fb.md', 'copy/ig.md', 'copy/line.md'], gate: true, description: '三平台草稿', inputs: ['brief.md'],
    criteria: '三檔齊全、不新增事實', role: '內容文案 → 人核准', deliverables: ['copy/fb.md：Hook／主文／CTA'], optional: true },
]
let installed: Pack['installed'] = null
const pack = (): Pack => ({
  name: 'marketing', version: '0.1.0', title: '行銷套件', description: '四個 AI 員工', workspace_dir: 'marketing',
  profiles: ['evidence-radar', 'research-strategist', 'content-copywriter'],
  agents: [{ profile: 'evidence-radar', name: '證據雷達', title: '雷達', description: '' }, { profile: 'research-strategist', name: '研究策略', title: '研究員', description: '' }, { profile: 'content-copywriter', name: '內容文案', title: '文案', description: '' }],
  stages: STAGES, has_hooks: true, installed,
})
let stageStatus: Record<string, StageStatus> = { topics: 'done', brief: 'review', copy: 'draft' }
let feedback = ''
const topicSummary = (): TopicSummary => ({
  id: '20260829_循環包裝箱', title: '循環包裝箱', created_at: '2026-08-29T01:00:00+00:00', updated_at: null,
  current_stage: Object.keys(stageStatus).find((k) => stageStatus[k] !== 'done') ?? null, stages: stageStatus, lights: STAGES.map((s) => stageStatus[s.id]),
})
const topicDetail = (): TopicDetail => ({
  ...topicSummary(), notes: '', dir: '/tmp/ws/marketing/20260829_循環包裝箱',
  stage_list: STAGES.map((s, i) => ({
    ...s, status: stageStatus[s.id], run_id: stageStatus[s.id] === 'draft' ? null : `run_${s.id}`, session_id: stageStatus[s.id] === 'draft' ? null : `s_${s.id}`,
    updated_at: '2026-08-29T01:00:00+00:00', feedback: s.id === 'brief' ? feedback : '',
    files: s.outputs.map((o) => ({ path: o, exists: s.id === 'topics', size: 12, mtime: null })),
    can_run: i === 0 || stageStatus[STAGES[i - 1].id] === 'done', can_approve: stageStatus[s.id] === 'review',
    rollback_targets: STAGES.slice(0, i + 1).map((x) => x.id), can_toggle: s.optional === true, enabled: stageStatus[s.id] !== 'skipped',
    review_hint: s.id === 'brief' && stageStatus[s.id] === 'review' ? 'topics' : '',
  })),
  files: [],
})
let topics: TopicSummary[] = []

function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const path = decodeURIComponent(url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, ''))
  const method = (init.method ?? 'GET').toUpperCase()
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ method, path, body })
  const p = path.split('?')[0]
  const T = '/packs/marketing/topics/20260829_循環包裝箱'
  if (p === '/packs') return Promise.resolve(ok({ items: [pack()], errors: { broken: 'pack.yaml 有未知欄位：foo' }, roots: ['/repo/packs'] }))
  if (p === '/packs/marketing/install') {
    installed = { id: 'pk_1', name: 'marketing', version: '0.1.0', installed_at: '2026-08-29T00:00:00', agents: { 'evidence-radar': 'ag_1' }, workflows: { topics: 'wf_1' }, profiles_created: [] }
    return Promise.resolve(ok({ name: 'marketing', installed }, 201))
  }
  if (p === '/packs/marketing') return Promise.resolve(ok({ ...pack(), status: { name: 'marketing', installed, profiles: {}, agents: [{ profile: 'research-strategist', agent_id: 'ag_2', name: '研究策略', title: '研究員', enabled: true, exists: true }], topics_count: topics.length, workspace: '/tmp/ws/marketing' } }))
  if (p === '/packs/marketing/topics' && method === 'GET') return Promise.resolve(ok(topics))
  if (p === '/packs/marketing/topics' && method === 'POST') {
    stageStatus = { topics: 'draft', brief: 'draft', copy: 'draft' }
    topics = [topicSummary()]
    return Promise.resolve(ok(topicDetail(), 201))
  }
  if (p === T) return Promise.resolve(ok(topicDetail()))
  if (p === `${T}/file`) return Promise.resolve(ok({ path: 'topic.md', content: '# 循環包裝箱\n\n- 角度一', binary: false, size: 12 }))
  if (p === `${T}/stages/brief/run`) { stageStatus = { ...stageStatus, brief: 'review' }; return Promise.resolve(ok({ run_id: 'run_b', stage: {} }, 202)) }
  if (p === `${T}/stages/topics/run`) { stageStatus = { ...stageStatus, topics: 'running' }; return Promise.resolve(ok({ run_id: 'run_x', stage: {} }, 202)) }
  if (p === `${T}/stages/brief/approve`) { stageStatus = { ...stageStatus, brief: 'done' }; return Promise.resolve(ok({ ok: true, status: 'done' })) }
  if (p === `${T}/stages/brief/reject`) { stageStatus = { ...stageStatus, brief: 'draft', ...(body.to === 'topics' ? { topics: 'draft' } : {}) }; feedback = body.comment; return Promise.resolve(ok({ ok: true, status: 'draft' })) }
  if (p === `${T}/stages/copy/enabled`) { stageStatus = { ...stageStatus, copy: body.enabled ? 'draft' : 'skipped' }; return Promise.resolve(ok({ ok: true, status: stageStatus.copy, enabled: body.enabled })) }
  if (p === '/sessions/s_brief/messages') return Promise.resolve(ok([{ id: 'm1', role: 'user', content: '主題資料夾：/tmp/ws/marketing/20260829_循環包裝箱' }]))
  return mockFetch(input, init)
}

beforeEach(() => {
  setupMocks({ loggedIn: true })
  setFetchImpl(fakeFetch as typeof fetch)
  calls.length = 0
  installed = null
  topics = []
  feedback = ''
  stageStatus = { topics: 'done', brief: 'review', copy: 'draft' }
})

function renderBoard(route: string) {
  return renderApp(
    <Routes>
      <Route path="/packs" element={<PacksPage />} />
      <Route path="/packs/:name" element={<StageBoard />} />
    </Routes>,
    { route },
  )
}

describe('PacksPage', () => {
  it('列出套件、階段與員工；安裝後出現「開啟階段視圖」；壞套件列在錯誤區', async () => {
    renderBoard('/packs')
    const card = within(await screen.findByTestId('pack-marketing'))
    expect(card.getByText('行銷套件')).toBeInTheDocument()
    expect(card.getByText('Brief ✋')).toBeInTheDocument()
    expect(card.getByText('內容文案')).toBeInTheDocument()
    expect(card.queryByTestId('open-marketing')).not.toBeInTheDocument()
    await userEvent.click(await card.findByTestId('install-marketing'))
    await waitFor(() => expect(screen.getByTestId('open-marketing')).toBeInTheDocument())
    expect(calls.find((c) => c.path === '/packs/marketing/install')?.method).toBe('POST')
    expect(screen.getByText(/未知欄位/)).toBeInTheDocument()
  })
})

describe('StageBoard', () => {
  it('未安裝 → 提示去安裝', async () => {
    renderBoard('/packs/marketing')
    expect(await screen.findByText('套件尚未安裝')).toBeInTheDocument()
  })
  it('建新主題 → 資料夾清單出現、六階段卡橫排、第一階段可執行', async () => {
    installed = { id: 'pk_1', name: 'marketing', version: '0.1.0', installed_at: '2026-08-29T00:00:00', agents: {}, workflows: {}, profiles_created: [] }
    renderBoard('/packs/marketing')
    expect(await screen.findByText('還沒有主題，先建一個')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('new-topic'))
    await userEvent.type(screen.getByTestId('topic-title'), '循環包裝箱')
    await userEvent.click(screen.getByTestId('topic-create'))
    expect(calls.find((c) => c.path === '/packs/marketing/topics' && c.method === 'POST')?.body).toEqual({ title: '循環包裝箱', notes: '' })
    expect(await screen.findByTestId('topic-20260829_循環包裝箱')).toBeInTheDocument()
    const row = within(await screen.findByTestId('stage-row'))
    expect(row.getAllByTestId(/^stage-(topics|brief|copy)$/)).toHaveLength(3)
    expect(row.getByTestId('run-topics')).toBeEnabled()
    expect(row.getByTestId('run-brief')).toBeDisabled()
    await userEvent.click(row.getByTestId('run-topics'))
    expect(calls.find((c) => c.path.endsWith('/stages/topics/run'))?.method).toBe('POST')
    await waitFor(() => expect(row.getByTestId('stage-topics-status')).toHaveTextContent('執行中'))
  })
  it('待核准階段：核准 → done；退回帶意見 → draft 顯示退回意見；右欄顯示員工與對話', async () => {
    installed = { id: 'pk_1', name: 'marketing', version: '0.1.0', installed_at: '2026-08-29T00:00:00', agents: {}, workflows: {}, profiles_created: [] }
    topics = [topicSummary()]
    renderBoard('/packs/marketing?topic=20260829_循環包裝箱&stage=brief')
    const brief = within(await screen.findByTestId('stage-brief'))
    expect(brief.getByTestId('stage-brief-status')).toHaveTextContent('待核准')
    // 右欄
    const side = within(screen.getByTestId('stage-side'))
    expect(side.getByText('研究策略')).toBeInTheDocument()
    await userEvent.click(side.getByTestId('open-conversation'))
    expect(await screen.findByTestId('conversation-modal')).toBeInTheDocument()
    expect(await screen.findByText(/主題資料夾/)).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    // 產出檔案預覽
    await userEvent.click(within(screen.getByTestId('stage-topics')).getByTestId('file-topic.md'))
    expect(await screen.findByTestId('pack-file-preview')).toBeInTheDocument()
    expect(await screen.findByText('角度一')).toBeInTheDocument()
    await userEvent.click(within(screen.getByTestId('pack-file-preview')).getByRole('button', { name: '關閉' }))
    // 退回
    expect(brief.getByTestId('reject-brief')).toBeDisabled()
    await userEvent.type(brief.getByPlaceholderText(/退回意見/), '受眾太寬')
    await userEvent.click(brief.getByTestId('reject-brief'))
    expect(calls.find((c) => c.path.endsWith('/stages/brief/reject'))?.body).toEqual({ comment: '受眾太寬' })
    await waitFor(() => expect(screen.getByTestId('stage-brief-status')).toHaveTextContent('未開始'))
    expect(screen.getByText(/退回意見：受眾太寬/)).toBeInTheDocument()
    // 重跑（fake：直接回到待核准）後核准
    await userEvent.click(screen.getByTestId('run-brief'))
    await waitFor(() => expect(screen.getByTestId('stage-brief-status')).toHaveTextContent('待核准'))
    await userEvent.click(screen.getByTestId('approve-brief'))
    await waitFor(() => expect(screen.getByTestId('stage-brief-status')).toHaveTextContent('完成'))
    expect(calls.find((c) => c.path.endsWith('/stages/brief/approve'))?.method).toBe('POST')
    await waitFor(() => expect(screen.getByTestId('run-copy')).toBeEnabled())
  })
})

describe('StageBoard：判斷條件／角色／交付物、退回到指定節點、可關閉階段', () => {
  it('階段卡顯示三欄與 AI 建議；退回選節點會帶 to；可關閉階段能關掉再開', async () => {
    installed = { id: 'pk_1', name: 'marketing', version: '0.1.0', installed_at: '2026-08-29T00:00:00', agents: {}, workflows: {}, profiles_created: [] }
    topics = [topicSummary()]
    renderBoard('/packs/marketing?topic=20260829_循環包裝箱&stage=copy')
    const copy = within(await screen.findByTestId('stage-copy'))
    const spec = within(copy.getByTestId('stage-copy-spec'))
    expect(spec.getByText(/三檔齊全/)).toBeInTheDocument()
    expect(spec.getByText(/內容文案 → 人核准/)).toBeInTheDocument()
    expect(spec.getByText(/copy\/fb.md：Hook/)).toBeInTheDocument()
    expect(screen.queryByTestId('stage-topics-spec')).not.toBeInTheDocument()
    // AI 建議退回
    const brief = within(screen.getByTestId('stage-brief'))
    expect(brief.getByTestId('hint-brief')).toHaveTextContent('AI 建議退回到：topics')
    await userEvent.type(brief.getByPlaceholderText(/退回意見/), '素材太舊')
    await userEvent.selectOptions(brief.getByTestId('reject-to-brief'), 'topics')
    await userEvent.click(brief.getByTestId('reject-brief'))
    expect(calls.find((c) => c.path.endsWith('/stages/brief/reject'))?.body).toEqual({ comment: '素材太舊', to: 'topics' })
    await waitFor(() => expect(screen.getByTestId('stage-topics-status')).toHaveTextContent('未開始'))
    // 關閉 copy → 已關閉、沒有執行鈕；再開啟
    await userEvent.click(copy.getByTestId('toggle-copy'))
    expect(calls.find((c) => c.path.endsWith('/stages/copy/enabled'))?.body).toEqual({ enabled: false })
    await waitFor(() => expect(screen.getByTestId('stage-copy-status')).toHaveTextContent('已關閉'))
    expect(screen.queryByTestId('run-copy')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('toggle-copy'))
    await waitFor(() => expect(screen.getByTestId('stage-copy-status')).toHaveTextContent('未開始'))
  })
})
