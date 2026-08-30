# A. 聊天（工作臺）模組 — 對齊狀態與實測紀錄（2026-08-29）

負責範圍：`server/studio/api/{sessions,chat_ws}.py`、`server/studio/models.py`（只加欄位／表）、`server/studio/modules/chat/`、
`web/src/pages/WorkbenchPage.tsx`、`web/src/components/chat/**`、`web/src/ws/**`、`web/src/api/sessions.ts`、`web/src/modules/chat/`。
另碰了兩個測試支援檔（例外，請合併者知悉）：`web/src/mock/fetch.ts`（加一行委派到 `modules/chat/mock.ts`）、`web/src/mock/MockWebSocket.ts`（假 WS 認得 regenerate/edit/steer）。

## 狀態總表
| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| 重新命名／刪除／切換／封存 | ☑ | pytest `test_session_patch_rename_archive_model_and_ordering`；vitest「側欄依來源分組…重新命名與封存」；真機 PATCH 回 200 | 重新命名用 `window.prompt`（簡潔優先） |
| 依來源分組摺疊 | ☑ | vitest 純函式 `groupSessions`；真機 sidebar_groups=`[cli, workbench]`（匯入的 CLI session 自成一組） | workbench/studio/web 合併為「工作臺」 |
| 進行中置頂＋spinner | ☑ | 後端 `run_status=running` 排序測試；vitest spinner；列表在有 running 時每 3 秒輪詢 | 伺服器重啟會把殘留 running 清掉（`ensure_columns`） |
| 依最後訊息時間排序 | ☑ | `test_session_list_running_first_then_recent` | — |
| 分類 CRUD／指派 | ☑ | `test_categories_crud_and_assign`；UI 管理視窗＋列表選單指派＋篩選 | 分類屬成員自己，不共享 |
| Ctrl+K 全文搜尋（標題＋訊息） | ☑ | `test_search_titles_and_messages`；vitest「Ctrl+K 搜尋…」；真機 `q=暗號` 命中 message | SQLite LIKE，不是 FTS；量大時再換 FTS5 |
| Hermes 歷史（state.db 唯讀）瀏覽／匯入 | ☑ | `test_hermes_history_list_messages_import`（含「匯入後 state.db 訊息數不變」）；真機：default 5908 筆＋8 個 profile，讀 13 則訊息、匯入 idempotent | 只讀 `mode=ro`；messages 的 `system` 略過；tool_calls 用 call_id 配對結果 |
| Markdown / 程式碼高亮＋複製 | ☑ | vitest「渲染 GFM 表格…」 | react-markdown 9 + remark-gfm + rehype-highlight（MIT，見致謝） |
| 工具卡展開／截斷 | ☑ | vitest「工具卡：參數／結果可展開，長內容截斷再展開」 | 1200 字截斷 |
| reasoning 摘要 | ☑ | 真機 run1 收到 `reasoning.available`，存到 assistant.reasoning 並顯示「推理摘要」卡 | — |
| 訊息引用 | ☑ | `test_ws_attachments_reply_and_image_parts`（input 帶 `[引用先前訊息]`）；vitest 引用流程 | 引用只帶前 2000 字 |
| 上傳：檔案／拖放／貼圖 | ☑ | `test_upload_download_preview_and_whitelist`；vitest 上傳流程（含 paste）；真機上傳 png/txt/csv → Hermes 讀到 note.txt 暗號 `PINEAPPLE-42` | 單檔 50MB；貼圖自動命名 `paste-<ts>.png` |
| 圖片以 gateway 支援的方式送 | ☑ | 查 `api_server.py::_normalize_multimodal_content`：`input` 可為 message list，content parts 接受 `image_url` data:image；真機送出後 gateway 202、log 無「falling back」，agent 回「有，已收到圖片」（同時它也呼叫 vision_analyze 讀路徑） | 4MB 以上圖片只附路徑不內嵌 |
| 下載 agent 產出檔案（白名單） | ☑ | `test_download_path_mentioned_in_message_is_allowed`（訊息提到的路徑可讀、鄰檔 404）；真機 `/etc/hosts` → 404 | 白名單＝uploads／`$HERMES_HOME/workspace`／訊息內出現過的路徑 |
| 內嵌預覽 HTML/PDF/圖/MD/CSV/code | ☑ | vitest 預覽（csv 表格、html sandbox iframe srcdoc）；真機 csv rows、png kind | HTML 由後端改 `text/plain` 回，前端 `sandbox=""` iframe，不會在 app origin 執行 |
| DOCX/PPTX/XLSX 後端轉 HTML | ☑ | `test_office_previews`（python-docx / python-pptx / openpyxl） | 簡易轉換：段落／標題／表格／投影片文字＋備註；不含圖片與樣式 |
| 模型選擇器（/api/model/options） | ☑ | `test_models_fallback_to_v1_models_and_normalize`；vitest 模型選擇器；真機 32 個 provider、current=openai-codex | 後端把 gateway 巢狀 payload 攤平；沒有 options 端點時退回 `/v1/models` |
| 每 session 模型 + 徽章 + token 用量 | ☑ | `test_ws_session_model_override_reaches_gateway`（body 帶 model/provider）；真機切到 `gpt-5.6-sol` 後回覆「GPT-5.6-SOL」；session usage 累計 127,344 tok、context 24,999 | `context_tokens`＝最後一次 run in+out（近似上下文大小） |
| 壓縮進度 | ◐ | 讀 api_server.py：runs SSE 事件只有 message.delta/tool.*/reasoning.available/approval.*/run.*，**沒有 compression 事件**；前端保留 `compress|compact` 事件名顯示位（vitest 有測） | 等 gateway 提供事件 |
| 背景委派結果 | ◐（round2 接上，等上游 complete） | 重讀 api_server.py L7443：runs SSE **有** `subagent.start`／`subagent.complete`（goal/subagent_id/task_index/task_count/depth/model/status/summary/duration_seconds/tokens/cost_usd/files_written/output_tail；`subagent.tool` 與進度刻意不送）。chat_ws 原樣轉發，complete 落庫成 `tool_name=subagent` 的 tool 訊息；前端 `SubagentItem`＋「背景委派」卡（start 配對 complete，重連後只有 complete 也能顯示，歷史 fromMessages 轉回卡）。pytest `test_ws_subagent_events_forwarded_and_persisted`、vitest chatState | 真機（default，gpt-5.6-luna）：事件序 `run.started → tool.started(delegate_task) → tool.completed → subagent.start → message.delta → reasoning.available → run.completed`，**沒有 subagent.complete**；前端 run 結束時把執行中的委派卡收成 completed／failed，摘要與 token 要等上游把 complete 送到 runs 串流 |
| steer／stop／重新生成／編輯重送 | ☑ | `test_ws_regenerate_and_edit`、`test_ws_stop_and_steer_forwarded`；真機 run2：`run.steered → steer.ack → stop.ack → run.cancelled`；regenerate 先發 `messages.removed` 再重跑；edit「只回覆一個字：好」→「好」 | 進行中輸入框變成插話 |
| 手機版 <640px 側欄抽屜 | ☑ | vitest「手機版：☰ 開抽屜側欄」；Tailwind `sm:` 斷點（640px） | 預覽面板在 <1024px 用全螢幕覆蓋 |

