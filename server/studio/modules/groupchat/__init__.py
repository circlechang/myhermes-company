"""J. 群聊模組：多 AI 員工房間、@mention 路由、上下文壓縮、WS 即時。"""
from fastapi import APIRouter

from . import models  # noqa: F401  (register tables)
from .api import on_shutdown, on_startup, router as _rest, ws_router as _ws

router = APIRouter()
router.include_router(_rest)
router.include_router(_ws)

__all__ = ["router", "on_startup", "on_shutdown"]
