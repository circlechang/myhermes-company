# docs/parity 索引

七份模組報告，都是 2026-08-29 對本機 Hermes 0.20.5（9 個 profile）真機實測後寫的。
每份含：狀態表（☑/◐/☐＋怎麼驗＋已知限制）、自動測試清單、真機指令與輸出摘要、決策記錄、需要合併進 README 的致謝。
彙整後的狀態表在 `../PARITY.md`；本頁只做導覽。

| 檔案 | 涵蓋區段 | 一句話摘要 |
|---|---|---|
| [chat.md](chat.md) | A 聊天（工作臺） | 21/23 完成；上下文靠固定 `session_id`＋`conversation_history`，圖片以 content parts 送，HTML 預覽走 sandbox iframe；壓縮進度與子代理事件等 gateway |
| [admin1.md](admin1.md) | B 頻道、C 用量、D 排程、G 模型、H 多 Profile | 11 平台單頁設定寫 `.env`／`config.yaml` 都保留註解；用量唯讀 state.db（30 日 4,983 sessions）；cron 走 gateway `/api/jobs`；模型管理不回任何 key；OAuth 與 gateway restart 真機沒按 |
| [admin2.md](admin2.md) | I 檔案、L Skills／記憶／Journey、M 主題、N 日誌、O 終端／MCP／Plugins／版本 | 檔案瀏覽器根限定＋防穿越（含 symlink）；skills 242 筆、Journey 267 節點；xterm 終端僅 owner/admin；版本比較追 GitHub latest |
| [collab.md](collab.md) | J 群聊、E 看板、P 語音 | 群聊「誰回誰是 assistant」＋@ 深度上限＋摘要壓縮；看板與 `hermes kanban` 同一份 kanban.db、dnd-kit 拖拉；語音瀏覽器優先、後端 whisper-cli／edge-tts 後備 |
| [workflows.md](workflows.md) | F 視覺化工作流 | React Flow 六種節點、閘門退回重跑、預算／期限、快照回放、cron／webhook 觸發、LINE／webhook／檔案投遞；真機「熱點→選題→閘門→文案」189k tokens 跑通 |
| [coding.md](coding.md) | K Coding Agents | Claude Code／Codex／Pi 以 subprocess＋stream-json 統一成事件；Anthropic／Responses 相容 proxy 讓 CLI 用 Hermes 模型（只能問答，工具迴圈在 Hermes 端）；Pi 本機未裝 |
| [release.md](release.md) | Q 發行 | `myhermescompany` CLI＋wheel 內建前端、`/api` 前綴 middleware、非 loopback 安全檢查；Docker／compose 本機 daemon 沒開未驗 |

## 讀法建議
- 想知道「某功能到底能不能用」：先看 `../PARITY.md` 對應行，再點進明細檔看「已知限制」欄。
- 想接手改程式：每份檔案開頭列了負責的 `server/studio/modules/<x>/` 與 `web/src/modules/<x>/` 路徑，以及測試檔名。
- 想重跑真機驗證：每份都有起伺服器的 `STUDIO_PORT=87xx STUDIO_DB=<tmp>` 指令與清理方式；測試資料都是自建再刪，不碰使用者的 profile／記憶／設定。
