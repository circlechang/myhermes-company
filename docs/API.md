# Studio Server API 契約 v0.1（前後端共同依據）
Base: `http://127.0.0.1:8700`。除 `/auth/login`、`/health`、`/webhooks/wf/{token}`、Coding proxy（自有 token）外皆需 `Authorization: Bearer <jwt>`。
正式環境所有端點也可加 `/api` 前綴同源呼叫（`/api/health` ≡ `/health`，middleware 去前綴；未知 `/api/*` 回 404 JSON 而非 index.html）；WebSocket 一律 `/ws/*`（也接受 `/api/ws/*`）。
所有回應 JSON；錯誤 `{ "error": { "code": "...", "message": "..." } }`。

章節順序依 `docs/PARITY.md` 的區段字母（A 聊天 … Q 發行）。

## Auth
- `POST /auth/login {username,password}` → `{token, member:{id,username,role,company_id}}`
- `GET /auth/me` → member
- 首次啟動若無任何成員：自動建 company「預設公司」＋ owner `admin/admin`（啟動 log 提示改密碼）。

## Company / Members
- `GET /companies/current` → `{id,name,created_at}`
- `GET /members`、`POST /members {username,password,role}`、`PATCH /members/{id}`、`DELETE /members/{id}`（owner/admin）

## Agents（AI 員工 = Hermes profile 綁定）
- `GET /agents` → `[{id,name,profile,title,description,avatar,model,enabled,soul_excerpt}]`
  伺服器啟動時掃 `hermes profile list`／`~/.hermes/profiles/*` 自動同步為 agents（未綁定者 enabled=false）。
- `POST /agents {name,profile,title,description}`、`PATCH /agents/{id}`、`DELETE /agents/{id}`
- `GET /agents/{id}/soul` → `{content}`；`PUT /agents/{id}/soul {content}`（寫 `~/.hermes/profiles/<p>/SOUL.md`）
- `GET /agents/{id}/skills` → `[{name,enabled,description}]`（gateway `/p/<profile>/v1/skills`）

## Chat（A 聊天／工作臺對話）
### Session 管理
- `GET /sessions?agent_id=&include_archived=false&category_id=` → `[session]`，排序：**進行中（run_status=running）置頂 → last_message_at 新→舊**。
  session 欄位：`{id,agent_id,member_id,title,source,created_at,updated_at,last_message_at,archived,category_id,model,provider,running,run_status,last_run_id,usage:{input_tokens,output_tokens,total_tokens,context_tokens},imported_from}`
  `source`：workbench | workflow | 匯入自 Hermes 的原 source（cli/telegram/cron/api_server…），前端依此分組。
- `POST /sessions {agent_id,title?,source?,model?,category_id?}` → session
- `GET /sessions/{id}`；`PATCH /sessions/{id} {title?,archived?,category_id?("" 清除),model?,provider?}`；`DELETE /sessions/{id}`
- `POST /sessions/{id}/model {model,provider}`（空字串＝回 profile 預設）→ session
- `GET /sessions/search?q=&limit=30` → `[{session,match:"title"|"message",snippet,message_id?}]`（Ctrl+K；LIKE 大小寫不敏感）
- `GET /sessions/{id}/messages` → `[{id,role,content,run_id,created_at,reply_to,attachments:[{name,path,mime,size}],reasoning?,usage?,tool_name?,tool_args?,tool_result?}]`
### 分類（`server/studio/modules/chat`）
- `GET /chat/categories`、`POST /chat/categories {name,color?,position?}`、`PATCH /chat/categories/{id}`、`DELETE /chat/categories/{id}`（刪分類只清 session.category_id）。分類屬於「成員」自己。
### 上傳／下載／預覽
- `POST /chat/uploads`（multipart：`session_id`、`files[]`，單檔 ≤50MB）→ `[{name,path,mime,size,session_id}]`；存 `<STUDIO_DB 目錄>/uploads/<company_id>/<session_id>/`，檔名淨化＋同名加序號。
- `GET /chat/uploads?session_id=` → 該 session 已上傳清單
- `GET /chat/files?path=&download=false&token=`（`token` query 給 `<img>/<iframe>` 用）→ 檔案本體；`.html` 一律以 `text/plain` 回，前端用 sandbox iframe srcdoc 顯示。
  **白名單**：① 該公司 uploads 目錄 ② `$HERMES_HOME/workspace` ③ 該成員 session 訊息內文／附件／tool_result 中「原文出現過」的絕對路徑；其他一律 404。
- `GET /chat/preview?path=` → `{kind,name,path,size,url,...}`；kind＝html/markdown/code→`text,language,truncated`；csv→`rows,truncated`；docx/pptx→`html`（python-docx / python-pptx 簡易轉換）；xlsx→`sheets:[{name,rows,truncated}]`（openpyxl，每表 500 列）；pdf/image→前端用 `url`；binary→無預覽。轉換失敗回 `kind=binary,error`（不 500）。
### 模型
- `GET /chat/models?profile=&refresh=false` → `{providers:[{slug,name,is_current,authenticated,models:[{id,provider,label,pricing?}]}],models,current:{model,provider},fallback?,error?}`
  來源 gateway `GET /p/<profile>/api/model/options`；沒有該端點時退回 `/v1/models`（`fallback:true`）。
### Hermes 歷史 session（唯讀 `state.db`，`file:…?mode=ro`）
- `GET /chat/hermes-history/sources` → `[{profile,total,sources:{cli:n,telegram:n…}}]`（default＝`$HERMES_HOME/state.db`，其餘＝`profiles/<p>/state.db`）
- `GET /chat/hermes-history?profile=&source=&q=&limit=50&offset=0` → `[{profile,id,source,title,model,started_at,ended_at,last_activity_at,message_count,tool_call_count,input_tokens,output_tokens,archived}]`
- `GET /chat/hermes-history/{profile}/{id}/messages` → `{session,messages:[...]}`（assistant.tool_calls 拆成 tool 訊息並用 tool_call_id 配對結果；system 略過）
- `POST /chat/hermes-history/{profile}/{id}/import {agent_id?,title?}` → Studio session（`source`＝原 source、`imported_from="<profile>:<id>"`、token 用量帶入；同一來源重複匯入回同一筆）
### WS `/ws/chat?token=<jwt>`
- client→server：
  - `{"type":"run","session_id","input","attachments?":[{name,path,mime,size}],"reply_to?":message_id,"model?","provider?"}`
  - `{"type":"regenerate","session_id"}`：刪掉最後一則使用者訊息之後的所有訊息，用同一句重跑
  - `{"type":"edit","session_id","input","message_id?"}`：改寫最後（或指定）一則使用者訊息、刪掉其後訊息並重跑
  - `{"type":"approval","run_id","decision":"once|session|always|deny"}`、`{"type":"stop","run_id"}`、`{"type":"steer","run_id","input"}`
