# Hermes 相容性：升級會不會斷，一個指令就能檢查

模組 `server/studio/modules/compat/`、契約 `server/studio/hermes/contract/`、前端 `/compat`。
對應 Hermes **0.20.5（tag v2026.8.19）**；2026-08-29 真機驗證。

## 一句話

Studio 碰到 Hermes 的每一個點（gateway 端點、CLI 指令、檔案／DB 欄位）都列在
`server/studio/hermes/contract/surface.yaml`（59 項，機器可讀、有註解），每項標注 **風險分級** 與 **受影響的 Studio 模組**。
`myhermescompany hermes-check` 對真的 Hermes 逐項驗，輸出 pass/fail/skip ＋ 判定「相容／部分相容（列受影響功能）／不相容」。
升級前 `POST /compat/precheck` 在暫存目錄裝新版 Hermes、起沙盒 gateway 跑同一套測試；每週六 22:00 自動盯 GitHub 新 tag。

## 分級（surface.yaml 的 `risk`）

| risk | 是什麼 | 為什麼 | 目前項數 |
|---|---|---|---|
| **low** | Hermes gateway 公開 API（`/v1/*`、`/api/*`） | 有版本承諾、OpenAI 相容格式，最不容易斷 | 22 |
| **medium** | CLI 帶 `--json` 的輸出（`kanban list --json`、`plugins list --json`、`journey --json`）＋ 只驗子命令／旗標存在的 `--help` 探針 | 結構穩定但沒有正式契約 | 16 |
| **high** | 解析 CLI 表格／人類文字（`profile list`、`gateway status`、`--version`、`memory status`、`auth`）、直接讀 HERMES_HOME 內部檔案（`.env`、`config.yaml`、`auth.json`、`SOUL.md`、`skills/`…）、SQLite 欄位（`state.db` sessions/messages、`cron/executions.db`） | 內部結構，升級最容易打斷 | 21 |

`critical: true` 的項目（`gw.health`、`gw.runs.create`、`file.env`）失敗 → **不相容**；其他失敗 → **部分相容**，報告列出受影響模組；全過 → **相容**。

## 接觸面總覽（節錄；完整見 surface.yaml 或 `GET /compat/surface`）

- **Gateway**（22）：`/v1/health`、錯 key 回 `gateway_auth_failed`、`/p/{profile}` 前綴、`/p/default` 前綴（`gw.prefix.default`）、`/v1/models`、`/v1/skills`、`/api/model/options`、
  `/v1/runs`（POST／status／events SSE／approval／stop／steer）、`/api/jobs`（list／create／get／PATCH／pause／resume／run／DELETE）、
  `/v1/chat/completions`、`/v1/responses`。
- **CLI**（20）：`--version`、`kanban list/diagnostics/show/create/dispatch/移動動詞/--board`、`profile list`（表格）、`profile create|rename|delete|use|export|import`、
  `gateway status`（文字）、`gateway restart`、`plugins list --json`、`plugins enable|disable`、`mcp add|remove|test`、全域 `-p`、`memory status`、`journey --json`、`bundles create|delete`、`auth add|logout|status`。
- **檔案／目錄**（14）：`.env`（API_SERVER_KEY）、`config.yaml`、`auth.json`、`active_profile`、`profiles/<p>/{SOUL.md,config.yaml}`、`SOUL.md`、`memories/`、`skills/**/SKILL.md`、`hermes-agent/skills/`、`logs/`、`cron/`、`workspace/`、`skill-bundles/`、`kanban.db`。
- **SQLite**（3）：`state.db` `sessions`（11 必要欄位＋10 選配）、`messages`（8＋2）、`cron/executions.db` `executions`。

每項的 `affects` 對應 `server/studio/modules/<name>` 或 `studio/api/*`（hermes_status／agents／chat）。

## 探針怎麼跑（不動使用者資料）

| kind | probe | 做什麼 |
|---|---|---|
| endpoint | `live` | 真的呼叫，驗 2xx＋必要欄位（`keys`／`keys_any`／`list_item_keys`）；SSE 收到帶 `event`/`type` 的 JSON 事件並等到終止事件 |
| endpoint | `route` | 用假 id／空 body 打，只驗「路由存在＋回**結構化 JSON 錯誤**」（整條路由不存在時 Hermes 回純文字 `404: Not Found`，可區分） |
| cli | `run` | 真的執行唯讀指令，依 `parse`（json／json_first_bracket／regex／text）驗輸出 |
| cli | `help` | 跑 `<argv> --help`，驗子命令與旗標字串存在（會寫資料的指令都用這招） |
| file / db | exists | 檔案存在＋格式（env keys／yaml keys／json keys／SKILL.md frontmatter／PRAGMA table_info 欄位） |

