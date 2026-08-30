# 功能清單與實測狀態

每項要：後端 API ＋ 前端頁面 ＋ 自動測試 ＋ 真機實測（打本機 Hermes 0.20.5）。
狀態：☑ 完成並實測　◐ 部分（有自動測試但真機未跑完、或依賴 gateway 尚未提供）　☐ 未做　「不做」需寫理由。
各模組的完整實測紀錄、決策、指令輸出在 `docs/parity/*.md`（索引 `docs/parity/INDEX.md`）；本檔只留狀態與一句話驗法。
彙整日期：2026-08-29（round3 更新）。逐輪的品保紀錄與截圖是內部資料，不隨公開版釋出。

## 進階功能（不計入下方 163 項）
| 項目 | 狀態 | 一句話驗法 | 明細檔 |
|---|---|---|---|
| 工作流強化：等待狀態單一真相＋重啟修復、輸出溢出區、結構化自檢 done_check、效果快取只重跑變動節點 | ☑ | pytest `test_workflow_harness.py`（10）；真機 SIGTERM 後閘門可續核准、done_check 兩輪定稿 | parity/workflows.md |
| Hermes 相容性：59 項接觸面契約（`surface.yaml`）、`hermes-check`、沙盒升級預檢、每週盯新 tag、能力降級 | ☑ | 真機 0.20.5 `hermes-check` 57/0/1 相容、預檢 v2026.8.19 55 秒；round3 `/p/default` 契約項通過 | COMPAT.md |
| 設定精靈 `/setup`：檢查 Hermes → 一鍵開 API 門（寫 key＋重啟 gateway）→ 啟用員工 → 改密碼 | ☑ | pytest `test_setup_wizard.py`（7）＋vitest 6；round3 加「key 錯誤」辨識（`GatewayAuthError`） | COMPAT.md |
| 事件強化＋全站搜尋：seq／因果鏈／kind 白名單、FTS5 中文搜尋 `/search`、唯讀機器 token、`mhc-search` skill | ☑ | pytest `test_events_search.py`（9）；真機 `/search?q=文案` 12 筆；round3 掛上側欄＋`install-skill` 子命令 | parity/spec_extras.md |
| 行業套件 `/packs`：pack.yaml＋stages.yaml＋資料夾當資料庫，第一個套件 `packs/marketing` | ☑ | pytest `test_packs.py`（14）；round3 改「skills 只裝到新建 profile」＋事件 `pack.*` | PACKS.md |

## 總表

| 區段 | ☑ | ◐ | ☐ | 不做 | 明細檔 |
|---|--:|--:|--:|--:|---|
| A 聊天（工作臺） | 21 | 2 | 0 | 0 | parity/chat.md |
| B 平台頻道 | 7 | 0 | 0 | 0 | parity/admin1.md |
| C 用量分析 | 7 | 0 | 0 | 0 | parity/admin1.md |
| D 排程任務 | 5 | 0 | 0 | 0 | parity/admin1.md |
| E 看板 | 11 | 0 | 0 | 0 | parity/collab.md |
| F 視覺化工作流 | 13 | 1 | 0 | 0 | parity/workflows.md |
| G 模型管理 | 9 | 1 | 0 | 0 | parity/admin1.md |
| H 多 Profile | 11 | 0 | 0 | 0 | parity/admin1.md |
| I 檔案瀏覽器 | 5 | 0 | 0 | 1 | parity/admin2.md |
| J 群聊 | 11 | 0 | 0 | 0 | parity/collab.md |
| K Coding Agents | 12 | 3 | 0 | 1 | parity/coding.md |
| L Skills 與記憶 | 9 | 0 | 0 | 0 | parity/admin2.md |
| M 主題 | 4 | 0 | 0 | 0 | parity/admin2.md |
| N 日誌 | 5 | 0 | 0 | 0 | parity/admin2.md |
| O 管理與執行環境 | 7 | 0 | 0 | 2 | parity/admin2.md |
| P 語音與媒體 | 6 | 0 | 0 | 0 | parity/collab.md |
| Q 發行 | 6 | 2 | 0 | 1 | parity/release.md |
| **合計（163 項）** | **149** | **9** | **0** | **5** | |

