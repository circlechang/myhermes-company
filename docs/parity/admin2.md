# Parity：I 檔案瀏覽器 · L Skills 與記憶 · M 主題 · N 日誌 · O 終端／MCP／Plugins／版本

日期：2026-08-29。對本機 Hermes v0.20.5（9 個 profile）實測；Studio server 起在 `STUDIO_PORT=8766`、`STUDIO_DB` 指到暫存目錄，跑完已停掉。
程式：後端 `server/studio/modules/{files,skills,memory,journey,theme,logs,admin}/`；前端 `web/src/modules/{files,skills,theme,logs,admin}/` ＋ `web/src/components/admin2/`。
測試：`server/tests/test_admin2_modules.py`（21 個，含路徑穿越／symlink 逃逸／終端 pty）、`web/src/test/admin2.test.tsx`（6 個）。

## I. 檔案瀏覽器
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| 本機瀏覽（根限定） | ☑ | `GET /files/roots` 回 11 個根（workspace、9 個 profile:*、uploads）；`GET /files/list?path=profile:researcher` 回 47 筆 | 根＝Hermes workspace／各 profile 目錄／Studio uploads／`STUDIO_FILE_ROOTS="label=/abs,..."` 額外根 |
| 防路徑穿越 | ☑ | `profile:researcher/../../.env`、`workspace/../.env` 皆 400 `path_traversal`；pytest 另測 symlink 指到根外 → 400、未知根 → 404、絕對路徑 → 404 | 以 `resolve()` 後 `relative_to(root)` 判斷，symlink 也擋 |
| 上傳／下載／重新命名／複製／移動／刪除／建目錄 | ☑ | 在 `workspace/_studio_test` 全流程跑過（mkdir→write→rename→copy→move→upload→download 回原 bytes→delete），最後目錄已不存在 | 同名目標回 409；不能刪／寫根本身 |
| 預覽＋編輯（高亮） | ☑ | `GET /files/read` 回文字／二進位判斷（`SOUL.md` 2006B text/markdown）；前端 CodeMirror 6（md/js/ts/py/yaml/json/html/css） | >2MB 文字只顯示前 2MB 唯讀；圖片用 blob 預覽；其他二進位不預覽 |
| 附回聊天 | ☑ | `POST /files/attach` 回 `workspace://workspace/_studio_test/up.txt`；前端派發 `window.dispatchEvent(new CustomEvent('studio:attach',{detail:{path,uri,name}}))`，vitest 驗事件內容 | 聊天模組需監聽 `studio:attach` |
| 權限 | ☑ | member 對 `profile:*` 根只能讀（寫 403）；workspace／uploads 可寫 | 設計決策：profile 目錄含 config/.env，僅 owner/admin 可寫 |
| Docker／SSH／Singularity 後端 | 不做 | — | 本產品定位單機部署，只操作本機檔案系統 |

