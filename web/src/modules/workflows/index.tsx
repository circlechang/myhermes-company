// 工作流模組：清單在 pages/WorkflowsPage（/workflows），這裡註冊編輯／快照／審批路由與 i18n
import type { StudioModule } from '../registry'
import { ApprovalsPage } from './ApprovalsPage'
import { EditorPage } from './EditorPage'
import { en, zhTW } from './i18n'
import { RunPage } from './RunPage'

const mod: StudioModule = {
  name: 'workflows',
  routes: [
    { path: '/workflows/approvals', element: <ApprovalsPage /> },
    { path: '/workflows/runs/:runId', element: <RunPage /> },
    { path: '/workflows/:id', element: <EditorPage /> },
  ],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