跨模組共同狀態（round3）：pytest／vitest／build／Playwright／重啟 log 全綠；詳細紀錄是內部品保資料，不隨公開版釋出。
跨模組共同狀態（round2）：pytest 全套 173 綠；vitest 全套連跑 3 次皆綠（coding 串流測試 flake 已修：不是共享狀態，是測試在自動切到 diff 分頁後才找輸出文字，加上 CodingPage 完成後用舊 messages 快取重建畫面的真 bug）；`npm run build` 通過；Playwright 見 qa/round2.md。
◐ 的共同原因：(1) 會改動使用者本機的 Hermes 設定／auth.json、要人互動或會花錢，所以真機沒按；(2) gateway 0.20.5 沒有對應事件或能力（壓縮事件、Responses function_call）；(3) 本機環境沒有（Docker daemon、Pi）。

## A. 聊天（工作臺）— `parity/chat.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| Socket 串流、run 分派到 Hermes profile | ☑ | 真機 WS `run.started → message.delta×n → run.completed`，第二輪能答「上一句問了什麼」（session_id＋conversation_history） |
| 多 session：重新命名／刪除／切換／封存 | ☑ | pytest `test_session_patch_rename_archive_model_and_ordering`；真機 PATCH 200 |
| 依來源分組摺疊（CLI/Telegram/LINE/工作臺…） | ☑ | vitest `groupSessions`；真機匯入的 CLI session 自成一組 |
| 進行中 session 置頂＋spinner | ☑ | 後端 `run_status=running` 排序測試；有 running 時每 3 秒輪詢 |
| 依最後訊息時間排序 | ☑ | `test_session_list_running_first_then_recent` |
| 分類 CRUD／指派（每成員自己的） | ☑ | `test_categories_crud_and_assign` |
| Ctrl+K 全文搜尋（標題＋訊息） | ☑ | `test_search_titles_and_messages`；真機 `q=暗號` 命中 message（SQLite LIKE，非 FTS） |
| Hermes 歷史 session（state.db 唯讀）瀏覽／匯入 | ☑ | 真機 default 5,908 筆＋8 profile，匯入 idempotent、state.db 不被寫入 |
| Markdown／程式碼高亮／一鍵複製 | ☑ | vitest GFM 表格渲染 |
| 工具卡展開／長內容截斷 | ☑ | vitest（1200 字截斷） |
| reasoning 摘要卡 | ☑ | 真機收到 `reasoning.available` 落到 assistant.reasoning |
| 訊息引用 | ☑ | `test_ws_attachments_reply_and_image_parts`（引用前 2000 字） |
| 上傳：檔案／拖放／剪貼簿貼圖 | ☑ | 真機上傳 png/txt/csv，Hermes 讀到 note.txt 暗號 |
| 圖片以 gateway 支援的 content parts 送 | ☑ | 真機 gateway 202、agent 回「已收到圖片」；4MB 以上只附路徑 |
| 下載 agent 產出檔案（白名單） | ☑ | 訊息提到的路徑可讀、鄰檔 404、`/etc/hosts` 404 |
| 內嵌預覽 HTML(sandbox)/PDF/圖/MD/CSV/code | ☑ | vitest；HTML 後端改 `text/plain`＋前端 `sandbox=""` iframe |
| DOCX/PPTX/XLSX 後端轉 HTML | ☑ | `test_office_previews`（簡易轉換，不含圖片樣式） |
| 模型選擇器（gateway `/api/model/options`） | ☑ | 真機 32 providers、current=openai-codex；無 options 端點退回 `/v1/models` |
| 每 session 模型徽章＋token 用量 | ☑ | 真機切到 `gpt-5.6-sol` 後回覆證實；usage 累計落庫 |
| steer／stop／重新生成／編輯重送 | ☑ | 真機 `run.steered → steer.ack → stop.ack → run.cancelled`；regenerate 先發 `messages.removed` |
| 手機版 <640px 側欄抽屜 | ☑ | vitest「☰ 開抽屜側欄」 |
| 壓縮進度 | ◐ | **等上游**：再讀 api_server.py 確認 runs SSE 只有 message.delta/tool.*/reasoning.available/approval.*/subagent.*/run.*，壓縮只在訊息投影層（`_compressed_summary`）沒有事件；前端保留 `compress|compact` 顯示位（vitest 有測） |
| 背景委派結果 | ◐ | gateway 0.20.5 有 `subagent.start`／`subagent.complete`（api_server.py L7443）；chat_ws 轉發＋complete 落庫成 `tool_name=subagent`，前端「背景委派」卡（pytest＋vitest）。**真機**：default 用 delegate_task 委派後收到 `subagent.start{goal,subagent_id,model}`，但 `subagent.complete` 沒有出現在 runs SSE（delegate_task 的 tool.completed 反而先到）→ 前端在 run 結束時自動把執行中的委派卡收成完成；complete 的摘要／token **等上游** |

