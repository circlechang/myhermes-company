# Q. 發行 — parity 報告（2026-08-29）

| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| pip 套件＋CLI `myhermescompany` start/stop/status/restart/logs/reset-admin/version | ☑ | `scripts/build-all.sh --skip-web` 出 wheel（含 web_dist 5 檔）→ `python3.12 -m venv` 暫時環境 `pip install` → `myhermescompany start --daemon --port 8790` → `status` running → `restart` → `stop` → `status` stopped；pid 在 `$STUDIO_HOME/studio.pid`、log 在 `$STUDIO_HOME/logs/studio.log` | `update` 子指令沒做（就是 `pip install -U` + `restart`，寫在 DEPLOY §6）；`logs -f` 靠系統 `tail` |
| 伺服器直接服務前端（SPA fallback） | ☑ | `curl /` → 200 text/html（index.html）；`/chat/x` → 200 index.html；`/assets/index-*.js` → 200；`/api/nope` → 404 JSON（不是 index）；`/ws/*` 不走 fallback | 只在 `studio/web_dist/index.html` 存在時掛載；開發模式 `python -m studio` 沒 build 就只有 API |
| `/api/*` 同源前綴 | ☑ | `/health` 與 `/api/health` 都 200；`POST /api/auth/login` 拿到 token；`/api/ws/chat?token=` websocket 可連（pytest）；真機 `/api/hermes/status` 帶 token → `gateway_ok:true, version 0.20.5, 9 profiles` | 用純 ASGI middleware 改 `scope["path"]`，前端 `API_BASE='/api'` 不用改；vite dev proxy 原樣 |
| 安全預設（非 loopback） | ☑ | `myhermescompany start --host 0.0.0.0` 沒 `STUDIO_SECRET` 且 admin 仍預設 → 印兩條原因、exit 2；`reset-admin --password` 後 ＋ `STUDIO_SECRET=…` → 起得來；`STUDIO_ADMIN_PASSWORD` 短於 8 字元 → 拒絕 | 只檢查 `owner` 角色的預設密碼；不檢查其他帳號 |
| Docker image（多階段 node→python） | ◐ | `Dockerfile` 寫好；本機 Docker daemon 沒開（`docker info` 失敗、沒有 compose plugin）→ **`docker build` 未驗**。CI（`.github/workflows/ci.yml` release job）會 build 不 push | image 不含 Hermes、不含 `hermes` CLI（kanban/profile CLI 功能在容器內不可用） |
| docker-compose（官方 hermes image ＋ studio） | ◐ | `docker-compose -f docker-compose.yml --env-file .env.example config` 通過（語法／變數插值）；**未真的 `up`** | 用 bridge 網路而非官方的 `network_mode: host`；LINE 等平台 port 要自己加 |
| Zeabur 部署說明 | ☑（文件） | `docs/DEPLOY.md` §4：Dockerfile 部署、env 清單、`/data` volume、與 Hermes 連線兩條路 | 未實際部署到 Zeabur（使用者沒授權部署／花錢） |
| README 快速開始（正式＋開發） | ☑ | 讀 README | |
| 桌面版（Electron） | 不做 | — | 產品定位單機／伺服器網頁，不出桌面殼 |

## 自動測試
`server/tests/test_cli_static.py`（11 個）：pid 讀寫／過期清理／垃圾內容、`status`/`stop` 無程序、`stop_pid` 真的殺子程序、已在跑時 `start` 拒絕、preflight loopback 放行／公開綁定兩條拒絕／短密碼／設密碼後放行、`reset-admin`、路徑穿越（`/../outside.txt` 不外洩）、SPA fallback＋`/api` 前綴＋404 JSON、POST/WebSocket 走 `/api`、沒 web_dist 只服務 API。
全套：`cd server && .venv/bin/python -m pytest -q` → **42 passed**。web `npm run build` 過（產物落 `server/studio/web_dist/`）。

