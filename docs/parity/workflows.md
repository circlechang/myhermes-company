# F. 視覺化工作流 — 對齊狀態與實測紀錄

負責檔案：`server/studio/modules/workflows/`（engine/scheduler/runners/conditions/cron/hub/api）、`server/studio/api/workflows.py`（CRUD）、`server/studio/workflow_validate.py`、`server/studio/models.py`（Workflow/WorkflowRun + 新表 workflow_run_nodes / workflow_schedules / workflow_webhooks / workflow_approvals）、`web/src/modules/workflows/`、`web/src/pages/WorkflowsPage.tsx`。
新依賴：前端 `@xyflow/react`（MIT，React Flow；請在 README 致謝表加一列）。後端無新依賴（cron 自寫）。

## 狀態
| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| 畫布（React Flow）：hermes / coding-agent / gate / condition / loop / delivery 節點；檔案/圖片附件 | ☑ | vitest `graph.test.ts`（25）＋ Playwright 截圖 `wf-editor.png` | 附件只是「路徑清單」附在訊息 `[附件]` 區，靠 Hermes 工具自己讀檔；沒有上傳器（檔案模組負責上傳後貼路徑） |
| 有向邊、結構化條件、成功／失敗路線、迴圈、審批閘門 | ☑ | pytest `test_workflow_engine.py`：failure_route / condition_branches / condition_ai / loop_max / loop_until / gate_reject_then_approve | 迴圈定義：`loop_back` 邊只能指回 loop 節點、source 需在 body 內；本體重入時整個 body 重置重跑 |
| 縮放、自動排版（拓撲分層）、複製節點、鍵盤刪除 | ☑ | 工具列「自動排版／縮放至全圖」、Delete/Backspace、⌘D、⌘S | 自動排版是分層置中，不做交叉最小化 |
| 匯入／匯出 JSON（含版本）；profile 感知工作區 | ☑ | `test_import_export_batch_delete`；清單頁 profile 下拉、匯入按鈕 | 匯出用瀏覽器下載；`profile` 只是篩選欄位，不限制節點用哪個員工 |
| 執行器：拓撲排程、扇入、並行、每節點 Hermes session、訊息組裝 | ☑ | `test_linear_snapshot_and_conversation`、`test_fan_in_parallel`；真機見下 | 走 `/v1/runs`（session_id + instructions + model）；只在節點明確填 model 才送，員工預設模型交給 profile（同步進來的 `stealth/ox-alpha` 會被 Codex 供應商拒絕） |
| 閘門：暫停→核准／退回附意見→上游重跑 | ☑ | `test_gate_reject_then_approve`；真機核准 | 見下「重啟修復」：重啟後閘門可續核准 |
| **等待狀態單一真相＋重啟修復**（harness 借鏡 1） | ☑ | `test_workflow_harness.py::test_recover_gate_after_restart / test_recover_interrupted_node_needs_attention_then_rerun / test_done_check_blocked_survives_restart`；真機見下 §6 | `workflow_approvals(pending)` 是閘門唯一真相，引擎記憶體 `approval_events` 與 `node_states` 只是快取，啟動 `recover()` 從表重建；關機改成 `park()`（停 gateway run、取消 task，**不改 DB**）。執行中被中斷 → `outcome_unknown` / `needs_attention` / 收件匣 `workflow_attention`；同一 run 同時有中斷節點與等待閘門時以 needs_attention 為準（該 run 的 pending 審批 cancelled）。邊決策從 events 重建（loop 重入用 `loop.iteration` 清體內邊）；`deadline_seconds` 以剩餘時間續算 |
| **節點輸出溢出區 spill**（借鏡 2） | ☑ | `test_spill_above_and_below_threshold`（門檻上下、下游訊息、端點） | 預設 32 KB（`STUDIO_WF_SPILL_BYTES`）；head 4 KB／tail 2 KB；檔案 `<workspace>/runs/<run_id>/<node_id>.output.md`（同節點多次 attempt 覆寫）；UI 標「已溢出，查看完整」→ 彈窗全文＋下載。真機兩條 run 的輸出都沒超過 32 KB，溢出只在 pytest 驗（門檻調到 600 B） |
| **結構化自檢 done_check**（借鏡 3） | ☑ | `test_parse_done_check / test_done_check_complete_and_parse_failure / test_done_check_continue_rounds_and_cap / test_done_check_blocked_waits_for_human`；真機 §7 | 每輪新 session（同 attempt）、上限預設 3；blocked 借用 `workflow_approvals`（收件匣已聚合 pending 審批，不另塞 inbox_items 免重複），approve＝繼續、reject＝退回節點 failed；解析失敗＝complete＋`node.note` warning。重啟時卡在 blocked 的節點：恢復後人 approve → 本節點**整個重跑**一輪（帶 `[人的指示]`），不是接續原輪次 |
| **效果快取→只重跑變動節點**（借鏡 4，借 dsh_workflow） | ☑ | `test_effect_hash / test_rerun_reuses_unchanged_nodes` | 只快取 hermes / coding-agent / condition；gate（要人）、loop（有狀態）、delivery（副作用）一律重跑；`from_node` 本身一定重跑；被閘門退回帶意見的節點不快取；UI「強制全跑」勾選＝`force:true`。hash 用「上游輸出的 hash」，所以父 run 溢出過的節點只比對縮短版輸出（檔案路徑含 run_id，會變 → 下游不會誤中快取，但也就不會沿用） |
| 預算（token／成本）與期限 | ☑ | `test_budget_stop`、`test_deadline_timeout`；真機一次 20000 token 上限被 51k 的單輪打爆 → `budget_exceeded` | gateway 不回成本時 `cost_usd` 用 `default_cost_per_1k`（預設 0）估；Hermes 一輪 input 約 25k–110k tokens，預算請以十萬計 |
| 停止／重跑（可從失敗節點重跑） | ☑ | `test_stop_while_waiting_gate_and_rerun_from_node` | 從節點重跑會沿用父 run 的上游輸出（狀態 `reused`），圖用父 run 的凍結快照 |
| 執行歷史持久化、凍結快照、節點對話、邊決策、證據回放 | ☑ | `GET /workflow-runs/{id}`；快照頁滑桿 `wf-replay-step6.png`；雙擊節點開對話 `wf-conversation.png` | 回放是依 events 重播狀態（不是重新執行） |
| coding-agent 節點（claude / codex / pi subprocess，串流） | ☑ | `test_coding_agent_skip_and_mock`（mock）；真機 `claude -p … --output-format stream-json` 回 PONG、usage 7 tok / $0.025 | pi 本機未安裝 → UI 標示「未安裝」、執行時 skipped（output 空、視為成功）。codex 走 `codex exec --json`（未真機跑，避免燒額度）。claude 一定 `-p` 非互動，工具授權用它自己的預設 |
| 排程（cron、伺服器內、重啟恢復） | ☑ | `test_schedule_and_cron`（tick 驅動）；cron 解析 5 欄 `* , - /` | 停機期間錯過的不補跑；名稱式（MON/JAN）不支援 |
| webhook 觸發 `POST /webhooks/wf/{token}` | ☑ | `test_webhook_trigger`；真機觸發並在第一節點訊息看到 `[外部輸入]` | 端點免登入，token 64 hex 即憑證；可刪除重生 |
| 投遞：LINE push／通用 webhook／寫檔 | ☑（LINE ◐） | `test_delivery_file_webhook_line`；真機寫檔 | 本機 `~/.hermes/.env` 沒有 `LINE_CHANNEL_ACCESS_TOKEN` → UI 顯示未設定、節點執行失敗並帶明確訊息；LINE 實際 push 未真機驗證。Heptabase 略（依任務說明） |
| 前端：清單（profile 篩選、批次刪除）、畫布、執行面板（WS 即時）、歷史、快照、審批面板 | ☑ | vitest `RunPanel.test.tsx`（4）、`runState.test.ts`（3）、`pages.test.tsx` 工作流案例；截圖 `wf-list/editor/runpanel/snapshot/replay/conversation/approvals.png` | 清單頁路由 `/workflows` 仍在 `pages/WorkflowsPage.tsx`；編輯 `/workflows/:id`、快照 `/workflows/runs/:runId`、審批 `/workflows/approvals` 由模組註冊 |

