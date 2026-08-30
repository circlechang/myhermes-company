# 本產品專屬四模組：events / inbox / soul_history / limits

日期 2026-08-29。程式：`server/studio/modules/{events,inbox,soul_history,limits}/`、`web/src/modules/{events,inbox,soul_history,limits}/`。
沒有改其他模組任何檔案；契約寫在 docs/API.md 四個新章節。

| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| events 表＋`record()` helper＋REST（列表／篩選／facets／CSV／手動記錄） | ☑ | pytest `test_events_record_query_export`；真機 `POST /events` line.inbound → `GET /events` 看到、CSV 有 BOM 表頭 | member 可見性用 `agent` 欄位套 profile；`agent` 空白的事件所有人可見 |
| collector（messages / workflow_runs / approvals / groupchat / kanban → events） | ☑ | pytest `test_events_collector_chat_workflow_kanban`（重掃不重複、kanban 狀態變化才記）；真機背景 5 秒掃到 seeded 訊息 `events collector +1` | 沒有 hook 可攔，用輪詢（預設 60 秒）；kanban 第一次只建快照；LINE／webhook 入口要各自呼叫 `record()` 或 `POST /events` |
| 前端 `/events` 時間軸（來源／種類／員工／成員／期間／搜尋、payload 展開、CSV 下載） | ☑ | `tsc --noEmit` 過；沒寫 vitest（指派只要求 inbox、limits） | CSV 下載走 fetch+blob 帶 token |
| inbox 聚合：工作流閘門 | ☑ | pytest `test_inbox_aggregates_and_resolves`（`api.approve/reject` 指向既有 `/workflow-approvals`） | 決定仍由 workflows 模組執行，本模組不代理 |
| inbox 聚合：對話危險指令（`pending_approvals`） | ☑（round2 接上） | chat_ws 收到 `approval.request` 直接 `inbox.record()`（不走 HTTP，事件帶 `pending_id`）；對話頁決定 → chat_ws 先 `inbox.lookup()`，已 resolved 就回 `approval.ack{already_decided}` 不再 forward，否則 forward 後 `inbox.mark_decided()`；收件匣決定 → resolve 代呼 gateway 一次，再經 `chat_ws.notify_approval_decided()` 推 `approval.responded{via:inbox}` 回對話 WS（前端已吃這個事件把卡標成已決定）。pytest `test_ws_approval_lands_in_inbox_and_chat_decision_resolves_it`、`test_ws_approval_decided_from_inbox_forwards_once_and_notifies_chat`（兩條路 `gw_state.approvals` 都只有一筆） | 重啟後殘留 pending 標 expired；徽章數字不輪詢 |
| inbox 聚合：看板 blocked 卡 | ☑ | pytest（FakeCli 加 blocked 卡）；**真機**：`GET /inbox` 看到 2 張 blocked 卡，detail＝diagnostics「blocked for 709h」 | 「已處理」只是 Studio 端標記（`inbox_done`），不改 kanban 狀態；要真的 unblock 去看板 |
| inbox 聚合：群聊 @ 人類 | ☑ | pytest `test_inbox_groupchat_mention`（`@admin` 命中、無 @ 不算、done 後消失） | groupchat 沒有 mention 表，掃最近 7 天 500 則訊息用 regex 比對顯示名；member 只看 @ 自己 |
| `GET /inbox/count` badge API＋前端 `useInboxCount()` | ☑ | 真機 `{"count":2,"by_kind":{"kanban_blocked":2}}` | 每次 count 都會跑一次 `hermes kanban list`（約 0.3 秒）；導覽同事掛 badge 時 30 秒輪詢即可 |
| 前端 `/inbox` 一頁處理（核准／退回附意見／四段式決定／已處理／前往） | ☑ | vitest `specExtras.test.tsx` InboxPage 4 case | 「前往」的 link 由後端給（`/workflows/{id}/runs/{run}`、`/?session=`、`/kanban?task=`、`/groupchat/{room}`），各頁是否吃 query 參數要看該模組 |
| soul_versions 表＋啟動快照版本 0（冪等） | ☑ | pytest（default/researcher/writer 各 v0，再跑 `snapshot_all` 回 0）；**真機**：9 個 profile 全部 v0（SOUL.md 長度 500～2100 chars 不等） | 真機只讀沒寫（不動使用者 SOUL.md，mtime 未變） |
| `PUT /soul-history/{profile}` 寫入＋記版本、diff、rollback、漂移偵測＋snapshot | ☑ | pytest `test_soul_history_versions_diff_rollback`：v0→PUT v1→外部改檔 drift→snapshot v2→rollback 到 v0 產 v3、檔案內容＝v0；member 403、不可見 profile 404 | round2：`PUT /agents/{id}/soul` 改呼叫本模組 `write_versioned()`（回 `version`／`same`），AgentsPage SOUL 卡加「版本歷史」連結 `/soul-history?profile=`（頁面吃 query 參數）；pytest `test_agent_crud_soul_skills` 驗每次儲存有版本、同內容不加版本；vitest pages 驗連結 |
| 前端 `/soul-history` 獨立頁（版本清單、diff 上色、回滾、編輯寫入、漂移提示） | ☑ | `tsc` 過；沒寫 vitest | — |
| usage_limits 表＋CRUD＋今日進度 | ☑ | pytest `test_limits_trigger_disable_and_reset`：60 tokens 60%→未超；昨天的不算；110 超過→agent enabled=false→同日不重複→reset 重新啟用 | 用量只算 Studio 對話的 `messages.usage`；Hermes 自己跑的（CLI/Telegram/cron）不在內 |
| 檢查器每分鐘（可調）超過就停用＋事件＋inbox | ☑ | **真機**：設 default 每日 1 token，seed 一則 5 tokens 訊息到暫存 DB，5 秒內 log `limits fired`、`GET /agents` default enabled=false、inbox 多一筆 limit_exceeded、events 有 `limit.exceeded`；reset 後 enabled=true | 美元靠 usage 帶的 cost 或價格表估算，沒價格＝0 → 純美元上限對無價模型不會觸發 |
| company scope＋notify 模式 | ☑ | pytest `test_limits_company_scope_usd_notify`（cost_usd 0.7 > 0.5 觸發、不停用） | — |
| 前端 `/limits`（新增／編輯／暫停／改模式／刪除／重設、今日進度條、今日各員工表） | ☑ | vitest LimitsPage 3 case（進度條 85%、超額 130%、reset、新增 POST body） | — |

