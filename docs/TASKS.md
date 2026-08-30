# Tasks（狀態放檔案）
## M0
- [x] 本機 Hermes 開啟 API server（API_SERVER_KEY）並以 curl 驗證 /v1/health、/v1/runs SSE（2026-08-29 通過）
- [x] `server/`：FastAPI 骨架、設定、SQLite(sqlmodel)、auth(JWT)　　驗證：`pytest tests/test_auth.py`（bcrypt + PyJWT，首次啟動自動建「預設公司」＋ admin/admin）
- [x] `server/studio/hermes/`：gateway client（health/models/skills/runs+SSE/approval/stop/steer；`/p/{profile}` 前綴）、cli client（kanban list/create/status/comment、profile list、SOUL.md 讀寫）
- [x] `server/studio/api/`：auth, companies/members, agents, sessions, chat ws, kanban, workflows(CRUD＋驗證；/run 回 501), hermes status
- [x] tests：fake gateway（真 uvicorn 執行緒，SSE 可逐段串流）＋ fake CLI；`cd server && .venv/bin/python -m pytest` → **31 passed**（2026-08-29）
  覆蓋：auth/members 權限、agents 同步（冪等）＋SOUL/skills、sessions 隔離、kanban 代理、ws chat（事件轉發、落庫、第二輪帶 history、tool/approval/stop/steer、失敗路徑）、workflow 12 種驗證失敗＋API CRUD
- [x] 真實煙擊測試（2026-08-29，Hermes v0.20.5 gateway 8642）：
  - `python -m studio` 起 8700；`curl /health` → `{"ok":true}`
  - `curl POST /auth/login admin/admin` → token；`GET /agents` → **9 個 agents**（default 與其餘 8 個 profile，模型從 `hermes profile list` 帶入；只有 default enabled）
  - `GET /hermes/status` → gateway_ok=true, version=0.20.5；`GET /kanban/tasks` → 4 張卡（與 `hermes kanban list --json` 同源）
  - `POST /sessions {agent_id=default}` → `s_773e0b10f796`
  - `python websockets` 客戶端送「用一句繁體中文說你是誰」→ `run.started` → 20 段 `message.delta` → `run.completed`（6.2 秒，回覆為一句自我介紹，usage 24,950 tokens）
  - 第二輪「我上一句問了你什麼？」→ 3.3 秒回「你問我『用一句繁體中文說你是誰』。」（上下文成功）；`GET /sessions/{id}/messages` 看到 4 則 user/assistant 落庫
  - 測完 `pkill -f "python -m studio"`，server 已停

### M0 決策記錄
- **上下文不用 `previous_response_id`**：讀 api_server.py 確認 `/v1/runs` 不寫 response store，改用「固定 `session_id` ＋ 每次帶 `conversation_history`（最近 40 則）」，細節在 docs/API.md。
- Python 3.12（uv 建 venv；本機預設 python3 是 3.14，套件相容性未驗）。密碼雜湊直接用 `bcrypt`，不用 passlib（passlib 對 bcrypt≥4.1 有相容警告）。
- agents 同步規則：每個 profile 對每間公司各建一筆，`default` 預設 enabled，其餘 enabled=false 等管理者啟用；模型變動時更新 `model`。
- 測試的 fake gateway 用真 uvicorn 執行緒而非 `httpx.ASGITransport`，因為後者會把整個回應緩衝，SSE 等審批會死鎖。
- `approval.request` gateway 沒有獨立 approval_id，以 run_id 填入；核准 body 是 `{"choice": once|session|always|deny}`。
- kanban 狀態流轉沒有 `--json` 的動詞回傳純文字，server 統一包成 `{ok, id, raw}`。
- 非 loopback 認證強制、審計表寫入、用量統計：M3 再做（Audit 表已建但 M0 未寫入）。

### M0 未完成／待 M1+
- [ ] `POST /workflows/{id}/run` 執行器（M2）
- [ ] `hermes/status` 的 profiles 解析靠 `hermes profile list` 表格文字，CLI 改版可能要調 regex（已有檔案系統 fallback）
- [ ] Audit 表尚未寫入；成本／用量彙總（usage 已隨 run.completed 轉發，但未落庫）
- [ ] 前端（M1）

### M0 驗收（2026-08-29）
- server pytest 31 passed；web vitest 18 passed、build 過。
- 端到端（真機）：vite proxy → Studio → Hermes /p/default/v1/runs SSE → 回覆落庫 2 則；/agents 9 個 profile；/kanban 4 張；/hermes/status gateway_ok。
- 坑：zsh `echo` 會把 JSON 的 `\n` 轉成換行，驗證腳本要用 printf/檔案；vite 只綁 ::1，用 localhost 不要 127.0.0.1。
- logo 已接入（web/public/logo.svg、favicon、Layout、Login）。

## M1（下一步）
- [ ] `events` 表（來源/時間/對象/內容/AI 員工/人類決策/投遞結果）＋所有入口寫入
- [ ] 成員管理頁、新增/刪除 AI 員工表單、steer 插話鈕
- [ ] 待辦收件匣（閘門/危險指令核准/LINE 請求統一）
- [ ] SOUL.md 版本歷史
- [ ] usage 落庫＋公司/員工每日 token 上限
- [ ] LINE 設定頁（寫 LINE_* 到 ~/.hermes/.env、重啟 gateway）＋路由規則（哪個 OA/關鍵字 → 哪個 AI 員工）

## 第四波（2026-08-29）
- [x] 工作流強化（harness 借鏡四項）— parity/workflows.md
- [x] Hermes 相容性契約＋預檢＋排程 — COMPAT.md
- [x] 設定精靈（截圖為內部品保紀錄，不隨公開版釋出）
- [x] 事件強化＋FTS 搜尋＋mhc-search skill — parity/spec_extras.md
- [x] 行業套件＋行銷套件 — PACKS.md
- [x] round3 跨模組收尾（help 頁、事件白名單、GatewayAuthError、cli 子命令、packs skills 範圍、kanban probe 卡、/p/ 前綴統一）
- [x] 8700 換成新後端並全套驗證

## 收尾（2026-08-29）
- [x] 全域改名 **MyHermesCompany**（目錄 ~/MyHermesCompany、pyproject/CLI `myhermescompany`、app name/title/favicon、README/docs、brand 已完成）
- [x] 介紹說明頁（Landing Page）：照 `~/.claude/skills/zenbu-ai-landing-page` 課程／服務模式；截圖用 Playwright 對真實 UI 抓、內嵌 data URI；單檔 HTML 零外連；內容＝全部功能、使用方法、帶來的好處；放 `~/artifacts/MyHermesCompany-intro.html` 與 repo `site/index.html`
- [ ] GitHub：建 repo，推送前檢查無 .env/*.db/密鑰
