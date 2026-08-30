# 行業套件（Packs）：怎麼寫一個套件

> 一個套件＝一組 AI 員工（SOUL.md）＋工作流模板＋接該行業系統的 skills＋「階段」定義。
> 安裝到一家公司後，套件的工作在**工作區的資料夾**裡推進（資料夾當資料庫，借 dsh-oil-creator 的做法）。
> 第一個套件是 `packs/marketing/`（行銷套件），拿它當範本改最快；`packs/content-pipeline/`（內容生產線）示範三欄、條件分支、可關閉階段與退回到指定節點（§9），行銷人員 SOP 在 `docs/packs/content-pipeline.md`。

## 1. 目錄長什麼樣

```
packs/<name>/
  pack.yaml            必填：名稱、版本、requires、提供的 profiles / agents / workflows / skills / stages / hooks
  stages.yaml          階段定義＋新主題時要建立的檔案
  profiles/<p>/SOUL.md 可選：AI 員工人格。安裝時複製到 ~/.hermes/profiles/<p>/（已存在就不動）
  profiles/<p>/config.yaml  可選：一起複製（只在 profile 不存在時）
  workflows/*.json     每階段一個工作流，格式＝ POST /workflows/import 的 data
  skills/<s>/SKILL.md  可選：Hermes skill，安裝時只複製到「本次新建」的 profile 的 skills/<s>/；使用者既有的 profile 完全不動
  hooks.py             可選：只能 import studio.sdk（載入時 AST 檢查，違反就整個套件不載入）
```

搜尋路徑（先找到的同名優先）：`MHC_PACKS_DIR`（可用 `:` 串多個）→ `<資料目錄>/packs`（預設 `~/.myhermescompany/packs`）→ repo 根 `packs/`。

## 2. pack.yaml

```yaml
name: marketing            # 必須等於目錄名；小寫英數、- 、_
version: 0.1.0
title: 行銷套件
description: 一句話說這套件做什麼
requires:                  # 目前只記錄、不強制；未來用來擋版本
  studio: ">=0.1"
  modules: [workflows, inbox, events]
workspace_dir: marketing   # 主題資料夾放在 <工作區>/<workspace_dir>/；省略＝name
profiles: [evidence-radar, research-strategist]   # 這套件會用到的 Hermes profile
agents:                    # 顯示名／職稱（沒列在 profiles 的會自動補進去）
  - profile: evidence-radar
    name: 證據雷達
    title: 研究與證據雷達
    description: 一句話
workflows: [topics.json, brief.json]   # workflows/ 下的檔名，階段只能引用這裡列的
skills: [marketing-folder-ops]         # skills/ 下的目錄名
stages: stages.yaml
hooks: hooks.py
```

**未知欄位一律載入失敗**（不會靜默忽略），錯誤會列在 `GET /packs` 的 `errors` 與 `/packs` 頁面下方。

## 3. stages.yaml：階段與資料夾

```yaml
topic_files:               # 建新主題時先寫進資料夾的檔案；可用 {title} {topic_id} {topic_dir} {notes} {created_at}
  topic.md: |
    # {title}
    ## 備註
    {notes}

stages:                    # 順序＝推進順序：前一階段 done 才能跑下一階段
  - id: brief              # 小寫英數＋底線
    title: Brief
    description: 給人看的說明（階段卡上）
    agent: research-strategist     # 負責的 profile，要在 pack.yaml profiles 裡
    workflow: brief.json           # 要在 pack.yaml workflows 裡
    inputs: [topic.md]             # 只做展示與提示變數 {inputs}
    outputs: [brief.md]            # 相對資料夾的路徑；可以是目錄（assets/）。建主題時先 mkdir 父層
    gate: true                     # true：跑完進「待核准」，塞收件匣，人核准才 done；退回帶意見回 draft
    prompt: |                      # 渲染後當工作流的 [外部輸入]（input.text）餵給根節點
      主題：{title}
      主題資料夾（絕對路徑）：{topic_dir}
      讀 {topic_dir}/topic.md，寫 {topic_dir}/brief.md …
      寫完檔案後只回覆一行「已寫入 brief.md」。
```

提示可用變數：`{title} {topic_id} {topic_dir} {notes} {outputs} {inputs} {feedback} {stage} {stage_title}`。
被退回過的階段重跑時，提示尾巴自動加 `[退回意見]\n<意見>`。

一個主題＝ `<工作區>/<workspace_dir>/<YYYYMMDD>_<slug>/`，裡面：

```
topic.md  brief.md  copy/{fb,ig,line}.md  assets/  publish.md  analytics.md   ← 你在 stages.yaml 定義的
status.json                                                                   ← 系統維護，不要手改
```

