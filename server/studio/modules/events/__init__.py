"""events 模組（SPEC §9 存事件不存交易）。

其他模組寫事件只要：
    from studio.modules.events import record
    record("line.inbound", "line", "user:U123", {"text": "..."}, member_id=None, agent="default")
不需要拿 engine；模組 on_startup 時把 engine 綁進來。engine 還沒綁（例如單元測試直接呼叫）時回 None 且不丟例外。

沒有 hook 可攔的既有資料（chat messages / workflow_runs / groupchat / kanban）由 collector 定期掃描補記（見 collector.py）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Optional

from sqlmodel import Session

from .models import Event, EventCursor  # noqa: F401 (register tables)
from .kinds import KNOWN_KINDS, KNOWN_PREFIXES, backfill_seq, is_known, next_seq, normalize_kind  # noqa: F401
from .api import router  # noqa: F401
from . import collector

log = logging.getLogger("studio.events")

_engine = None


def bind_engine(engine) -> None:
    global _engine
    _engine = engine


def record(kind: str, source: str, subject: str, payload: Optional[dict[str, Any]] = None, *,
           member_id: Optional[str] = None, agent: Optional[str] = None, company_id: str = "",
           decision: str = "", delivery: str = "", db: Optional[Session] = None,
           causes: Optional[list[str]] = None) -> Optional[Event]:
    """極簡事件記錄 helper。傳 db 就掛在呼叫端的交易裡（由呼叫端 commit）；不傳就自己開 session 立即 commit。

    kind 不在白名單（kinds.KNOWN_KINDS / KNOWN_PREFIXES）會改成 `other.<kind>` 並記 warning；
    `causes` 是上游事件 id（因果鏈）；seq 在寫入時配號（單調遞增）。"""
    ev = Event(kind=normalize_kind(kind), source=source, subject=subject or "", agent=agent or "", member_id=member_id or "",
               company_id=company_id or "", decision=decision or "", delivery=delivery or "",
               payload_json=json.dumps(payload or {}, ensure_ascii=False, default=str),
               causes_json=json.dumps([c for c in (causes or []) if c]))
    if db is not None:
        ev.seq = next_seq(db)
        db.add(ev)
        db.flush()
        return ev
    if _engine is None:
        log.debug("events.record before engine bound: %s %s", kind, subject)
        return None
    try:
        with Session(_engine) as s:
            ev.seq = next_seq(s)
            s.add(ev)
            s.commit()
            s.refresh(ev)
        return ev
    except Exception as e:  # 記事件永遠不該讓主流程炸掉
        log.warning("events.record failed: %s", e)
        return None


async def _collector_loop(app, interval: float) -> None:
    while True:
        try:
            await asyncio.sleep(interval)
            n = await collector.collect(app)
            if n:
                log.info("events collector +%d", n)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("events collector failed: %s", e)


async def on_startup(app) -> None:
    bind_engine(app.state.engine)
    try:
        backfill_seq(app.state.engine)
    except Exception as e:
        log.warning("events seq backfill failed: %s", e)
    interval = float(os.environ.get("STUDIO_EVENTS_SCAN_SECONDS", "60"))
    if interval > 0 and not getattr(app.state.settings, "_no_scheduler", False):
        app.state.events_collector_task = asyncio.create_task(_collector_loop(app, interval))


async def on_shutdown(app) -> None:
    task = getattr(app.state, "events_collector_task", None)
    if task:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
