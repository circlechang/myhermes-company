# MyHermesCompany — 產品規格書 v0.1（2026-08-29）

> 定位：裝在「既有 Hermes Agent」之上的公司級 AI 工作臺。Hermes Agent 本體（MIT）不改；
> 本產品＝一個 Python 伺服器＋一個網頁前端，透過 Hermes 官方 API／CLI 操作 Hermes。
> 商用產品，自有著作；只引用 MIT 專案程式碼並保留聲明，不複製 BSL 授權程式碼。

## 1. 一句話
每個人都有一個 AI 工作臺；工作臺裡的員工是 Hermes profile；把員工排成工作流，就是一間公司。

## 2. 核心概念（資料模型）
| 概念 | 說明 | 對應 Hermes |
|---|---|---|
| Company（公司） | 租戶。一個安裝可有多間公司 | 無（Studio 自有） |
| Member（成員） | 人類使用者，屬於一間公司，有角色 owner/admin/member | 無 |
| Agent（AI 員工） | 公司裡的一個 AI 角色，綁定一個 Hermes profile | `~/.hermes/profiles/<name>` |
| Workbench（工作臺） | 一個成員的工作畫面：他的對話、他能用的 Agent、他的工作流、他的看板 | — |
| Session（對話） | 成員與某個 Agent 的一段對話；**可綁一份 Doc（文件模式）** | gateway `/api/sessions` |
| Doc（文件） | **一份 .md ＋不可變的版本歷史＋血緣**。一個對話串的核心就是完成一份文件；不同的工作流＝這份文件從 A 站傳到 B 站再到 C 站 | Studio 自有（`docs` / `doc_versions` / `doc_links`；最新版同時寫進工作區檔案） |
| Workflow（工作流） | DAG：節點＝Agent＋任務；邊＝資料流；含審批閘門、條件、排程 | Studio 自有；節點執行走 gateway runs |
| WorkflowRun | 一次執行的快照與各節點 session | Studio 自有 |
| Task（看板卡） | 交辦單 | `hermes kanban`（kanban.db） |
| Channel（頻道） | LINE OA 等對外入口 | Hermes 內建 LINE plugin＋Studio 路由規則 |

## 3. 使用者故事（MVP 必做）
1. 老闆建立公司、邀請成員；每個成員登入後看到自己的工作臺。
2. 成員在工作臺選一個 AI 員工聊天，串流輸出、看到工具呼叫、能核准危險指令。
3. 老闆在畫布上排工作流：熱點→選題→【審批】→文案→內容→【審批】→發布/存檔；可手動跑、可排程跑；每次執行可回看每個節點的對話。
4. 工作流任一節點的產出可推到 LINE OA；LINE 傳訊給 OA 可指定由哪個 AI 員工接。
5. 看板：卡片建立／指派給 AI 員工／狀態流轉，與 `hermes kanban` 同一份資料。
6. 管理：AI 員工（profile）清單、模型、skills 開關、記憶檔檢視；用量與成本。

## 4. 架構
```
瀏覽器（React）
   │ HTTPS / WebSocket
Studio Server（Python FastAPI, port 8700）
   ├─ SQLite：companies, members, agents, workflows, workflow_runs, channel_rules, audit
   ├─ Hermes Gateway API server（http://127.0.0.1:8642, Bearer API_SERVER_KEY）
   │     /v1/runs (+SSE events, approval, steer, stop) · /api/sessions · /api/jobs · /v1/models · /v1/skills
   │     多 profile：路徑前綴 /p/{profile}/...
   ├─ Hermes CLI（subprocess, --json）：kanban · profile · cron · sessions
   ├─ 檔案系統：~/.hermes/profiles/<p>/{SOUL.md, config.yaml, skills/, memories/}
   └─ LINE Messaging API（push/reply；webhook 由 Hermes 內建 line plugin 接，或由 Studio 接後轉發）
```
不做：不 import Hermes 內部模組、不寫 bridge 程序、不碰 Hermes 的 state.db 寫入。