`status.json` 的每個階段：`{status, run_id, session_id, updated_at, feedback, error, missing_outputs, inbox_item_id, history[]}`。

狀態機（`server/studio/modules/packs/stages.py` 的 `TRANSITIONS`）：

```
draft ──run──▶ running ──完成──▶ review（gate）──approve──▶ done
                 │                   └──reject（帶意見）──▶ draft
                 └──失敗／停止──▶ failed
非 gate：running ──完成──▶ done。done / failed 都可以再 run。
```

「完成」看的是工作流 run 的狀態，不看 LLM 輸出；產出檔沒寫出來只會記在 `missing_outputs`（階段卡顯示「缺少」），不會擋，讓人自己決定退回或手動補。

## 4. workflows/*.json：階段工作流

就是 `GET /workflows/{id}/export` 的格式。最小可用的單節點：

```json
{
  "format": "myhermescompany.workflow", "format_version": 1,
  "workflow": {
    "name": "Brief",
    "nodes": [{ "id": "brief", "title": "Brief", "kind": "hermes", "agent": "research-strategist",
                "prompt": "依上方「外部輸入」的指示執行：用檔案工具讀主題資料夾、把產出寫成指定路徑的檔案。",
                "tool_approval": "allow" }],
    "edges": [], "budget": { "deadline_seconds": 1800 }
  }
}
```

- 節點用 `agent: <profile>` 指員工；安裝時會換成該公司 agents 表的 `agent_id`。
- 階段的具體任務（含資料夾絕對路徑）由 `stages.yaml` 的 `prompt` 在執行時以 `[外部輸入]` 帶入，所以工作流可以很通用；要多節點（研究→寫→自檢）也行，只要根節點沒有上游就會拿到外部輸入。
- `tool_approval: allow` 讓 Hermes 的檔案工具不用逐次授權；產出一律寫在工作區資料夾內。
- 安裝時工作流名稱是 `[<pack>] <name>`，description 帶 `source=pack:<name> stage=<id>`；重裝時同名的更新 nodes/edges（version +1），不重複建。

## 5. hooks.py（可選）

```python
from studio import sdk          # 只能 import 這個；其他 studio.* 一律拒絕載入

def on_install(sdk_, ctx):      # ctx = {company_id, member_id, installed}
    sdk.record_event("pack.marketing.ready", "pack", "pack:marketing", {...}, company_id=ctx["company_id"])   # 存成 pack.marketing.ready

def on_topic_created(sdk_, topic):   # topic = {topic_id, title, dir}
    ...

def on_stage_finished(sdk_, info):   # info = {topic_id, stage, status}  status ∈ done / review / failed
    ...
```

`studio.sdk` 的四個穩定函式（核心改版只保證這四個簽名）：

| 函式 | 做什麼 |
|---|---|
| `record_event(kind, source, subject, payload=None, **kw)` | 寫事件；`pack.*` 是白名單前綴族原樣存（套件事件查 `GET /events?kind=pack.*`），其他不在白名單的 kind 自動加 `custom.` 前綴 |
| `add_inbox_item(company_id, kind, title, detail="", *, ref="", link="", agent="")` | 塞收件匣（同 company+kind+ref 未完成不重複） |
| `async run_workflow(workflow_id, *, company_id, member_id="pack", input=None, trigger="pack")` | 用既有引擎跑工作流，回 `{run_id, status}` |
| `list_agents(company_id)` | `[{id, name, profile, title, enabled}]` |

hook 丟例外只記 warning，不影響流程。

## 6. 安裝時發生什麼（冪等）

1. profiles：`~/.hermes/profiles/<p>/` 不存在且套件帶 SOUL.md → 建目錄＋複製；存在就**完全不動**。
2. skills：只複製到第 1 步**本次新建**的 profile 的 `skills/<s>/`；既有 profile 不動（round3 決定：套件不該往使用者的 profile 塞檔案；要給既有員工用就手動複製或 `myhermescompany install-skill`）。
3. agents：每個 profile 在該公司 agents 表找同名列，有就綁定（並啟用），沒有就用 pack.yaml 的 name/title 建。
4. workflows：每階段匯入一個；同名更新。
5. `installed_packs` 記一列（`agents_json`＝profile→agent id，`workflows_json`＝stage→workflow id）。

移除：刪套件建立的工作流（含 runs／排程／webhook）與 `installed_packs` 列；**agents、profile、主題資料夾都保留**。

## 7. 執行時發生什麼