## B. 平台頻道（11 平台，LINE 優先）— `parity/admin1.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 單頁設定 line/telegram/discord/slack/whatsapp/matrix/feishu/dingtalk/qqbot/weixin/wecom | ☑ | `GET /channels` 列 11 平台；真機偵測 telegram、whatsapp 已設定 |
| LINE 完整欄位（token/secret/port/host/public url/allowlist/home channel）＋ webhook URL | ☑ | 真機寫 `LINE_PORT` 再 DELETE，`.env` diff 與之前完全一致 |
| 憑證寫 `~/.hermes/.env`（只改指定 key，註解順序保留，0600） | ☑ | `write_env` 單元測試；密鑰值永不回前端 |
| 行為設定寫 `config.yaml`（ruamel round-trip 保留註解） | ☑ | pytest `reactions: true` 落盤且註解還在 |
| 已設定／未設定偵測 | ☑ | 必填 key 都非空＝已設定 |
| gateway 狀態（running/PID/launchd/stale/各 profile） | ☑ | 真機 PID＋8 profile running、偵測到 `stale_service` |
| 重啟 gateway | ☑ | pytest 用 fake 驗有呼叫 `hermes gateway restart`；round2 真機按 `POST /channels/gateway/restart`（brief 允許只重啟 default），之後 `/hermes/status` gateway_ok=true（見 qa/round2.md） |

## C. 用量分析 — `parity/admin1.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 總 token／session 數／日均／API 呼叫 | ☑ | 唯讀 state.db；真機 30 日 4,983 sessions、in 203M／out 7.2M |
| 估算成本（Hermes 值優先，否則價格表；公司可覆蓋） | ☑ | 真機 codex 訂閱 session 走價格表 → 顯示「若走 API 的等值」 |
| 快取命中率 | ☑ | `cache_read/(input+cache_read)`；真機 83.9% |
| 模型／來源／profile 分佈 | ☑ | 真機 gpt-5.6-luna 4,809、cron 3,352 |
| 30 日趨勢（recharts 折線＋長條＋圓餅＋明細表） | ☑ | 每日桶補零 |
| 篩選：profile／只算本公司 Studio session | ☑ | `studio_*` session id 確實對回 state.db；member 只看指派 profile |
| Studio 側用量（chat_ws 累計） | ☑ | `sessions.input_tokens/output_tokens`＋訊息數 |

## D. 排程任務 — `parity/admin1.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| cron 建立／編輯／暫停／恢復／刪除／立即執行（gateway `/api/jobs`） | ☑ | 真機建 `studio-test-0300` → pause → resume → delete，`jobs.json` 無殘留 |
| 表達式快捷預設 | ☑ | `GET /cron/presets` 8 組 |
| 投遞目標（local/origin／已設定平台／bot-chat／自訂） | ☑ | `GET /cron/targets` 真機列 telegram、whatsapp |
| 執行歷史（`executions.db`＋輸出 md） | ☑ | 真機 diary-daily-backup 5 筆＋30 個輸出檔 |
| 前端 `/cron` 頁 | ☑ | profile 下拉、表單、卡片操作、展開歷史 |