## 測試結果
- 後端：`cd server && .venv/bin/python -m pytest` → **165 passed**（含新 `tests/test_spec_extras.py` 8 個）。
- 前端：`npx tsc --noEmit` 乾淨；`npx vitest run src` → **17 files / 106 passed**（新 `src/test/specExtras.test.tsx` 7 個）。
  `npx vitest run` 不加路徑會把 `e2e/*.spec.ts`（Playwright）也撈進來而失敗，這是既有狀況不是本次造成；coding.test.tsx 在全量平行跑偶爾 flaky、單跑過。
- 沒跑 `vite build`：build 會覆寫 `server/studio/web_dist/`，而 8700 正式站正在服務那個目錄，等合併時再 build。

## 真機（2026-08-29，Hermes v0.20.5，9 個 profile）
- `STUDIO_HOME=<scratch> python -m studio start --port 8791`（暫存 DB；`STUDIO_EVENTS_SCAN_SECONDS=5 STUDIO_LIMITS_CHECK_SECONDS=5`），8700 正式版全程沒動、測完 `pkill` 只剩 8700。
- 指令與結果見上表「真機」欄；用 `STUDIO_DB` 單獨指定 DB 時 CLI 仍會用 `~/.myhermescompany/studio.pid` 判斷「已在執行中」，要用 `STUDIO_HOME` 整個換掉。

