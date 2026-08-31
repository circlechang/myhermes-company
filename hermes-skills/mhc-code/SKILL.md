---
name: mhc-code
version: 1.0.0
description: "把寫程式／改檔案的任務派給 MyHermesCompany 裡的 coding 員工（Claude Code／Codex／Pi），同步等結果，回傳輸出摘要與檔案改動（git diff）。當使用者說「叫 Claude Code 去改…」「派一個工程任務」「幫我在某個 repo 加上…」「跑一下那個修正並給我 diff」時使用。會在使用者本機真的執行指令與改檔案。"
metadata:
  requires:
    bins: ["python3"]
    env: ["MHC_CODE_TOKEN"]
---

# mhc-code — 把工程任務派給 coding 員工

這個 skill 打 MyHermesCompany Studio 的 `/coding/*` API，讓你（Hermes 員工）把一件事交給
**coding 員工**（runtime 是 Claude Code／Codex／Pi 的 AI 員工）去做，等它做完，再把
「它說了什麼」跟「它改了哪些檔案」帶回來。

## ⚠️ 這是會動到使用者機器的能力

派出去的任務會在使用者的電腦上**真的執行指令、真的改檔案**。所以：

- **工作目錄一定在允許清單內**：Studio 只接受落在檔案模組根白名單（`STUDIO_FILE_ROOTS`、
  Hermes workspace、profile 目錄、Studio uploads）裡的目錄。**預設不允許任意路徑**；
  想讓某個 repo 可以被派工作，要由使用者自己把它加進 `STUDIO_FILE_ROOTS`。
  你不能繞過這個限制，也不要建議使用者關掉它。
- **token 必須是可寫的**：唯讀的 `mhc_…` token 派不了工作（會拿到 403）。可寫 token 只有 owner 能發。
- **派之前先講清楚要做什麼**：任務描述要具體（改哪個檔、要什麼結果），不要把模糊的願望丟過去。
- 任務**不可逆的部分**（刪檔、跑 migration、對外送出、花錢）要先問過使用者再派。

## 設定（只讀環境，不要在對話裡要 token）

- `MHC_CODE_TOKEN`：owner 在 Studio 發的**可寫**機器 token（`mhc_…`）。
  腳本依序讀：環境變數 → `$HERMES_HOME/profiles/<profile>/.env` → `~/.hermes/.env`；
  沒有 `MHC_CODE_TOKEN` 時會退回 `MHC_SEARCH_TOKEN`（但那把通常是唯讀的，派工作會 403）。
- `MHC_STUDIO_URL`：Studio 位址，預設 `http://127.0.0.1:8700`。

沒有 token 時腳本 exit 2 並印出「請 owner 用 `POST /search/tokens {"can_write": true}` 發 token」。
**不要**請使用者把 token 貼進對話，請他自己寫進 `~/.hermes/.env`。

## 指令

腳本：`scripts/mhc_code.py`（只用 Python 標準函式庫）。預設輸出精簡 JSON，加 `--text` 印給人看的格式。

### 1. 有哪些 coding 員工

```bash
python3 scripts/mhc_code.py agents [--text]
```

回 `id`、`name`、`runtime`（claude-code/codex/pi）、`workspace`、`installed`、`enabled`。
**先看這個再派**：員工不存在、停用、或 CLI 沒安裝就不要派。

### 2. 派一件任務（同步等結果）

```bash
python3 scripts/mhc_code.py run <員工名稱或 id> "在 hello.py 印出 hello，然後說完成" [--workspace /allowed/path] [--timeout 600] [--text]
```

- 預設用該員工設定好的工作目錄；`--workspace` 只在你確定那個目錄也在允許清單內時才用。
- `--timeout` 預設 600 秒（10 分鐘），上限 3600。逾時會回 `status=timeout_waiting`，任務仍在跑，
  可以之後用 `status <job>` 再查。
- 回傳：`job`（工作 id）、`status`、`output`（它的最後回覆）、`changes`（每個檔案加幾行／刪幾行）、
  `files`（git 狀態）。完整 diff 用下面的 `diff`。
- `changes` 每一筆有 `preexisting`：`true` 代表**開工前工作區就已經有這個改動**，不是這次做的。
  回報給使用者時只講 `preexisting=false` 的那些，不要把工作區本來就髒的檔案算成這次的成果。

### 3. 查進度 / 拿完整 diff

```bash
python3 scripts/mhc_code.py status <job_id> [--text]
python3 scripts/mhc_code.py diff <job_id> [--text]
```

## 回答使用者時

1. 先講**結果**（做完了沒、它說了什麼），再講**改了什麼檔**（用 `changes` 的檔名與 +/- 行數）。
2. 改動範圍大或有風險時，把 `diff` 的關鍵片段貼出來讓使用者確認，不要只說「已完成」。
3. 失敗就照實說失敗原因（`error`），不要粉飾，也不要重派第三次以上——回報並問使用者。
4. 不要把 token、工作目錄以外的環境設定印給使用者。

## 常見錯誤

- exit 2 / `no token`：見設定段。
- HTTP 403 `forbidden`：token 是唯讀的，派不了工作 → 請 owner 發 `can_write` token。
- HTTP 400 `workspace_not_allowed`：工作目錄不在白名單 → 請使用者把它加進 `STUDIO_FILE_ROOTS` 後重啟 Studio。
- HTTP 400 `agent_not_installed`：那位員工的 CLI 沒裝（例：`npm i -g @anthropic-ai/claude-code`）。
- HTTP 400 `not_a_coding_agent`：你指到的是 Hermes 員工，不是 coding 員工 → 先跑 `agents` 看清單。
