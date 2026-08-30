# K. Coding Agents（Claude Code / Codex / Pi）— 對齊與實測紀錄

程式位置：`server/studio/modules/coding_agents/`（detect / parsers / runner / proxy / router / models）、`web/src/modules/coding_agents/`（CodingPage / DiffView / state / socket / api）。API 契約見 `docs/API.md`「Coding Agents」。

## 狀態總表
| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| 偵測安裝（PATH、~/.local/bin、~/.nvm/versions/node/*/bin、/opt/homebrew/bin）＋版本 | ☑ | 真機 `GET /coding/agents`：claude `~/.local/bin/claude` v2.1.251、codex v0.145.0、pi 未安裝 | 版本用 `<bin> --version`，逾時 15s 視為空字串 |
| 未安裝顯示安裝指令＋一鍵安裝（owner） | ☑（pytest） | pytest 以 `/bin/echo` 冒充 npm 跑完 job、member 403；前端 vitest 點安裝→顯示 job 完成 | 真機沒有實際 `npm i -g`（不想動使用者全域 node），pi 仍未裝 |
| 設定：工作區／模型／API 模式／profile／權限與沙箱 | ☑ | `PUT /coding/settings/claude`（真機）；不存在的工作區 400 | 每家公司一份，非每人 |
| Anthropic 相容 proxy → Hermes `/v1/chat/completions` | ☑ | 真機 curl 非串流回 `PROXY OK`；串流收到 `message_start … content_block_delta("STREAM"," OK") … message_stop` | Claude Code 送的 tools 定義被丟掉：Hermes 自己跑工具、只回文字，所以 proxy 模式下 Claude Code 只能「問答」，不能讓 Claude Code 自己編輯檔案（工具迴圈在 Hermes 端） |
| Responses 相容 proxy → Hermes `/v1/responses` | ☑（pytest）◐（真機） | pytest 直通＋串流＋去 tools；真機 `GET /coding/proxy/openai/v1/models` 回 `hermes-agent` | 真機沒跑 Codex-走-proxy 全程（Codex 需要 function_call 才會動手，Hermes 不回 function_call，同上限制） |
| Claude Code 走 proxy 真機 | ☑ | `api_mode=hermes` 跑 `claude -p …`，回 `PROXY VIA CLAUDE CODE`（模型顯示 Hermes profile 的 `claude-fable-5[1m]`） | 首次實測因沿用 `max_budget_usd=0.05` 被 Claude Code 判 `error_max_budget_usd`（它用 Anthropic 牌價算 24k 上下文）；已改成 proxy 模式不帶該旗標 |
| 啟動 session（subprocess＋stream-json 解析→統一事件→WS→落庫） | ☑ | 真機 claude：`print hello in python, no tools`（haiku、max_turns 1）→ `session.init/message.delta/run.completed`，cost 0.018；codex：建 `hello.txt` → `tool.started(file_change)/tool.completed/run.completed` | Claude Code 的 stream-json 一則 assistant 事件是一整段，不是 token 級 delta（可加 `--include-partial-messages`，先不開以免事件量爆） |
| 中止 | ☑（pytest） | 假 CLI `sleep 30` → `stop` 後 <10s 收到 `run.cancelled`（整個 process group 一起殺） | — |
| 繼續（resume） | ☑ | 真機同 session 第二輪自動帶 `--resume a9b8…`，Claude 正確回答「你上一句要我印 hello」；codex 記 thread_id 用 `exec resume` | pi `--session` 未實測 |
| 送圖片 | ☑（pytest） | `POST /coding/sessions/{id}/images` base64 存到 `<ws>/.studio-uploads/`；claude 以路徑附在 prompt 請它 Read、codex `-i` | 真機沒跑圖片任務（省 token） |
| 內建終端視圖 | ◐ | 先用日誌視圖（stderr／未解析行以 `log` 事件顯示，執行指令列顯示在分頁列）。round2 評估：admin 的 `/ws/terminal` cwd 只收 profile 名／固定根目錄 id，不收 coding 工作區路徑；coding session 不是 PTY | 要做：後端 `resolve_cwd` 開放 `path:<abs>`（owner/admin）＋抽出 xterm 元件成 `TerminalPane`，CodingPage 加「終端」分頁 |
| 工作區選擇 | ☑ | `GET /coding/fs` 目錄瀏覽（標示 git repo），設定面板可瀏覽／選用 | 只列目錄、跳過 dot 目錄，上限 500 |
| 檔案 diff（執行前後 `git diff HEAD` 並排） | ☑ | 真機 codex 建檔後 `diff.files=[{"??","hello.txt"}]`、after 含新檔內容（未追蹤檔補成 new file diff） | 非 git 工作區顯示「無法比對」；diff 上限 2MB |
| 前端 `/coding` 頁（卡片／新開 session／歷史／串流／diff 分頁） | ☑（vitest） | 3 個頁面測試＋4 個狀態測試全綠 | 沒有用瀏覽器實際點過（vite dev 未起） |
| Pi | ◐ | 解析器依 pi-agent-core 事件型別寫，用假腳本測；本機沒裝 | 指令 `pi -p --mode json` 與 `--session` 未在真機驗證 |
| 獨立視窗（桌面版） | 不做 | — | 產品無桌面版 |

## 測試
- 後端：`cd server && .venv/bin/python -m pytest tests/test_coding_agents.py` → 20 passed（假 CLI 在 `tests/fake_cli/fake_{claude,codex,pi}.sh`，印真實格式的 JSONL 樣本；proxy 用自建假上游驗轉換與串流）。全套 `pytest tests` 124 passed／6 failed，失敗全在 `test_workflow_engine.py`／`test_workflows.py`（F 工作流模組同事正在改，與本模組無關）。
- 前端：`npx vitest run src/modules/coding_agents` → 7 passed。測試直接 render `CodingPage`（不經 `App`），因為同事的 admin2／skills 模組還缺 `@codemirror/lang-*`、`d3-force` 套件會讓整個 `App` 載入失敗；`tsc --noEmit` 本模組零錯誤（其餘錯誤同樣來自那些缺套件）。

## 真機實測摘要（2026-08-29，STUDIO_PORT=8791、暫時 DB，跑完已停）
```
GET /coding/agents → claude installed v2.1.251, codex v0.145.0, pi not installed
claude -p 'print hello in python, no tools' --output-format stream-json --verbose --model haiku --permission-mode acceptEdits --max-turns 1 --max-budget-usd 0.05
  → session.init(a9b80593…) → message.delta('```python\nprint("hello")\n```…') → run.completed exit=0 cost_usd=0.0178
第二輪同 session（--resume a9b80593…）→「You asked me to print hello in Python without using any tools.」
codex exec --json --skip-git-repo-check -C <ws> -s workspace-write 'Create a file hello.txt…'
  → tool.started file_change → run.completed；diff.files=[{"??","hello.txt"}]，messages 落庫 user/tool/assistant
curl POST /coding/proxy/anthropic/v1/messages（x-api-key=proxy token）→ {"type":"message","content":[{"text":"PROXY OK"}]}
curl … "stream":true → event: message_start / content_block_delta×2 / message_delta / message_stop
claude（api_mode=hermes）→ 'PROXY VIA CLAUDE CODE'（經 Hermes 回覆）
```

## 決策
- session／messages 用共用表（`source=coding:<agent>`、`agent_id=""`），coding 專屬欄位另放 `coding_session_meta`、每次執行 `coding_runs`；工作臺列表（A 模組）需依 `source` 分組時可直接用。
- 中止一律 `killpg`：CLI 會再開 node／shell 子程序，只殺父程序 stdout 不會關（pytest 首版就是這樣卡 30 秒）。
- WS 斷線不殺子程序，讓它跑完落庫，重連後從歷史看結果。
- proxy 驗證用每家公司一把 `hsp_` token（也收 Studio JWT），Hermes 的 `API_SERVER_KEY` 永遠留在伺服器端。
- 沒有引用任何第三方程式碼；未複製 BSL 專案內容。

## round2 補記（2026-08-29）
- `CodingPage` 重建畫面的 bug：原本每次 msgs/runs query 更新都 `setState(fromMessages(...))`，run.completed 後 invalidate runs → 用舊的 messages 快取把剛串流完的輸出洗掉一次（真機也會閃）。改成每個 session 只用伺服器資料重建一次（`hydratedFor`），歷史未載完就開跑時把歷史接在前面；完成時也 invalidate messages。
- vitest 「新開 session → 執行」在全套並行偶紅／後來必紅的真正原因：run.completed 帶 diff 會自動切到 diff 分頁，輸出分頁內容不在 DOM，測試卻先 `findByText('Done: …')`；事件跑得快就輸給自動切換。不是共享狀態（每個測試檔獨立 module context，`setCodingWebSocketImpl` 不跨檔）。測試改成先驗 diff 分頁再切回輸出，並加「重抓回來的空 messages 不能洗掉即時輸出」的回歸斷言。全套連跑 3 次皆綠。