## E. 看板 — `parity/collab.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| profile 感知（依 assignee 篩） | ☑ | `GET /kanban/board?assignee=` |
| 卡片 CRUD（`hermes kanban` CLI 同一份 kanban.db） | ☑ | `create --json`／`show --json`；hermes 無編輯標題 CLI，`edit` 只回填 result |
| 拖拉換狀態（dnd-kit） | ☑ | Playwright 真滑鼠拖 ready→review；「執行中」欄不可拖入 |
| 優先權（低/中/高/緊急 ↔ 10/50/80/100） | ☑ | UI |
| 標籤（Studio `kanban_meta`，不進 kanban.db） | ☑ | board/detail 合併 |
| 留言（`--author` 帶登入帳號） | ☑ | 真機留言後 `show` 看得到 |
| 附件（上傳→`kanban attach`） | ☑ | `attachments --json`／`attach-rm` |
| complete/block/unblock/archive/request-review | ☑ | `move` 對應 CLI 動詞；hermes 不允許的轉換回 502 訊息 |
| 診斷（`diagnostics --json`） | ☑ | 板頂橫幅＋卡片 ⚠ |
| 即時更新 | ☑ | 8 秒輪詢（沒接 `kanban watch`） |
| 派給 AI 員工執行（assign → promote → dispatch） | ☑ | 真機 dry-run 回 `spawned`；實際 spawn 未跑（避免燒 token） |

## F. 視覺化工作流（核心）— `parity/workflows.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 畫布（React Flow）：hermes／coding-agent／gate／condition／loop／delivery 節點；附件路徑 | ☑ | vitest `graph.test.ts` 25 項＋Playwright 截圖 |
| 有向邊、結構化條件（rule／AI）、成功／失敗路線、迴圈、審批閘門 | ☑ | pytest failure_route／condition_branches／condition_ai／loop_max／loop_until／gate_reject_then_approve |
| 縮放、自動排版、複製節點、鍵盤刪除 | ☑ | 工具列＋⌘D／⌘S／Delete |
| 匯入／匯出 JSON（含版本）；profile 感知工作區 | ☑ | `test_import_export_batch_delete` |
| 執行器：拓撲排程、扇入、並行、每節點 Hermes session | ☑ | 真機「熱點→選題→閘門→文案」跑完，189k tokens，三節點各有 session |
| 閘門：暫停→核准／退回附意見→上游重跑 | ☑ | 真機 `approve {comment}` 後文案節點訊息帶 `[審批意見]`；伺服器重啟後 run 標 stopped |
| 預算（token／成本）與期限 | ☑ | 真機 20,000 token 上限被單輪 51k 打爆 → `budget_exceeded`（預算請以十萬計） |
| 停止／重跑（可從失敗節點） | ☑ | `test_stop_while_waiting_gate_and_rerun_from_node`；上游沿用父 run 輸出 |
| 執行歷史持久化、凍結快照、節點對話、邊決策、證據回放 | ☑ | 快照頁滑桿回放到第 6 步；雙擊節點開對話 |
| coding-agent 節點（claude／codex／pi subprocess） | ☑ | 真機 claude 回 PONG、$0.025；codex 未真機跑；pi 未裝→skipped |
| 排程（cron 5 欄，伺服器內，重啟後重算） | ☑ | `test_schedule_and_cron`；停機期間錯過不補跑 |
| webhook 觸發 `POST /webhooks/wf/{token}` | ☑ | 真機 202，第一節點看到 `[外部輸入]` |
| 前端：清單／畫布／執行面板（WS）／歷史／快照／審批面板 | ☑ | vitest 36 項＋7 張截圖 |
| 投遞：LINE push／通用 webhook／寫檔 | ◐ | 寫檔、webhook 真機通過；LINE 因本機無 `LINE_CHANNEL_ACCESS_TOKEN`（round2 再查 `.env` 仍無）只驗到「未設定→明確失敗訊息」，實際 push 要有真 channel 才能驗。Heptabase、LINE 關鍵字觸發未做 |