- server→client：原樣轉發 gateway 事件並加 `session_id`：`run.started{run_id,message_id,attachments,reply_to,model}`、`message.delta{delta}`、`reasoning.available{...}`、`tool.started{name,args}`、`tool.completed{name,result}`、`approval.request{approval_id,command,context,pending_id}`（同時落 inbox `pending_approvals`）、`subagent.start{subagent_id,goal,task_index,task_count,model,depth}`／`subagent.complete{subagent_id,goal,status,summary,output_tail,duration_seconds,input_tokens,output_tokens,tool_count,cost_usd}`（背景委派；complete 落庫成 `tool_name=subagent` 的 tool 訊息）、`run.completed{output,usage?,message_id,session_usage?}`、`run.failed{error}`、`run.cancelled`、`run.steered`
  - 額外：`ready`、`approval.ack{already_decided?,decision?}`（收件匣已先決定時不再 forward）、`approval.responded{approval_id,decision,via:"inbox"}`（收件匣決定後推回對話）、`stop.ack`/`steer.ack`、`messages.removed{ids}`（regenerate/edit 先發）、`error{code,message}`（`busy`＝該 session 仍在回覆）
  - 送給 Hermes 的實際 input＝`[引用先前訊息]\n> …`（若有 reply_to）＋使用者文字＋`[附件檔案，已存在本機，可直接讀取]\n- name: /abs/path`；**圖片附件另以 `input:[{role:"user",content:[{type:"text"},{type:"image_url",image_url:{url:"data:image/…;base64,…"}}]}]` 送**（api_server `_normalize_multimodal_content` 接受 data:image），gateway 回 400 時退回純路徑。
  - usage 累計：`run.completed.usage` 加總到 session（`input/output/total_tokens`），`context_tokens`＝最後一次 run 的 in+out；同時存到 assistant 訊息 `usage`。`reasoning.available` 文字存到 assistant 訊息 `reasoning`。
  - 伺服器負責：session→profile 對應、呼叫 `POST /p/<profile>/v1/runs`（body 帶 `session_id`、`conversation_history`、`model`、`provider`）、訂閱 `/events` SSE、落 messages 到 SQLite、維護 `session.run_status`（伺服器重啟時把殘留的 running 清掉）。
  - **上下文維持的實際做法（M0 決定）**：查 `gateway/platforms/api_server.py` 後確認 `/v1/runs` 只會「讀」`previous_response_id`，但只有 `/v1/responses` 會寫入 response store，run_id 無法用 `previous_response_id` 串接。因此改為：
    1. 每個 Studio session 建立時產生固定的 `hermes_session_id`（`studio_xxx`），每次 run 以 `session_id` 帶給 gateway（同一 Hermes session 累積記憶／SessionDB）；
    2. 每次 run 同時帶 `conversation_history`（從 Studio SQLite 取最近 40 則 user/assistant 訊息），這是 gateway 明確支援且優先於 previous_response_id 的欄位。
    實測（2026-08-29）第二輪「我上一句問了你什麼」能正確回答。
  - `tool.started`/`tool.completed` 轉發時補 `name`（gateway 欄位是 `tool`）與 `args`（gateway 的 `preview`）、`result{duration,error}`；`approval.request` 補 `approval_id`（gateway 沒有獨立 id，以 run_id 代替）與 `context{choices,...}`。
  - 壓縮進度：gateway 0.20.5 的 `/v1/runs/{id}/events` 沒有 compression 事件（只有 message.delta / tool.* / reasoning.available / approval.* / subagent.start|complete / run.*），前端保留 `compress|compact` 事件名的顯示位。

## Channels（B 平台頻道）— `server/studio/modules/channels`（owner/admin）
- `GET /channels[?profile=]` → `{platforms:[{id,label,description,docs_url,configured,fields:[{name,label,required,secret,kind,set,hint,default,value?}],config_section,config_keys,config,webhook_url?,webhook_hint?}], env_path, config_path}`；secret 欄位不回 value
- `PUT /channels/{id} {env?:{KEY:value|null}, config?:{…}, restart?:bool, profile?}` → `{ok, env:{KEY:set|removed|unchanged}, config, restart, platform}`；只改對應 key，寫 `~/.hermes/.env`（或 profile 的 .env）與 `config.yaml` 平台區段
- `DELETE /channels/{id}` 移除該平台所有 env key
- `GET /channels/gateway/status` → `{ok,running,pid,supervised,stale_service,profiles:[{name,running,pid}],raw}`（解析 `hermes gateway status`）；`POST /channels/gateway/restart`
- 平台 id：line telegram discord slack whatsapp matrix feishu dingtalk qqbot weixin wecom

## Usage（C 用量）— `server/studio/modules/usage`（唯讀 state.db）
- `GET /usage/summary?days=30&profile=&company=1` → `{totals:{input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,sessions,sessions_per_day,api_calls,messages,tool_calls,cost_usd,cost_hermes_usd,cost_table_usd,sessions_unpriced,cache_hit_rate,days}, daily:[{key,sessions,input_tokens,output_tokens,cache_read_tokens,cost_usd}], by_model, by_source, by_profile, studio:{sessions,messages,input_tokens,output_tokens}, sources:[{profile,path,exists,sessions}], filters}`
- `GET /usage/prices` → `{prices:[{model,input,output,cache_read,source:builtin|custom}], unit}`；`PUT /usage/prices {model,input,output,cache_read}`；`DELETE /usage/prices/{model}`（admin）

## Cron（D 排程）— `server/studio/modules/cron`（gateway `/api/jobs`；`?profile=` 走 `/p/{profile}`）
- `GET /cron/presets`、`GET /cron/targets[?profile=]` → `{targets:[{id,label,kind}]}`
- `GET /cron/jobs[?profile=&include_disabled=]` → `{jobs:[gateway job + schedule_display + paused]}`；`POST /cron/jobs {name,schedule,prompt,deliver,skills?,repeat?,profile?}`（admin）；`GET/PATCH/DELETE /cron/jobs/{id}`；`POST /cron/jobs/{id}/{pause|resume|run}`
- `GET /cron/jobs/{id}/runs` → `{runs:[executions.db 列], outputs:[{filename,size}]}`；`GET /cron/jobs/{id}/output/{filename}` → `{text}`
- 錯誤：gateway 4xx/5xx → `gateway_error`(502)／`not_found`(404)；連不上 → `gateway_unreachable`

## Kanban（E 看板）— 模組 `modules/kanban`，包 `hermes kanban` CLI
### 模組端點（新）
- `GET /kanban/board?assignee=&archived=` → `{tasks:[card…], diagnostics, profiles, statuses, assignee, archived}`；card = hermes 欄位 ＋ `priority_label(low|medium|high|urgent)` ＋ `tags[]`（Studio 端 `kanban_meta`）＋ `diagnostics[]`
- `POST /kanban/cards {title, body?, assignee?, priority?(label|int), tags?[], skills?[], model?, max_runtime?, parent?, triage?}` → `{id, tags, …}`（`create --json`）
- `GET /kanban/cards/{id}` → `show --json`（`{task, latest_summary, parents, children, comments, events}`，task 含 tags/diagnostics）
- `PUT /kanban/cards/{id}/tags {tags[]}`
- `POST /kanban/cards/{id}/move {status, reason?, result?}`：done→`complete --result`、blocked→`block <reason>`、scheduled→`schedule`、review→`request-review`、archived→`archive`、todo→`unblock`、ready→`unblock`+`promote`；`running` 拒絕（由 dispatcher 決定）
- `POST /kanban/cards/{id}/assign {profile}`（空或 none＝取消）、`POST /kanban/cards/{id}/comments {text}`（`--author` 帶登入帳號）
- `GET|POST /kanban/cards/{id}/attachments`（POST multipart `file`）、`DELETE /kanban/cards/{id}/attachments/{attachment_id}`
- `POST /kanban/cards/{id}/archive`、`POST /kanban/cards/{id}/edit {result, summary?}`
- `POST /kanban/cards/{id}/dispatch {profile?, dry_run?, max_spawn?}` → `{assign?, promote, dispatch}`（assign → promote → `dispatch --json`）
- `GET /kanban/diagnostics?severity=`、`GET /kanban/stats`、`POST /kanban/dispatch {dry_run, max_spawn}`
- CLI 失敗一律 502 `hermes_cli_error`（訊息＝CLI stderr，例如 `cannot block t_xxx`）
### 舊端點（`studio/api/kanban.py`，保留相容）
- `GET /kanban/tasks?status=` → 直接轉 `hermes kanban list --json`（status 只接受 hermes 的值：todo/ready/running/review/blocked/scheduled/done/archived/triage）
- `POST /kanban/tasks {title,body,assignee(profile),priority}`、`POST /kanban/tasks/{id}/status {status}`、`POST /kanban/tasks/{id}/comment {text}`
  status 對應 CLI 動詞：done→`complete`、blocked→`block`、scheduled→`schedule`、ready/todo→`unblock`、review→`request-review`、archived→`archive`、promote→`promote`；CLI 失敗回 502 `hermes_cli_error`。

