# 使用者引導（Tour／說明抽屜／空狀態／範例工作流）

日期：2026-08-29　起因：使用者回報「實際使用時有時候不知道功能怎麼用」。

範圍：`web/src/guide/i18n.ts`、`web/src/help/**`、`web/src/components/guide/{Tour,HelpDrawer}.tsx`、`web/src/components/EmptyState.tsx`、`web/src/modules/workflows/template.ts`、`components/nav/{TopBar,Sidebar,icons}`（TopBar 是任務明講可改；Sidebar 只加 `data-tour` 屬性）、七個頁面的空列表位置。沒動 App/Layout/i18n json/main。

## 完成條件對照

| 項目 | 狀態 | 怎麼驗 | 備註／已知限制 |
|---|---|---|---|
| 首次導覽 6 步，spotlight 高亮真實元素，可跳過、使用者選單「重看導覽」 | ☑ | vitest `guidance.test.tsx`「自動出現／跳過不重複」「六步走完」「重看」；Playwright `guidance.spec.ts` 新帳號登入走完 | 自寫輕量元件（零依賴，沒用 driver.js）；key `mhc.tour.done=1`；目標元素靠 `data-tour="sidebar"`、`nav-<key>`、頂欄 `inbox`；手機側欄不在 DOM → popover 置中、無 spotlight；Esc／←→ 鍵可用 |
| 每頁「？」抽屜：這頁做什麼／怎麼用／常見問題／相關頁 | ☑ | vitest 依路由切換內容＋`helpFor` 覆蓋側欄全部路由；Playwright 工作臺→工作流標題切換 | 24 條路由（含 `/workflows/approvals`、`/workflows/runs`）；最長前綴匹配；en 是骨架（短版）；文案依 USER_GUIDE 與各模組字串，未逐頁實機操作驗證每句話 |
| 空狀態卡（共用 `EmptyState`） | ☑ | vitest 渲染／動作／連結；Playwright 工作臺 `empty-sessions` 截圖 | 工作臺（建立新對話）、工作流（載入範例＋自己新建）、群聊房間（建立房間，compact）、看板（建第一張卡）、事件（→工作臺）、收件匣（→工作流）、頻道（全部未設定時→捲到 LINE 表單）、畫布無節點（載入範例）。看板「空」判定是整個板沒卡，不是單欄 |
| 範例工作流一鍵載入 | ☑ | curl `POST /workflows` 用同一形狀 → 201、4 節點 3 邊，已刪 | 走 `wfApi.create`（`/workflows/import` 需要 export 格式包裝，不用它）；員工依啟用清單輪流指派；畫布內載入只換圖不存檔，仍要按儲存 |
| 測試全綠 | ☑ | vitest 18 檔 115 測試；`npm run build`；Playwright 37 條（含新加 1 條） | 既有 `workbench.spec.ts` 第 14 行 locator 改限定側欄（空狀態按鈕也含「新對話」）；`e2e/helpers.ts` 的 `login/loginFast` 先寫 `mhc.tour.done`，避免導覽遮罩擋既有 e2e |

## 沒做／待決
- 導覽只在桌面有 spotlight；手機退回純說明卡。
- 說明文案是 zh-TW 主、en 短骨架；之後若改模組行為要同步 `src/help/pages.zh-TW.ts`。
- 沒有「每個空狀態都在真機出現」的截圖，只有工作臺（新帳號必空）與工作流清單（新帳號亦空，順帶出現在 help-drawer.png）。