## G. 模型管理 — `parity/admin1.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 從 `auth.json` 發現供應商（不回 token） | ☑ | 真機列 openai-codex／openrouter／copilot／anthropic；回應 grep 不到 `sk-`／JWT |
| 抓模型清單（gateway options；`?live=1` 直打供應商） | ☑ | 真機 47 供應商；openrouter live 396 個 |
| 新增／更新／刪除自訂 OpenAI 相容供應商 | ☑ | 寫 `config.yaml providers.<slug>`＋`.env HERMES_CUSTOM_<SLUG>`，與 Hermes dashboard 同規則 |
| URL 自動偵測非 v1 版本 | ☑ | 真機 `https://openrouter.ai/api` → `/v1` |
| 內建供應商 API key | ☑ | 寫供應商第一個 env，不走 CLI argv |
| 供應商分組／可見模型／別名（Studio 端偏好） | ☑ | `model_prefs` 每公司一份 |
| 預設模型切換（直接寫 `config.yaml model.*`） | ☑ | 真機讀到 default／researcher 各自模型；`hermes model` 是互動 TUI 不能包 |
| STT／TTS 供應商目錄 | ☑ | 8 個 TTS、5 個 STT，附 key 是否存在 |
| 前端 `/models` 頁 | ☑ | 分組卡片、勾可見／別名／設預設、OAuth 流程框、自訂供應商表單 |
| OAuth／device flow（包 `hermes auth add --no-browser`） | ◐ | `parse_auth_output` 有單元測試、logout／status 真機通過；完整登入沒跑——**會寫使用者的 `~/.hermes/auth.json` 且要人拿手機掃碼**，無法自動驗 |

## H. 多 Profile — `parity/admin1.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 列表／詳情（含 active profile） | ☑ | `GET /profiles` 真機 9 個 |
| 建立（`--no-alias`，不碰使用者 PATH） | ☑ | 真機建 `studio-test-tmp`，公司自動補一筆 Agent |
| 複製（`--clone-from`） | ☑ | 真機複製 skills／SOUL |
| 重新命名（Agent 表與成員指派一併改） | ☑ | `hermes profile rename`；default 只改顯示名 |
| 刪除（default 回 400） | ☑ | 真機目錄消失、Agent 列一併刪 |
| 切換預設 | ☑ | 真機 `active_profile` 檔改變 |
| 匯出 tar.gz | ☑ | 真機 1.95 MB、tar 內容正確 |
| 匯入 tar.gz | ☑ | pytest 用匯出檔 round-trip；真機未跑（會覆蓋 `~/.hermes/profiles`） |
| profile 範圍設定（`config.yaml` set/patch/unset/text，密鑰遮罩） | ☑ | 真機寫 `model.default` 成功 |
| 帳號綁定（owner 全部；admin 未指派＝全部；member 只看指派） | ☑ | `/agents /profiles /usage /cron` 都過濾；`sessions.py` 尚未套 `profile_visible`（見待辦） |
| 前端 `/profiles` 頁＋AgentsPage 嵌入 | ☑ | 表格＋建立／匯入＋config 編輯器＋帳號綁定 |

## I. 檔案瀏覽器 — `parity/admin2.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 本機瀏覽（根限定：workspace／各 profile／uploads／`STUDIO_FILE_ROOTS`） | ☑ | 真機 11 個根、`profile:researcher` 47 筆 |
| 防路徑穿越（`..`／絕對路徑／symlink 逃逸） | ☑ | 真機 `profile:researcher/../../.env` → 400；pytest symlink 根外 → 400 |
| 上傳／下載／重新命名／複製／移動／刪除／建目錄 | ☑ | 真機 `workspace/_studio_test` 全流程，最後目錄不存在 |
| 預覽＋編輯（CodeMirror 6 高亮） | ☑ | >2MB 文字只顯示前 2MB 唯讀；圖片 blob 預覽 |
| 附回聊天（`studio:attach` CustomEvent） | ☑ | vitest 驗事件內容 |
| Docker／SSH／Singularity 後端 | 不做 | 本產品定位單機部署，只操作本機檔案系統 |