## Workflows（F 視覺化工作流；M2：畫布＋執行器＋觸發＋投遞）
CRUD（`studio/api/workflows.py`）：
- `GET /workflows?profile=` 清單（profile 篩選）；`POST /workflows {name,nodes,edges,viewport,description?,profile?,budget?}` → 201
- `GET/PATCH/DELETE /workflows/{id}`；PATCH 動到 nodes/edges 時 `version` +1；`POST /workflows/batch-delete {ids}`（連同 runs/排程/webhook 一起刪）
- 驗證失敗回 422 `{error:{code:"workflow_invalid", message:"...; ..."}}`。規則（`studio/workflow_validate.py`）：
  - 節點 `kind`：`hermes`（別名 `agent`）｜`coding-agent`｜`gate`｜`condition`｜`loop`｜`delivery`
  - hermes：`agent_id`（或 `agent`=profile）＋`prompt` 必填；可選 `profile, model, skills[], system, attachments[], tool_approval: deny|allow, done_check: bool, done_check_max_rounds: int(預設 3)`
    - `done_check`：提示末尾加 `[自檢]` 段要求模型最後附 ```json {"status":"complete|continue|blocked","evidence","next"}```。引擎解析（去掉區塊後才是節點輸出）：`complete` → 完成；`continue` → 同節點再跑一輪（新 session、attempt 不變，訊息帶 `[上一輪輸出]`＋下一步；到 `done_check_max_rounds` 就以最後一輪為結果並記 `node.note`）；`blocked` → 建 `workflow_approvals` 一列（`node_title` 帶「（自檢 blocked）」、payload 帶證據），節點 `waiting_approval`，人 approve＝「繼續」（意見以 `[人的指示]` 帶入下一輪）、reject＝「退回」（節點 failed）；解析失敗視為 complete 並記 `node.note` warning。每輪記在 `node_states[n].done_rounds[]` 與事件 `node.done_check {round,status,evidence,next,warning}`
  - coding-agent：`tool: claude-code|codex|pi`、`prompt`、`cwd?`、`timeout_seconds?`
  - condition：`mode: rule`（`rule:{op: contains|not_contains|regex|json_path|min_length|max_length|equals, value?, path?}`）或 `mode: ai`（`agent_id`＋`prompt`，回答 YES/NO）
  - loop：`max_iterations` 1–100、`until?`（同 rule 結構）
  - delivery：`channel: line`（`to`）｜`webhook`（`url` http(s)）｜`file`（`path` 工作區內，可含 `{run_id}`；`append?`）；可選 `template`（`{{text}}`、`{{workflow}}`）
  - 邊：`{id?, source, target, sourceHandle?, targetHandle?, on: always|success|failure, loop_back?}`；`targetHandle` 只能 `input`；`sourceHandle`：一般 `output`、condition `true|false`、loop `body|exit`
  - 拿掉 `loop_back` 邊後必須是 DAG 且單一連通；`loop_back` 邊的 target 必須是 loop 節點、source 必須在該 loop 的 body 可達範圍內
- `GET /workflows/{id}/export` → `{format:"myhermescompany.workflow", format_version:1, exported_at, workflow:{name,description,profile,version,nodes,edges,viewport,budget}}`；`POST /workflows/import {data, name?}` → 201（驗證同上；format 不對回 422 `bad_format`）

執行（`studio/modules/workflows/`）：
- `POST /workflows/{id}/run {input?}` → 202 `{run_id, status:"running"}`；`input.text` 或 `input.payload` 會以 `[外部輸入]` 餵給沒有上游的節點
- `GET /workflows/{id}/runs`、`GET /workflow-runs?status=`（摘要：id/status/trigger/usage/error/時間）
- `GET /workflow-runs/{run_id}` → 摘要 + `snapshot`（凍結的 nodes/edges/viewport/budget/version）+ `node_states`（每節點 `status/attempt/output/error/usage/session_id/hermes_session_id/profile/started_at/finished_at`…）+ `events`（時間軸：`run.status / node.status / edge.decision / approval.request / approval.decided / loop.iteration / tool.approval / node.note / run.rerun`）+ `edge_decisions` + `approvals` + `nodes`（workflow_run_nodes 列）
- `POST /workflow-runs/{run_id}/stop`（409 `not_running`）；`POST /workflow-runs/{run_id}/rerun {from_node?, force?}` → 202 新 run（`trigger:"rerun"`, `parent_run_id`；from_node 之外的上游節點沿用父 run 輸出、狀態 `reused`）；`DELETE /workflow-runs/{run_id}`
  - **效果快取**：rerun 時每個 `hermes / coding-agent / condition` 節點在派發當下算 `effect_hash`（節點設定 prompt/agent/model/skills/system/attachments/tool/rule/done_check ＋ 上游輸出的 hash），與父 run 該節點的 `effect_hash` 相同就直接沿用輸出（狀態 `reused`、`reason:"效果快取…"`、事件 `node.status reused`），不新開 session；`from_node` 本身一定重跑；gate / loop / delivery 不快取；`force:true` 全部重跑
- `GET /workflow-runs/{run_id}/nodes/{node_id}/output` → `{run_id,node_id,spilled,bytes,path,content}`：節點完整輸出（溢出時讀工作區檔案；404 節點不存在）
- run 狀態：`running | waiting_approval | completed | failed | stopped | timeout | budget_exceeded | needs_attention`；節點狀態多 `pending | skipped | reused | outcome_unknown`
- **溢出（spill）**：節點輸出 > 32 KB（環境變數 `STUDIO_WF_SPILL_BYTES`）時完整內容寫 `<workspace>/runs/<run_id>/<node_id>.output.md`，`node_states[n].output` 與下游訊息只帶 head 4 KB ＋ tail 2 KB ＋「完整內容：<路徑>」；`node_states[n].spill = {path, bytes, head_bytes, tail_bytes}`，事件 `node.spill`
- **重啟修復**（伺服器啟動 `recover()`；關機只 `park()` 不改 DB）：`workflow_approvals(status=pending)` 是閘門等待的唯一真相——等閘門的 run 重啟後仍 `waiting_approval`、原 approval 可核准／退回（事件 `run.recovered`）；有節點 `running` 被中斷的 run → 該節點 `outcome_unknown`、run `needs_attention`、其餘 pending 節點 `skipped`、該 run 的 pending 審批 cancelled、收件匣 `inbox_items(kind=workflow_attention, ref=run_id)` 一筆＋事件 `workflow.needs_attention`；可 `rerun {from_node}`
- 訊息組裝：user＝`[上游結果]\n### <上游標題>\n<輸出>…\n\n[退回意見]…\n\n[本節點任務]\n<prompt>\n\n[附件]…`；instructions＝「你在執行工作流「X」的節點「Y」，只做本節點任務…」；每節點一個 Studio session（`source:"workflow"`，`hermes_session_id = wf-<run>-<node>-<attempt>`），對話用 `GET /sessions/{id}/messages` 讀
- 預算 `budget:{max_tokens?, max_cost_usd?, deadline_seconds?}`：超過 → run `budget_exceeded` / `timeout`，其餘節點 `skipped`
- 失敗判定：節點失敗但有走出去的邊（failure/always 路線）視為已處理；沒有 → run `failed`

審批：
- `GET /workflow-approvals?status=pending|all|approved|rejected|cancelled`
- `POST /workflow-approvals/{id}/approve {comment?}`：閘門輸出＝上游結果＋`[審批意見]`
- `POST /workflow-approvals/{id}/reject {comment?}`：閘門直接上游節點重跑（attempt+1、新 session、訊息帶 `[退回意見]`），再次進閘門；已決定回 409 `already_decided`；run 已不在引擎（修復程序判定 needs_attention）回 409 `not_waiting`
- 同一組端點也處理 hermes 節點 `done_check` 的 blocked（approve＝繼續、reject＝退回節點失敗）

排程 / webhook：
- `GET/POST /workflows/{id}/schedules {cron, enabled?, input?}`（5 欄 cron，伺服器本地時間；壞表達式 422 `bad_cron`）；`PATCH/DELETE /workflow-schedules/{sid}`；欄位 `next_run_at/last_run_at/last_run_id`。排程器每 20 秒檢查，狀態在 DB，重啟後從現在重算下一次（不補跑）
- `GET/POST /workflows/{id}/webhooks` → `{token, path:"/webhooks/wf/<token>", hits}`；`DELETE /workflow-webhooks/{wid}`
- `POST /webhooks/wf/{token}`（**免 token 認證，token 即憑證**）→ 202 `{run_id}`；body JSON 進 `input.payload`，有 `text` 欄位另放 `input.text`

其他：
- `GET /workflow-env` → `{coding_tools:{claude-code|codex|pi:{installed,path}}, line_configured, workspace}`
- `WS /ws/workflows?token=`：先收 `{type:"ready"}`；事件 `run.status / node.status(+output/error/usage/branch/reason) / node.delta / node.tool / node.done_check(+round/status/evidence) / approval.request(+payload, kind?:"done_check") / approval.decided`，都帶 `run_id, workflow_id, ts`；可送 `{type:"subscribe", run_ids:[...]}` 只收特定 run，`{type:"ping"}`