## L. Skills 與記憶
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| Skills 清單／搜尋／分類 | ☑ | `GET /skills?profile=default` 242 筆（local 228、builtin 14）、27 個分類；`?q=google` 過濾；symlink 的 skill（cubox → .agents）也掃得到 | 來源：profile `skills/`＋`hermes-agent/skills`（builtin，同名以 local 為準）；分類＝上層目錄或 frontmatter category |
| 詳情與附檔預覽 | ☑ | `GET /skills/cubox` 回 v1.0.9、附檔 references/*.md；`/skills/{name}/file?rel=` 有防穿越（pytest） | 附檔 >1MB 或二進位只回大小 |
| 啟用／停用 | ☑（pytest） | 寫 profile `config.yaml` 的 `skills.disabled`（與 `hermes skills config` 同一份），ruamel 保留註解——pytest 驗 `# keep me` 還在 | `hermes skills config` 是互動式無法包；真機未對使用者 config.yaml 做寫入測試（避免動到設定） |
| 建立／編輯 | ☑（pytest） | `PUT /skills/{name}` 建 `skills/[category]/name/SKILL.md`（自動補 frontmatter）；編輯既有 SKILL.md | 只能寫 local；builtin 若要改會複製成 local（同名覆蓋 builtin） |
| Skill Bundles | ☑ | 真機 `POST /skills/bundles` → `hermes bundles create myhermescompany-tmp --skill cubox --skill find-skills` 成功建檔，`DELETE` 移除，目錄已清空 | 讀 `~/.hermes/skill-bundles/*.yaml` |
| 用量統計 | ☑ | `GET /skills/usage` 由 Studio messages（tool 訊息）＋ `state.db` 唯讀 `messages.tool_calls LIKE '%skill%'` 計數 | 子字串比對，短名稱可能偏高；state.db 只掃 2 萬筆 |
| 使用者筆記 | ☑ | Studio 表 `skill_notes`（每成員每 skill 一筆），pytest 驗 PUT/GET | — |
| 記憶管理 | ☑ | `GET /memory/files` 列 MEMORY.md/USER.md(+bak)；讀 USER.md；`../config.yaml` 400；真機新增 `STUDIO_TW_TEST.md` 再刪除；`GET /memory/status` 轉 `hermes memory status` | `hermes memory` CLI 只管外部 provider，內建記憶＝檔案直讀寫；MEMORY.md/USER.md 不可刪只可清空；寫入僅 owner/admin |
| Journey 關係圖 | ☑ | `GET /journey/graph?profile=default` → 267 節點／492 邊（skills 239＋記憶檔＋記憶條目）；researcher 109 節點／159 邊。前端 d3-force 版面＋SVG、分類篩選、點節點看詳情、時間軸依 mtime 回放（vitest 驗拉到最早只剩舊節點） | 邊＝`[[wiki]]`／`` `name` ``／內文提及 skill 名（≥4 字）；`merge_hermes=1` 併 `hermes journey --json` 的邊，但其節點 id 與本機 skill 名對不上（真機併入 0 條），保留為選項 |

## M. 主題
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| 亮／暗／跟隨系統 | ☑ | `PUT /theme {settings:{mode:"dark"}}`；前端在 `<html>` 設 `data-theme`，`tailwind.config.js` darkMode 改成 variant（跟隨系統為預設、`data-theme` 可強制）——這是唯一動到共用設定的地方，預設行為不變 | — |
| 介面風格（圓角／方角）、密度（舒適／緊湊）、字級、文字色、主色 | ☑ | vitest 驗 `--studio-font-size`、`--studio-primary`、`data-theme`；模組 on-import 注入 `<style id=studio-theme-style>`，不改 Layout.tsx | 覆蓋範圍：`.btn-primary/.input/.card/.btn` 與 html 字級；其他頁面的硬編色不受影響 |
| 每帳號背景圖 | ☑ | 真機上傳 1×1 PNG → `has_background:true`，`GET /theme/background` 200 69B | 只收 png/jpeg/webp/gif ≤8MB，存 `<db dir>/theme-backgrounds/` |
| 存 DB＋localStorage 快取＋即時預覽 | ☑ | 表 `theme_prefs`（每成員）；`localStorage['mhc.theme']`；改設定立即 `applyTheme` 再 PUT | 登入後同步靠模組載入時有 token；若在同一頁面登入，會在進入「外觀」頁時再同步 |

## N. 日誌
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| 列檔案 | ☑ | `GET /logs/files` 83 個（`~/.hermes/logs/*`、各 profile `logs/`、Studio `studio.log`） | id 格式 `hermes/<f>`、`profile:<p>/<f>`、`studio/studio.log`，名稱含 `.log` 才列 |
| 依等級／檔案／關鍵字篩選 | ☑ | `GET /logs/read?file=hermes/gateway.log&level=ERROR&lines=5` 回真實 2 筆 ERROR（3.4MB 檔尾端讀取）；`q=`、`http_only=1` pytest 驗 | 從檔尾讀，最多 5000 行 |
| 尾端追蹤 | ☑ | `WS /ws/logs?token&file=studio/studio.log` 先 `ready`，打一次 `/health` 後收到 `{"type":"line",...}`；輪替時送 `rotated` | 0.5s 輪詢 stat |
| 結構化解析＋HTTP 高亮 | ☑ | 解析 `ts / level / component / msg`，uvicorn access 行解出 `{method,path,status}`；前端狀態碼上色 | 非標準格式的行 level=null |
| Studio 自己的 log | ☑ | `on_startup` 掛 RotatingFileHandler 到 `<db dir>/studio.log`（5MB×3），含 uvicorn access | — |

## O. 管理與執行環境
| 項目 | 狀態 | 怎麼驗 | 限制 |
|---|---|---|---|
| Web 終端 | ☑ | `WS /ws/terminal?token&cwd=profile:researcher` → `ready{cwd,shell,pid}`；送 `echo ok-$((40+2)); pwd` 收到 `ok-42` 與 `/profiles/researcher`；`exit` 收到 `{"type":"exit"}`；pytest 用 `/bin/sh` 跑 `echo`，member 連線回 `forbidden` | 後端 `ptyprocess`（venv 與 pyproject 已加）；前端 xterm.js 動態載入；僅 owner/admin；cwd 只能選 workspace／各 profile／home |
| MCP 列出 | ☑ | `GET /mcp/servers?profile=default` 10 個（twinmind/linear/trello…）、`?profile=researcher` 4 個；`env/headers` 含 token/key 的值遮罩 | 直接讀 profile `config.yaml` `mcp_servers` |
| MCP 新增／刪除／測試 | ☑ | 新增／刪除包 `hermes [-p profile] mcp add|remove`（pytest 驗 argv，含 `--args` 放最後）；真機 `POST /mcp/servers/linear/test` 轉 `hermes mcp test`，輸出「✗ Connection failed（需互動 OAuth）」→ `ok:false` | OAuth 登入需在終端互動（可用 Web 終端跑 `hermes mcp login`）；真機未新增／刪除實際 server（避免改使用者設定） |
| Plugins | ☑ | `GET /plugins` → `hermes plugins list --json` 56 個（3 enabled）；enable/disable 包 CLI（pytest） | 真機未切換（避免改設定） |
| 版本更新提示 | ☑ | `GET /version` → Hermes 0.20.5、落後 upstream 1498 commits、GitHub latest `v2026.8.27`（api.github.com 403 時改追 `releases/latest` 的 302）、`update_available:true`；`STUDIO_UPDATE_CHECK=0` 關閉 | 版本比較用數字三段，Hermes 換成日期式 tag 後只能提示「有新 tag」 |
| 裝置／區網節點 | 不做 | — | 桌面版功能 |

## 決策與備註
- WebSocket 一律走 `/ws/*`（`/ws/logs`、`/ws/terminal`），vite proxy 與正式站同一條路；HTTP 走 `/api`→rewrite。
- `hermes skills list`、`mcp list`、`bundles list` 都是表格輸出，所以讀檔案／config.yaml；只有 mutation 走 CLI。`plugins list --json`、`journey --json` 有 JSON。
- 新增依賴：後端 `ptyprocess`、`ruamel.yaml`、`python-multipart`（已裝進 `server/.venv` 並加進 `server/pyproject.toml` dependencies）；前端 `@xterm/xterm`、`@xterm/addon-fit`、`codemirror`、`@codemirror/*`、`d3-force`（package.json 已加；期間曾被其他 agent 的 `npm install` 蓋掉一次，已補回）。
- 其他 agent 影響：`npm run build` 目前被 `src/modules/workflows/RunPage.tsx` 的 TS 錯誤擋住（非本模組；`vite build` 單獨可過）；vitest 全套有 2 個失敗在看板／工作流測試（ResizeObserver、React Flow），非本模組；本模組 6/6 綠。pytest 全套 155 綠。
- 未做真機寫入的：skill 啟停（會重寫使用者 config.yaml）、MCP add/remove、plugins enable/disable、建立新 skill 到真實 profile——都有 pytest 覆蓋。
- 授權：只用 MIT 套件（xterm.js、CodeMirror 6、d3-force），未複製任何 BSL 專案程式碼／字串；`hermes journey --json` 只是呼叫 CLI。

## round2 補記：登入鎖定（O）
| 項目 | 狀態 | 怎麼驗 | 已知限制 |
|---|---|---|---|
| 登入鎖定 | ☑ | `POST /auth/login` 同帳號（`u:<name>`）或同 IP（`ip:<addr>`，吃 `X-Forwarded-For` 第一段）連續失敗 5 次 → 鎖 900 秒，回 `423 {"error":{"code":"locked","retry_after":N}}`＋`Retry-After` 標頭；鎖住時正確密碼也 423；成功登入刪計數；鎖到期自動解除重新計數；鎖定寫 `audit(action=login.locked)`。環境變數 `STUDIO_LOGIN_MAX_FAILURES`、`STUDIO_LOGIN_LOCK_SECONDS`。pytest `test_login_lockout_after_five_failures_and_clear`、`test_login_lock_expires`；真機 8700：第 5 次 423 `retry_after:899`，`myhermescompany clear-login-locks` 清 2 筆（帳號＋IP）後 admin 200 | 計數在 DB `login_locks`（多 worker 一致）；反向代理沒設 `X-Forwarded-For` 時所有人同一個 IP 桶，5 次就全鎖——正式部署請確認代理有帶 |
| CLI `clear-login-locks [--username]` | ☑ | pytest `test_clear_login_locks_cli`；真機同上 | 直接操作 DB，不用重啟 |