## 決策
- collector 用輪詢不用 middleware：messages 由 chat_ws 落庫、沒有 app-level hook；輪詢＋(kind, subject) 查重最簡單可靠，且重啟接著水位掃。
- 危險指令核准由 inbox 自己落庫（`pending_approvals`）而不是讀 WS 記憶體，resolve 時代呼 gateway，讓收件匣能獨立於對話頁做決定。
- 回滾＝新版本（不刪歷史）；版本全域不分公司，因為 SOUL.md 本來就是 Hermes 層的檔案。
- 四個模組都有 nav 項（inbox order 5、limits 45、events 46、soulHistory 47）；導覽同事若要自己掛 `/inbox`＋badge，把 `web/src/modules/inbox/index.tsx` 底部 `nav` 拿掉即可，`useInboxCount()` 已匯出。
- 沒有引用任何外部專案程式碼。


---

# 2026-08-29 追加：events 強化（seq／causes／kind 白名單）＋ search 模組（FTS5）＋ mhc-search skill

程式：`server/studio/modules/events/{kinds.py,models.py,collector.py,api.py}`、新 `server/studio/modules/search/{fts.py,tokens.py,api.py,install.py}`、新 `hermes-skills/mhc-search/`、`web/src/modules/events/{index.tsx,search.tsx,events.test.tsx}`、`server/tests/test_events_search.py`。
設計參考：deepseek-harness（MIT）的事件序號與搜尋機制。