## Models（G 模型管理）— `server/studio/modules/models`（owner/admin；key 永不回傳）
- `GET /models/providers[?profile=]` → `{providers:[{id,name,kind:builtin|custom,auth_type,base_url,key_envs,key_env_set,oauth_capable,oauth_logged_in,oauth_error,credentials:[{id,label,auth_type,source,last_status}],configured,is_active,is_current,group,hidden_models,aliases,enabled, model?,models?,key_env?}], active_provider, current:{model,provider,base_url}, groups}`
- `GET /models/catalog[?refresh=1]` → gateway `/api/model/options` 原樣；`GET /models/providers/{id}/models?live=0|1[&profile=]` → `{models,source:gateway|live}`
- `POST /models/providers/detect {base_url,api_key?,provider_id?}` → `{base_url,models,detected,tried}`（自動試 /v1 /v4 /api/v1 …）
- 自訂供應商：`POST /models/providers {name,base_url,api_key?,model?,models?,api_mode?,context_length?,detect=true}` → 寫 `config.yaml providers.<slug>`＋`.env HERMES_CUSTOM_<SLUG>`；`PUT /models/providers/{id}`；`DELETE /models/providers/{id}`
- 內建供應商 key：`PUT /models/providers/{id}/key {api_key,env_var?}`；`DELETE /models/providers/{id}/key`
- OAuth：`POST /models/auth/{provider}/start` → `{id,provider,status:starting|waiting|done|failed|cancelled,url,code,output,error}`（包 `hermes auth add <p> --type oauth --no-browser`）；`GET /models/auth/sessions/{id}`；`POST /models/auth/sessions/{id}/submit {text}`；`DELETE /models/auth/sessions/{id}`；`DELETE /models/auth/{provider}`（logout）；`GET /models/auth/{provider}/status`
- 預設模型：`GET /models/default[?profile=]`；`PUT /models/default[?profile=] {model,provider?,base_url?}`（寫 config.yaml `model.*`）
- 偏好：`PUT /models/providers/{id}/prefs {group?,hidden_models?,aliases?,enabled?}`（Studio DB `model_prefs`）
- STT／TTS：`GET /models/speech[?profile=]` → `{tts:{provider,providers:[{id,name,key_envs,key_set,current,settings}]}, stt:{…,enabled}, voice}`；`PUT /models/speech {tts?,stt?,env?}`

## Profiles（H 多 Profile）— `server/studio/modules/profiles`
- `GET /profiles` → `{profiles:[{name,display_name,model,provider,gateway,is_default,description,path,has_soul,has_env,skills}], active, restricted}`（依成員可見性過濾）
- `GET /profiles/{name}`；`POST /profiles {name,clone_from?,description?,no_skills?}`（`hermes profile create --no-alias`）；`POST /profiles/{name}/clone {new_name}`；`POST /profiles/{name}/rename {new_name}`；`DELETE /profiles/{name}`（`-y`；default 400）；`POST /profiles/{name}/use`
- `GET /profiles/{name}/export` → tar.gz 檔（`hermes profile export`）；`POST /profiles/import`（multipart `file`＋`name?`）
- `GET /profiles/{name}/config[?raw=1]` → `{path, config}`（密鑰欄位 `***`）／`{path,text}`；`PUT /profiles/{name}/config {set?:{dotted:value}, patch?:{…}, unset?:[…], text?}`（ruamel 保留註解）
- 帳號綁定：`GET /profiles/assignments/members`、`PUT /profiles/assignments/members/{id} {profiles:[…]}`；`/members` 的建立／PATCH 也接受 `profiles`，`member_public` 多 `profiles`、`all_profiles`
- 可見性 helper：`studio.auth.allowed_profiles(member) -> list|None`（None=全部）、`profile_visible(member, name)`。owner 全部；admin 未指派＝全部；member 只看指派。`/agents` 已套用，其他模組請自行呼叫。
- 錯誤碼：`bad_profile_name`、`unknown_profile`、`conflict`、`hermes_cli_error`(502)、`bad_yaml`

## 檔案瀏覽器（I；模組 files，前綴 `/files`）
虛擬路徑格式 `<root>/<相對路徑>`；root：`workspace`、`profile:<name>`、`uploads`、`extra:<label>`（env `STUDIO_FILE_ROOTS="label=/abs,..."`）。任何 `..`／絕對路徑／symlink 逃逸 → 400 `path_traversal`；未知 root → 404 `root_not_found`。`profile:*` 根僅 owner/admin 可寫（member 403）。
- `GET /files/roots` → `[{id,label,kind,exists,writable}]`
- `GET /files/list?path=` → `{path,root,parent,entries:[{name,path,kind:dir|file,size,mtime,ext}]}`
- `GET /files/read?path=` → `{path,name,size,mtime,mime,binary,truncated,content|null}`（文字 >2MB 只回前 2MB 並 truncated）
- `PUT /files/write {path,content}`、`POST /files/mkdir {path}`、`POST /files/rename {path,new_name}`、`POST /files/copy|move {path,dest(目錄)}`、`DELETE /files?path=`（409 `exists` 同名）
- `POST /files/upload?path=<dir>`（multipart `file`）、`GET /files/download?path=`
- `POST /files/attach {path}` → `{uri:"workspace://<root>/<rel>",abs_path,name}`；前端派發 `CustomEvent('studio:attach',{detail:{path,uri,name}})` 給聊天模組

## Group chat（J 群聊；模組 `modules/groupchat`）
- `GET /groupchat/rooms` → `[room]`；room = `{id,name,invite_code,no_mention_policy(none|round_robin|host),host_member_id,summarizer_member_id,history_n,compress_threshold_tokens,max_ai_depth,created_by,members[],last_message,message_count}`
- `POST /groupchat/rooms {name, no_mention_policy?, agent_ids?[], history_n?, compress_threshold_tokens?, max_ai_depth?}`、`GET|PATCH|DELETE /groupchat/rooms/{id}`
- `POST /groupchat/rooms/join {invite_code}`、`POST /groupchat/rooms/{id}/invite/regenerate`
- `GET /groupchat/rooms/{id}/members`；`POST … {agent_id | member_id, display_name?, model?, system_prompt?}`；`PATCH …/{rm_id} {display_name?, model?, system_prompt?, agent_id?}`；`DELETE …/{rm_id}`
- `GET /groupchat/rooms/{id}/messages?before_seq=&limit=` → `[{id,seq,sender_id,sender_name,sender_kind(human|ai|system),content,depth,run_id,status(done|failed),created_at}]`
- `POST /groupchat/rooms/{id}/messages {content}`（與 WS `message` 同一條路：存檔→廣播→路由 AI）
- `GET /groupchat/rooms/{id}/summaries`、`POST /groupchat/rooms/{id}/compress`（強制把摘要後所有訊息折成新摘要；沒東西 409）、`GET /groupchat/rooms/{id}/context` → `{messages_since_summary, estimated_tokens, threshold, history_n, summary}`
- `WS /ws/groupchat?token=`（同 `/groupchat/ws`）
  - client→server：`{"type":"join","room_id"}`、`{"type":"leave","room_id"}`、`{"type":"message","room_id","content"}`、`{"type":"typing","room_id"}`、`ping`
  - server→client（都帶 `room_id`）：`ready{member_id}`、`joined{member}`、`left`、`message.new{message}`、`human.typing{member_id,name}`、`ai.typing{member_id,name,trigger_id}`、`ai.started{member_id,run_id}`、`ai.delta{member_id,run_id,delta}`、`ai.tool{member_id,tool}`、`ai.done{member_id,run_id}`、`ai.failed{member_id,error,message}`、`summary.started`、`summary.updated{summary}`、`summary.failed{error}`、`error{code,message}`
  - 路由：有 @ → 被點名的 AI（可多位、排除自己）；沒 @ 且人類發言 → 依 `no_mention_policy`；AI 發言沒 @ 不觸發；AI 訊息 `depth ≥ max_ai_depth` 不再觸發。
  - 送 gateway：`POST /p/{profile}/v1/runs {input:"[名字]: 內容", conversation_history:(摘要後最近 history_n 則；自己=assistant、其他=user), instructions:(成員名單＋角色提示＋摘要), session_id:"studio_room_{room}_{member}", model?}`。

## Coding Agents（模組 K，前綴 `/coding`，程式在 `server/studio/modules/coding_agents/`）
- `GET /coding/agents` → `[{id: claude|codex|pi, name, installed, path, version, install_cmd, package, docs, supports:{resume,images,proxy}, npm_available, settings, running}]`
  偵測順序：PATH → `~/.local/bin` → `/opt/homebrew/bin` → `/usr/local/bin` → `~/.nvm/versions/node/*/bin`；版本以 `<bin> --version` 取得。
- `POST /coding/agents/{agent}/install`（owner）→ 202 `{job_id, command}`，背景跑 `npm i -g <package>`；`GET /coding/install/{job_id}` → `{status: running|completed|failed, log, exit_code}`。
- `GET /coding/settings/{agent}`、`PUT /coding/settings/{agent} {workspace?, model?, api_mode?: direct|hermes, hermes_profile?, extra?}`（admin）
  `extra`：claude `permission_mode(default|acceptEdits|plan|bypassPermissions)`、`max_turns`、`max_budget_usd`、`allowed_tools`、`dangerously_skip_permissions`；codex `sandbox(read-only|workspace-write|danger-full-access)`。每家公司一份。
