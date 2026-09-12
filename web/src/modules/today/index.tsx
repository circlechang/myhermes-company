// 「今天」：首頁。老闆的三個問題（等你決定／出問題的／花了多少）＋今天完成了什麼。「等你決定」就是收件匣。
import type { StudioModule } from '../registry'
import { TodayPage } from './TodayPage'

const zhTW = {
  nav: { today: '今天' },
  today: {
    title: '今天', subtitle: '等你決定的、出問題的、花了多少',
    decide: '等你決定', decideEmpty: '現在沒有等你的事',
    problems: '出問題的', problemsEmpty: '沒有失敗的', goWorkflows: '到流程', fixChannel: '去設定 →', openFlow: '打開流程 →',
    cost: '今天花了多少', costToday: '今天 {{amount}}', costMonth: '本月累計 {{amount}}', fxRate: '匯率 {{rate}}', fxLabel: '1 美元 = NT$', runs: '{{n}} 次執行', costTop: '花最多的員工', costWarn: '有護欄快到上限或已超過。', costNoLimit: '還沒設成本護欄。', goLimits: '成本護欄', goUsage: '看 30 日用量',
    done: '今天完成了什麼', doneEmpty: '今天還沒有完成的事',
    status: { failed: '失敗', budget_exceeded: '超出預算', needs_attention: '要人看', timeout: '逾時' },
  },
}
const en = {
  nav: { today: 'Today' },
  today: {
    title: 'Today', subtitle: 'What needs you, what broke, what it cost',
    decide: 'Needs your decision', decideEmpty: 'Nothing is waiting on you',
    problems: 'Went wrong', problemsEmpty: 'No failures', goWorkflows: 'Open flows', fixChannel: 'Fix settings →', openFlow: 'Open flow →',
    cost: 'Spent today', costToday: 'Today {{amount}}', costMonth: 'This month {{amount}}', fxRate: 'FX {{rate}}', fxLabel: '1 USD = NT$', runs: '{{n}} runs', costTop: 'Top spenders', costWarn: 'A guardrail is near or over its limit.', costNoLimit: 'No cost guardrail set yet.', goLimits: 'Limits', goUsage: '30-day usage',
    done: 'Done today', doneEmpty: 'Nothing finished yet today',
    status: { failed: 'Failed', budget_exceeded: 'Over budget', needs_attention: 'Needs attention', timeout: 'Timed out' },
  },
}

const mod: StudioModule = {
  name: 'today',
  routes: [{ path: '/today', element: <TodayPage /> }],
  nav: [{ to: '/today', key: 'today', order: 0, group: 'today', icon: 'Sun' }],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
