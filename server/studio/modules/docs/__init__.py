"""docs 模組：把「一份文件（.md）」變成第一級物件。

使用者的心智模型：一個對話串的核心就是完成一份文件；不停對話＝不停更新這份文件；
不同的工作流＝這份文件從 A 站傳到 B 站再到 C 站。所以這裡提供：

- `docs` / `doc_versions` / `doc_links` 三張表（內容真相在 DB，最新版同時寫回工作區的 `.md`）
- REST `/docs`（見 api.py 與 docs/API.md）
- 給 chat_ws 與工作流引擎共用的服務層 `service.py`（圍欄解析、版本、血緣、漂移）

工作區路徑與工作流引擎相同：`<STUDIO_DB 目錄>/workspace`。
"""
from __future__ import annotations

import logging
from pathlib import Path

from .api import router  # noqa: F401
from .models import Doc, DocLink, DocVersion  # noqa: F401 (register tables)
from . import service  # noqa: F401

log = logging.getLogger("studio.docs")


def workspace_for(settings) -> Path:
    return Path(settings.db_path).parent / "workspace"


async def on_startup(app) -> None:
    ws = workspace_for(app.state.settings)
    ws.mkdir(parents=True, exist_ok=True)
    (ws / "docs").mkdir(parents=True, exist_ok=True)
    app.state.docs_workspace = ws
    service.bind(app.state.engine, ws)
    log.info("docs workspace: %s", ws)