- `GET /coding/proxy-info`（admin）→ `{anthropic_base_url, openai_base_url, token, claude_env, codex_config_snippet, codex_env}`；`POST /coding/proxy-info/rotate`（owner）重設 token。
- `GET /coding/fs?path=` → `{path, parent, is_git, dirs:[{name,path,is_git}]}`（工作區選擇器）。
- `GET /coding/sessions?agent=`、`POST /coding/sessions {agent, workspace?, model?, title?}`、`GET/PATCH/DELETE /coding/sessions/{id}`
  session 落在共用 `sessions` 表（`source=coding:<agent>`、`agent_id=""`），補充欄位在 `coding_session_meta`（workspace/model/external_session_id/status）。
- `GET /coding/sessions/{id}/messages`（共用 `messages` 表，role user|assistant|tool）
- `GET /coding/sessions/{id}/runs` → `[{id,status,exit_code,prompt,diff_before,diff_after,files:[{status,path}],usage,error,started_at,finished_at}]`
- `POST /coding/sessions/{id}/images {filename, data_base64}` → `{path}`（存到 `<workspace>/.studio-uploads/`；Claude Code 在 prompt 附路徑請它 Read，Codex 用 `-i`）
- `WS /ws/coding?token=`：
  - client→server：`{"type":"run","session_id","input","images?":[path]}`、`{"type":"stop","run_id"}`、`ping`
  - server→client（都帶 `session_id`、`run_id`）：`ready`、`run.started{command}`、`session.init{external_session_id,model?}`、`message.delta{delta}`、`tool.started{name,args,call_id}`、`tool.completed{name,result,call_id,error}`、`log{text,stream?}`（stderr／不認得的行）、`run.completed{output,usage,diff:{before,after,files,is_git},exit_code,external_session_id}`、`run.failed{error,output?,diff}`、`run.cancelled{output?,diff}`、`stop.ack`、`error{code,message}`
  - 第二輪起自動續接：claude `--resume <session_id>`、codex `exec resume <thread_id>`、pi `--session`。
  - 執行指令：claude `claude -p <prompt> --output-format stream-json --verbose [--model] [--resume] --permission-mode … [--max-turns] [--max-budget-usd]`；codex `codex exec --json --skip-git-repo-check -C <ws> [-m] -s <sandbox> [-i img] [resume <id>] <prompt>`；pi `pi -p --mode json [--model] [--session] <prompt>`。
- 相容 proxy（給沒有 Anthropic／OpenAI key 的人用 Hermes 模型跑 CLI；驗證用 `x-api-key` 或 `Authorization: Bearer <proxy token 或 Studio JWT>`）：
  - `POST /coding/proxy/anthropic/v1/messages`（Anthropic Messages，支援 `stream`）→ Hermes `/p/<profile>/v1/chat/completions`；`POST …/messages/count_tokens` 回估算值。
  - `POST /coding/proxy/openai/v1/responses`、`POST …/chat/completions`（直通、去掉 `tools`/`model`）、`GET …/models`。
  - profile：`?profile=` 或 `X-Hermes-Profile`，否則用該公司 claude／codex 設定的 `hermes_profile`。
  - `api_mode=hermes` 時 Studio 自動注入：claude `ANTHROPIC_BASE_URL=<base>/coding/proxy/anthropic`、`ANTHROPIC_AUTH_TOKEN=<token>`；codex `-c model_provider=myhermescompany -c model_providers.myhermescompany.{base_url,wire_api="responses",env_key="MHC_PROXY_KEY"}` 與環境變數 `MHC_PROXY_KEY`。

## Skills／記憶／Journey（L；模組 skills、memory、journey）
- `GET /skills?profile=&q=&category=&source=local|builtin` → `{profile,items:[{name,dir,path,source,category,description,version,tags,mtime,files,enabled,seeded?}],categories:[{name,count}]}`
- `GET /skills/{name}?profile=` → item ＋ `{content,frontmatter,body,attachments:[{rel,size}]}`；`GET /skills/{name}/file?profile=&rel=` → `{rel,binary,size,content}`
- `PUT /skills/{name} {profile,content,category?}`（owner/admin；建立或覆寫 local SKILL.md）
- `POST /skills/{name}/toggle {profile,enabled}` → 寫 profile config.yaml `skills.disabled`（保留註解）
- `GET/PUT /skills/{name}/note {content}`（每成員筆記，Studio 表 `skill_notes`）
- `GET /skills/usage` → `{counts:{skill:n},top:[[skill,n]]}`
- `GET /skills/bundles`、`POST /skills/bundles {name,skills[],description?,instruction?}`（`hermes bundles create`）、`DELETE /skills/bundles/{name}`
- `GET /memory/files?profile=`、`GET /memory/file?profile=&name=`、`PUT /memory/file {profile,name,content}`（admin）、`DELETE /memory/file?profile=&name=`（MEMORY.md/USER.md 不可刪）、`GET /memory/status?profile=`（`hermes memory status` 文字）
- `GET /journey/graph?profile=&entries=1&merge_hermes=0` → `{nodes:[{id,label,kind:skill|memory|memory_entry,category,timestamp,...}],edges:[{source,target,kind:wikilink|code|mention|contains|hermes}],categories,time_range:[min,max],stats}`

## 主題（M；模組 theme，前綴 `/theme`，每成員）
- `GET /theme` → `{settings:{mode:light|dark|system,style:rounded|square,density:comfortable|compact,font_size:12..20,text_color,primary,background_opacity},has_background,updated_at}`
- `PUT /theme {settings:{...部分}}`、`DELETE /theme`（重設）
- `POST /theme/background`（multipart `file`，png/jpeg/webp/gif ≤8MB）、`GET /theme/background`（圖檔）、`DELETE /theme/background`

## 日誌（N；模組 logs）
- `GET /logs/files` → `[{id,group,name,size,mtime}]`（id：`hermes/<f>`、`profile:<p>/<f>`、`studio/studio.log`）
- `GET /logs/read?file=&lines=200&level=&q=&http_only=0` → `{file,size,entries:[{raw,ts,level,component,msg,http:{method,path,status}|null}]}`
- `WS /ws/logs?token=&file=&level=&q=` → `ready` → `{type:line,entry}` / `{type:rotated}`

## 管理（O 終端／MCP／Plugins／版本；模組 admin）
- `GET /terminal/cwds`（admin）→ `[{id,label,path}]`；`WS /ws/terminal?token=&cwd=&cols=&rows=`（owner/admin）：client 送純文字＝輸入、`{"type":"resize",cols,rows}`；server 送純文字＝輸出、`{type:ready,cwd,shell,pid}`、`{type:exit,code}`、`{type:error,code,message}`
- `GET /mcp/servers?profile=` → `{profile,servers:[{name,transport:http|stdio,url,command,args,auth,enabled,env(遮罩),headers(遮罩),tools}]}`
- `POST /mcp/servers {name,profile,url?|command?,args?,auth?:oauth|header,env?,connect_timeout?}`（`hermes mcp add`）、`DELETE /mcp/servers/{name}?profile=`、`POST /mcp/servers/{name}/test?profile=` → `{ok,output}`
- `GET /plugins` → `hermes plugins list --json` ＋ `enabled`；`POST /plugins/{name}/enable|disable`
- `GET /version?check=1` → `{studio:{version},hermes:{version,date,upstream,behind,python},latest:{tag,url}|null,update_check_enabled,update_available,repo}`；env `STUDIO_UPDATE_CHECK=0` 關閉、`HERMES_GITHUB_REPO` 換 repo

## Voice（P 語音；模組 `modules/voice`）
- `GET /voice/capabilities` → `{stt:{available,engine,model,needs_ffmpeg}, tts:{available,engine,default_voice}, browser_first:true}`
- `POST /voice/transcribe`（multipart `file`, form `language`=zh）→ `{text, language, segments[], engine, model}`；無 whisper-cli／模型 → 501 `stt_unavailable`
- `POST /voice/speak {text, voice?, rate?, volume?}` → `audio/mpeg`（edge-tts）；沒裝 → 501 `tts_unavailable`
- `GET /voice/voices?locale=zh` → `[{name,gender,locale}]`
- 環境變數：`STUDIO_WHISPER_BIN`、`STUDIO_WHISPER_MODEL`
- 前端事件契約：`window` 派發 `studio:voice-input` `{detail:{text,final,source}}`；監聽 `studio:voice-speak` `{detail:{text}}`

