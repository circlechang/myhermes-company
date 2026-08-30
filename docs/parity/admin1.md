# admin1：B 平台頻道／C 用量分析／D 排程任務／G 模型管理／H 多 Profile

實測日期 2026-08-29，對本機 Hermes 0.20.5（9 個 profile 都在跑 gateway）。
後端 `server/studio/modules/{profiles,channels,cron,usage,models}/`，前端 `web/src/modules/{profiles,channels,cron,usage,models}/`。
測試：`server/tests/test_admin1.py`（13 個）、`web/src/test/admin1.test.tsx`（6 個）；全套 pytest 155 綠、vitest 91 綠＋1 紅（`coding_agents` 模組，非本區段）。

真機實測方式：`STUDIO_PORT=8793 STUDIO_DB=<tmp>/studio.db` 起 uvicorn，`admin/admin` 登入後 curl。
測試資料（profile `studio-test-tmp`／`studio-test-tmp2`、cron `studio-test-0300`、`.env` 的 `LINE_PORT`）全部清掉，
`~/.hermes/.env` 用 diff 驗證與實測前完全相同（權限 0600 也保留）。

## 共用決策
- `.env` 寫入：`profiles/files.py::write_env` 只改指定 key、其他行（含註解、順序）原樣保留，原子寫入＋0600。已設定／未設定只看 key 存在且非空，密鑰值永不回前端（欄位 `secret=true` 連 value 都不回）。
- `config.yaml` 寫入：ruamel.yaml round-trip，註解與排版保留（測試 `test_profile_config_roundtrip_keeps_comments` 驗證 `# top comment` 與行尾註解都在）。
- 需新依賴：`ruamel.yaml>=0.18`（已裝進 `server/.venv`；請併入 `pyproject.toml` dependencies）、前端 `recharts@2`（已寫進 `web/package.json`）。
- 不 import Hermes 內部模組。供應商目錄 `models/registry.py` 是 dev 時從 `hermes_cli/auth.py::PROVIDER_REGISTRY` 一次性產生的靜態表（MIT，來源已在檔頭註明；請在 README 致謝表加 hermes-agent）。
- 權限：五個區段的寫入操作都要 owner/admin；讀取部分依 H 的 profile 可見性過濾。

## H. 多 Profile
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| 列表／詳情 | ☑ | `GET /profiles` 列出 9 個真實 profile＋模型＋`active_profile`（讀 `~/.hermes/active_profile`） | `hermes profile list` 的表格解析沿用既有 `HermesCli.list_profiles`；CLI 掛了退回檔案系統 |
| 建立 | ☑ | `POST /profiles {name:"studio-test-tmp",description}` → `hermes profile create --no-alias --description`，目錄出現、`profile.yaml` 有描述、公司自動補一筆 Agent | 一律 `--no-alias`（不在 `~/.local/bin` 放 wrapper，產品不該碰使用者 PATH）；新 profile 沒有 config.yaml 時模型顯示繼承 default |
| 複製 | ☑ | `POST /profiles/{name}/clone` → `hermes profile create new --clone-from name`，實測複製 skills/SOUL | `--clone-all`（含 state）沒開放 |
| 重新命名 | ☑ | `hermes profile rename`；Agent 表與成員指派一併改名 | `default` 只改顯示名稱（CLI 語意） |
| 刪除 | ☑ | `hermes profile delete -y`，實測目錄消失、Agent 列一併刪；`default` 回 400 | |
| 切換預設 | ☑ | `hermes profile use`，實測 `active_profile` 檔改變 | |
| 匯出 tar.gz | ☑ | `GET /profiles/{name}/export` → `hermes profile export -o` 暫存檔串流回傳，實測 1.95 MB、tar 內容正確 | |
| 匯入 tar.gz | ☑ | `POST /profiles/import`（multipart，`name` 可選）→ `hermes profile import --name` | 真機只驗匯出；匯入在 pytest 用匯出檔 round-trip 驗（CLI 在真機會覆蓋 `~/.hermes/profiles`，不想留垃圾） |
| profile 範圍設定 | ☑ | `GET/PUT /profiles/{name}/config`：`set`(dotted)/`patch`/`unset`/`text`；真機對 `studio-test-tmp` 寫 `model.default` 成功 | 回前端的 config 會把 token/secret/key 欄位遮成 `***`；`?raw=1` 才給原文（admin） |
| 帳號綁定 | ☑ | `members.profiles_json`＋`studio.auth.allowed_profiles(member)`／`profile_visible()`；`GET/POST/PATCH /members` 帶 `profiles`；`/agents`、`/profiles`、`/usage`、`/cron` 都過濾 | 規則：owner 全部；admin 未指派＝全部（向下相容）、有指派只看指派；member 只看指派。**`sessions.py` 沒動**（非我負責）：建議在 `create_session`／`list_sessions` 加 `profile_visible(p.member, agent.profile)` 一行 |
| 既有 DB 升級 | ☑ | `profiles.on_startup` 用 `ALTER TABLE members ADD COLUMN profiles_json` 補欄位 | |
| 前端 | ☑ | `/profiles` 頁（表格＋建立／匯入＋config 編輯器＋帳號綁定勾選）；`AgentsPage` 左欄嵌入 `ProfilesPanel`（compact） | 重新命名／複製用 `prompt()`，簡單但夠用 |