| 項目 | 狀態 | 怎麼驗 | 已知限制／決策 |
|---|---|---|---|
| `seq` 單調遞增＋既有資料補號 | ☑ | pytest `test_events_seq_monotonic_and_kind_whitelist`、`test_events_backfill_seq_for_legacy_rows`；**真機**：把 8700 的 studio.db 複製到暫存 MHC_HOME 起 8791，啟動 log `db: added missing column events.seq/causes_json`，`select count(*),count(distinct seq),min(seq),max(seq)` → `68|68|1|68` | seq 是全域（不是每 company 一組）；配號用 `MAX(seq)+1`，單一 SQLite 寫入者不撞號，多程序寫同一顆 DB 沒測 |
| `causes` 因果鏈＋`GET /events/{id}/chain` | ☑ | pytest `test_collector_fills_causes_for_workflow_chain`（run.started ← node.completed／approval.requested ← approval.decided；run 結束 causes＝started＋節點）；真機 8791 rescan 後 `#66 #67 workflow.node.completed causes=[ev_50785f69d9ff(run.started)]`、`#68 approval.requested causes=[同上]` | 舊資料（升級前已收集的 chat.run／approval.decided）causes 空；真機 `#43 approval.decided` 的 approval 列已不在，鏈是空的 |
| `kind` 白名單（`events/kinds.py`），未知 → `other.*` + warning | ☑ | pytest 同上（`weird.thing` → `other.weird.thing`，caplog 有 warning；`POST /events` 同）；`GET /events/kinds` | 前綴族 `line./webhook./form./cron./api./pack./custom.` 放行（`pack.` round3 加），避免入口型事件每加一個 kind 都要改常數 |
| 時間軸頁：seq、因果鏈展開、`?subject=&event=&q=` 深連結、全站搜尋框 | ☑ | vitest `events.test.tsx`（4 條：搜尋送出／scope 切換／連結、空結果、因果鏈展開、深連結自動開鏈）；`npm run build` 過 | `/search` 路由由 events 模組註冊；round3 補了 `src/help/` 說明頁後已掛上側欄（事件之後） |
| FTS5 全站搜尋（chat／group／workflow／events），中文可搜 | ☑ | pytest `test_search_fts_chinese_hits_all_scopes`（「文案」四個 scope 都命中、「Launch」／前綴 `laun`、AND、注入字串不 500）、`test_search_scope_time_agent_filters`（scope／from／to／agent、更新後同步）、`test_search_member_scoping`；**真機 8791 真實資料** `GET /search?q=文案` → `total 12`（chat 5、workflow 2、events 5），片段與 link 正確；`/search?q=好&scope=chat` → 12 | 索引欄用「CJK 每字一 token」而非 trigram（trigram 搜不到兩字詞）；bm25 對中文短 phrase 的排序意義有限，同分再依 ts 新→舊。events 片段會帶 `input_tokens=…` 這類數值對，可讀性普通 |
| 索引同步（trigger → `search_dirty` → drain） | ☑ | pytest 改訊息內容後舊詞不再命中、新詞命中；真機 `/search/status` `dirty:0` | 沒用外部內容表（多來源）；刪除來源列走 delete trigger。別的程式直接寫 DB 也只會進 dirty 表，不會因缺 Python 函式而炸 |
| 唯讀機器 token（owner 發、只能 GET search/events） | ☑ | pytest `test_search_machine_token_readonly`（POST /events、/search/tokens、/reindex、/auth/me、/agents 都 401；撤銷後 401；admin 發 → 403；事件有記）；真機 8791：`POST /events → 401`、`GET /agents → 401`、`GET /search → 200`、`GET /events → 200` | token 明文只回一次、DB 存 sha256；token 身分＝發 token 的 owner，所以看得到全公司（給 AI 員工用時要知道這點） |
| `mhc-search` skill＋安裝（API／module CLI） | ☑ | pytest `test_install_skill_api_and_module_cli`（裝到 profile／default、.env 只覆寫兩個鍵、不存在的 profile 404）、`test_skill_script_reads_env_and_calls_api`（腳本從 .env 讀 token、search／events／chain 三個子命令、沒 token exit 2）；**真機**：對 8791 `POST /search/install-skill {profile:"tmp-search", write_env:true, create_token:true}` 裝進**暫存 HERMES_HOME** 的 tmp-search profile，`HERMES_HOME=<tmp> HERMES_PROFILE=tmp-search python3 scripts/mhc_search.py search 文案 --text` 印出 12 筆＋link，`events --kind approval.*`、`chain <id>` 正常；使用者 `~/.hermes/skills`、`~/.hermes/profiles/*/skills` 確認沒有 mhc-search | 沒有跑 `hermes -p tmp-search` 真對話（建暫存 profile 要動 Hermes 本體太重），用腳本直呼代替；round3 加了 `myhermescompany install-skill mhc-search [--profile]`（轉呼叫 `studio.modules.search.install`） |
| 不 restart 8700、不 commit | ☑ | 8700 程序與 `~/.myhermescompany/studio.db` 沒動（`pragma table_info(events)` 仍無 seq 欄，等下次重啟才會 migrate＋補號）；8791 驗完已停 | — |

**測試結果**：`server/tests/test_events_search.py` 9 條＋既有 `test_spec_extras.py` 8 條全綠（既有 collector 測試期望值從 3 改 4：多了 `approval.requested`）；再加 chat_module／kanban_board／coding_agents／workflow_engine／groupchat／sessions／auth 共 **100 passed**（5 分鐘）。全套 pytest 一次跑在當時卡住（同機另有 5 個同事的 pytest 同時跑，疑似固定 port 撞到），沒拿到全套數字。vitest `events.test.tsx` 4 條綠、`guidance.test.tsx` 綠。`npm run build`（tsc＋vite）過。全套 vitest 一次跑時偶有跨檔干擾（其他模組正被同事修改中，`workflows/RunPanel.test.tsx` 單獨跑也紅，非本次改動）。

**接手同事注意**：(1) `src/help/` 若加 `/search` 說明頁，把 `web/src/modules/events/index.tsx` 底部 nav 的註解拿掉即可掛側欄；(2) 其他模組要記事件請先看 `events/kinds.py`，新 kind 加進 `KNOWN_KINDS`，否則會變 `other.*`；(3) 想讓 AI 員工用搜尋：owner 在 Studio 呼叫 `POST /search/install-skill {profile, write_env:true, create_token:true}` 一次做完。