## Setup（首次設定精靈）— `server/studio/modules/setup`（owner 限定；`/setup/state` 任何成員）
- `GET /setup/state` → `{completed, is_owner}`：精靈完成了沒。前端首登若 owner 且未完成 → 導 `/setup`；非 owner 未完成 → 頂端提示「請管理員完成設定」。舊版伺服器沒有此端點（404）時前端靜默略過。
- `GET /setup/status` → `{completed, hermes:{installed,bin,version,home,home_exists,install_cmd,docs_url,error}, api:{key_configured,key_source:env_file|env|none,studio_key_loaded,url,env_path,reachable,version,error}, gateway:{ok,running,pid,supervised,stale_service,profiles,raw_tail}, profiles:{count,names}, admin:{default_password,username}, next_step:install|api|password|agents|done, dry_run}`。
  偵測：`hermes --version`、`~/.hermes` 是否存在、`.env` 的 `API_SERVER_KEY` 是否存在且 ≥16 字（只回布林）、用 Studio 載入的 key 打 `/v1/health`、`hermes gateway status`、profiles 目錄數、owner 是否仍用預設密碼 `admin`。
- `POST /setup/enable-api {dry_run?, restart?=true}` → `{status:configured|written|restarting, changed, backup?, reachable, job}`
  - key 已設且 `/v1/health` 通 → `configured`，不動任何檔案（也會把檔案裡的 key 同步進 Studio 的 GatewayClient，給「Studio 起動後才手動設 key」的情況）。
  - key 已設但 gateway 沒回應 → `restarting`：只重啟 gateway，不改 key。
  - key 未設 → `written`：先複製 `.env` 為 `.env.bak-<yyyymmdd-HHMMSS>`，用 `profiles/files.write_env` 只加 `API_SERVER_KEY=<token_urlsafe(32)>` 一行（其他行原樣），同步到 Studio，然後背景 `hermes gateway restart`（沒在跑就 `start`）並輪詢 `/v1/health` 最多 90 秒。
  - 回應與 log 永不含 key 值。`dry_run`（或環境變數 `MHC_SETUP_DRY_RUN=1`）只寫檔、不碰 gateway、不輪詢。同時只允許一個 job（409 `busy`）。
- `GET /setup/enable-api/progress` → `{job:{id,dry_run,done,ok,phase,error,log_tail,steps:[{name:write_key|gateway|health,status:running|ok|failed|skipped,detail}],elapsed,manual_cmd}|null}`（前端每 1.2 秒輪詢）。
- `POST /setup/admin-password {password}`：改呼叫者（owner）自己的密碼；<8 碼或等於 `admin` → 400 `weak_password`。
- `POST /setup/complete` / `POST /setup/reset`：Studio DB `setup_state` 表記 `completed` flag。
- 前端：`/setup` 路由掛在 Layout 之外（全頁精靈）；「設定」頁 owner 看得到「重新執行設定精靈」；精靈完成後清 `mhc.tour.done` 並觸發首次導覽。「稍後再說」只記 sessionStorage，下次登入仍會導向。

## Hermes 狀態
- `GET /hermes/status` → `{gateway_ok, version, profiles:[{name,model,gateway}], api_server_url}`
- `GET /health` → `{ok:true}`

## 設定（環境變數）
所有 `STUDIO_*` 都有等價的 `MHC_*`（兩者都設時 `MHC_*` 優先）。資料目錄預設 `~/.myhermescompany`；啟動時若只有舊的 `~/.hermes-studio-tw` 存在會自動搬移並記 log。
`STUDIO_PORT=8700`、`STUDIO_DB=~/.myhermescompany/studio.db`、`STUDIO_SECRET`（JWT）、
`HERMES_API_URL=http://127.0.0.1:8642`、`HERMES_API_KEY`（預設讀 `~/.hermes/.env` 的 `API_SERVER_KEY`）、`HERMES_HOME=~/.hermes`、
`HERMES_BIN`（預設 `~/.local/bin/hermes`）、`STUDIO_HOST=127.0.0.1`。`STUDIO_SECRET` 未設時自動產生並存到 `<db 目錄>/secret.key`（0600）。
`STUDIO_HOME=~/.myhermescompany`（pid／log／DB／secret／uploads 的根；有設且 `STUDIO_DB` 未設時 DB＝`$STUDIO_HOME/studio.db`）、`STUDIO_ADMIN_PASSWORD`（啟動時套用到 admin）、`STUDIO_FILE_ROOTS`、`STUDIO_UPDATE_CHECK`、`STUDIO_WHISPER_BIN/MODEL`。完整表與非 loopback 安全檢查見 `docs/DEPLOY.md` §0／§5。

## Events（SPEC §9 存事件不存交易）— `server/studio/modules/events`
- 表 `events(id, ts, seq, kind, source, subject, agent, member_id, company_id, payload_json, decision, delivery, causes_json)`；`event_cursors` 是 collector 水位。
  - `seq`：全域單調遞增（寫入時 `MAX(seq)+1`），列表預設依 seq 反序；既有資料在 events 模組 `on_startup` 依 ts、id 補號（`kinds.backfill_seq`）。
  - `causes`：上游事件 id 陣列（因果鏈）。collector 會盡量填：`workflow.node.completed`／`approval.requested` → 該 `workflow.run.started`；`approval.decided` → `approval.requested`；`workflow.run`（結束）→ run.started＋各節點；AI 群聊回覆 → 同房前一則；`chat.run` → 同 session 前一筆。
  - `kind` 白名單在 `events/kinds.py`（`KNOWN_KINDS`＋前綴族 `line. webhook. form. cron. api. pack. custom. other.`；round3 加 `workflow.needs_attention / workflow.recovered / node.done_check / compat.check / compat.precheck`）；不在名單的 kind 寫入時改成 `other.<kind>` 並記 warning（`record()`、collector、`POST /events` 都套）。
- `GET /events?source=&kind=&agent=&member_id=&subject=&since=&until=&q=&limit=100&offset=0` → `{items:[{id,ts,seq,kind,source,subject,agent,member_id,company_id,payload,decision,delivery,causes}],total,limit,offset}`；`kind` 可用 `*` 萬用（`form.*`）；`since/until` ISO 8601（壞格式 400 `bad_time`）；`q` LIKE 搜 payload/subject/kind（全文搜尋請用 `GET /search`）。member 只看得到自己可見 profile 的事件（`agent` 空白者一律可見）。
- `GET /events/kinds` → `{kinds[], prefixes[]}` 白名單。`GET /events/facets` → `{sources,kinds,agents,members:[{value,count}]}`；`GET /events/{id}`；`GET /events/export.csv?（同篩選）` → UTF-8 BOM CSV（最多 5 萬筆）。
- `GET /events/{id}/chain?depth=10` → `{event, upstream:[…由近到遠，各帶 effect=下游 id…], downstream:[causes 含此事件者], truncated}`；看不見的事件略過。
- `POST /events {kind, source?="api", subject?, payload?, agent?, decision?, delivery?, causes?[]}` → 201（外部入口：表單／webhook 轉接／人工登記；member_id＝呼叫者；`causes` 只保留存在的 id）。
- `POST /events/collect`（admin）→ `{ok, added}` 立即掃描一次。
- **唯讀機器 token**：以上 GET 端點也接受 search 模組發的 `mhc_…` token（見 Search）；POST 一律只收 JWT。
- **其他模組寫事件**：`from studio.modules.events import record` → `record(kind, source, subject, payload=None, *, member_id=None, agent=None, company_id="", decision="", delivery="", db=None, causes=None)`；傳 `db` 就掛進呼叫端交易，不傳就自己 commit；engine 未綁或失敗回 `None` 不丟例外。
- **collector**（背景每 `STUDIO_EVENTS_SCAN_SECONDS`=60 秒，0 關閉）：chat `messages`(assistant+run_id)→`chat.run`（source=chat|workflow|coding 依 session.source）、`workflow_runs.started_at`→`workflow.run.started`、`workflow_run_nodes.finished_at`→`workflow.node.completed`（subject `run_node:<run>:<node>:<attempt>`）、`workflow_approvals` 建立→`approval.requested`、已決定→`approval.decided`(decision=approved|rejected)、`workflow_runs` 已結束→`workflow.run`、`room_messages`→`groupchat.message`、`hermes kanban list --json` 狀態變化→`kanban.status`（第一次只建快照）。以 (kind, subject) 查重，重啟不重複。
- 模組自己寫的事件：`approval.request`/`approval.decided`（inbox 危險指令）、`soul.write`/`soul.rollback`、`limit.exceeded`/`limit.reset`、`search.token.created`/`search.token.revoked`/`search.skill.installed`。

