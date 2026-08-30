// 「？」說明抽屜的 /packs 頁：從模組內登記，不動 src/help/pages.*
import { HELP_PAGES, type HelpPage } from '../../help'

const zh: HelpPage = {
  path: '/packs', title: '行業套件',
  what: ['一個套件＝一組 AI 員工＋工作流模板＋階段定義，例如行銷套件的六階段。', '安裝後在工作區用「資料夾當資料庫」推進：每個主題一個資料夾，產出都是裡面的 md 檔。'],
  how: ['在清單按「安裝」：會建 AI 員工（既有 profile 直接綁定）與每階段一個工作流。', '按「開啟階段視圖」，左邊「新主題」建一個資料夾。', '中間階段卡由左到右按「執行這階段」；AI 員工把產出寫進資料夾。', '標 ✋ 的階段跑完會進「待核准」並出現在收件匣；核准才能跑下一階段，退回要附意見。', '點產出檔名可預覽／編輯；右欄看負責員工與最近一次執行的對話。'],
  faq: [
    { q: '產出檔缺少？', a: 'AI 員工沒把檔案寫進資料夾（看右欄對話）。可退回重跑，或自己在預覽裡編輯補上。' },
    { q: '重新安裝會覆蓋 SOUL.md 嗎？', a: '不會。profile 已存在就不動；只更新工作流模板。' },
    { q: '自己寫套件？', a: '看 docs/PACKS.md：一個目錄含 pack.yaml、stages.yaml、workflows/*.json、profiles/*/SOUL.md。' },
  ],
  related: [{ to: '/inbox', label: '收件匣' }, { to: '/workflows', label: '工作流' }, { to: '/agents', label: 'AI 員工' }],
}
const en: HelpPage = {
  path: '/packs', title: 'Industry packs',
  what: ['A pack = AI staff + workflow templates + stage definitions.', 'After install, folders are the database: one folder per topic, outputs are markdown files inside.'],
  how: ['Install: creates agents (binds existing profiles) and one workflow per stage.', 'Open the stage board and create a topic.', 'Run stages left to right; the AI writes files into the folder.', 'Stages marked ✋ wait for approval (also in Inbox); send back with feedback.', 'Click a file to preview/edit; the right column shows the owner and last run.'],
  faq: [
    { q: 'Outputs missing?', a: 'The agent did not write the file; check the conversation, send back, or edit by hand.' },
    { q: 'Reinstall overwrites SOUL.md?', a: 'No. Existing profiles are never touched; only workflow templates update.' },
  ],
  related: [{ to: '/inbox', label: 'Inbox' }, { to: '/workflows', label: 'Workflows' }],
}
for (const [lng, pg] of [['zh-TW', zh], ['en', en]] as const) {
  const list = HELP_PAGES[lng]
  if (list && !list.some((p) => p.path === pg.path)) list.push(pg)
}