## 測試摘要
- 後端：`server/tests/test_chat_module.py` 14 項（fake gateway）＋既有 `test_ws_chat.py`／`test_sessions.py` 不變；全套 `pytest -q` → **155 passed**（含其他模組）。
- 前端：`web/src/test/chatModule.test.tsx` 13 項＋`chatState.test.ts` 6 項全綠；`chat.test.tsx`（走 App）在其他模組依賴裝齊後可跑；全套 vitest 89/92，3 個紅燈在 `modules/groupchat`（「加入」按鈕重複）與 `modules/coding_agents`（單跑全綠，全跑時 timing），不在本模組。
- `tsc --noEmit`：本模組檔案零錯誤（其他模組尚缺 `@codemirror/lang-*`、`d3-force` 型別）。

## 真機實測（2026-08-29，Hermes 0.20.5，default profile）
指令：`STUDIO_PORT=8791 STUDIO_DB=<scratch>/studio.db .venv/bin/python -m studio` ＋ `scratchpad/studio-chat/e2e.py`（httpx + websockets），跑完已 kill。
- `/chat/models?profile=default`：32 providers（nous 42、openrouter 46、anthropic 12、openai-codex 7 ✔current、copilot 17…），`current={model:gpt-5.6-sol, provider:openai-codex}`。
- 上傳 `dot.png(70B) / note.txt / table.csv` → preview csv rows OK、png kind=image、`/chat/files` 回 `image/png` 且 bytes 相同；`/etc/hosts` → 404。
- run1（附 png+txt，問暗號）：事件 `run.started → tool.started(read_file) → tool.completed → tool.started(vision_analyze) → … → reasoning.available → message.delta×n → run.completed`，輸出「PINEAPPLE-42；有，已收到圖片。」usage in 50,667 / out 459；session_usage 同步。
- run2（數到 200 → steer「數到 5 就停」→ stop）：`run.steered, steer.ack, stop.ack, run.cancelled`。
- regenerate：`messages.removed(1) → run.completed`；edit：「只回覆一個字：好」→「好」。
- 訊息落庫：user(附件 ✔) / tool read_file / tool vision_analyze / assistant(usage ✔ reasoning ✔) / user / assistant。
- 模型切換：`POST /sessions/{id}/model gpt-5.6-sol` → run.started.model=gpt-5.6-sol → 回「GPT-5.6-SOL」。
- 搜尋 `q=暗號` → message 命中。
- Hermes 歷史：sources 依 profile 分組（default 數千筆、其餘各數十筆）；list 前 5 筆為 api_server（本次測試自己產生的）；讀一筆 cli session 13 則訊息；匯入 → `source=cli, imported_from=default:20260814_143203_86144d`, 13 則；重複匯入回同 id；state.db 未被寫入（只用 `mode=ro`）。

## 決策記錄
1. **DB 欄位遷移**：SQLModel `create_all` 不會補既有表欄位，模組 `on_startup` 用 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 只加不改（`ensure_columns`，有測試）。
2. **不改 `studio/hermes/gateway.py`**（別人的檔）：模型清單與多模態 run 直接用 `gateway._client()/_prefix()/_raise()` 發請求。
3. **圖片**：先試 content parts（data URL），gateway 400 才退回純路徑；文字檔一律走「把本機路徑寫進 input」。
4. **HTML 預覽安全**：後端把 `.html` 當 `text/plain` 回，前端 `sandbox=""` iframe + srcdoc，避免 agent 產出的 HTML 在 app origin 執行。
5. **檔案讀取 token 走 query**：`<img>/<iframe>` 帶不了 Authorization，`/chat/files` 另接受 `?token=`（其餘端點不接受）。
6. **regenerate/edit 在伺服器端做刪除**，先發 `messages.removed{ids}` 讓前端對齊，再走一般 run 流程。
7. ~~PARITY「背景委派結果」不做~~ round2 更正：gateway 有 subagent.start/complete 事件，已接。

## 致謝（MIT，請合併到 README）
- react-markdown、remark-gfm、rehype-highlight、highlight.js（前端 Markdown／高亮）
- python-docx、python-pptx、openpyxl（後端 Office 預覽轉換）