## 5. Hermes 介面契約（已在本機 v0.20.5 驗證）
- 啟用 API server：`~/.hermes/.env` 設 `API_SERVER_KEY`（≥ 強度門檻），gateway 重啟後 8642 開放；所有請求 `Authorization: Bearer <key>`。
- 對話：`POST /v1/runs` body `{input, instructions?, previous_response_id?, conversation_history?}` → run_id；`GET /v1/runs/{id}/events` SSE，事件：`message.delta`、`tool.started`、`tool.completed`、`reasoning.available`、`approval.request`、`approval.responded`、`run.steered`、`run.completed`、`run.failed`、`run.cancelled`。核准：`POST /v1/runs/{id}/approval`；中止：`/stop`；插話：`/steer`。
- Session：`GET/POST /api/sessions`、`/api/sessions/{id}/chat/stream`（SSE）、`/messages`、`/fork`、`/model`。
- 排程：`/api/jobs`（CRUD/pause/resume/run）。
- 看板：`hermes kanban list --json`、`create`、`assign`、`comment`、`complete`、`block`…（kanban.db 共用於所有 profile）。
- Profile：`hermes profile list`；SOUL.md／config.yaml 直接讀寫檔案。
- LINE：Hermes 內建 `plugins/platforms/line`，env `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`、`LINE_PORT`(8646)、`LINE_PUBLIC_URL`。

## 6. 工作流規格
- 節點：`{id, title, agent(profile), model?, skills[], prompt, attachments[], kind: agent|gate|condition}`
- 邊：`{source, target, on: always|success|failure, condition?}`
- 執行：拓撲排序；扇入等全部上游成功；每節點一個 Hermes session（source=workflow）；下游 user message＝`[上游結果]…[本節點任務]`；系統提示：「你在執行工作流的一個節點，只做本節點任務」。
- 閘門：暫停，寫入 pending_approvals，成員在工作臺核准／退回（退回附意見→回到上一節點重跑）。
- 觸發：手動、cron（Studio 自排，或建成 Hermes job）、webhook、LINE 關鍵字。
- 產出投遞：LINE push、Heptabase、檔案、Webhook。
- 每次 run 存快照（節點/邊/各 session id/狀態/成本），可回看。

## 7. 借鏡（來源與取用方式）
- JPeetz/Hermes-Studio（MIT）：DAG 拓撲排列、crew 模板、cron 管理 UI、審批卡三段式（once/session/always）、成本表。可引用程式碼。
- outsourc-e/hermes-workspace（MIT）：三服務連線模型（gateway/dashboard/UI）、能力偵測降級、看板五欄、review 閘。
- nesquena/hermes-webui（MIT）：手機版導航、語音輸入、session 標籤與專案、CLI session 帶 badge。
- 同類商業產品：僅參考公開說明中的「功能行為」（群聊 @mention、工作流上游訊息組裝、審批閘門、頻道設定），**不引用其程式碼或文案**。

## 8. 非功能
- 語言：Python 3.11 + FastAPI + SQLite（後端）；React + TypeScript + Vite（前端）；zh-TW 為預設語系，i18n 架構保留。
- 部署：單機 `pip install` + `myhermescompany start`；Docker；Zeabur。
- 安全：密碼登入＋JWT；非 loopback 必須開啟認證；密鑰只存 `.env`；LINE webhook 驗簽。
- 授權：本產品自有；依賴清單附 MIT 聲明。

## 9. 系統邊界（2026-08-29 定案）
- **定位＝協調層／萬能中樞**：入口層（LINE OA、表單、網頁、Webhook、排程）經 API 進來 → Studio 記錄、交給 AI 員工與工作流判斷 → 出口投遞。
- **存事件、不存交易**：所有進入中樞的事情記成 `events`（來源、時間、對象、內容、處理的 AI 員工、人類決策、投遞結果），存本地 SQLite（on-premise 即客戶自己的資料庫）。訂單、庫存、金流一律不存，由 AI 員工透過 skill / MCP 讀寫外部系統（ERP、商店、CRM）。
- **產品形態＝一個核心＋行業套件**：套件＝一組 AI 員工（SOUL.md）＋工作流模板＋接該行業系統的 skills。首批：行銷套件（現成 4 profile）、內容生產線套件、餐飲營運套件（排班／交辦）、品牌電商套件（先接外部商店，不自建）。
- 三個驗證場景：行銷公司（多租戶原生）、品牌線上銷售（客服＋名單＋再行銷）、餐廳營運（內外場溝通＋ERP 報表解讀；點餐／團購屬交易系統，外接）。