## Search（全站 FTS5 搜尋＋AI 可用的 skill）— `server/studio/modules/search`
- 索引：SQLite FTS5 虛擬表 `search_index(scope, ref, company_id, agent, member_id, ts, title, body, meta, text)`，涵蓋 `messages.content`（user/assistant）、`room_messages.content`、`workflow_run_nodes.output`、`events.subject+payload 文字`。**中文**：`text` 欄把每個 CJK 字前後補空白（unicode61 不切 CJK、trigram 搜不到兩字詞），查詢時中文片段轉 phrase `"文 案"`、拉丁字用 `"word"*` 前綴；整段查詢都加引號，不會被 FTS 語法注入。
- 同步：來源表 trigger（insert／update／delete）只寫 `search_dirty(scope, ref, op)`（純 SQL），模組在每次 `GET /search` 前、背景每 `STUDIO_SEARCH_SYNC_SECONDS`=15 秒、啟動時吃掉；索引空的時候全量重建。
- `GET /search?q=&scope=chat|group|workflow|events|all（可逗號並列）&from=&to=&agent=&limit=20&offset=0` → `{items:[{scope,ref,title,snippet,ts,agent,member_id,score,link,meta}],total,q,scopes,match}`；`score` 越大越相關（bm25 取負）；`link` 是前端路徑（chat `/?session=&message=`、group `/groupchat?room=&message=`、workflow `/workflows/runs/{run}?node=`、events `/events?subject=&event=`）。壞 scope 400 `bad_scope`、壞時間 400 `bad_time`。可見性：company 內；member 套 profile 可見性且 `chat` 只看自己的 session；owner/admin 看全公司。
- `GET /search/status` → `{documents, by_scope, dirty}`；`POST /search/reindex`（admin）→ `{indexed}`。
- **唯讀機器 token（owner）**：`POST /search/tokens {label?}` → 201 `{id,label,…,token:"mhc_…"}`（明文只回這一次，DB 只存 sha256）；`GET /search/tokens`；`DELETE /search/tokens/{id}` 撤銷。拿 `mhc_` token 打 API＝以發 token 的 owner 身分，但只有 `GET /search`、`GET /events*` 接受；其他端點 401。
- **安裝 skill（owner）**：`POST /search/install-skill {profile?="", write_env?=false, create_token?=false, studio_url?}` → `{installed_to, profile, env_written, env_file?, token_id?, token_created?}`：把 repo `hermes-skills/mhc-search/` 複製到 `~/.hermes/skills/mhc-search`（default）或 `~/.hermes/profiles/<p>/skills/mhc-search`；`write_env` 才會把 `MHC_STUDIO_URL`（＋ `create_token` 時新發的 `MHC_SEARCH_TOKEN`）寫進該 profile 的 `.env`（同名鍵覆寫、其他行保留、0600、token 不回顯）。skill 原始碼位置可用 `MHC_SKILLS_DIR` 覆寫（pip 安裝時 repo 不在）。
  等價 CLI：`server/.venv/bin/python -m studio.modules.search.install mhc-search [--profile NAME] [--hermes-home ~/.hermes] [--url http://127.0.0.1:8700] [--token-stdin]`。
- **skill `mhc-search`**（`hermes-skills/mhc-search/`）：`scripts/mhc_search.py search "文案" [--scope] [--since 7d] [--agent] [--limit] [--text]`、`events [--kind approval.*] [--subject] [--since]`、`chain <event_id>`；token 依序讀環境變數 `MHC_SEARCH_TOKEN` → `$HERMES_HOME/profiles/$HERMES_PROFILE/.env` → `~/.hermes/.env`；沒 token exit 2。

## Inbox（待辦收件匣）— `server/studio/modules/inbox`
- `GET /inbox[?kind=]` → `{items:[{id,kind,ref_id,title,detail,agent,created_at,link,actions[],api{...},ref?,run_id?,session_id?}],count,by_kind,warnings[]}`，依時間新→舊。
  kind 與來源：`workflow_gate`（`workflow_approvals` pending；`api.approve/reject`＝既有 `/workflow-approvals/{id}/approve|reject`）、`chat_approval`（本模組 `pending_approvals`；`api.resolve`）、`kanban_blocked`（`hermes kanban list --json --status blocked`＋diagnostics 說明；`api.done=/inbox/done`＋`ref`）、`groupchat_mention`（最近 7 天 `room_messages` 內含 `@<人類顯示名>`；member 只看 @ 自己、admin 看全部）、`limit_exceeded`／`notice`（`inbox_items`；`api.done=/inbox/items/{id}/done`）。看板／群聊套 profile 可見性；CLI 失敗放進 `warnings` 不 500。
- `GET /inbox/count` → `{count, by_kind}`（導覽 badge；前端 `useInboxCount()` 每 30 秒）。
- 對話危險指令（表 `pending_approvals`）：**chat 模組收到 gateway `approval.request` 時請呼叫** `POST /inbox/approvals {run_id, session_id?, approval_id?, command?, context?, agent?}` → 201（同 run_id＋approval_id 的 pending 回同一筆；agent 省略時由 session 推得）。`GET /inbox/approvals?status=pending|resolved|expired|all`。`POST /inbox/approvals/{id}/resolve {decision: once|session|always|deny, forward?=true}` → `{ok,decision,forwarded}`：`forward=true` 會代呼 gateway `/p/<agent>/v1/runs/{run_id}/approval`（run 已結束時 forwarded=false 但仍記錄）；已決定 409 `already_decided`。chat 模組若在 WS 端已送出決定，也請呼叫 resolve（`forward:false`）讓收件匣清掉。伺服器重啟時殘留 pending 一律標 `expired`。
- 一般待辦：`POST /inbox/items {kind?="notice",title,detail?,ref?,link?,agent?}`、`POST /inbox/items/{id}/done`；其他模組可用 `from studio.modules.inbox import add_item` → `add_item(company_id, kind, title, detail="", *, ref="", link="", agent="", db=None, dedupe=True)`。
- 外部來源已處理標記：`POST /inbox/done {ref:"kanban:<task_id>"|"mention:<room_message_id>"}`、`DELETE /inbox/done?ref=`（表 `inbox_done`）。

## Packs（行業套件；模組 `modules/packs`，前綴 `/packs`；套件怎麼寫見 docs/PACKS.md）
- 套件＝目錄 `packs/<name>/`（`pack.yaml`＋`stages.yaml`＋`workflows/*.json`＋`profiles/*/SOUL.md`＋`skills/`＋`hooks.py`）。搜尋路徑 `MHC_PACKS_DIR` → `<資料目錄>/packs` → repo `packs/`。hooks.py 只能 import `studio.sdk`（`record_event / add_inbox_item / run_workflow / list_agents`）。
- `GET /packs` → `{items:[{name,version,title,description,workspace_dir,profiles,agents[{profile,name,title,description}],workflows,skills,stages[{id,title,agent,workflow,outputs,gate,description,inputs}],has_hooks,path,installed|null}],errors:{<dir>:原因},roots[]}`；pack.yaml 有未知欄位＝載入失敗，列在 `errors`。
- `GET /packs/{name}` → 套件＋`status`；`GET /packs/{name}/status` → `{installed|null, profiles:{<p>:SOUL.md 存在?}, agents:[{profile,agent_id,name,title,enabled,exists}], topics_count, workspace}`。
- `POST /packs/{name}/install`（owner/admin）→ 201 status（冪等）：profile 不存在才從套件建 SOUL.md、skills 複製到 profile（不覆寫）、agents 綁既有列或新建、每階段匯入一個工作流（名 `[<pack>] <title>`，description `source=pack:<name> stage=<id>`，同名更新）、`installed_packs` 記一列。壞套件 422 `pack_invalid`。
- `DELETE /packs/{name}`（owner/admin）→ `{ok, workflows_removed}`：刪套件工作流（含 runs／排程／webhook）與安裝記錄；agents／profile／主題資料夾保留。未安裝 409 `not_installed`。
- 主題（資料夾當資料庫，`<工作區>/<workspace_dir>/<YYYYMMDD>_<slug>/`，`status.json` 系統維護）：
  - `GET /packs/{name}/topics` → `[{id,title,created_at,updated_at,current_stage,stages:{<sid>:status},lights:[status…]}]`（新→舊）
  - `POST /packs/{name}/topics {title, slug?, notes?}` → 201 主題詳情；依 `stages.yaml` 的 `topic_files` 建初始檔、outputs 父目錄
  - `GET /packs/{name}/topics/{id}` → 摘要＋`{notes,dir,stage_list:[階段定義＋{status,run_id,session_id,updated_at,feedback,error,missing_outputs,inbox_item_id,history[],files:[{path,exists,size,mtime}],can_run,can_approve}],files[]}`；讀取時會補結算 running 但 run 已結束的階段
  - `GET /packs/{name}/topics/{id}/file?path=` → `{path,content,binary,size}`（>2MB 413；越界 400 `bad_path`）；`PUT …/file {path,content}`（`status.json` 不可寫）