## J. 群聊 — `parity/collab.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 房間 CRUD、邀請碼加入、成員（人類＋AI）加入／移除 | ☑ | 真機建房（copywriter＋strategist），邀請碼 8 碼 |
| 每 AI 成員可設顯示名／profile／模型／角色提示 | ☑ | `PATCH …/members/{rm}`；UI ✎ 編輯器 |
| WS `/ws/groupchat` 即時 | ☑ | 真機 `ready→joined→message.new→ai.typing→ai.delta×14→ai.done`，5.6s |
| @mention 路由（可多位、不分大小寫） | ☑ | 真機 `@content-copywriter` 只有它回 |
| 無 @ 策略：不回／輪流／主持人 | ☑ | pytest `test_round_robin_when_no_mention` |
| 上下文組裝（近 N 則＋摘要；誰回誰是 assistant） | ☑ | session_id 固定 `studio_room_{room}_{member}` |
| 壓縮：超門檻用一個 AI 做摘要 | ☑ | 真機 `POST …/compress` 6.3s 得條列摘要 |
| 輸入中／回覆進度（typing→delta→tool） | ☑ | 人類 typing 4 秒過期 |
| SQLite 持久化 | ☑ | 重啟後訊息仍在 |
| AI 互 @ 深度上限 | ☑ | pytest 回音 fake max=3 停在 6 則；真機 depth 2 停 |
| 手機版 | ☑ | Playwright 390×844 截圖 |

## K. Coding Agents — `parity/coding.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 偵測安裝（PATH／~/.local/bin／nvm／homebrew）＋版本 | ☑ | 真機 claude v2.1.251、codex v0.145.0、pi 未裝 |
| 未安裝顯示指令＋一鍵安裝（owner） | ☑ | pytest 以 `/bin/echo` 冒充 npm；真機沒真的 `npm i -g` |
| 設定：工作區／模型／API 模式／profile／權限與沙箱（每公司一份） | ☑ | 真機 `PUT /coding/settings/claude`；不存在工作區 400 |
| Anthropic 相容 proxy → Hermes | ☑ | 真機 curl 非串流＋串流皆通；Claude Code 的 tools 定義被丟掉，proxy 模式只能問答 |
| Claude Code 走 proxy 真機 | ☑ | `api_mode=hermes` 回 `PROXY VIA CLAUDE CODE` |
| 啟動 session（subprocess＋stream-json→統一事件→WS→落庫） | ☑ | 真機 claude 回 hello、cost 0.018；codex 建 `hello.txt` |
| 中止（killpg 整個 process group） | ☑ | pytest `sleep 30` → stop <10s `run.cancelled` |
| 繼續（`--resume`／`exec resume`） | ☑ | 真機第二輪正確記得上一句 |
| 送圖片 | ☑ | pytest；真機沒跑圖片任務 |
| 工作區選擇（`/coding/fs`） | ☑ | 只列目錄、上限 500 |
| 檔案 diff（執行前後 `git diff HEAD` 並排） | ☑ | 真機 codex 建檔後 `diff.files` 含新檔 |
| 前端 `/coding` 頁 | ☑ | vitest 7 項；未用瀏覽器實際點 |
| Responses 相容 proxy（Codex） | ◐ | pytest 直通＋串流通過；真機只驗 `/models`。**改不了的原因**：Hermes gateway `/v1/responses` 不回 `function_call`，Codex 拿不到工具呼叫就無法完成任務，屬上游限制 |
| 內建終端視圖 | ◐ | 先以日誌視圖呈現 stderr。round2 評估：O 模組 `/ws/terminal` 的 `cwd` 只收 profile 名／固定根目錄 id，不收任意工作區路徑；coding session 本身不是 PTY，換 xterm 只是換字型。要做需後端開放 `cwd=path:<abs>`（owner/admin）＋抽出 AdminPage 的 xterm 元件，留給下一輪 |
| Pi | ◐ | 解析器依 pi-agent-core 事件型別、假腳本測；round2 再查 `which pi` 仍未裝（不擅自 `npm i -g` 到使用者機器） |
| 獨立視窗（桌面版） | 不做 | 產品無桌面版 |

