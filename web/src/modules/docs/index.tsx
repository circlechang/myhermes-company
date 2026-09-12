// docs 模組：文件＝第一級物件。
// /docs 清單、/docs/:id 血緣視圖、/doc-mode 文件模式工作臺（左聊天右文件）。
import type { StudioModule } from '../registry'
import { DocDetailPage } from './DocDetailPage'
import { DocModePage } from './DocModePage'
import { DocsListPage } from './DocsListPage'

export * from './api'
export { DocPanel } from './DocPanel'
export { DocActions } from './DocActions'
export { DiffView, DiffStatBadge } from './DiffView'
export { LineageGraph, layout } from './LineageGraph'
export { DocsListPage, DocDetailPage, DocModePage }

const zhTW = {
  nav: { docs: '文件', docMode: '文件模式' },
  docs: {
    title: '文件',
    subtitle: '每一份 .md 都有版本、diff 與血緣；工作區裡看得到同一份檔案',
    empty: '還沒有文件。',
    new: '建立',
    newTitle: '新文件標題',
    rename: '改名字',
    renameHint: '點一下改名字（工作區的檔名會跟著換）',
    versions: '版本歷史',
    noVersions: '還沒有版本（AI 的第一份輸出就是 v1）。',
    latest: '最新',
    chars: '字',
    diff: '差異',
    diffPrev: '與上一版比',
    diffLatest: '與最新比',
    revertTo: '還原到此版',
    fork: '分出一份',
    archive: '封存',
    archiveHint: '收起來不刪：清單預設不顯示，隨時可取消封存',
    unarchive: '取消封存',
    deleteHint: '刪掉版本紀錄與血緣；工作區裡的檔案會留著',
    confirmDelete: '確定刪除「{{title}}」？版本紀錄與血緣會一起刪掉，工作區裡的檔案會保留。',
    showArchived: '顯示封存（{{n}}）',
    hideArchived: '隱藏封存',
    updatedAt: '更新於',
    driftShort: '檔案已被外部改動',
    status: { draft: '草稿', review: '審核中', final: '定稿', archived: '封存' },
    origin: { chat: '對話', workflow: '工作流', pack: '套件', upload: '上傳' },
    author: { human: '人', agent: 'AI' },
    linkKind: { derived: '延伸', split: '分岔', merged: '合併', selected: '選中' },
    filter: {
      status: '狀態', origin: '來源', stage: '站別', search: '搜尋標題／路徑',
      allStatus: '全部狀態', allOrigin: '全部來源', allStage: '全部站別',
    },
    workbench: {
      open: '開一份文件',
      openHint: '把這個對話變成經營一份文件：AI 每輪會更新它，右側可直接預覽',
      bound: '文件模式',
    },
    panel: {
      title: '文件',
      latest: '最新版',
      history: '版本',
      showDiff: '看差異',
      showDoc: '看文件',
      edit: '編輯',
      save: '存成新版本',
      saveHint: '存檔＝人類作者的新版本',
      empty: '（還沒有內容，跟 AI 說第一句話）',
      newVersion: '新版本 v{{v}}',
      accept: '接受',
      revert: '還原上一版',
      drift: '工作區的 .md 檔和最新版本不一樣（有人從別的地方改過）',
      snapshot: '把檔案現況存成新版本',
    },
    lineage: { title: '血緣：從哪來、去了哪', empty: '（還沒有血緣）' },
    mode: {
      docs: '文件',
      pickDoc: '先選一份文件',
      emptyTitle: '還沒有文件：建一份，之後每次對話都是在把它寫完。',
      createFirst: '建第一份文件',
      hint: '左邊選一份文件，或建一份新的：這個對話串的目標就是把它寫完。',
      noSession: '這份文件還沒有對話。',
      start: '開始對話',
      firstTurn: '說出你要的東西，AI 每一輪都會把整份文件更新一次。',
      patchFailed: '差異套不上（{{reason}}），已請 AI 重出全文。',
    },
  },
}

const en = {
  nav: { docs: 'Docs', docMode: 'Doc mode' },
  docs: {
    title: 'Documents',
    subtitle: 'Every .md is versioned, diffable and has lineage; the same file is visible in the workspace',
    empty: 'No documents yet.',
    new: 'Create',
    newTitle: 'New document title',
    versions: 'Version history',
    noVersions: 'No versions yet (the first AI output becomes v1).',
    latest: 'latest',
    chars: 'chars',
    diff: 'Diff',
    diffPrev: 'Diff prev',
    diffLatest: 'Diff latest',
    revertTo: 'Revert to this',
    fork: 'Fork',
    archive: 'Archive',
    archiveHint: 'Hide without deleting; hidden from the list by default, can be unarchived anytime',
    unarchive: 'Unarchive',
    deleteHint: 'Deletes versions and lineage; the file in the workspace is kept',
    confirmDelete: 'Delete "{{title}}"? Versions and lineage go with it; the workspace file is kept.',
    showArchived: 'Show archived ({{n}})',
    hideArchived: 'Hide archived',
    updatedAt: 'updated',
    driftShort: 'file changed outside',
    status: { draft: 'Draft', review: 'In review', final: 'Final', archived: 'Archived' },
    origin: { chat: 'Chat', workflow: 'Workflow', pack: 'Pack', upload: 'Upload' },
    author: { human: 'Human', agent: 'AI' },
    linkKind: { derived: 'derived', split: 'split', merged: 'merged', selected: 'selected' },
    filter: {
      status: 'Status', origin: 'Origin', stage: 'Stage', search: 'Search title / path',
      allStatus: 'All statuses', allOrigin: 'All origins', allStage: 'All stages',
    },
    workbench: {
      open: 'Open a document',
      openHint: 'Turn this conversation into work on a document: the AI updates it each turn, previewed on the right',
      bound: 'Document mode',
    },
    panel: {
      title: 'Document',
      latest: 'Latest',
      history: 'Versions',
      showDiff: 'Diff',
      showDoc: 'Document',
      edit: 'Edit',
      save: 'Save as new version',
      saveHint: 'Saving creates a human-authored version',
      empty: '(empty — say the first thing to the AI)',
      newVersion: 'New version v{{v}}',
      accept: 'Accept',
      revert: 'Revert previous',
      drift: 'The .md on disk differs from the latest version',
      snapshot: 'Snapshot the file',
    },
    lineage: { title: 'Lineage: where it came from, where it went', empty: '(no lineage yet)' },
    mode: {
      docs: 'Documents',
      pickDoc: 'Pick a document first',
      emptyTitle: 'No documents yet: create one, and every conversation after that works on finishing it.',
      createFirst: 'Create the first document',
      hint: 'Pick a document on the left, or create one: this thread exists to finish it.',
      noSession: 'No conversation for this document yet.',
      start: 'Start chatting',
      firstTurn: 'Say what you want; every turn rewrites the whole document.',
      patchFailed: 'Patch did not apply ({{reason}}); asked the AI for the full text.',
    },
  },
}

const mod: StudioModule = {
  name: 'docs',
  routes: [
    { path: '/docs', element: <DocsListPage /> },
    { path: '/docs/:id', element: <DocDetailPage /> },
    { path: '/doc-mode', element: <DocModePage /> },
  ],
  nav: [
    { to: '/doc-mode', key: 'docMode', order: 11, icon: 'FileText', group: 'chat' },
    { to: '/docs', key: 'docs', order: 23, icon: 'Folder', group: 'work' },
  ],
  i18n: { 'zh-TW': zhTW, en },
}
export default mod