- 階段推進（狀態 `draft | running | review | done | failed`）：
  - `POST /packs/{name}/topics/{id}/stages/{sid}/run {force?}` → 202 `{run_id, stage}`：前一階段未 done 或本階段執行中 409 `not_ready`；沒有對應工作流 409 `no_workflow`。呼叫 `sdk.run_workflow`，`input={text:渲染後提示, pack, topic_id, topic_dir(絕對路徑), stage, outputs[]}`，trigger `pack:<name>`。結束後：非 gate → done；gate → review ＋ 收件匣 `pack_stage_review`（link `/packs/<name>?topic=&stage=`）；失敗 → failed（`error`）
  - `GET …/stages/{sid}/run` → `{stage,status,run_id,session_id,run:{status,session_id,error}|null,history[]}`
  - `POST …/stages/{sid}/approve {comment?}` → `{ok,stage,status:"done"}`；`POST …/stages/{sid}/reject {comment}` → `status:"draft"`（`feedback` 存進 status.json，重跑時提示尾巴加 `[退回意見]`）；不是 review 狀態 409 `bad_transition`；收件匣那筆自動標完成
- 事件（`pack.*` 前綴族，白名單原樣存；round3 前是 `custom.pack.*`）：`pack.install / uninstall / topic.created / stage.run / stage.finished / stage.decided`（decision=approved|rejected）。

## SOUL.md 版本歷史 — `server/studio/modules/soul_history`（表 `soul_versions(profile, version, content, member_id, ts, note)`）
- **透過 Studio 寫 SOUL.md 請改走** `PUT /soul-history/{profile} {content, note?}` → `{id,profile,version,member_id,ts,note,chars,lines,same}`（寫檔＋記版本；與最新版相同不新增，`same:true`）。既有 `PUT /agents/{id}/soul` 不記版本，前端 AgentsPage 若要版本化請改呼叫這支。
- 啟動時每個 profile 沒有版本就把現有 SOUL.md 快照為版本 0（冪等）。版本全域（不分公司）；讀取套 profile 可見性，寫入／回滾／快照需 owner/admin。
- `GET /soul-history` → `[{profile,versions,latest}]`；`GET /soul-history/{profile}` → `[meta…]`（新→舊）；`GET /soul-history/{profile}/{version}` → meta＋`content`。
- `GET /soul-history/{profile}/current` → `{content, latest_version, drift}`（drift＝檔案與最新版不同，代表有人從別的路徑改過）；`POST /soul-history/{profile}/snapshot {note?}` 把檔案現況記成新版本。
- `GET /soul-history/{profile}/diff?a=&b=` → `{from,to,diff(unified),added,removed}`；b 省略＝最新、a 省略＝b 的前一版、`b=-1`＝檔案現況（to=null）。
- `POST /soul-history/{profile}/rollback {version, note?}` → 新版本（歷史不可變；`rolled_back_to`）；寫事件 `soul.write` / `soul.rollback`。

## Limits（成本護欄）— `server/studio/modules/limits`（表 `usage_limits`）
- `GET /limits` → `[{id,scope:company|agent,agent_id,daily_tokens,daily_usd,enabled,action:disable|notify,last_triggered_on,disabled_agents[],agent:{id,name,profile,enabled}|null,today:{tokens,usd,runs,tokens_pct,usd_pct,exceeded,triggered_today}}]`
- `POST /limits {scope,agent_id?,daily_tokens=0,daily_usd=0,enabled?,action?}`（admin；0＝不限，至少設一項；agent 不存在 404）、`PATCH /limits/{id}`、`DELETE /limits/{id}`（204）。
- `GET /limits/today` → `{date(UTC), company:{tokens,usd,runs}, agents:[{agent_id,name,profile,enabled,model,tokens,usd,runs}]}`。用量來源＝Studio `messages.usage`（assistant 訊息、UTC 當日）依 session→agent 彙總；美元優先取 usage 內 `cost_usd|estimated_cost_usd`，沒有就用 usage 模組價格表（`session.model` 或 `agent.model`）估算；沒有價格＝0。Hermes 自己（CLI/Telegram）的用量不計入。
- 檢查器每 `STUDIO_LIMITS_CHECK_SECONDS`=60 秒（0 關閉）：超過 → `action=disable` 時把該 agent（company scope＝全公司 agent）`enabled=false`；寫事件 `limit.exceeded`＋inbox `limit_exceeded`。每條上限每天只觸發一次。
- `POST /limits/check`（admin）→ `{fired:[{limit_id,disabled[],usage}]}` 立即檢查；`POST /limits/{id}/reset` → `{ok,re_enabled[]}` 清今天觸發並重新啟用它停掉的 agent（事件 `limit.reset`）。

## Compat（Hermes 相容性）— `server/studio/modules/compat`（詳見 docs/COMPAT.md）
接觸面清單 `server/studio/hermes/contract/surface.yaml`；契約測試 `studio.hermes.contract.run()`；CLI `myhermescompany hermes-check [--json] [--writes] [--only id,id]`（round3 接進 cli.py；等價 `scripts/hermes-contract.sh`／`python -m studio.modules.compat hermes-check`，exit 0 相容／1 部分／2 不相容／3 跑不起來）。
- `GET /compat/surface` → `{version, hermes_tested, modules:{name:desc}, items:[{id,kind,risk,label,note,critical,affects[],probe,target}]}`
- `GET /compat/status` → `{schedule:{enabled,weekday,hour,minute,last_run}, tested:{tag,version,at}, latest_seen:{tag,at}, current:{version,checked_at,verdict,run_id}, last_precheck, running:[job]}`
- `POST /compat/check {writes?:false}`（admin）→ 完整報告 `{schema, hermes{version,cli_version,date,api_url,home,profile}, mode{sandbox,writes}, duration_ms, summary{pass,fail,skip,total,verdict:compatible|partial|incompatible,failed_ids[],affected_modules[{module,failed[]}],by_risk}, items[{id,status:pass|fail|skip,reason,ms,kind,risk,label,critical,affects[],note,detail}], cleanups[], run_id}`。`writes=true` 才做會建資料的呼叫（建完清掉）。
- `GET /compat/runs?kind=check|precheck&limit=` → `[{id,kind,want,tag,version,status,verdict,summary,error,log_path,triggered_by,created_at,finished_at}]`；`GET /compat/runs/{id}` 多 `report`
- `POST /compat/precheck {version:"latest"|"vYYYY.M.D"}`（admin）→ job `{id,want,status,tag,version,progress[{ts,step,msg}],error,log_path,summary}`；同時只能一個（409 `precheck_running`）
- `GET /compat/precheck/{id}` → job ＋ `report`（status：queued|resolving|cloning|installing|starting|testing|done|failed|timeout）
- `POST /compat/check-latest`（admin）→ `{result:"noop:<tag>"|"precheck:<tag>:<job_id>"|"skip:<why>"}`
- `GET /compat/capabilities` → `{source:{finished_at,verdict,hermes_version}|null, modules:[{module,description,status:available|degraded|unavailable|unknown,missing[],degraded[]}]}`
- `GET /compat/schedule`、`PATCH /compat/schedule {enabled?,weekday?(0=一…6=日),hour?,minute?}`（admin）
- 環境變數：`STUDIO_COMPAT_SCHEDULER=0` 關排程、`STUDIO_COMPAT_TICK_SECONDS`、`STUDIO_PRECHECK_DIR`、`STUDIO_PRECHECK_KEEP=1`、`STUDIO_PRECHECK_PYTHON`、`STUDIO_PRECHECK_EXTRA_PKGS`、`STUDIO_HERMES_REPO`
- 事件 `compat.check` / `compat.precheck`（source `compat`）；有 fail 時每家公司一筆 inbox `kind=compat`（ref `compat:<kind>:<tag>`，link `/compat`）