## G. 模型管理
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| 從 auth.json 發現供應商 | ☑ | `GET /models/providers`：真機列出 openai-codex（OAuth 已登入、active）、openrouter（env key＋3 組憑證）、copilot、anthropic；nous 顯示 `relogin_required` 錯誤訊息；回應 grep 不到 `sk-`/JWT 樣式字串 | `credential_pool` 只回 id/label/auth_type/source/last_status 等，不回 token |
| 抓模型清單 | ☑ | 預設走 gateway `/api/model/options`（`GET /models/catalog`，真機 47 供應商、codex 7 個模型）；`?live=1` 直接打供應商 `/models`（openrouter 真機 396 個） | OAuth 供應商只能走 gateway；Anthropic／Gemini 的 header 差異在 `fetch_models` 吸收 |
| 新增／更新／刪除自訂供應商 | ☑ | 寫 `config.yaml providers.<slug>` {name, base_url, model, models{}, key_env}；key 寫 `.env HERMES_CUSTOM_<SLUG>`（與 Hermes dashboard `_write_custom_endpoint` 同規則，`api_key` 不進 yaml）；刪除連 env 一起清 | 舊格式 `custom_providers` 列表只讀不寫（刪除會處理） |
| URL 自動偵測 | ☑ | `POST /models/providers/detect`：依序試 `/v1 /v4 /api/v1 /api/paas/v4 /openai/v1 /v1beta`；真機 `https://openrouter.ai/api` → 偵測到 `/v1` | |
| API key（內建供應商） | ☑ | `PUT /models/providers/{id}/key` 寫供應商第一個 env（例 `DEEPSEEK_API_KEY`），不走 CLI argv | |
| OAuth／device flow | ◐ | `POST /models/auth/{provider}/start` 起 `hermes auth add <p> --type oauth --no-browser` 子程序，解析 stdout 的 URL／code（`parse_auth_output` 有單元測試），`GET /models/auth/sessions/{id}` 輪詢、`/submit` 把 PKCE code 貼回 stdin、`DELETE` 取消／`hermes auth logout` | **真機沒跑完整登入**（會動使用者的 auth.json）；只驗了 logout／status 的 CLI 包裝與輸出解析。支援清單：anthropic/nous/openai-codex/xai-oauth/qwen-oauth/minimax-oauth/copilot |
| 分組／可見模型／別名 | ☑ | Studio DB `model_prefs`（每公司一份）；`PUT /models/providers/{id}/prefs` | 這是 Studio 端顯示偏好，不影響 Hermes 本身 |
| 預設模型切換 | ☑ | `PUT /models/default?profile=` 直接寫 `config.yaml model.{default,provider,base_url}`；真機讀到 default＝gpt-5.6-luna/codex、researcher＝stealth/ox-alpha/openrouter | `hermes model` 是互動 TUI 不能非互動用；`hermes config set` 沒有 profile 參數，所以直接寫檔（等同 CLI 落盤結果） |
| STT／TTS 目錄 | ☑ | `GET/PUT /models/speech`：列 8 個 TTS、5 個 STT 供應商，附 key 是否存在；真機 tts=edge、stt=local | 只切換供應商與寫設定，語音本體在語音模組 |
| 前端 | ☑ | `/models` 頁：分組卡片、展開模型清單（勾可見／✎別名／★設預設）、API key 輸入、OAuth 流程框、自訂供應商表單（偵測按鈕）、STT/TTS 卡 | |

