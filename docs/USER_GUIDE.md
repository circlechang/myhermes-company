# MyHermesCompany 上手指南（給已經裝好 Hermes Agent 的人）

前提：本機有 Hermes Agent（`hermes` CLI 可用、`~/.hermes` 存在、至少一個 profile）；沒裝的話設定精靈第 1 步會給安裝指令。
本文只講「怎麼用」，端點細節看 `API.md`，部署變體看 `DEPLOY.md`，功能能不能用看 `PARITY.md`。

## 1. 裝 Studio
```bash
pip install myhermescompany-*.whl      # 或在 repo：scripts/build-all.sh 先產 wheel
myhermescompany start --daemon                        # http://127.0.0.1:8700
myhermescompany status                                # running 才算起來；log 在 ~/.myhermescompany/logs/studio.log
```
要給同事用（綁 `0.0.0.0`）必須先 `export STUDIO_SECRET=$(openssl rand -hex 32)` 並 `myhermescompany reset-admin --password '<強密碼>'`，否則拒絕啟動。
語音後備 TTS 要另外 `pip install 'myhermescompany[tts]'`（edge-tts 是 GPL-3.0，所以不預裝）。

## 2. 用設定精靈把 Hermes 的門打開
用瀏覽器開 `http://127.0.0.1:8700`，帳號 `admin`／密碼 `admin`。第一次登入會自動進「首次設定精靈」（之後在「設定」頁有「重新執行設定精靈」），五步：
1. **檢查 Hermes**：顯示偵測到的 `hermes` 指令、版本、`~/.hermes`、profile 數、gateway 有沒有在跑。沒裝會給安裝指令與官方文件連結；裝好按「重新偵測」。
2. **開啟 API 門**：Studio 不 import Hermes，全部透過 gateway 的 HTTP API（:8642）。按「一鍵開門」會：產生一把隨機 key → 備份 `~/.hermes/.env` 為 `.env.bak-<時間>` → 只加一行 `API_SERVER_KEY=…`（其他行不動）→ `hermes gateway restart`（沒在跑就 start）→ 等 `/v1/health` 回應（最多 90 秒）。key 已經設好、門已經開著的話，這一步直接顯示「已開啟」。失敗會顯示 gateway 輸出尾巴與手動指令。
3. **AI 員工**：列出所有 profile，勾選要給同事用的（同「AI 員工」頁的啟用開關）。
4. **管理員密碼**：把 `admin/admin` 改掉（可跳過，但會警告）。
5. **完成**：進工作臺並跑一次首次導覽。

不想用精靈、要自己手動做，等價的是：
```bash
# ~/.hermes/.env 加一行（key 至少 16 字元，不要貼到對話或 repo）
API_SERVER_KEY=<自己產一串>
hermes gateway restart
curl -s -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/v1/health
```
回 JSON 就通了。`myhermescompany` 啟動時會讀 `~/.hermes/.env` 的 `API_SERVER_KEY`，不用再設一次。多個 profile 各自有 `/p/<profile>/...` 前綴，Studio 會自己帶。
Hermes 跑在另一台機器時，再加 `API_SERVER_HOST=0.0.0.0`，Studio 端用 `HERMES_API_URL`＋`HERMES_API_KEY` 指過去（這種情況精靈第 2 步與看板／profile 等 CLI 功能會降級）。
非 owner 登入時若精靈還沒完成，頁面頂端會提示「請管理員完成設定」。

## 3. 登入與成員
首次啟動自動建「預設公司」與 owner `admin/admin`。登入後第一件事：右上「成員」把 admin 密碼改掉，再建其他人的帳號。
角色三種：owner（全部）、admin（管理設定、可被指派看哪些 profile）、member（只能用被指派的 AI 員工）。
「Profile」頁的「帳號綁定」決定每個人看得到哪些 profile；沒指派的 admin 預設看全部，member 預設什麼都看不到。
登入是帳號密碼＋JWT；目前沒有登入失敗鎖定，對外開放請前面放 Caddy/Nginx 並限制來源。

## 4. 把 profile 變成 AI 員工
Studio 啟動時會掃 `hermes profile list`，每個 profile 在「AI 員工」頁各有一筆，只有 `default` 預設啟用。
- 啟用：AI 員工頁把要用的 profile 打開，填名稱／職稱／描述（這是給同事看的，不影響 Hermes）。
- 人設：點「SOUL」直接編輯 `~/.hermes/profiles/<p>/SOUL.md`，存檔即生效（下次 run）。
- 模型：「模型」頁可改該 profile 的預設模型（寫 `config.yaml model.*`）；聊天時也能每個 session 臨時切。
- 技能：「Skills」頁可看該 profile 有哪些 skill、開關、寫筆記；「記憶」看 MEMORY.md／USER.md。
- 新員工：「Profile」頁建立（可從既有 profile 複製），會自動出現在 AI 員工列表。
一個 profile 就是一個員工；同一個 profile 給多間公司用，記憶是共用的（Hermes 端只有一份）。

