// 聊天／工作臺模組：不新增路由（工作臺仍在 `/`），只註冊 i18n 字串。
import type { StudioModule } from '../registry'

const zhTW = {
  chat: {
    copy: '複製', copied: '已複製', reply: '引用', edit: '編輯', regenerate: '重新生成', resend: '重送',
    replyingTo: '引用', editingLast: '正在編輯上一則訊息，送出後會刪掉之後的回覆重新生成', reasoning: '推理摘要',
    steer: '插話', steerPlaceholder: '回覆中… 輸入文字可插話（不中斷）', attach: '附加檔案', uploading: '上傳中（{{n}}）',
    dropHint: '可拖放檔案、Ctrl+V 貼圖', compressing: '上下文壓縮中…', archived: '封存',
    tool: { showMore: '展開全部（{{n}} 字）', showLess: '收合' },
    source: { workbench: '工作臺', cli: 'CLI', telegram: 'Telegram', discord: 'Discord', line: 'LINE', slack: 'Slack', whatsapp: 'WhatsApp', workflow: '工作流', group: '群聊', cron: '排程', api_server: 'API', tui: 'TUI', hermes: 'Hermes' },
    menu: { open: '更多', rename: '重新命名', archive: '封存', unarchive: '取消封存' },
    rename: { prompt: '新名稱' },
    confirmDelete: '確定刪除這個對話？訊息會一併刪除。',
    category: { filter: '分類篩選', all: '全部分類', manage: '管理分類', assign: '指派分類', none: '（無分類）', title: '分類', newName: '新分類名稱', add: '新增', color: '顏色', confirmDelete: '刪除分類？對話不會被刪除。' },
    search: { open: '搜尋對話', title: '搜尋對話', placeholder: '搜尋標題或訊息內容…', none: '沒有符合的對話', inTitle: '標題', inMessage: '訊息', hint: '↑↓ 選擇 · Enter 開啟 · Esc 關閉 · Ctrl/⌘+K 隨時開啟' },
    model: { title: '選擇模型', filter: '篩選模型…', useDefault: '使用 profile 預設模型', default: '預設', current: '目前', unauth: '未登入', fallback: 'gateway 沒有 /api/model/options，只列出虛擬模型', ctx: '上下文' },
    preview: { download: '下載', attach: '附回聊天', truncated: '（內容過長，已截斷）', noPreview: '此格式不支援預覽，請下載。', title: '預覽' },
    hermes: { title: 'Hermes 歷史', badge: 'Hermes', readonly: '唯讀', import: '匯入成 Studio 對話', none: '找不到 state.db' },
    mobile: { openSidebar: '開啟對話清單', closeSidebar: '關閉' },
    info: { tokens: 'Token 用量', inTok: '輸入', outTok: '輸出', ctxTok: '上下文' },
  },
}

const en = {
  chat: {
    copy: 'Copy', copied: 'Copied', reply: 'Quote', edit: 'Edit', regenerate: 'Regenerate', resend: 'Resend',
    replyingTo: 'Quoting', editingLast: 'Editing last message; later replies will be regenerated', reasoning: 'Reasoning',
    steer: 'Steer', steerPlaceholder: 'Replying… type to steer without stopping', attach: 'Attach files', uploading: 'Uploading ({{n}})',
    dropHint: 'Drop files or paste images', compressing: 'Compressing context…', archived: 'Archived',
    tool: { showMore: 'Show all ({{n}} chars)', showLess: 'Show less' },
    source: { workbench: 'Workbench', cli: 'CLI', telegram: 'Telegram', discord: 'Discord', line: 'LINE', slack: 'Slack', whatsapp: 'WhatsApp', workflow: 'Workflow', group: 'Group', cron: 'Cron', api_server: 'API', tui: 'TUI', hermes: 'Hermes' },
    menu: { open: 'More', rename: 'Rename', archive: 'Archive', unarchive: 'Unarchive' },
    rename: { prompt: 'New title' },
    confirmDelete: 'Delete this session and its messages?',
    category: { filter: 'Category filter', all: 'All categories', manage: 'Manage categories', assign: 'Assign category', none: '(none)', title: 'Categories', newName: 'New category', add: 'Add', color: 'Color', confirmDelete: 'Delete category? Sessions are kept.' },
    search: { open: 'Search sessions', title: 'Search sessions', placeholder: 'Search titles or messages…', none: 'No matches', inTitle: 'title', inMessage: 'message', hint: '↑↓ select · Enter open · Esc close · Ctrl/⌘+K' },
    model: { title: 'Pick model', filter: 'Filter models…', useDefault: 'Use profile default', default: 'default', current: 'current', unauth: 'not signed in', fallback: 'gateway lacks /api/model/options; virtual model only', ctx: 'ctx' },
    preview: { download: 'Download', attach: 'Attach to chat', truncated: '(truncated)', noPreview: 'No preview for this format; download instead.', title: 'Preview' },
    hermes: { title: 'Hermes history', badge: 'Hermes', readonly: 'read-only', import: 'Import as Studio session', none: 'No state.db found' },
    mobile: { openSidebar: 'Open sessions', closeSidebar: 'Close' },
    info: { tokens: 'Token usage', inTok: 'in', outTok: 'out', ctxTok: 'context' },
  },
}

const mod: StudioModule = { name: 'chat', routes: [], i18n: { 'zh-TW': zhTW, en } }
export default mod
