import type { StudioModule } from '../registry'
import { GroupChatPage } from './GroupChatPage'

const zhTW = {
  nav: { groupchat: '群聊' },
  groupchat: {
    title: '群聊', subtitle: '多位 AI 員工同房討論；@名稱 點名回覆',
    rooms: '房間', newRoom: '新房間', roomName: '房間名稱', policy: '無 @ 時', pickAgents: '加入的 AI 員工',
    policies: { none: '不回覆', round_robin: '輪流回覆', host: '主持人回覆' },
    inviteCode: '邀請碼', join: '加入', haveCode: '有邀請碼？', noRooms: '還沒有房間', pickRoom: '選一個房間，或建立新房間',
    settings: '房間設定', connected: '已連線', connecting: '連線中', disconnected: '未連線',
    thinking: '思考中…', replying: '回覆中…', usingTool: '使用工具 {{tool}}…', humanTyping: '{{names}} 輸入中…', compressing: '正在壓縮對話摘要…',
    empty: '房間裡有 {{n}} 位 AI 員工，用 @名稱 點名開始',
    inputPlaceholder: '輸入訊息，@ 點名 AI 員工，Enter 送出', input: '訊息', send: '送出',
    depthHint: 'AI 之間互相 @ 的深度', copy: '複製', regenerate: '重新產生',
    host: '主持人', pickHost: '選主持人', historyN: '帶入近期訊息數', threshold: '壓縮門檻（token）', maxDepth: 'AI 互 @ 深度上限',
    context: '上下文', contextStats: '摘要後累積 {{n}} 則／約 {{tokens}} token（門檻 {{threshold}}）', summaryBy: '目前摘要（{{by}}）', compressNow: '立即壓縮',
    members: '成員', addAgent: '加入 AI 員工…', add: '加入', remove: '移除 {{name}}',
    displayName: '顯示名稱', profile: '員工', model: '模型', modelDefault: '（用員工預設）', rolePrompt: '角色提示',
    confirmDelete: '確定刪除這個房間與所有訊息？', deleteRoom: '刪除房間',
  },
}
const en = {
  nav: { groupchat: 'Group chat' },
  groupchat: {
    title: 'Group chat', subtitle: 'Several AI staff in one room; @name to route a reply',
    rooms: 'Rooms', newRoom: 'New room', roomName: 'Room name', policy: 'Without @', pickAgents: 'AI staff to add',
    policies: { none: 'No reply', round_robin: 'Round robin', host: 'Host replies' },
    inviteCode: 'Invite code', join: 'Join', haveCode: 'Have an invite code?', noRooms: 'No rooms yet', pickRoom: 'Pick a room or create one',
    settings: 'Room settings', connected: 'connected', connecting: 'connecting', disconnected: 'disconnected',
    thinking: 'thinking…', replying: 'replying…', usingTool: 'using {{tool}}…', humanTyping: '{{names}} typing…', compressing: 'Compressing context…',
    empty: '{{n}} AI staff here. Start with @name',
    inputPlaceholder: 'Message; @ to mention; Enter to send', input: 'Message', send: 'Send',
    depthHint: 'AI-to-AI mention depth', copy: 'Copy', regenerate: 'Regenerate',
    host: 'Host', pickHost: 'Pick host', historyN: 'Recent messages sent', threshold: 'Compress threshold (tokens)', maxDepth: 'Max AI-to-AI depth',
    context: 'Context', contextStats: '{{n}} msgs / ~{{tokens}} tokens since summary (threshold {{threshold}})', summaryBy: 'Summary (by {{by}})', compressNow: 'Compress now',
    members: 'Members', addAgent: 'Add AI staff…', add: 'Add', remove: 'Remove {{name}}',
    displayName: 'Display name', profile: 'Staff', model: 'Model', modelDefault: '(staff default)', rolePrompt: 'Role prompt',
    confirmDelete: 'Delete this room and all messages?', deleteRoom: 'Delete room',
  },
}

const mod: StudioModule = {
  name: 'groupchat',
  routes: [{ path: '/groupchat', element: <GroupChatPage /> }],
  nav: [{ to: '/groupchat', key: 'groupchat', order: 12, group: 'chat', icon: 'MessageSquare' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