## 5. 第一個工作流：熱點 → 選題 → 閘門 → 文案
「工作流」頁「新建」，在畫布上放四個節點並連線：
1. **熱點**（AI 員工節點，例：evidence-radar）：prompt「找出本週 3 個與循環包裝相關的熱點，每個附一句證據」。
2. **選題**（例：research-strategist）：prompt「從上游熱點挑一個最值得寫的題目，給標題與三個論點」。它會自動收到 `[上游結果]`。
3. **審批閘門**：run 到這裡會暫停，出現在「審批」頁。
4. **文案**（例：content-copywriter）：prompt「依審批通過的選題寫 600 字貼文」。
存檔後按「執行」。約 15 秒後狀態變 `waiting_approval`，到「審批」頁看選題輸出，按「核准」（可附意見，文案節點會收到 `[審批意見]`）或「退回」（選題節點帶著你的意見重跑一次）。
完成後點任一節點可看它那一輪的完整對話；「快照」頁的滑桿能逐步回放哪條邊走過。
預算：一輪 Hermes 通常 25k–110k tokens，`budget.max_tokens` 請以十萬計，設 20,000 會在第二節點就 `budget_exceeded`。
要定時跑：工作流的「排程」加 cron（5 欄，伺服器本地時間）；要讓外部系統觸發：「webhook」產生一個 `POST /webhooks/wf/<token>` 網址，body 的 `text` 會當第一個節點的 `[外部輸入]`。

## 6. 接 LINE OA
Hermes 內建 LINE plugin，Studio 只負責幫你把設定寫進 `~/.hermes/.env` 並重啟 gateway。
1. LINE Developers 建 Messaging API channel，拿到 Channel access token 與 Channel secret。
2. 「頻道」頁選 LINE，填 token／secret／`LINE_PUBLIC_URL`（你對外的 https 網址，例如 Cloudflare Tunnel 或 ngrok）、可選 allowlist 與 home channel，存檔後按「重啟 gateway」。
3. 頁面會顯示 webhook URL（`<LINE_PUBLIC_URL>/line/webhook`），貼回 LINE Developers 的 Webhook URL 並開啟 Use webhook。
4. 用手機加 OA 好友傳一句話，工作臺側欄「LINE」分組會出現這個 session（匯入 Hermes 歷史後可看）。
工作流要推到 LINE：加「投遞」節點選 `line`，填 `to`（userId 或 groupId）。本機沒設 token 時節點會明確失敗，不會靜默。
LINE 訊息路由到特定 AI 員工（關鍵字→profile）目前未做，先用 Hermes 自己的 profile 綁定。

## 7. 看板
「看板」頁與 `hermes kanban` 是同一份 `kanban.db`，你在 CLI 建的卡這裡都看得到，反之亦然。
- 建卡：標題、內容、指派（profile）、優先權（低/中/高/緊急）、標籤（標籤是 Studio 自己存的，不進 kanban.db）。
- 拖拉換欄：ready→review 等直接拖；「執行中」欄不能拖進去，那由 Hermes dispatcher 決定。
- 派給 AI 員工：卡片上「派工」＝assign → promote → `hermes kanban dispatch`，dispatcher 依優先權撿卡跑。先用 dry-run 看會派給誰。
- 留言帶你的登入帳號；附件會轉成 `kanban attach`。
板頂的黃色橫幅是 `hermes kanban diagnostics`（例如卡在 blocked 太久）。畫面每 8 秒刷新一次。

## 8. 群聊
「群聊」建房間，把兩個以上 AI 員工拉進來，也可以邀請同事（邀請碼 8 碼）。
- `@名字` 指定誰回；可以一次 @ 多位，各自展開。
- 沒 @ 時依房間設定：不回／輪流／固定主持人回。AI 自己的話沒 @ 不會觸發別人，避免自言自語。
- AI 互相 @ 有深度上限（預設 3），到頂就停。
- 每個 AI 成員可各自設顯示名、profile、模型、角色提示（例如「你是挑毛病的審稿人」）。
- 訊息多到門檻，房間會叫一位 AI 寫摘要，之後只帶「摘要＋新訊息」，省 token；也可手動按「壓縮」。
每則 AI 訊息有「朗讀」，輸入框有麥克風（Chrome/Safari 直接用瀏覽器語音，沒有就退回後端 whisper）。

## 9. 成本護欄
花錢的地方只有一個：每次 run 送進 Hermes 的 tokens。護欄分四層：
1. **看**：「用量」頁讀 Hermes 的 state.db，30 日總 token、成本、快取命中率、每個模型／來源／profile 各花多少。訂閱制模型（codex）Hermes 回 0，Studio 用價格表算「若走 API 等值」；不想看到就把該模型價格設 0。
2. **限**：工作流每個 run 可設 `max_tokens`／`max_cost_usd`／`deadline_seconds`，超過即停、其餘節點 skipped。群聊用摘要壓縮控制上下文長度。
3. **擋**：工作流內 Hermes 的工具授權預設 deny（無人值守不放行危險指令）；閘門讓人先看再花下一段錢；Coding Agent 有 `max_turns`／`max_budget_usd`（proxy 模式下不帶，因為 Claude Code 會用 Anthropic 牌價誤判）。
4. **分**：帳號只看被指派的 profile；用量頁可只算本公司 Studio 產生的 session。
每個公司／員工的每日 token 上限還沒做（TASKS M1），目前靠工作流預算與人工看用量頁。
