"""search 模組：SQLite FTS5 全站搜尋（chat / group / workflow / events）＋唯讀機器 token＋Hermes skill 安裝。

其他模組不需要呼叫這裡；索引靠來源表的 trigger 進 `search_dirty`，本模組自己吃掉。
"""
from __future__ import annotations

import asyncio
import logging
import os

from .tokens import SearchToken  # noqa: F401 (register table)
from .api import router  # noqa: F401
from . import fts

log = logging.getLogger("studio.search")


async def _drain_loop(app, interval: float) -> None:
    while True:
        try:
            await asyncio.sleep(interval)
            n = await asyncio.to_thread(fts.drain, app.state.engine)
            if n:
                log.debug("search drained %d", n)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("search drain failed: %s", e)


async def on_startup(app) -> None:
    engine = app.state.engine
    fts.ensure_schema(engine)
    if fts.index_empty(engine):
        n = fts.reindex_all(engine)
        log.info("search index built: %d docs", n)
    else:
        fts.drain(engine)
    interval = float(os.environ.get("STUDIO_SEARCH_SYNC_SECONDS", "15"))
    if interval > 0 and not getattr(app.state.settings, "_no_scheduler", False):
        app.state.search_drain_task = asyncio.create_task(_drain_loop(app, interval))


async def on_shutdown(app) -> None:
    task = getattr(app.state, "search_drain_task", None)
    if task:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