## 真機實測（2026-08-29，Hermes 0.20.5，伺服器 `STUDIO_PORT=8797 STUDIO_DB=<scratch>/studio.db`）
1. 建「熱點（evidence-radar）→ 選題（research-strategist）→ 審批閘門 → 文案（content-copywriter）」，`POST /workflows/{id}/run`
   - 15s 後 `waiting_approval`；`GET /workflow-approvals` payload＝選題輸出（「循環包裝落地卡在哪：回收、清洗與責任如何分攤？」）
   - `approve {comment:"OK 請寫"}` → 20s 後 `completed`；文案節點 user 訊息開頭 `[上游結果] ### 審批閘門 … [審批意見] OK 請寫 … [本節點任務]`
   - usage 合計 189,396 tokens（hot 25k / pick 55k / copy 110k）；events 19 筆、edge_decisions 3 條皆 true；三個節點各有 session，`/sessions/{id}/messages` 可讀
2. 第一次跑的失敗紀錄（已修）：hot 節點 `HTTP 400 'stealth/ox-alpha' model is not supported when using Codex` — 因為把同步進來的 agent.model 送給 gateway；改成只送節點自填的 model。同一次 20000 token 預算在第二節點就 `budget_exceeded`，證明預算閘有效。
3. webhook：`POST /webhooks/wf/<token> {"text":"外部給的題目…"}` → 202；hot 節點訊息 `[上游結果] ### 外部輸入 外部給的題目…`；跑到閘門後 `POST /workflow-runs/{id}/stop` → stopped、審批 cancelled。
4. coding-agent：`claude-code` 節點「Reply with exactly PONG」→ completed、exit 0、output `PONG`、usage 7 tok / $0.0253；接 file 投遞寫到 `<workspace>/code/<run_id>.txt`（20 bytes）。
5. UI（掛載 `server/studio/web_dist`，Playwright headless）：清單、編輯器（點閘門看屬性）、執行面板（歷史列表）、快照頁（綠邊＝走過、時間軸）、回放到第 6 步（後段邊變灰、閘門回 pending）、對話彈窗、審批面板皆正常；console 只有 React Flow 在無尺寸容器下的 SVG NaN 警告（headless 量測前的既有行為）。

