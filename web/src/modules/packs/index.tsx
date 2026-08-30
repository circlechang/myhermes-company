// 行業套件模組：/packs 清單＋安裝、/packs/:name 階段視圖（資料夾當資料庫）
import type { StudioModule } from '../registry'
import './help'
import { en, zhTW } from './i18n'
import { PacksPage } from './PacksPage'
import { StageBoard } from './StageBoard'

const mod: StudioModule = {
  name: 'packs',
  routes: [
    { path: '/packs', element: <PacksPage /> },
    { path: '/packs/:name', element: <StageBoard /> },
  ],
  nav: [{ to: '/packs', key: 'packs', order: 18, group: 'work', icon: 'Puzzle' }],
  i18n: { 'zh-TW': { nav: { packs: zhTW.packs.nav }, ...zhTW }, en: { nav: { packs: en.packs.nav }, ...en } },
}
export default mod
