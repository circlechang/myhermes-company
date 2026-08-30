"""K. Coding Agents：Claude Code / Codex / Pi 的偵測、安裝、設定、啟動、串流、diff。

REST 前綴 /coding，WebSocket /ws/coding，相容 proxy /coding/proxy/*。"""
from __future__ import annotations

from fastapi import APIRouter

from . import models as _models  # noqa: F401  (註冊資料表)
from .proxy import router as _proxy_router
from .router import router as _rest_router, shutdown, ws_router as _ws_router

router = APIRouter()
router.include_router(_rest_router)
router.include_router(_proxy_router)
router.include_router(_ws_router)


async def on_shutdown(app) -> None:
    await shutdown()


__all__ = ["router", "on_shutdown"]
