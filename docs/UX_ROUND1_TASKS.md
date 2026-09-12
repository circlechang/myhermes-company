# UX 第一輪（IDEO 觀察六項）— 進度檔

日期：2026-09-02　分支：ux/ideo-round1

| # | 項目 | 完成條件 | 狀態 |
|---|---|---|---|
| 1 | 首頁＝「等你決定」 | 登入後預設進 /today：待核准、失敗的 run、超預算警示、今天完成了什麼；工作臺退為側欄項目 | ☑ |
| 2 | 側欄 23→5 群 | 今天／工作／員工／對話／設定；「系統」全部摺進 /settings 子頁；所有舊路由仍可用 | ☑ |
| 3 | 員工頁＝人事檔案 | 選員工後右欄先看到：職稱、擅長、最近 7 天做了什麼（對話／工作流站數）、花了多少、被退回幾次；SOUL 編輯退到第二個分頁 | ☑ |
| 4 | 系統詞退到工程師模式 | 預設隱藏 Session ID／Run ID／profile／SOUL.md／模型 id 等；設定頁一顆「工程師模式」開關，開了才出現 | ☑ |
| 5 | 對話自動命名＋一行結果 | 新對話第一句自動變標題；跑完後側欄該筆顯示一行結果（產出文件 vN／投遞 LINE／最後回覆摘要） | ☑ |
| 6 | 工作流：試跑一站＋產出就地＋審批就地 | 每站有「試跑這一站」；站底下直接看這站產出；等審批時該站卡片就有核准／退回 | ☑ |

驗證器：`web: tsc + vitest + build`、`server: pytest`、Playwright mock 截圖存 docs/qa/screens/、伺服器重啟後 curl 抓新 bundle 字串。

## 完成紀錄（2026-09-02）
- 驗證：web tsc 乾淨、vitest 35 檔 262 測試全綠（+18）、pytest 490 全綠（+13）；build 後重啟 :8700，/today /workbench /settings /agents 皆 200。
- 截圖：docs/qa/screens/ux1-*.png（today／agent-dossier／workbench-results／settings-hub／settings-engineer／workflow-stations）。
- 新端點：`GET /agents/{id}/dossier?days=7`、`POST /workflows/{wf}/nodes/{node}/try`；`GET /sessions` 多回 `result`／`result_kind`；`GET /workflow-runs` 預設排除 try run（`?include_try=true`）。
- 舊路由全部保留：`/` 轉 `/today`，工作臺改 `/workbench`，14 個系統頁從側欄移到 /settings 樞紐。
- 沒做／要注意：既有「與 default 的對話」不會回填標題（下次送訊息才觸發）；試跑 UI 沒露出 input 欄；人工審批節點沒有 session_id 所以人事檔案的「被退回」只算得到有 session 的閘門；events collector 會把 try run 算進統計。

# 第二輪：工作流重設計（依 docs/UX_WORKFLOW_REDESIGN.md）

| # | 期別 | 完成條件 | 狀態 |
|---|---|---|---|
| W1 | 第一期 | 站卡閱讀模式一行＋點開編輯；加一步只剩三種；清單卡片化（誰參與／上次／下次／跑一次）；詞彙表套用；分岔迴圈自檢畫布回放收進工程師模式；審批頁離開側欄與清單頁主按鈕 | ☑ |
| W2 | 第二期 | 流程頁預設「最近一次」分頁，每站一行狀態＋結果摘要；「什麼時候跑／最多花多少」在「怎麼跑」分頁底部 | ☑ |
| X3 | 第三期 | `POST /workflows/draft {text}` 用 Hermes 員工排草稿鏈；DraftDialog 一句話→草稿→確認→建立 | ☑ |

完成紀錄（2026-09-02 晚）：web tsc 乾淨、vitest 37 檔 282 全綠（+20）、pytest 497 全綠（+7）；build 後重啟 :8700。截圖 docs/qa/screens/ux2-*.png。
新端點 `POST /workflows/draft {text, agent_id?}`（不建流程，回草稿）；`POST /workflows/{id}/nodes/{node}/try`。
沒做：分岔／迴圈站在工程師模式仍是舊介面；`POST /workflows/draft` 未對真 Hermes 打過（只驗解析退路）；原本存在的「與 default 的對話」不回填標題。

# 第三輪：挑剔使用者十條（2026-09-03，分支 ux/round3-mobile-notify）

| # | 路 | 完成條件 | 狀態 |
|---|---|---|---|
| M | 手機 | 工作臺／AI 員工／流程「等你看」／今天／收件匣在 390px 寬能完整操作：清單優先、點了進內容、有返回；閱讀欄在手機是全螢幕；頂欄收成 4 個控制項 | ☑ |
| N | 通知 | 流程等你看、對話危險指令、流程失敗 → 推 LINE（用既有 LINE 投遞），訊息附連結直達；設定頁可填收件對象與站台網址、可關 | ☑ |
| V1 | 今天＝收件匣 | 收件匣併進今天頁（種類籤保留），側欄拿掉收件匣，頂欄徽章指到今天；金額 NT$＋本月累計（匯率可設）；時間全站「今天 09:30／昨天／8/29」；載入改骨架 | ☑ |
| V2 | 詞彙與空狀態 | 核准→可以、待辦收件匣→收件匣、AI 員工管理→AI 員工；Skills／Coding Agents／頻道／模型／看板在工程師模式關時零系統詞；Coding Agents 離開側欄；文件模式／群聊／套件空狀態各一顆主按鈕；錯誤訊息附「去修」連結 | ☑ |

完成紀錄（2026-09-04）：web tsc 乾淨、vitest 44 檔 322 全綠（+38）、pytest 508 全綠（+11）；build 後重啟 :8700。截圖 docs/qa/screens/ux5-*.png（桌機 8 張＋手機 6 張）。
新東西：LINE 通知（`/notify/prefs`、`/notify/test`、`/notify/status`；等你看／流程失敗／危險指令三種訊息、10 分鐘去重、安靜時段）；`web/src/lib/format.ts`（台幣、萬 tokens、今天 09:30）；CollapsiblePanel 手機 sheet 模式；收件匣併入今天頁（/inbox 轉址）。
測試基礎：vitest 限 4 個 worker、findBy 等待 4 秒（全套並行時 1 秒會閃紅）。
沒做：Coding Agents 頁只從設定總覽或員工卡「開工程對話」進；LINE 推播沒對真 LINE 打過（需 token）；手機版只用 jsdom＋mock 截圖驗，沒真機。
