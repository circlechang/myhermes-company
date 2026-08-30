# J 群聊／E 看板／P 語音 — 對齊紀錄（2026-08-29）

程式：`server/studio/modules/{groupchat,kanban,voice}/`、`web/src/modules/{groupchat,kanban,voice}/`；例外授權改了 `web/src/pages/KanbanPage.tsx`（改成薄殼引用模組）。
`server/studio/api/kanban.py` 未動（舊端點保留），新端點都在模組。另外為了測試 mock 加了 `web/src/mock/fetch.ts` 的 `/kanban/board`、`/kanban/cards/*` 假資料，並改寫 `src/test/pages.test.tsx` 的看板案例（欄位從 5 欄變 6 欄）。

自動測試：pytest `tests/test_groupchat.py`(13) `tests/test_kanban_board.py`(9) `tests/test_voice.py`(3)；vitest `modules/{groupchat,kanban,voice}/*.test.tsx`(10) ＋ `pages.test.tsx` 看板案例。
真機：`STUDIO_PORT=8731`＋本機 Hermes 0.20.5（9 個 profile 在跑）＋ vite dev :5199（proxy→8731）＋ Playwright（node 1.62）。跑完程序已停、測試卡片已 `kanban archive --rm` 清掉、測試房間已刪。

## J. 群聊
| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| 房間 CRUD、邀請碼加入、成員（人類＋AI）加入／移除 | ☑ | pytest `test_room_crud_and_invite`；真機建房 `room_66c9…`（content-copywriter＋research-strategist），邀請碼 8 碼 | 非管理者只看得到自己加入的房；owner/admin 進任何房會自動加入 |
| 每 AI 成員可設顯示名／profile／模型／角色提示 | ☑ | `PATCH /groupchat/rooms/{id}/members/{rm}`；UI 設定面板 ✎ 編輯器 | 模型字串直接傳 gateway `model`，不驗證是否存在 |
| WS `/ws/groupchat` 即時 | ☑ | pytest `test_ws_join_message_and_ai_stream`；真機 websockets 客戶端：`ready→joined→message.new→ai.typing→ai.started→ai.delta×14→ai.done→message.new(ai)`，5.6s 收到回覆 | 同時掛 `/groupchat/ws` 路徑 |
| @mention 路由 | ☑ | pytest `test_mention_routes_to_named_ai_only`、`test_parse_mentions_*`；真機 `@content-copywriter` 只有它回 | 名稱比對不分大小寫、可接標點；也接受 @profile 名 |
| 無 @ 策略：不回／輪流／主持人 | ☑ | pytest `test_round_robin_when_no_mention`、`test_decide_targets_*` | AI 自己的訊息沒 @ 不會觸發任何人（避免自言自語） |
| 上下文組裝（近 N 則＋摘要）送 `/p/{profile}/v1/runs` | ☑ | 自己的話是 assistant、別人是 `[名字]: …` user；instructions 帶成員名單／角色提示／摘要；session_id 固定 `studio_room_{room}_{member}` | |
| 壓縮：超門檻用一個 AI 做摘要存 room_summaries | ☑ | pytest `test_compression_triggers_and_trims_history`；真機 `POST …/compress` 6.3s 得到 content-copywriter 寫的條列摘要，之後 context 只帶摘要＋新訊息 | 門檻用字元粗估 token（CJK 1 字＝1）；每次人類發言前檢查一次；摘要員預設第一位 AI，可改 |
| 輸入中／回覆進度 | ☑ | UI `ai.typing`（思考中）→`ai.delta`（串流）→ `ai.tool`（使用工具 X）；人類 typing 4 秒過期 | |
| SQLite 持久化 rooms/room_members/room_messages/room_summaries | ☑ | `server/studio/modules/groupchat/models.py`；重啟後訊息仍在 | |
| AI 互 @ 深度上限 | ☑ | pytest `test_ai_to_ai_mentions_are_depth_limited`（fake gateway 回音會無限互 @，max=3 停在 6 則）；真機 strategist 回覆 @copywriter → depth 2 再回一則後停（房間 max_ai_depth=2） | 人類同時 @ 兩位會各自展開一條支線 |
| 手機版 | ☑ | Playwright 390×844：房間清單全屏抽屜、快速 @ 鈕、麥克風、送出（`shot_mobile_room.png`） | 頂部主導覽在窄螢幕會擠成直排——那是共用 Layout，不在本模組範圍 |

決策：
- 群聊 run 不走 `conversation_history` 混用多 AI 的 assistant 角色，而是「誰在回、誰就是 assistant」，其餘一律 user＋名字前綴；實測模型會照做且不再加自己的名字前綴（伺服器也會剝掉 `[名字]:`）。
- 失敗（gateway 掛／run.failed）會存成一則 `status=failed` 的 AI 訊息，不會靜默消失。

