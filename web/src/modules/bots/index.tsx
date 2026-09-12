import type { StudioModule } from '../registry'

// Bots 訊息介面本身是全螢幕深色殼（App.tsx 在舊 Layout 外面掛 /bots/*），這裡只登記側欄入口與翻譯。
const mod: StudioModule = {
  name: 'bots',
  routes: [],
  nav: [{ to: '/bots', key: 'bots', order: 1, group: 'chat', icon: 'Bot' }],
  i18n: { 'zh-TW': { nav: { bots: 'Bots（訊息）' } }, en: { nav: { bots: 'Bots (messenger)' } } },
}
export default mod
