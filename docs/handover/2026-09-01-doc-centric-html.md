# 以文件為核心：HTML 文件、工作臺連動、版位對調

## 目標（可驗證的完成條件）

1. **文件預設 HTML 且可直接預覽**
   - 新建文件 `format=html`、路徑 `.html`；既有 `.md` 不壞、照舊用 Markdown 渲染
   - 文件面板用沙箱 iframe 預覽 HTML
2. **工作臺的對話可以開文件**
   - 工作臺對話按「開一份文件」→ 建 doc（html）並綁 `sessions.doc_id`
   - 該文件出現在 `/docs` 與 `/doc-mode`，可繼續經營
3. **文件模式版位**：`[文件清單][文件（中央）][對話（最右）]`

## 設計決定

- **format 欄位預設留空，以路徑副檔名回推**。自動 migration 會把新欄位填成模型預設值，
  若預設 `html` 會把既有的 `.md` 文件錯標成 html。留空 + `Doc.fmt()` 回推，零 migration、不會標錯。
- **HTML 用沙箱 iframe `srcdoc` 預覽**，不用 `dangerouslySetInnerHTML`：
  文件內容來自模型，等同不可信輸入，不能讓它拿到頁面的 DOM 與 token。

## 進度

- [x] 盤點現況：doc↔chat 連動只存在於 /doc-mode；`.md` 硬性綁死；版位是 [清單][對話][文件]
- [x] 後端：`Doc.format` + `fmt()` + `default_path()` 依格式 + `resolve()` 放行 `.html`
- [x] 後端：`DOC_RULES` 依格式給不同輸出指示
- [x] 前端：`DocPanel` 依格式選渲染（html → 沙箱 iframe）
- [x] 前端：DocModePage 版位對調
- [x] 前端：工作臺「開一份文件」入口 + 文件面板
- [x] 驗證：server pytest、web tsc + vitest、實機建一份 HTML 文件看預覽

## 驗證方式

- `cd server && .venv/bin/python -m pytest tests/ -q`（注意：一定要用 `python -m pytest`，
  直接 `pytest` 會因 sys.path 少了 rootdir 而假失敗 13 個 error + 1 failure）
- `cd web && npx tsc --noEmit && npx vitest run`
- 實機：`server/.venv/bin/myhermescompany restart` 後開 http://127.0.0.1:8700

## 完成紀錄（2026-09-01）

- server `python -m pytest`：475 passed
- web `tsc` + `vitest`：240 passed（新增 4 個測試）
- 實機：既有 `.md` 文件 `fmt()` 回推為 md 未被誤判；新建的「獵戶科技」為 `format=html`、路徑 `.html`

### 過程中修掉的兩個非顯而易見的坑

1. **mock 後端有兩層**：`modules/chat/mock.ts` 的 `chatMock()` 在 `mock/fetch.ts` 主路由**之前**攔截
   `/sessions/*`，而且是逐欄位處理。在 fetch.ts 加 PATCH 路由完全碰不到，要改 chat mock。
2. **`doc.updated` 事件帶 `session_id`**（`chat_ws.py:557`），前端 handler 必須在 `!ev.session_id`
   的早退之前處理它，否則會被當成一般聊天事件餵進 `applyEvent`。
