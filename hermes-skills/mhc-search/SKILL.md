---
name: mhc-search
version: 1.0.0
description: "查 MyHermesCompany（Studio）裡發生過的事：跨對話、群聊、工作流節點輸出、事件時間軸的全文搜尋（中文可搜），以及事件因果鏈。當使用者問「上次那件事怎樣了」「之前客人說過什麼」「上週交辦了什麼」「那個工作流跑到哪」「誰核准了什麼」時使用。唯讀。"
metadata:
  requires:
    bins: ["python3"]
    env: ["MHC_SEARCH_TOKEN"]
---

# mhc-search — 問 Studio「上次那件事怎樣了」

這個 skill 打 MyHermesCompany Studio 的唯讀 API（`GET /search`、`GET /events`、`GET /events/{id}/chain`）。
所有指令都是**唯讀**，不會改任何資料。

## 設定（只讀環境，不要在對話裡要 token）

- `MHC_SEARCH_TOKEN`：owner 在 Studio 發的唯讀機器 token（`mhc_…`）。腳本依序讀：環境變數 →
  `$HERMES_HOME/profiles/<profile>/.env` → `~/.hermes/.env`。
- `MHC_STUDIO_URL`：Studio 位址，預設 `http://127.0.0.1:8700`。

沒有 token 時腳本會以 exit 2 結束並印出「請 owner 用 `POST /search/tokens` 發 token」；**不要**請使用者把 token 貼到對話裡，
請他自己寫進 `~/.hermes/.env` 或該 profile 的 `.env`。

## 指令

腳本：`scripts/mhc_search.py`（只用 Python 標準函式庫）。預設輸出精簡 JSON，加 `--text` 印給人看的格式。

### 1. 全站搜尋

```bash
python3 scripts/mhc_search.py search "文案" [--scope chat|group|workflow|events|all] [--since 7d|2026-08-01] [--until ...] [--agent <profile>] [--limit 20]
```

回傳 `items[]`：`scope`（chat/group/workflow/events）、`ref`（原始資料 id）、`title`、`snippet`（命中片段）、`ts`、`agent`、`link`（Studio 頁面路徑）、`score`（越大越相關）。
中文直接搜（兩個字的詞也可以），多個詞以空白分開＝AND。

### 2. 事件時間軸

```bash
python3 scripts/mhc_search.py events [--kind approval.*] [--subject run:wr_xxx] [--source workflow] [--agent <profile>] [--since 3d] [--limit 50]
```

### 3. 因果鏈（這件事從哪來、往哪去）

```bash
python3 scripts/mhc_search.py chain <event_id> [--depth 10]
```

回傳 `event`、`upstream[]`（由近到遠的上游事件）、`downstream[]`（直接下游）。

## 回答使用者時

1. 先 `search`，用結果的 `link` 讓使用者能點回 Studio 看原文。
2. 命中是事件（`scope=events`）時，用 `chain` 把前因後果補上再回答（例如審批決定 → 它對應的審批請求 → 那個 run 何時開始）。
3. 沒命中就說「Studio 裡找不到含『…』的紀錄（搜尋範圍：…，期間：…）」，不要編。
4. 別把 token、URL 之外的設定印給使用者。

## 常見錯誤

- exit 2 / `no token`：見設定段。
- HTTP 401：token 被撤銷或站別不對（`MHC_STUDIO_URL`）。
- HTTP 400 `bad_scope`／`bad_time`：scope 拼錯或時間格式錯（用 ISO 8601 或 `7d`／`24h`）。
