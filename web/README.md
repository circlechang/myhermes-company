# MyHermesCompany — 前端（web/）

React 18 + TypeScript + Vite + react-router v6 + TanStack Query v5 + Tailwind v3 + i18next。
後端契約：`../docs/API.md`（HTTP）與 `/ws/chat` 事件（WebSocket）。**本目錄不碰 `server/`。**

## 指令
```bash
export PATH=~/.nvm/versions/node/v25.2.0/bin:$PATH
npm install
npm run dev        # http://localhost:5173，/api 與 /ws proxy 到 127.0.0.1:8700
npm run dev:mock   # 同上，但不需後端（VITE_MOCK=1）
npm test           # vitest（jsdom + testing-library）
npm run build      # tsc --noEmit + vite build → dist/
```

## Mock 模式（沒有後端也能開發／測試）
- `VITE_MOCK=1 npm run dev`（或 `npm run dev:mock`）。畫面右上角會出現「Mock 模式」標籤。
- 帳密：`admin / admin`。
- 實作：不用 MSW，改用「換掉 fetch」（`src/api/client.ts` 的 `setFetchImpl`）與「換掉 WebSocket」
  （`src/ws/chatSocket.ts` 的 `setWebSocketImpl`）兩個注入點；`src/mock/fetch.ts` 依 API.md 回應並把狀態放記憶體，
  `src/mock/MockWebSocket.ts` 模擬 `/ws/chat` 事件流。原因：零額外依賴、測試可直接重用同一套 mock、不需 service worker。
- MockWebSocket 腳本規則：
  - 訊息含「審批 / approve / rm / 刪除」→ 先送 `approval.request`（審批卡），核准後跑工具＋回覆；拒絕則回覆不執行。
  - 訊息含「錯誤 / fail」→ `run.failed`。
  - 其他 → `tool.started/completed` ＋ 逐段 `message.delta` ＋ `run.completed`。
  - 測試可用 `ws.emit(event)` 直接推任意事件、`ws.sent` 檢查前端送了什麼。

## 頁面
| 路徑 | 內容 |
|---|---|
| `/login` | 帳密登入，token 存 localStorage（`mhc.token`），401 時自動登出 |
| `/` | 工作臺：左＝AI 員工清單＋該員工的對話清單（＋新對話／刪除）；中＝聊天（串流、工具卡可展開、審批卡 once/session/always/deny、停止）；右＝session 資訊（WS 狀態、profile、model、run id、usage） |
| `/agents` | AI 員工清單（啟用開關）＋ SOUL.md 編輯儲存 ＋ skills 清單 |
| `/kanban` | 五欄 backlog/todo/in_progress/review/done，讀 `/kanban/tasks`；新增卡片；用下拉「移到」改狀態（未做拖拉） |
| `/workflows` | 清單＋建立（建立時自動放一個 agent 節點以通過「≥1 節點」驗證）＋節點順序概覽；畫布區為「即將推出（M2）」占位 |
| `/settings` | Hermes 狀態：gateway、版本、API server、profiles 表；Studio 公司／成員／角色 |

## 決定記錄（沒問就自行拍板的地方）
1. **Vite proxy**：`/api/*` → `http://127.0.0.1:8700/*`（rewrite 掉 `/api`）；`/ws` → `ws://127.0.0.1:8700/ws`。
   正式部署時前端若與後端同源，把 `API_BASE`（`src/api/client.ts`）改成 `''` 或在反向代理做同樣 rewrite。
2. **WS 連線**：整個工作臺只開一條 `/ws/chat?token=`，事件依 `session_id` 分流到各 session 的本地狀態；斷線指數退避重連（最長 10s）。
3. **審批**：按下按鈕即本地鎖定四個按鈕並顯示決定；同時送 `{"type":"approval","run_id","decision","approval_id"}`
   （`approval_id` 是契約外多帶的欄位，後端可忽略）。若後端回 `approval.responded` 也會同步狀態。
4. **串流合併規則**（`src/ws/chatState.ts`，純函式）：連續 `message.delta` 疊進同一則 assistant 訊息；遇到 `tool.started` /
   `approval.request` 會切斷串流，後續 delta 開新泡泡；`run.completed` 若只帶 `output` 而沒 delta，補一則訊息。
5. **`tool.completed` 配對**：優先用 `call_id`（若後端有給），否則從後往前找同名且執行中的工具卡。
6. **歷史訊息**：每個 session 只合併一次；若使用者在歷史載入前就送了訊息，歷史接在前面（避免覆蓋串流內容）。
7. **看板未知狀態**：不在五欄內的 status 一律歸 backlog，卡片不消失。
8. **i18n**：`src/i18n/zh-TW.json` 為主，`en.json` 為對照骨架；語言存 localStorage（`mhc.lang`），預設 zh-TW。
9. **深淺色**：Tailwind `darkMode: 'media'`，跟隨系統，沒有手動切換。
10. **token 儲存**：localStorage 不可用時退到記憶體（隱私模式／測試環境不會壞）。
11. **沒有 ESLint/Prettier**：先靠 `tsc --strict`；要加再加。

## 測試覆蓋
- `login.test.tsx`：未登入導向、錯誤密碼、成功登入存 token 進工作臺、語言切換。
- `chatState.test.ts`：串流合併、工具卡配對、切斷規則、failed/completed。
- `chat.test.tsx`：假 WebSocket 下的歷史載入＋工具卡展開、送訊息串流渲染＋送出的 `run` 事件、直接 `emit` 事件、審批卡四鍵＋鎖定＋deny。
- `pages.test.tsx`：SOUL.md 編輯儲存、看板五欄＋搬移、工作流建立＋畫布占位、Hermes 狀態頁。

## 未完成／M2 之後
- 工作流畫布（DAG 編輯）、執行與 run 回看。
- 看板拖拉、評論 UI（API 已接 `comment`，畫面未做）。
- 成員管理頁（`/members` API 未做畫面）、新增／刪除 AI 員工的表單（API client 已有）。
- 對話 `steer`（插話）按鈕：client 已支援事件，畫面未放。
- 尚未對真後端做端到端驗證（後端同時開發中）；契約若有出入以 `docs/API.md` 為準調整 `src/api/`。
