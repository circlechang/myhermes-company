# 貢獻指南

謝謝你願意動手。這頁只講一件事：怎麼讓你的修改可以被合併。

## 開發環境

```bash
# 後端（Python ≥ 3.11，建議 3.12）
cd server && python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/python -m pytest -q

# 前端（Node 22+）
cd web && npm ci
npm test          # vitest
npm run build     # 產物落在 server/studio/web_dist/
npm run dev:mock  # 沒有後端也能看畫面
```

跑起整套：`cd web && npm run build && cd ../server && .venv/bin/myhermescompany start --port 8700`。

## 送 PR 之前

1. **測試要綠**：`pytest -q` 與 `npm test` 全過，`npm run build` 沒有錯誤。
2. **新行為要有測試**。後端加 API 就加 pytest；前端加畫面就加 vitest。
   跨模組的行為（工作流、審批、群聊）請用既有的 fake gateway／fake CLI，不要打真的 Hermes。
3. **不要塞進真實資料**。測試 fixture、範例、截圖一律用中性假資料：
   不要有真實公司名、客戶名、人名、路徑（`/Users/<你>`）、金鑰、真實用量數字。
4. **不要改 Hermes 本體的假設**。本專案只透過官方 Gateway API 與 `hermes` CLI 操作 Hermes。
   新增接觸面請同步更新 `server/studio/hermes/contract/surface.yaml`，
   並讓 `myhermescompany hermes-check` 仍然過。
5. **`.env`、`*.db`、金鑰、wheel 不要進版控**（`.gitignore` 已擋，請再確認一次 `git status`）。

## 送 PR

- 從 `main` 開分支，一個 PR 做一件事。
- 標題寫「做了什麼」，內文寫「怎麼驗的」——貼上你跑的指令與結果，不要只寫「已測試」。
- 行為有變就更新對應文件：`docs/USER_GUIDE.md`、`docs/API.md`、`docs/PARITY.md`。
- 大改動（新模組、資料表變更、破壞相容）請先開 issue 討論，不要直接送。

## 回報問題

用 issue 模板。最有用的三件事：**版本**（`myhermescompany version`、`hermes --version`）、
**重現步驟**、**實際看到什麼**（錯誤訊息、`myhermescompany logs` 的相關片段）。
貼 log 之前記得把金鑰與個資塗掉。

## 授權

送出貢獻即表示你同意這些內容以本專案的授權（Business Source License 1.1，見 [`LICENSE`](./LICENSE)）發行。