### harness 借鏡四項真機（2026-08-29 晚，`MHC_HOME=<scratch>/wfharness/mhc STUDIO_PORT=8781`，`uvicorn.run(create_app(Settings.from_env()))`，真 Hermes 0.20.5）
6. **重啟修復**：建「熱點（evidence-radar）→ 審批閘門 → 文案（content-copywriter）」，run `wr_ab45695918ea` 跑到 `waiting_approval`（hot 29.9k tokens；輸出為三個熱點候選標題），`GET /workflow-approvals` 一筆 pending。`kill <pid>`（SIGTERM，走 on_shutdown → `park()`）→ 重新起 server → `GET /workflow-runs/{id}` 仍 `waiting_approval`、events 多一筆 `run.recovered`、同一筆 approval 仍 pending → `approve {comment:"重啟後核准，請寫"}` 200 → 完成 `completed`（hot/gate/copy 全 completed），copy 的 user 訊息含 `[審批意見]\n重啟後核准，請寫`，usage 合計 59,979（只多了 copy 的一輪，hot 沒重跑）。
   - 第一次真機失敗紀錄（已修）：最初 `on_shutdown` 仍呼叫 `eng.stop()`，SIGTERM 是優雅關機，run 被標 stopped、審批 cancelled，重啟後無東西可恢復。改成 `park()` 後才通過；**這也表示只有 kill -9／斷電那種硬當機原本就走 recover()**，優雅關機以前反而是最會弄壞閘門的路徑。