## 決策記錄
- **靜態檔／前綴不改 `app.py`**：`studio/static.py` 的 `install_static(app)` 在 `create_app()` 之後由 CLI 呼叫（Starlette middleware stack 是 lazy，第一個 request 前加都有效；catch-all route 排在所有 router 之後）。測試環境（conftest）不掛，既有測試不受影響。
- **`/api` 前綴用 middleware 去掉，而不是把 router 全加前綴**：前端正式環境同源直接打 `/api/x`，dev 用 vite proxy rewrite，兩邊都不用改前端。middleware 在 scope 標 `studio_api=True`，讓未知 API 路徑回 404 JSON 而非 index.html。
- **pid 檔由子程序在 preflight 通過後才寫**：`--daemon` 父程序等 pid 出現（最多 15 s）再輪詢 `/health`（最多 10 s），所以「啟動成功」＝真的可以 curl。preflight 失敗 → 子程序 exit 2，父程序回報並帶 log 路徑。
- **`STUDIO_HOME` 也決定 DB 預設路徑**：`config.py` 只認 `STUDIO_DB`，所以 `cli.apply_home_env()` 在 STUDIO_HOME 有設、STUDIO_DB 沒設時補 `STUDIO_DB=$STUDIO_HOME/studio.db`。這樣測試／容器不會誤碰 `~/.myhermescompany/studio.db`。
- `python -m studio` 不帶子指令＝前景 `start`（相容原行為）。console script 保留舊名 `myhermescompany` 並新增 `myhermescompany`。
- pyproject 加了 `ruamel.yaml`：同事的 channels/skills/profiles 模組 import 它但沒宣告，wheel 裝到乾淨 venv 會 import 失敗（實測抓到）。

## 真機實測摘要（本機 Hermes 0.20.5，port 8790，STUDIO_HOME=暫存目錄）
```
myhermescompany start --daemon --port 8790   → 已在背景啟動 pid …，http://127.0.0.1:8790
GET /            → 200 text/html  <!doctype html><html lang="zh-TW">…
GET /health      → {"ok":true} 200        GET /api/health → 200
GET /chat/x      → 200 (index.html)       GET /assets/index-QtBl8edu.js → 200
GET /api/nope    → 404 {"error":{"code":"not_found"}}
POST /api/auth/login admin/admin → token；GET /api/hermes/status → gateway_ok:true version 0.20.5 profiles 9
myhermescompany restart --port 8790 → /health 200；myhermescompany stop → 已停止；status → stopped (exit 3)
start --host 0.0.0.0（未設 secret／預設密碼）→ 拒絕啟動 exit 2；reset-admin 後＋STUDIO_SECRET → 起來
```
啟動 log 裡 `module channels failed to import: No module named 'studio.modules.channels.registry'` 是同事模組尚未完成的檔，不在本任務範圍。

## 已知限制／待辦
- `docker build`、`docker compose up` 本機未驗（daemon 沒開；round2 再查 `docker info` 仍失敗，不擅自啟動使用者的 Docker Desktop）；compose 只驗了 `config`。
- round2：CLI `status/stop/logs` 加 `--port`；`studio.pid` 第二行起記 `port=`／`host=`，`status` 會打 `/health` 顯示 `health=ok|no-response`，`restart` 不帶 `--port` 沿用記錄的 port；新增 `clear-login-locks`。pytest `test_pid_file_records_port_and_status_uses_it`、`test_clear_login_locks_cli`。
- 沒有 DB migration：既有 `studio.db` 遇到同事新增欄位（例：`members.profiles_json`）會 `no such column`；正式版需要 alembic 或啟動時 `ALTER TABLE` 補欄。實測時使用者本機 `~/.myhermescompany/studio.db` 就踩到（用暫存 STUDIO_HOME 繞過，沒動它）。
- `scripts/build-all.sh` 預設會跑 `npm ci`（會重裝 `web/node_modules`）；這次為了不干擾同時在改 web 的同事用 `--skip-web`，web 是用 `npm run build` 單獨驗的。
- `.env.example` 放在 repo 根目錄給 compose 用，`.env` 已在 `.gitignore`。
- 新增 `.gitignore`：`server/studio/web_dist/`、`web/dist/`、`server/build/`、`server/dist/`。
- 致謝表無需新增（沒引用外部程式碼；compose 參考官方 hermes-agent 文件與其 MIT compose 的變數名）。
