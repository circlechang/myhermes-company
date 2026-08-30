# 版面與導覽（Layout / Sidebar / TopBar）

日期：2026-08-29　範圍：`web/src/components/Layout.tsx`、`web/src/components/nav/**`、`web/src/modules/registry.ts`、`web/src/i18n/*.json`、各模組 `nav` 欄位（只加 `group`/`icon`/`order`）。App.tsx 的路由聚合沒動。

## 完成條件對照

| 項目 | 狀態 | 怎麼驗 | 備註／已知限制 |
|---|---|---|---|
| 左側 icon rail，可展開成寬側欄，狀態記 localStorage | ☑ | vitest `layout.test.tsx`「展開／收合」「重新載入沿用」；Playwright 換新分頁後仍是收合 | key `mhc.sidebar` = `expanded`/`collapsed`，預設展開 |
| 分群：工作／AI 員工／連接／系統，沒指定的放「其他」 | ☑ | vitest `groupNav` 單元測試＋側欄四群都在 | 「其他」群只在有未分群項目時出現 |
| registry `nav` 支援 `group`、`icon`（lucide-react） | ☑ | `tsc --noEmit` 綠 | icon 是字串名，對照表在 `components/nav/icons.ts`，未知名稱退回圓點；新增 icon 要加進對照表（避免整包 lucide 進 bundle） |
| 頂欄：logo＋產品名、當前頁標題、搜尋鈕、收件匣鈕、語言、主題、使用者選單（登出） | ☑ | vitest「頂欄」「主題切換／登出」；截圖 | 當前頁標題＝最長前綴匹配的導覽項（`/workflows/runs/x` → 工作流） |
| 搜尋鈕觸發既有 Ctrl+K | ☑ | vitest 攔到 `keydown{key:'k',ctrlKey}` | WorkbenchPage 在 window 上監聽；離開工作臺頁按了沒反應（既有行為，聊天模組沒有全域搜尋） |
| 收件匣 badge，`/inbox` 可缺省 | ☑ | vitest：無 `/inbox` 模組時連到 `/workflows/approvals`；有時連 `/inbox` 並打 `GET /inbox/count` → `{count}` | 任何模組也可 `window.dispatchEvent(new CustomEvent('mhc:inbox',{detail:{count}}))` 即時更新；只在掛載時抓一次，沒有輪詢 |
| 手機：側欄變抽屜，無底部 tab bar | ☑ | vitest「手機抽屜」（mock matchMedia）；Playwright 390px 截圖，scrollWidth=390（不橫向捲動） | 斷點 `(max-width: 767px)`；手機時語言切換移到使用者選單內 |
| 深淺色跟 theme 模組 `data-theme` | ☑ | Playwright 點頂欄切換後 `data-theme=dark`，截圖 `desktop-dark.png` | 切換走 theme 模組 `applyTheme()`（寫 `<html data-theme>`＋localStorage 快取），並盡力 `PUT /theme {settings:{mode}}` 同步到伺服器；tailwind darkMode variant 不變 |
| 鍵盤 `g` 再 `w/a/k/f` | ☑ | 手動 | 1.5 秒內按第二鍵；輸入框內不觸發 |
| 既有 18 條路由可用 | ☑ | vitest 檢查側欄含全部 18 個 href；`npm run build` 綠 | 另外兩個同事新加的模組（`/inbox`、`/limits`）也已分群 |

## 分群結果

- 工作：工作臺、收件匣、群聊、工作流、看板、Coding Agents
- AI 員工：AI 員工、Profile、模型、Skills
- 連接：頻道、排程、檔案
- 系統：用量、成本護欄、外觀、日誌、語音、管理（Terminal／MCP／Plugins 是 `/admin` 內的分頁，沒有獨立路由，所以放系統群一個項目）、Hermes 狀態
- Memory/Journey 目前沒有獨立路由（在 Profile 頁內），未列側欄。

## 驗證紀錄

```
cd web && npx tsc --noEmit                 # 綠
npx vitest run --exclude "e2e/**"          # 98/99：唯一紅的是 coding_agents 串流測試，
                                           #   排除 layout.test.tsx 後同樣紅、單跑綠 → 全套並行時的既有 flake，非本次造成
npm run build                              # ✓ built
VITE_MOCK=1 vite --port 5199 + Playwright  # 五種版面各截一張（桌面展開／收合／深色／手機關閉／手機抽屜）
```

Playwright 腳本用 mock 模式登入 admin/admin，經側欄點連結導頁（mock 模式整頁重載會掉登入態，所以沒用 `goto`）。

## 依賴

- 新增 `lucide-react@0.468.0`（ISC 授權）到 `web/package.json`。

## 測試檔的坑

Node 25 內建 `globalThis.localStorage`，在 vitest jsdom 環境下會蓋掉 jsdom 的，沒帶 `--localstorage-file` 就丟 SecurityError。`layout.test.tsx` 自己塞了一個記憶體版 Storage；其他要碰 localStorage 的測試也會遇到，建議之後統一放 `src/test/setup.ts`（本次不在我的改動範圍）。

## 沒做／待決

- `e2e/crawl.spec.ts`（QA 同事的 Playwright spec）會被 vitest 撿到而報錯，需要在 `vite.config.ts` 的 `test.exclude` 加 `e2e/**`（不在我的範圍）。
- 收件匣數字沒有輪詢／WS 推播，靠事件或重新掛載更新。
