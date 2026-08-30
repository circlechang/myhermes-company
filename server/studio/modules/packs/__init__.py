"""packs 模組：行業套件（一組 AI 員工＋工作流模板＋skills＋階段定義）的載入、安裝與「資料夾當資料庫」的階段推進。

套件放 repo 根 `packs/<name>/`（或 MHC_PACKS_DIR、<資料目錄>/packs）；hooks.py 只能 import `studio.sdk`。
REST 在 api.py（前綴 /packs），主題資料夾邏輯在 stages.py，安裝邏輯在 install.py，格式驗證在 loader.py。
"""
from __future__ import annotations

import logging

from ... import sdk
from .api import router  # noqa: F401
from .models import InstalledPack  # noqa: F401 (register table)

log = logging.getLogger("studio.packs")


async def on_startup(app) -> None:
    sdk.bind(app)
    from pathlib import Path

    from .loader import discover, pack_roots
    packs, errors = discover(pack_roots(Path(app.state.settings.db_path).parent))
    for name, err in errors.items():
        log.warning("pack %s 載入失敗：%s", name, err)
    log.info("packs available: %s", ", ".join(packs) or "(none)")