## L. Skills 與記憶 — `parity/admin2.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| Skills 清單／搜尋／分類（profile local＋builtin） | ☑ | 真機 242 筆、27 分類；symlink skill 也掃到 |
| 詳情與附檔預覽（防穿越） | ☑ | 真機 `GET /skills/cubox` 附檔 references |
| 啟用／停用（寫 `config.yaml skills.disabled`，保留註解） | ☑ | pytest `# keep me` 還在；真機未寫使用者 config |
| 建立／編輯 SKILL.md（只寫 local） | ☑ | pytest；builtin 改寫會複製成 local |
| Skill Bundles（`hermes bundles create`） | ☑ | 真機建 `myhermescompany-tmp` 再刪 |
| 用量統計（Studio messages＋state.db tool_calls） | ☑ | 子字串比對，短名可能偏高 |
| 使用者筆記（每成員每 skill） | ☑ | pytest PUT/GET |
| 記憶管理（MEMORY.md／USER.md 等，`hermes memory status`） | ☑ | 真機新增 `STUDIO_TW_TEST.md` 再刪；`../config.yaml` 400 |
| Journey 關係圖（d3-force）＋分類篩選＋時間軸回放 | ☑ | 真機 default 267 節點／492 邊；`merge_hermes` 併入 0 條（id 對不上，保留選項） |

## M. 主題 — `parity/admin2.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 亮／暗／跟隨系統 | ☑ | `<html data-theme>`；tailwind darkMode 改 variant，預設行為不變 |
| 介面風格（圓／方角）、密度、字級、文字色、主色 | ☑ | vitest `--studio-font-size`／`--studio-primary` |
| 每帳號背景圖（png/jpeg/webp/gif ≤8MB） | ☑ | 真機上傳 1×1 PNG → `GET /theme/background` 200 |
| 存 DB＋localStorage 快取＋即時預覽 | ☑ | 改設定立即 `applyTheme` 再 PUT |

## N. 日誌 — `parity/admin2.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| 列檔案（`~/.hermes/logs`、各 profile logs、Studio log） | ☑ | 真機 83 個 |
| 依等級／檔案／關鍵字篩選（檔尾讀，最多 5000 行） | ☑ | 真機 `gateway.log level=ERROR` 回 2 筆 |
| 尾端追蹤（WS `/ws/logs`，輪替偵測） | ☑ | 打一次 `/health` 後收到 `line` 事件 |
| 結構化解析＋HTTP 存取高亮 | ☑ | uvicorn access 行解出 method/path/status |
| Studio 自己的 log（RotatingFileHandler 5MB×3） | ☑ | `<db dir>/studio.log` |

## O. 管理與執行環境 — `parity/admin2.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| Web 終端（xterm.js＋ptyprocess，僅 owner/admin） | ☑ | 真機 `echo ok-$((40+2))` 收到 `ok-42`；member 回 `forbidden` |
| MCP 伺服器列出（值遮罩） | ☑ | 真機 default 10 個、researcher 4 個 |
| MCP 新增／刪除／測試（包 `hermes mcp`） | ☑ | 真機 `test linear` → 需互動 OAuth → `ok:false`；未真的新增／刪除 |
| Plugins 列出／啟停（`plugins list --json`） | ☑ | 真機 56 個（3 enabled）；未真機切換 |
| 版本更新提示（Hermes 版本、落後 commits、GitHub latest） | ☑ | 真機 0.20.5 落後 1,498 commits、`update_available:true`；`STUDIO_UPDATE_CHECK=0` 關閉 |
| 認證：帳號密碼＋角色（owner/admin/member） | ☑ | 帳號密碼＋JWT＋角色（`test_auth.py`）；登入鎖定見下列 |
| 登入鎖定（連續失敗暫停） | ☑ | 同帳號或同 IP 連續 5 次失敗鎖 15 分鐘（DB `login_locks`，`STUDIO_LOGIN_MAX_FAILURES`／`STUDIO_LOGIN_LOCK_SECONDS` 可調），回 423＋`retry_after`＋`Retry-After`，鎖定寫 `audit`；成功登入歸零；`myhermescompany clear-login-locks [--username]`。pytest 2 個、真機 8700 第 5 次 423 `retry_after:899` → CLI 清鎖 → 200 |
| 裝置／區網節點 | 不做 | 桌面版功能 |
| App 連線（行動 App 相容層） | 不做 | 無 App |