**writes 規則**：標 `writes: true` 的項目（`/v1/runs` 三項、`/api/jobs` 建改刪、`kanban create` live）在正式環境**預設退回 route probe 或 skip**；
加 `--writes`（API `{"writes": true}`）才真的建：建一個 run 立刻 stop、建一個 cron job `studio-contract-probe` 改完刪掉、建一張卡 `studio-contract-probe` 後 archive。
預檢沙盒（全新 HERMES_HOME）一律 live；沙盒沒有的檔案（`.env`、`config.yaml`、`profiles/`…）標 skip 不算失敗。

## 指令

```bash
# 對本機 Hermes 跑（唯讀；exit 0 相容 / 1 部分 / 2 不相容 / 3 跑不起來）
scripts/hermes-contract.sh
scripts/hermes-contract.sh --json > report.json
scripts/hermes-contract.sh --writes            # 含會建資料的呼叫（建完清掉）
scripts/hermes-contract.sh --only gw.health,cli.profile.list
server/.venv/bin/python -m studio.modules.compat surface   # 列清單
```

round3 起 `myhermescompany hermes-check [--json] [--writes] [--only]` 與 `myhermescompany precheck [version] [--json]` 直接在 `studio/cli.py`
（實體仍是 `studio.modules.compat.__main__` 與 `precheck.run_precheck`；`scripts/hermes-contract.sh` 包同一層）。
`precheck` 是同步跑：進度印到 stderr，結束印同一份人類可讀報告，exit code 同 hermes-check。

Python：
```python
from studio.hermes import contract
report = contract.run(hermes_home, api_url, key, hermes_bin="~/.local/bin/hermes", writes=False)   # 同步
report = await contract.run_async(...)                                                            # FastAPI 內
contract.capabilities(report)            # {"modules": [{"module": "cron", "status": "degraded", "degraded": ["gw.jobs.list"]}, ...]}
from studio.modules.compat import capabilities
capabilities()                           # 由 DB 裡最近一次契約測試推導；沒跑過 → 全部 unknown（不阻擋任何功能）
```

報告 JSON：`{schema, surface_version, hermes{version,cli_version,date,api_url,home,bin,profile}, mode{sandbox,writes}, started_at, finished_at, duration_ms,
summary{pass,fail,skip,total,verdict,failed_ids,affected_modules[{module,failed[]}],by_risk}, items[{id,status,reason,ms,kind,risk,label,critical,affects,note,detail}], cleanups[]}`。

## API（前綴 `/compat`，需登入；寫入類需 owner/admin）

見 docs/API.md「Compat」區段。

## 升級預檢（sandbox）

`POST /compat/precheck {"version": "latest" | "v2026.8.27"}` → 背景任務，`GET /compat/precheck/{id}` 輪詢 `status/progress/report`。步驟：

1. `git ls-remote --tags`（沒有 GitHub API rate limit；失敗才退 API）解析 tag（命名 `vYYYY.M.D`，0.20.5 = v2026.8.19）
2. `git clone --depth 1 --branch <tag>` 到 `$TMPDIR/mhc-precheck/<job>/src`
3. `uv venv` ＋ `uv pip install -e . aiohttp`（沒 uv 退 `python -m venv` ＋ pip）。**aiohttp 必裝**：api_server adapter 需要它，基本安裝沒有會印 `No adapter available for api_server`
4. `HERMES_HOME=<job>/home API_SERVER_KEY=<隨機> API_SERVER_PORT=<空閒 port> hermes gateway run --force`（launchd 已有 gateway 時沒 `--force` 會拒絕啟動），等 `/v1/health`
5. `contract.run_async(sandbox=True)`，結束後 SIGTERM 整個 process group，刪暫存目錄（失敗保留 `precheck.log`）