## E. 看板
| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| profile 感知（依 assignee 篩） | ☑ | `GET /kanban/board?assignee=content-copywriter`；UI 下拉 | |
| 卡片 CRUD | ☑ | `POST /kanban/cards`（title/body/assignee/priority/tags/skills/model/max_runtime）；`GET /kanban/cards/{id}`＝`show --json`＋tags＋diagnostics | hermes 沒有「編輯標題／內容」CLI；`edit` 只能回填 done 卡的 result/summary |
| 拖拉換狀態（dnd-kit） | ☑ | Playwright 真滑鼠拖 ready→審核，hermes 狀態變 `review`（`shot_kanban_dragging.png`）；vitest 用 `resolveDrop` 純函式＋「移到」下拉（手機用） | 「執行中」欄不可拖入（由 dispatcher 決定）；hermes 不允許 review→blocked（CLI `cannot block`，UI 顯示 502 訊息） |
| 優先權 | ☑ | UI 低/中/高/緊急 ↔ 10/50/80/100 | |
| 標籤 | ☑ | hermes 沒有標籤欄位 → 存 Studio `kanban_meta`（task_id→tags），board/detail 合併 | 標籤不會進 kanban.db |
| 留言 | ☑ | `hermes kanban comment --author <帳號>`；真機留言後 `show` 看得到 | |
| 附件 | ☑ | multipart 上傳→暫存→`hermes kanban attach`；`attachments --json`；`attach-rm` | |
| complete/block/unblock/archive 等 | ☑ | `move` 對應 complete/block/schedule/request-review/archive/unblock(+promote) | |
| 診斷 | ☑ | `hermes kanban diagnostics --json` → 板頂橫幅＋卡片 ⚠（本機兩張 `stuck_in_blocked`） | |
| 即時更新 | ☑ | board 每 8 秒輪詢（TanStack refetchInterval） | 沒接 `kanban watch`（要常駐子程序；輪詢夠用） |
| 派給 AI 員工執行 | ☑ | `POST /kanban/cards/{id}/dispatch {profile}` = assign → promote → `hermes kanban dispatch --json --max 1`；真機 dry-run 回 `spawned:[{task_id,assignee:content-copywriter}]` | `dispatch` 是整板一輪、沒有單卡參數，只能把卡推到 ready 讓 dispatcher 依優先權撿；實際 spawn 未在真機執行（避免真的起 worker 燒 token） |

## P. 語音與媒體
| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| STT 瀏覽器優先 | ☑ | `useVoiceInput`：有 `SpeechRecognition` 就用；vitest 假 recognition 驗事件 | Safari/Chrome 才有；Firefox 走後端 |
| 後端 `/voice/transcribe` | ☑ | 本機 `whisper-cli`＋`ggml-model-whisper-base.bin`（MacWhisper 的模型）；ffmpeg 轉 16k wav；真機把 edge-tts 的 mp3 丟回去 1.3s 轉出「你好,這是Hermes Studio的語音測試,今天是8月29日。」 | 沒有 whisper-cli／模型 → 501 `stt_unavailable`，UI 隱藏麥克風；模型搜尋順序見 `MODEL_CANDIDATES`，可用 `STUDIO_WHISPER_MODEL` 指定；faster-whisper 未裝所以未接 |
| TTS 瀏覽器優先 | ☑ | `speak()`：有 `speechSynthesis` 就用 zh-TW 聲音 | |
| 後端 `/voice/speak` | ☑ | `edge-tts`（venv 已 pip 安裝，免 key）→ mp3；真機 0.8s 產 36KB／6.0s mp3（`zh-TW-HsiaoChenNeural`）；`/voice/voices?locale=zh-TW` 3 個聲音 | gateway/dashboard 沒有 audio API（brief 端點清單無），未接；需要網路 |
| 訊息「朗讀」鈕、輸入框麥克風 | ☑ | 群聊每則訊息 🔊、輸入列 🎤；`studio:voice-input` CustomEvent（detail `{text, final, source}`）、`studio:voice-speak` 事件 | 工作臺（WorkbenchPage）未改：聊天模組可 `import { MicButton, SpeakButton } from 'modules/voice'` 或監聽事件 |
| 語音設定頁 `/voice` | ☑ | 顯示四種引擎可用性、STT/TTS 測試、整合說明 | |

## 致謝／授權
- `@dnd-kit/core @dnd-kit/utilities`（MIT）— 看板拖拉。
- `edge-tts`（GPL-3.0，Python 套件，僅伺服器端以子套件方式呼叫，不打包進產品）— 後備 TTS。**請注意授權**：若要商用發行 Docker image，建議改成可選安裝（`pip install myhermescompany[tts]`）。
- whisper.cpp（MIT）— 只呼叫本機既有 `whisper-cli`，未附模型。
