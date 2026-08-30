# MyHermesCompany — server

```bash
cd server
uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/python -m studio          # http://127.0.0.1:8700，首次啟動建 admin/admin
.venv/bin/python -m pytest          # 31 tests, 以 fake gateway/CLI 跑，不碰本機 Hermes
```

環境變數見 `../docs/API.md` 末段。資料庫預設 `~/.myhermescompany/studio.db`。

依賴 Hermes Agent（MIT, NousResearch）官方 Gateway API server；本專案不 import Hermes 內部模組，只透過 HTTP 與 `hermes` CLI 操作。