`POST /packs/<pack>/topics/<topic>/stages/<stage>/run`：
1. 檢查前面階段都 done（`force: true` 可跳過）、本階段不在 running。
2. 渲染 `prompt` → `sdk.run_workflow(workflow_id, input={text, pack, topic_id, topic_dir, stage, outputs})`。
3. `status.json` 標 running、記 run_id；記事件 `pack.stage.run`。
4. 背景 watcher 每 0.5 秒看 run 狀態；結束 → 依 gate 推進、記 `pack.stage.finished`、gate 階段塞收件匣（kind `pack_stage_review`，link 回階段視圖）。
5. 保險：任何 `GET .../topics/<topic>` 讀取都會補結算 running 但 run 已結束的階段（伺服器重啟後 watcher 消失也不會卡住）。

AI 員工怎麼拿到資料：提示裡是**絕對路徑**，員工用 Hermes 的 `read_file` / `write_file` 直接讀寫；Studio 不解析 LLM 輸出。
每個階段一個 Studio session（`source=workflow`），右欄「看對話」就是它。

## 8. 寫新套件的檢查清單

1. 複製 `packs/marketing/` 改名；`pack.yaml` 的 `name` 要等於目錄名。
2. 每個階段：`outputs` 寫清楚、`prompt` 裡用 `{topic_dir}` 給絕對路徑、結尾要求「只回覆一行已寫入」。
3. `python -c "from studio.modules.packs.loader import load_pack; load_pack('packs/<name>')"` 沒丟 `PackError`。
4. 起一個暫存 `MHC_HOME` 的 Studio（別的 port），`POST /packs/<name>/install` → 建主題 → 跑第一階段，去資料夾看檔案有沒有真的出現。
5. 要接外部系統（ERP／商店）就放 `skills/`，並在 SOUL.md 寫清楚「不做交易，只讀寫外部系統」。

## 9. 階段的進階欄位：三欄、條件分支、可關閉、退回到指定節點

`stages.yaml` 每個階段除了 §3 的欄位，還可以加（範例見 `packs/content-pipeline/stages.yaml`）：

```yaml
    criteria: 總分 ≥18 進閘門；<18 封存      # 判斷條件（給人看，階段卡顯示）
    role: 研究策略 → 人核准                 # 負責角色（給人看；agent 仍是機器用的 profile）
    deliverables: ["topic-scorecard.md：五項分數與總分"]   # 交付物說明（給人看；outputs 仍是機器用的路徑）
    optional: true            # 可關閉的階段：主題層級 POST .../stages/<id>/enabled {enabled:false} → 狀態 skipped，視同 done 放行下一階段
    default_enabled: true     # optional 階段建主題時預設開／關
    branch:                   # 條件分支：跑完讀產出檔抓分數，未達門檻 → 狀態 archived（不進閘門、不塞收件匣）
      file: topic-scorecard.md
      pattern: "總分[：:]\\s*(\\d+)"     # 第 1 個群組是分數
      min: 18
      on_fail: archived                  # 目前只支援 archived
      reason_pattern: "封存理由[：:]\\s*(.+)"   # 可選：抓理由寫進 status.json 的 archived_reason（主題層級也記一份）
    hint:                     # 審核提示：gate 階段跑完從產出抓「建議退回到 X」，顯示在階段卡與收件匣 detail
      file: review.md
      pattern: "建議退回到[：:]\\s*([a-z_]+)"
```

狀態機新增：`archived`（分支未過；可再 run）、`skipped`（關閉；`unskip` 回 draft）。
`_can_run` 把 `done` 與 `skipped` 都當放行。分數與評估結果記在階段的 `branch_result`，主題層級有 `archived` / `archived_reason`。

**退回到指定節點**：`POST .../stages/<id>/reject {comment, to: "<stage>"}`（`to` 必須在本階段之前或等於本階段，且不能是 skipped 的階段）。
效果：本階段 reject；`to` 到最後所有 done/review/failed/archived 的階段 `rollback` 成 draft；退回意見掛在 `to`（重跑時提示尾巴帶 `[退回意見]`），其他被重置的階段只在 history 記一筆。
沒帶 `to` 就是原本的行為（只退本階段）。

提示新增變數：`{workspace_dir}`（`<工作區>/<workspace_dir>` 的絕對路徑，放跨主題檔案如 `_learnings.md`）、`{skipped_stages}`（本主題關閉的階段 id）。

## 10. 已知限制

- `requires` 只記錄不檢查。
- 沒有前端 `ui/`：階段視圖是通用的，靠 `stages.yaml` 驅動；套件不能加自己的頁面。
- 階段是線性的（前一個 done／skipped 才能跑下一個）；分支只有「分數門檻 → 封存」一種，平行或更複雜的分支要包進單一階段的工作流裡做。
- 主題資料夾不跨公司隔離（同一台機器的工作區）；多租戶請用不同 `MHC_HOME`。
