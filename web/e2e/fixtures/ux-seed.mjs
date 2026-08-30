// UX 極端資料：node ux-seed.mjs seed|clean  （密碼只從 E2E_PASS 讀）
import fs from 'node:fs'
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8700'
const STATE = new URL('./ux-seed.state.json', import.meta.url)
const mode = process.argv[2] ?? 'seed'
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.E2E_USER ?? 'admin', password: process.env.E2E_PASS }) })
if (!login.ok) { console.error('login failed', login.status); process.exit(1) }
const { token } = await login.json()
const H = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const call = async (m, p, body) => { const r = await fetch(`${BASE}/api${p}`, { method: m, headers: H, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t } if (!r.ok) console.error(m, p, r.status, t.slice(0, 200)); return j }

const LONG_TITLE_60 = '循環包裝箱如何幫電商省下百分之三十包材成本並同時降低碳排放與倉儲空間壓力的完整工作流程與驗證步驟說明文件'.slice(0, 60)
const SLUG = 'circular-box-saves-30pct-and-more-really-long-identifier-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const LONG_DESC = '這是一段超長的描述，用來測試版面：循環包裝箱如何幫電商省下 30% 包材成本；'.repeat(6) + ' ' + SLUG + ' ' + '~/.myhermescompany/workspace/content-pipeline/20260830_circular-box-saves-30pct/very/long/path/to/some/output/file-name-that-goes-on-and-on.md'

if (mode === 'seed') {
  const st = {}
  const agents = await call('GET', '/agents')
  const ag = agents.find((a) => a.profile === 'default') ?? agents[0]
  const wf = await call('POST', '/workflows', { name: LONG_TITLE_60, description: LONG_DESC, nodes: [
    { id: 'a', title: '第一步：從供應商試算表匯入最近三個月的包材採購數量與單價並整理成表格供後續比較', kind: 'hermes', agent_id: ag.id, prompt: '只回覆一個字：好', position: { x: 0, y: 0 } },
    { id: 'b', title: SLUG, kind: 'hermes', agent_id: ag.id, prompt: '只回覆一個字：好', position: { x: 350, y: 0 } },
  ], edges: [{ id: 'a-b-output', source: 'a', target: 'b' }], viewport: { x: 0, y: 0, zoom: 1 } })
  st.workflow = wf.id
  const s1 = await call('POST', '/sessions', { agent_id: ag.id, title: SLUG })
  const s2 = await call('POST', '/sessions', { agent_id: ag.id, title: '循環包裝箱如何幫電商省下 30% 包材成本——這是一個標題非常長的對話用來測試側欄清單的截斷效果' })
  st.sessions = [s1.id, s2.id]
  const room = await call('POST', '/groupchat/rooms', { name: '循環包裝箱如何幫電商省下百分之三十包材成本專案討論群組（含供應鏈與倉儲）'.slice(0, 40), agent_ids: [ag.id] })
  st.room = room.id
  const card = await call('POST', '/kanban/tasks', { title: ('循環包裝箱如何幫電商省下 30% 包材成本：' + SLUG).slice(0, 50), body: LONG_DESC + '\n\n' + '第二段：'.padEnd(200, '這是很長的內容') })
  st.card = card.id ?? card.task_id ?? card?.task?.id
  const ag2 = await call('POST', '/agents', { name: 'UX 測試員工 ' + SLUG, profile: ag.profile, title: '長描述測試', description: LONG_DESC })
  st.agent = ag2.id
  const prof = await call('POST', '/profiles', { name: 'uxtest-longdesc', description: LONG_DESC, no_skills: true })
  st.profile = prof?.name ? 'uxtest-longdesc' : null
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2))
  console.log(JSON.stringify(st))
} else {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  if (st.workflow) await call('DELETE', `/workflows/${st.workflow}`)
  for (const s of st.sessions ?? []) await call('DELETE', `/sessions/${s}`)
  if (st.room) await call('DELETE', `/groupchat/rooms/${st.room}`)
  if (st.agent) await call('DELETE', `/agents/${st.agent}`)
  if (st.profile) await call('DELETE', `/profiles/${st.profile}`)
  console.log('cleaned (kanban card', st.card, 'needs hermes kanban archive --rm)')
}
