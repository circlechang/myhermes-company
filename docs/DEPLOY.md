# 部署指南（MyHermesCompany）

MyHermesCompany ＝ 一個 Python 伺服器（FastAPI）內建前端靜態檔。**不含 Hermes Agent 本體**；
它透過 `HERMES_API_URL` 打 Hermes 的 Gateway API server（:8642），並可直接讀 `HERMES_HOME`
（profiles、`.env` 的 `API_SERVER_KEY`）。所以部署只有兩個問題：Studio 跑在哪、怎麼連到 Hermes。

> 改名說明：資料目錄預設 `~/.myhermescompany`；第一次用新版啟動時，若只有舊的 `~/.hermes-studio-tw` 存在會自動 rename 過去並印一行 log。所有 `STUDIO_*` 環境變數都有等價的 `MHC_*`（兩者都設時 `MHC_*` 優先）；CLI `myhermescompany`（舊名 `studio-tw` 暫時保留為別名）。

## 0. 環境變數一覽

| 變數 | 預設 | 說明 |
|---|---|---|
| `STUDIO_HOST` | `127.0.0.1` | 綁定位址。非 loopback 會啟動安全檢查（見 §5） |
| `STUDIO_PORT` | `8700` | |
| `STUDIO_HOME` | `~/.myhermescompany` | pid、`logs/studio.log`、`studio.db`、`secret.key`、`uploads/` |
| `STUDIO_DB` | `$STUDIO_HOME/studio.db` | SQLite 路徑 |
| `STUDIO_SECRET` | 自動產生存 `secret.key` | JWT 密鑰。**非 loopback 必填** |
| `STUDIO_ADMIN_PASSWORD` | — | 有設就在每次啟動時把 `admin` 密碼設成此值（≥8 字元）。容器／Zeabur 首次啟動用 |
| `HERMES_API_URL` | `http://127.0.0.1:8642` | Hermes Gateway API server |
| `HERMES_API_KEY` | 讀 `$HERMES_HOME/.env` 的 `API_SERVER_KEY` | Bearer key。另一台機器時直接給 |
| `HERMES_HOME` | `~/.hermes` | 讀 profiles／config；不存在也能跑（CLI 類功能降級） |
| `HERMES_BIN` | `~/.local/bin/hermes` 或 PATH | `hermes` CLI。容器內沒有，看板／profile 等 CLI 功能不可用 |

Hermes 端要開 API server：`~/.hermes/.env` 設 `API_SERVER_ENABLED=true`、`API_SERVER_KEY=<≥8字元>`；
跨機器再加 `API_SERVER_HOST=0.0.0.0`，然後 `hermes gateway restart`。

## 1. 同機安裝（pip，最常見）

```bash
pip install myhermescompany-*.whl      # 或 cd server && pip install .
myhermescompany start --daemon                        # 127.0.0.1:8700，pid/log 在 ~/.myhermescompany/
myhermescompany status | logs -f | restart | stop
myhermescompany reset-admin                           # 改 admin 密碼
myhermescompany clear-login-locks [--username x]      # 解除登入失敗鎖定（5 次／15 分鐘，STUDIO_LOGIN_MAX_FAILURES／STUDIO_LOGIN_LOCK_SECONDS）
```
wheel 由 `scripts/build-all.sh` 產生（build web → `server/studio/web_dist/` → wheel）。

要給區網／公網用：
```bash
export STUDIO_SECRET="$(openssl rand -hex 32)"
myhermescompany reset-admin --password '<強密碼>'
myhermescompany start --daemon --host 0.0.0.0
```
沒設 `STUDIO_SECRET` 或 admin 仍是 `admin` → 拒絕啟動（exit 2）。建議前面再放 Caddy/Nginx 做 TLS。

## 2. Docker：(a) 與既有 Hermes 同機

Hermes 已在主機上跑（非 Docker），只把 Studio 容器化：
```bash
docker build -t myhermescompany .
docker run -d --name studio --restart unless-stopped \
  -p 8700:8700 -v studio-data:/data \
  -v ~/.hermes:/hermes:ro \
  -e STUDIO_SECRET="$(openssl rand -hex 32)" \
  -e STUDIO_ADMIN_PASSWORD='<強密碼>' \
  -e HERMES_API_URL=http://host.docker.internal:8642 \
  myhermescompany
```
Linux 沒有 `host.docker.internal` 時加 `--add-host=host.docker.internal:host-gateway`，
且主機 Hermes 要 `API_SERVER_HOST=0.0.0.0`（或 docker0 位址）。`-v ~/.hermes:/hermes:ro`
讓 Studio 讀 `API_SERVER_KEY` 與 profiles；不想掛就改給 `-e HERMES_API_KEY=...`。

