"""模組自動註冊：每個子套件 studio/modules/<name>/ 可提供
- router: fastapi.APIRouter（自動 include）
- models 定義（import 即註冊到 SQLModel metadata）
- async def on_startup(app) / on_shutdown(app)（可選）
多人並行開發時只碰自己的模組目錄。"""
from __future__ import annotations
import importlib, pkgutil, logging
log = logging.getLogger("studio.modules")

def discover():
    mods = []
    for m in pkgutil.iter_modules(__path__):
        if m.ispkg or not m.name.startswith("_"):
            try:
                mods.append(importlib.import_module(f"{__name__}.{m.name}"))
            except Exception as e:
                log.exception("module %s failed to import: %s", m.name, e)
    return mods
