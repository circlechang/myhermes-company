// 首次設定精靈模組：路由 /setup 由 App.tsx 掛在 Layout 之外（全頁精靈，不進側欄）；這裡只註冊 i18n。
import type { StudioModule } from '../registry'
import { setupEn, setupZhTW } from './i18n'

export { SetupPage } from './SetupPage'
export { SetupGate } from './SetupGate'

const mod: StudioModule = {
  name: 'setup',
  routes: [],
  i18n: { 'zh-TW': setupZhTW, en: setupEn },
}
export default mod