## 3. Docker：(b) compose 同時起官方 Hermes image ＋ Studio

`docker-compose.yml` 已寫好：`hermes`（`nousresearch/hermes-agent`，`gateway run`，API server 開在 bridge 網路內
`hermes:8642`）＋ `studio`（本 repo Dockerfile）。
```bash
cp .env.example .env            # API_SERVER_KEY / STUDIO_SECRET / STUDIO_ADMIN_PASSWORD
mkdir -p ~/.hermes && docker run -it --rm -v ~/.hermes:/opt/data nousresearch/hermes-agent setup   # 首次：設定精靈
HERMES_UID=$(id -u) HERMES_GID=$(id -g) docker compose up -d
```
- `~/.hermes` 掛給 hermes 當 `/opt/data`（官方慣例），同一目錄唯讀掛給 studio 當 `/hermes`。
- 官方 compose 用 `network_mode: host`；這裡改用 bridge 讓 myhermescompany 能用服務名連線。
  若 Hermes 的聊天平台（LINE webhook 等）需要對外 port，自行在 `hermes` 服務加 `ports:`。
- 官方 image 與 API server 說明：`hermes-agent/website/docs/user-guide/docker.md`、`features/api-server.md`。

## 4. Zeabur

1. 用 Git 部署，Zeabur 會偵測根目錄 `Dockerfile`（多階段：node 建前端 → python:3.12-slim）。
   若被誤判成別的 builder，加 `zbpack.json`：`{"build_method":"dockerfile"}`。
2. 環境變數（Zeabur → Variables）：
   `STUDIO_SECRET`、`STUDIO_ADMIN_PASSWORD`（必填）、`HERMES_API_URL`、`HERMES_API_KEY`（必填，因為容器沒有 `~/.hermes`）。
   `STUDIO_HOST=0.0.0.0`、`STUDIO_PORT=8700`、`STUDIO_HOME=/data` 已在 image 內。
3. 持久化 volume：掛 `/data`（＝`STUDIO_HOME`：SQLite、secret、上傳檔）。沒掛的話每次重佈 DB 歸零。
4. Port：8700；Zeabur 網域指到它即可。WebSocket（`/ws/chat`）與 SSE 走同一 port。
5. 連 Hermes：Zeabur 上的 Studio 打不到你家的 `127.0.0.1:8642`，要嘛
   (a) Hermes 也部署到同一 Zeabur 專案（用官方 image，`API_SERVER_HOST=0.0.0.0`、`API_SERVER_KEY`；
   `HERMES_API_URL=http://<hermes 服務名>:8642`），要嘛
   (b) 主機 Hermes 用 Cloudflare Tunnel／Tailscale 露出 8642，`HERMES_API_URL` 指過去。
   `HERMES_BIN` 相關功能（kanban、profile CLI）在 Zeabur 上不可用。
6. 驗證：`curl https://<domain>/health` → `{"ok":true}`；`curl https://<domain>/` 回 index.html；
   登入 admin ＋ `STUDIO_ADMIN_PASSWORD`。

## 5. 安全預設

- `STUDIO_HOST` 非 loopback（不是 127.0.0.1/::1/localhost）時，啟動前檢查：
  1. `STUDIO_SECRET` 必須由環境變數提供（不接受自動產生的 `secret.key`）；
  2. 任何 `owner` 帳號的密碼不可仍是 `admin`。
  兩項任一不過 → 印出原因、exit 2、不開 port。
- `STUDIO_ADMIN_PASSWORD` 有設就在啟動時套用（重啟不會蓋掉你之後用 UI 改的密碼——除非變數還在；容器場景請理解這點）。
- 密鑰只以環境變數或 `secret.key`(0600) 存在，不進 repo、不印 log。

## 6. 升級

```bash
pip install -U myhermescompany-<new>.whl && myhermescompany restart
# docker: docker compose pull && docker compose up -d --build
```
DB schema 由 SQLModel `create_all` 建新表；既有表加欄位目前**沒有 migration**（見 parity/release.md 已知限制）。