實測 v2026.8.19：clone 5 秒、安裝 12 秒（uv 有快取）、gateway 1 秒就緒、契約測試 35 秒，**全程約 55 秒**；上限 15 分鐘（`total_timeout`），超過標 `timeout`。
環境變數：`STUDIO_PRECHECK_DIR`（暫存根）、`STUDIO_PRECHECK_KEEP=1`（不清）、`STUDIO_PRECHECK_PYTHON`（預設 3.12；Hermes 要 3.11–3.13）、`STUDIO_PRECHECK_EXTRA_PKGS`、`STUDIO_HERMES_REPO`。

**沙盒絕不碰 `~/.hermes`**：所有子程序都帶自己的 `HERMES_HOME`。例外是 `hermes gateway status`（channels 模組用）本來就看使用者的 launchd，唯讀。

## 每週自動盯

`on_startup` 起 loop（每 60 秒 tick，`STUDIO_COMPAT_TICK_SECONDS`；`STUDIO_COMPAT_SCHEDULER=0` 關掉）。排程存 `compat_state`：預設 **週六 22:00**（本機時區），
`PATCH /compat/schedule {enabled, weekday(0=一…6=日), hour, minute}` 可改／關。到點就 `check_latest`：抓最新 tag，比「已測版本」新（沒有已測版本就用本機 `hermes --version` 的日期）→ 開預檢。
結果：全 pass → 更新已測版本；有 fail → `events.record("compat.precheck")`（events 模組會存成 `other.compat.precheck`）＋ 每家公司一筆 inbox 待辦（kind `compat`，連到 `/compat`）。
手動「立即檢查」= `POST /compat/check-latest`。第一次建立狀態時 `last_schedule_run` 設成現在，**不會一啟動就開預檢**。

## 能力降級

`studio.modules.compat.capabilities()`：每個模組 `available | degraded | unavailable | unknown` ＋ `missing`（critical 項）／`degraded`（一般項）。
只是資訊，不強迫其他模組現在改用；前端 `/compat` 顯示。

## 真機結果（2026-08-29，Hermes 0.20.5）

- `hermes-check`（唯讀）：**相容**，57 pass / 0 fail / 1 skip（`active_profile` 不存在，optional），64 秒（CLI 每次啟動約 1–2 秒）。
- `hermes-check --writes`：見下方摘要（run 建了就 stop、cron job 建改刪、kanban 卡建了 archive）。
- 預檢 v2026.8.19（同版）：**相容**，51 pass / 0 fail / 7 skip（沙盒沒有 `.env`/`config.yaml`/`profiles`/`hermes-agent/skills`/`workspace`/`skill-bundles`/`active_profile`），55 秒。

## 已知限制／發現

- **錯 key 不是 401**：0.20.5 對錯 Bearer 回 HTTP 200 ＋ `{"error":{"code":"gateway_auth_failed"}}`。round3 起 `GatewayClient._raise` 對 2xx 也看 body（只有 `error`、沒有任何預期欄位 → 丟 `GatewayAuthError`；401/403 同樣丟它），`/hermes/status` 回 `auth_error:true`、`/setup/status` 回 `api.auth_failed:true`，UI 顯示「API key 錯誤」。契約項 `gw.auth.reject` 盯著這個行為。
- 早期簡報寫「`hermes cron list --json`、`sessions list --json`（確認）」——**都沒有** `--json`；Studio 也沒用它們（cron 走 `/api/jobs`、sessions 直讀 `state.db`），所以不在清單。
- `/p/{profile}` 前綴規則 round3 已統一成「有 profile 就加，含 default」（gateway.py／cron／models 都用 `GatewayClient._prefix`）；新契約項 `gw.prefix.default` 對真機 0.20.5 驗過 `/p/default/v1/models` 200。
- `kanban.db` 只透過 CLI 存取，清單裡只驗存在。
- 預檢沙盒沒有 model provider：`/v1/runs` 回 run_id 後立刻 failed，契約把「拿到 run_id、SSE 收到 run.failed」視為通過；不能驗真正的對話品質。
- 精細的欄位契約（例如 SSE 事件內每個欄位）只列在 `note`，沒有逐欄斷言；要加就在 surface.yaml 的 `expect` 加 key。
- GitHub API 未帶 token 常被 rate limit（本機實測 403），所以 tag 用 `git ls-remote`。
- 排程 tick 用本機時區的 `datetime.now()`；`compat_state` 只有一列，多公司共用。