## P. 語音與媒體 — `parity/collab.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| STT 瀏覽器優先（Web Speech） | ☑ | vitest 假 recognition；Firefox 走後端 |
| 後端 `/voice/transcribe`（本機 whisper-cli＋ffmpeg） | ☑ | 真機 1.3s 轉出測試句；沒模型 → 501、UI 隱藏麥克風 |
| TTS 瀏覽器優先（speechSynthesis zh-TW） | ☑ | `speak()` |
| 後端 `/voice/speak`（edge-tts，可選 extra `[tts]`） | ☑ | 真機 0.8s 產 36KB mp3；需網路；gateway 無 audio API 未接 |
| 訊息「朗讀」鈕、輸入框麥克風（`studio:voice-*` 事件） | ☑ | 群聊已接；工作臺可 import `modules/voice` 元件 |
| 語音設定頁 `/voice` | ☑ | 顯示四種引擎可用性＋測試 |

## Q. 發行 — `parity/release.md`
| 項目 | 狀態 | 怎麼驗 |
|---|---|---|
| pip 套件＋CLI `myhermescompany` start/stop/status/restart/logs/reset-admin/version | ☑ | 乾淨 venv 裝 wheel → start --daemon → status → restart → stop；`update` 子指令＝`pip install -U`＋restart（DEPLOY §6） |
| 伺服器直接服務前端（SPA fallback） | ☑ | `curl /` 200 index、`/api/nope` 404 JSON |
| `/api/*` 同源前綴（middleware 去前綴） | ☑ | `/health` 與 `/api/health` 都 200；`/api/ws/chat` 可連 |
| 安全預設（非 loopback 必須 `STUDIO_SECRET`＋改 admin 密碼） | ☑ | `--host 0.0.0.0` 未設 → exit 2；設好 → 起得來 |
| Zeabur 部署說明 | ☑ | `docs/DEPLOY.md` §4（文件；未實際部署，未授權花錢） |
| README 快速開始（正式＋開發） | ☑ | 讀 README |
| Docker image（多階段 node→python） | ◐ | Dockerfile 寫好、CI 會 build；round2 再查 `docker info` 仍失敗（daemon 沒開、不擅自啟動使用者的 Docker Desktop），`docker build` 未驗 |
| docker-compose（官方 hermes image＋studio） | ◐ | `compose config` 通過；同上 daemon 沒開，未 `up` |
| 桌面版（Electron） | 不做 | 產品定位單機／伺服器網頁，不出桌面殼 |

## 跨模組待辦（round2 後）
1. `sessions.py` 的 `create_session`／`list_sessions` 補 `profile_visible(member, agent.profile)`（H 模組建議）。
2. ~~登入鎖定（O）未做~~ round2 已做；Audit 表現在有 `login.locked` 一種寫入，其他動作仍未寫稽核。
3. 既有 `studio.db` 欄位升級靠各模組 `on_startup` 的 `ALTER TABLE ADD COLUMN`，沒有正式 migration（Q）。
4. 真機未按的寫入類操作（都有 pytest）：OAuth 完整登入、profile import、skill 啟停、MCP add/remove、plugins 切換、kanban 實際 dispatch、npm 一鍵安裝、LINE 實際 push。（gateway restart round2 已按）
5. `docker build`／`compose up`、Zeabur 實際部署未驗（daemon 沒開／未授權花錢）。
6. K 的內建終端視圖換成 xterm（需後端 `/ws/terminal` 開放工作區路徑）；工作臺（A）接 P 的麥克風／朗讀元件。
7. gateway 端待支援：壓縮進度事件；Responses API 回 function_call（Codex 走 proxy 才能用）。
8. 收件匣徽章只在掛載時抓一次，沒有輪詢／推播；chat 危險指令進收件匣後 TopBar 數字要重新整理才更新。
