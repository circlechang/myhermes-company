import type { StudioModule } from '../registry'
import { CodingPage } from './CodingPage'

const zhTW = {
  nav: { coding: 'Coding Agents' },
  coding: {
    title: 'Coding Agents', subtitle: 'Claude Code / Codex / Pi：安裝、設定、啟動與監看',
    installed: '已安裝', notInstalled: '未安裝', install: '一鍵安裝', installStatus: '安裝進度', npmMissing: '找不到 npm，請先安裝 Node.js',
    settings: '設定', settingsFor: '{{agent}} 設定', workspace: '工作區', workspaceHint: '工作區路徑（留空用預設）', browse: '瀏覽', useThis: '選這個',
    model: '模型', modelHint: '留空用 CLI 預設', apiMode: 'API 模式', apiModeDirect: '直連（自備 key／登入）', apiModeHermes: '走 Hermes（本機相容 proxy）',
    hermesProfile: 'Hermes profile', permissionMode: '權限模式', maxTurns: '最多回合', maxBudget: '預算上限（USD）', sandbox: '沙箱',
    proxyHint: '也可以在自己的終端用這些設定跑 CLI：',
    sessions: 'Session', newSession: '新開 Session', noSessions: '還沒有 session', noSession: '選一個 session，或新開一個', confirmDelete: '刪除這個 session 與所有紀錄？',
    externalId: 'CLI session id', wsConnected: '已連線', wsDisconnected: '未連線',
    tab: { output: '輸出', diff: '檔案 diff' }, emptyOutput: '輸入任務後按執行', you: '你', agent: 'Agent', toolRunning: '執行中', toolDone: '完成',
    cancelled: '已中止', usage: '用量', prompt: '任務', promptHint: '描述要做的事，Enter 執行，Shift+Enter 換行', run: '執行', stop: '中止', attachImage: '附圖',
    diff: { none: '這次執行還沒有 diff', notGit: '工作區不是 git repo，無法比對', before: '執行前（git diff HEAD）', after: '執行後（git diff HEAD）', clean: '（乾淨）' },
  },
}

const en = {
  nav: { coding: 'Coding Agents' },
  coding: {
    title: 'Coding Agents', subtitle: 'Claude Code / Codex / Pi: install, configure, run, watch',
    installed: 'Installed', notInstalled: 'Not installed', install: 'Install', installStatus: 'Install job', npmMissing: 'npm not found',
    settings: 'Settings', settingsFor: '{{agent}} settings', workspace: 'Workspace', workspaceHint: 'Workspace path (blank = default)', browse: 'Browse', useThis: 'Use this',
    model: 'Model', modelHint: 'blank = CLI default', apiMode: 'API mode', apiModeDirect: 'Direct (own key/login)', apiModeHermes: 'Via Hermes (local proxy)',
    hermesProfile: 'Hermes profile', permissionMode: 'Permission mode', maxTurns: 'Max turns', maxBudget: 'Budget (USD)', sandbox: 'Sandbox',
    proxyHint: 'You can also run the CLI from your own terminal with:',
    sessions: 'Sessions', newSession: 'New session', noSessions: 'No sessions yet', noSession: 'Pick a session or create one', confirmDelete: 'Delete this session and its history?',
    externalId: 'CLI session id', wsConnected: 'connected', wsDisconnected: 'disconnected',
    tab: { output: 'Output', diff: 'File diff' }, emptyOutput: 'Type a task and run', you: 'You', agent: 'Agent', toolRunning: 'running', toolDone: 'done',
    cancelled: 'cancelled', usage: 'Usage', prompt: 'Task', promptHint: 'Describe the task. Enter to run, Shift+Enter for newline', run: 'Run', stop: 'Stop', attachImage: 'Image',
    diff: { none: 'No diff for this run yet', notGit: 'Workspace is not a git repo', before: 'Before (git diff HEAD)', after: 'After (git diff HEAD)', clean: '(clean)' },
  },
}

const mod: StudioModule = {
  name: 'coding_agents',
  routes: [{ path: '/coding', element: <CodingPage /> }],
  nav: [{ to: '/coding', key: 'coding', order: 60, group: 'work', icon: 'Code2' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