## B. 平台頻道
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| 11 平台單頁 | ☑ | `GET /channels` 列 line/telegram/discord/slack/whatsapp/matrix/feishu/dingtalk/qqbot/weixin/wecom，欄位表 `channels/registry.py`（env 名稱取自 `gateway/config.py` 與各 `plugin.yaml`）；真機偵測 telegram、whatsapp 已設定 | QQBot 的 `QQ_APP_ID/QQ_CLIENT_SECRET`、WeChat 的 `WEIXIN_TOKEN/WEIXIN_ACCOUNT_ID` 是從 `gateway/config.py` 讀出的；WhatsApp 必填是 `WHATSAPP_ENABLED` |
| LINE 完整 | ☑ | token/secret/port/host/public url/allowlist/home channel；回 `webhook_url`（有 `LINE_PUBLIC_URL` 就拼 `/line/webhook`，否則給提示）；真機寫 `LINE_PORT` 再 `DELETE /channels/line`，`.env` diff 與之前完全一致 | 真機沒填真 token |
| 憑證寫 .env | ☑ | 只改對應 key；`null`/空字串＝移除 | profile 有自己的 `.env` 才寫 profile 的（`?profile=`） |
| 行為設定寫 config.yaml | ☑ | telegram/discord/slack/matrix 的 `require_mention`、`reactions`… 寫對應區段（pytest 驗 `reactions: true` 落盤且註解保留） | 其他平台 Hermes 沒有 config 區段，全靠 env |
| 已設定／未設定 | ☑ | 必填 key 都非空＝已設定 | |
| gateway 狀態 | ☑ | `hermes gateway status` 解析：running/PID/launchd/stale/各 profile；真機 PID 91118＋8 個 profile 全 running、偵測到 `stale_service` | |
| 重啟 gateway | ☑（round2） | `PUT /channels/{id} {restart:true}` 或 `POST /channels/gateway/restart` → `hermes gateway restart`（pytest 用 fake 驗有呼叫）；round2 真機在 8700 按過，結果見 qa/round2.md | 只重啟 default profile 的 gateway（Hermes 行為） |

## D. 排程任務
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| CRUD／暫停／恢復／立即執行 | ☑ | 走 gateway `/api/jobs`（`?profile=` → `/p/{profile}` 前綴）；真機建 `studio-test-0300`（`0 3 * * *`）→ pause → resume → delete，`jobs.json` 已無殘留 | `hermes cron list` 沒有 `--json`（實測 `unrecognized arguments`），所以不走 CLI；gateway create 只收 name/schedule/prompt/deliver/skills/repeat，`--model/--workdir` 等進階欄位沒有 |
| 表達式快捷預設 | ☑ | `GET /cron/presets` 8 組（含每天 03:00） | |
| 投遞目標 | ☑ | `GET /cron/targets`：local/origin＋已設定平台（真機 telegram、whatsapp）＋`bot-chat:<profile>`；前端可自訂 `platform:chat_id` | |
| 執行歷史 | ☑ | 唯讀 `~/.hermes/cron/executions.db`＋`cron/output/<job>/*.md`；真機 diary-daily-backup 5 筆＋30 個輸出檔 | 立即執行後歷史要等下一個 tick 才有紀錄 |
| 前端 | ☑ | `/cron` 頁：profile 下拉、表單（預設下拉、投遞下拉／自訂）、卡片操作、展開歷史與輸出 | |

## C. 用量分析
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| 總 token／session／日均／API 呼叫 | ☑ | 唯讀 `state.db`（`file:...?mode=ro`），default＋每個 profile 各一份；真機 30 日 4,983 sessions、in 203M／out 7.2M、cache_read 1.06B、日均 166 | 讀 `sessions` 表（Hermes 已彙總到 session 層級），不掃 messages |
| 估算成本 | ☑ | Hermes `estimated_cost_usd` 優先，否則內建價格表（USD/1M，17 組關鍵字包含比對），公司可覆蓋／新增／刪除（`usage_prices` 表） | 真機 codex 訂閱的 session Hermes 給 0，全落到價格表 → 440 USD 是「若走 API 的等值」，訂閱制想看 0 就把 `gpt-5.6-luna` 價格設 0 |
| 快取命中率 | ☑ | `cache_read / (input + cache_read)`；真機 83.9% | |
| 模型分佈／來源分佈／profile 分佈 | ☑ | 真機 gpt-5.6-luna 4,809、cron 3,352… | |
| 30 日趨勢 | ☑ | 每日桶補零；前端 recharts 折線（in/out）＋長條（sessions/cost）＋圓餅（模型）＋每日明細表 | |
| 篩選 | ☑ | `profile=`（哪個 state.db）、`company=1`（只算本公司 Studio session：`hermes_session_id` 對回 state.db，真機確認 `studio_*` id 確實落在 state.db） | member 只看指派 profile |
| Studio 側用量 | ☑ | `chat_ws` 累計在 `sessions.input_tokens/output_tokens` 的數字＋訊息數 | 真機 tmp DB 沒有 Studio 對話所以是 0 |

## 已知限制／待辦
1. OAuth 真機完整登入沒跑（避免改使用者 auth.json）；device-code 型（codex/nous）輸出格式已對過 CLI 原始碼，PKCE 型（anthropic）靠 `/submit` 貼 code。
2. `sessions.py` 的 profile 過濾待該檔負責人補一行 `profile_visible`。
3. `hermes profile import` 真機沒跑（pytest 有 round-trip）。
4. ~~gateway restart 真機沒按~~ round2 已按。
5. 用量的 messages 層級（每則訊息 token）沒做，Hermes session 層已夠用。
