// 看板模組：不註冊路由（/kanban 由 pages/KanbanPage.tsx 掛），只提供元件與 i18n 補充。
import type { StudioModule } from '../registry'

export { KanbanBoard } from './Board'
export * from './api'

const zhTW = {
  kanban: {
    subtitle: '與 hermes kanban 同一份資料；可依 profile 篩選、拖拉換狀態、派給 AI 員工執行',
    col: { todo: '待處理', ready: '就緒', running: '執行中', review: '審核', blocked: '卡住／排程', done: '完成' },
    status: { triage: '待分類', todo: '待處理', ready: '就緒', running: '執行中', review: '審核', blocked: '卡住', scheduled: '排程', done: '完成', archived: '封存' },
    filterProfile: '依 profile 篩選', allProfiles: '全部 profile', showArchived: '含封存', tags: '標籤',
    stuckCards: '{{n}} 張卡片需要處理', dragHandle: '拖拉 {{title}}', blockReason: '卡住原因（會寫成留言）',
    result: '結果', resultPlaceholder: '完成結果摘要（可留空）', complete: '完成',
    dispatch: '派給 AI 員工執行', dispatchProfile: '執行者', keepAssignee: '（維持目前指派）', dispatchNow: '派工',
    dispatchHint: '流程：指派 → 推到就緒 → 跑一輪 hermes kanban dispatch，由 dispatcher 依優先權啟動 worker；狀態會在幾秒內更新。',
    comments: '留言', commentPlaceholder: '寫留言…', addComment: '送出',
    attachments: '附件', attachmentsUnavailable: '（此版本 CLI 無法列出附件）', upload: '上傳附件',
    events: '事件', confirmArchive: '確定封存這張卡片？', archive: '封存',
  },
}
const en = {
  kanban: {
    subtitle: 'Same data as hermes kanban; filter by profile, drag to change status, dispatch to AI staff',
    col: { todo: 'To do', ready: 'Ready', running: 'Running', review: 'Review', blocked: 'Blocked / scheduled', done: 'Done' },
    status: { triage: 'Triage', todo: 'To do', ready: 'Ready', running: 'Running', review: 'Review', blocked: 'Blocked', scheduled: 'Scheduled', done: 'Done', archived: 'Archived' },
    filterProfile: 'Filter by profile', allProfiles: 'All profiles', showArchived: 'Include archived', tags: 'Tags',
    stuckCards: '{{n}} card(s) need attention', dragHandle: 'Drag {{title}}', blockReason: 'Block reason (added as comment)',
    result: 'Result', resultPlaceholder: 'Result summary (optional)', complete: 'Complete',
    dispatch: 'Dispatch to AI staff', dispatchProfile: 'Worker', keepAssignee: '(keep assignee)', dispatchNow: 'Dispatch',
    dispatchHint: 'assign → promote to ready → one `hermes kanban dispatch` pass; the dispatcher spawns workers by priority.',
    comments: 'Comments', commentPlaceholder: 'Write a comment…', addComment: 'Post',
    attachments: 'Attachments', attachmentsUnavailable: '(this CLI cannot list attachments)', upload: 'Upload',
    events: 'Events', confirmArchive: 'Archive this card?', archive: 'Archive',
  },
}

const mod: StudioModule = { name: 'kanban', routes: [], i18n: { 'zh-TW': zhTW, en } }
export default mod