7. **done_check**：單節點「口號」（content-copywriter，`done_check:true, max 3`），提示規則「訊息裡沒有 [上一輪輸出] 就只給草稿回 continue；有就給定稿回 complete」。結果：round 1 `continue`（evidence「草稿為『包裝循環，資源長流』」、next「潤飾成定稿」）→ round 2 `complete`（「已輸出潤飾後定稿」）；節點 attempt 仍 1、輸出「包裝循環，讓資源長流」（自檢區塊已剝掉）；events `node.done_check ×2`；第二輪 user 訊息含 `[上一輪輸出]`。usage 60.3k。
8. 未在真機驗：spill（真機輸出都 < 32 KB）、blocked 分支（pytest 有）、效果快取（pytest 有）；UI 新元件（NodeExtras：溢出彈窗、自檢輪次、快取／結果未知提示；NodePanel 自檢開關；RunPanel 強制全跑）只走 vitest，沒再截圖。

## 測試
- 後端：`server/.venv/bin/python -m pytest -q tests/test_workflow_engine.py tests/test_workflows.py tests/test_workflow_harness.py` → 44 passed（harness 新增 10）；全套見下方「本輪驗證」
- 前端：`npx vitest run src/modules/workflows` → 40 passed（新增 runState 2、RunPanel 2）；`npx tsc --noEmit` 零錯誤；`npm run build` 通過
- 本輪驗證（2026-08-29 晚）：全套 vitest 136 中 1 失敗 `src/test/guidance.test.tsx`「/compat 沒有說明」——來自別人未提交的 `modules/compat`，與本模組無關；全套 pytest 以 `--ignore=tests/test_compat.py`（同樣是未追蹤的 compat 模組，`test_scheduler_tick_triggers_precheck_when_newer` 失敗）跑，結果見報告

## 決策與注意
- 執行走 `/v1/runs`（非 `/api/sessions/*/chat`）：既有 GatewayClient 已處理 SSE、approval、stop；session 由 Studio 自己的 `sessions` 表承載，工作臺可直接瀏覽（`source=workflow`）。
- Hermes 工具授權請求在工作流內預設 **deny**（無人值守），節點可設 `tool_approval: allow`（送 `once`）。
- `studio/api/workflows.py` 的 `/run`、`/runs`、`/workflow-runs/{id}` 移到模組 router；原本 501 的測試改為 202。
- 既有 DB 缺欄位由模組 `on_startup` 用 `ALTER TABLE ADD COLUMN` 補（workflows.description/profile/version/budget_json、workflow_runs.*）。
- 真機時發現 `python -m studio` 有單例 pid 鎖（其他模組加的），第二個實例起不來；實測改用 `uvicorn.run(create_app(Settings.from_env()))`。
- 未做：Heptabase 投遞、LINE 關鍵字觸發（B 模組 LINE 設定完成後可加）、codex/pi 真機驗證。
- harness 借鏡的決策：
  - 不加新資料表／欄位（`studio/models.py` 不在本模組權限內）：`needs_attention`／`outcome_unknown` 只是既有 status 字串的新值，`spill`／`done_rounds`／`effect_hash` 放 `node_states_json`；`workflow_run_nodes` 仍是投影。
  - 重啟時「同一 run 既有中斷節點又有等待閘門」以 needs_attention 為準（取消審批），因為中斷節點可能是閘門的平行分支，恢復一半比全部重來更難解釋。
  - done_check 的 blocked 用 `workflow_approvals` 而不是 `inbox_items`：收件匣本來就聚合 pending 審批，兩邊都塞會出現兩筆；approve/reject 端點也因此不用新加。
  - 效果快取的 hash 把上游「輸出內容」納入而非只看設定，所以上游真的變了下游就重跑，和 dsh_workflow 一致；代價是溢出節點的下游拿不到快取（路徑含 run_id）。
  - `events` 模組的 `KNOWN_KINDS` 原本沒有 `workflow.needs_attention`（會存成 `other.*`）；round3 已加 `workflow.needs_attention / workflow.recovered / node.done_check`。
