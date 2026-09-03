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
