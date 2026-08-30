# 安裝到另一台機器

> 這份文件同時寫給人和 AI 助理看。AI 請逐步執行，每步都跑「驗證」那行，失敗就停下來回報，不要跳過。

## 前提
- macOS 或 Linux，Python 3.12+
- 那台機器**已安裝 Hermes Agent** 並已設定好模型供應商（`hermes --version` 有輸出）
- 私有 repo：先 `gh auth login`（或設好 SSH key）

## 方式 A：裝 release（推薦，不需要 Node，也不需要 gh）

```bash
cd ~/Downloads
curl -sLO https://github.com/circlechang/myhermes-company/releases/download/v0.1.0/myhermescompany-0.1.0-py3-none-any.whl
python3.12 -m venv ~/.myhermescompany-venv
~/.myhermescompany-venv/bin/pip install myhermescompany-0.1.0-py3-none-any.whl
~/.myhermescompany-venv/bin/myhermescompany start --daemon --port 8700
```
驗證：`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8700/` 應為 **200**（不是 404 也不是 503）。

> **不要改 wheel 的檔名**（例如 `curl -o mhc.whl`），pip 會回 `Invalid wheel filename` 拒絕安裝。用 `curl -sLO` 保留原檔名。

加進 PATH 比較好用：`echo 'export PATH="$HOME/.myhermescompany-venv/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`

## 方式 B：從原始碼（要改程式時用，需要 Node 22+）

```bash
gh repo clone circlechang/myhermes-company ~/MyHermesCompany
cd ~/MyHermesCompany/web && npm ci && npm run build      # 這步不可略，否則瀏覽器會看到 503
cd ../server && python3.12 -m venv .venv && .venv/bin/pip install -e .
.venv/bin/myhermescompany start --daemon --port 8700
```
驗證：同上，`/` 要回 200。
> 常見錯誤：跳過 `npm run build` 就啟動 → API 正常但瀏覽器回 **503 `web_not_built`**。前端產物 `server/studio/web_dist/` 不在 git 裡。
> 另一個常見錯誤：`start` 不加 `--daemon` 會佔住終端機（前景執行）。

## 第一次開站
瀏覽器開 `http://localhost:8700`，**設定精靈**會自動出現，依序：
1. 檢查 Hermes（顯示版本）
2. 一鍵開啟 API 門（自動寫 `~/.hermes/.env` 的 `API_SERVER_KEY` 並重啟 gateway，會先備份 `.env`）
3. 勾選要變成 AI 員工的 profile
4. 改掉預設密碼 `admin/admin`
5. 完成 → 進工作臺並播放導覽

## 把 AI 員工一起搬過去
Studio 不存 AI 員工本體，它們是 Hermes profile，住在 `~/.hermes/profiles/`。

```bash
# 舊機器
hermes profile export <名稱> -o ~/<名稱>.tar.gz
# 新機器
hermes profile import ~/<名稱>.tar.gz
```
或整包 `rsync -a ~/.hermes/profiles/ 新機器:~/.hermes/profiles/`。搬完在 Studio 的「AI 員工」頁把它們設為啟用。

## 行業套件
套件在 repo 的 `packs/`，方式 A 的 wheel 也含在內。到「行業套件」頁按安裝即可；主題資料夾會建在 `~/.myhermescompany/workspace/`。

## 更新到新版

```bash
myhermescompany update
```

它會查這個 repo 的最新 release，比對你手上的版本：已是最新就直接說「已是最新版 vX.Y.Z」；
有新版就印出版號與 release notes 摘要問你要不要裝，答 y 之後下載 wheel、
用「正在跑的那個 python」`pip install --upgrade`，然後沿用原本的 port 重啟服務。

```bash
myhermescompany update --check         # 只檢查不安裝（適合排程）
myhermescompany update --check --json  # 機器可讀
myhermescompany update --yes           # 不問直接裝
```

- 安裝失敗不會弄壞現有安裝：pip 的 upgrade 是先備好新版才換掉舊版，失敗時原版原封不動。
- 站內（管理 → 版本、右上角）也會提示有新版，但**不做站內一鍵更新**——更新要重啟伺服器，
  等於把正在服務的自己關掉，所以只告訴你指令。
- 不想讓它連 GitHub：`MHC_UPDATE_CHECK=0`。檢查結果快取 6 小時。

## 常用指令
```bash
myhermescompany status|stop|restart|logs --port 8700
myhermescompany update [--check] [--yes] [--json]   # 更新到最新 release
myhermescompany hermes-check          # Hermes 升版前先跑，確認相容
myhermescompany reset-admin           # 忘記密碼
myhermescompany clear-login-locks     # 連續打錯被鎖 15 分鐘時
```

## 疑難排解
| 現象 | 原因 | 處理 |
|---|---|---|
| 瀏覽器 404 | 舊版沒有這個防呆 | 照方式 A 重裝，或補跑 `npm run build` |
| 瀏覽器 503 `web_not_built` | 前端沒建 | `cd web && npm ci && npm run build` 後 `restart` |
| 對話沒反應、模型清單空 | Hermes 的 API 門沒開或 key 錯 | 重跑設定精靈第 2 步；或 `myhermescompany hermes-check` |
| 終端機卡住不還我 | `start` 沒加 `--daemon` | Ctrl-C 後加 `--daemon` |
