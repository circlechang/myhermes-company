"""In-process cron scheduler for workflow_schedules; state lives in the DB so it survives restarts.
Missed fires while the server was down are NOT back-filled (next_run_at is recomputed from now)."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Session, select

from ...models import Workflow, WorkflowSchedule, now
from .cron import CronError, next_run

log = logging.getLogger("studio.workflows.scheduler")


def compute_next(cron: str, after_utc: Optional[datetime] = None) -> datetime:
    base_utc = (after_utc or now()).replace(tzinfo=timezone.utc)
    local = base_utc.astimezone()
    nxt_local = next_run(cron, local.replace(tzinfo=None)).replace(tzinfo=local.tzinfo)
    return nxt_local.astimezone(timezone.utc).replace(tzinfo=None)


class WorkflowScheduler:
    def __init__(self, db_engine, wf_engine, *, interval: float = 20.0):
        self.db_engine = db_engine
        self.wf_engine = wf_engine
        self.interval = interval
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    async def _loop(self) -> None:
        self.refresh_next_times()
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("scheduler tick failed")
            await asyncio.sleep(self.interval)

    def refresh_next_times(self) -> None:
        with Session(self.db_engine) as db:
            for s in db.exec(select(WorkflowSchedule).where(WorkflowSchedule.enabled == True)).all():  # noqa: E712
                if s.next_run_at is None or s.next_run_at < now():
                    try:
                        s.next_run_at = compute_next(s.cron)
                    except CronError:
                        s.enabled = False
                    db.add(s)
            db.commit()

    async def tick(self, at: Optional[datetime] = None) -> int:
        t = at or now()
        fired = 0
        with Session(self.db_engine) as db:
            due = db.exec(select(WorkflowSchedule).where(WorkflowSchedule.enabled == True, WorkflowSchedule.next_run_at <= t)).all()  # noqa: E712
            items = []
            for s in due:
                wf = db.get(Workflow, s.workflow_id)
                if wf is None:
                    db.delete(s)
                    continue
                db.expunge(wf)
                items.append((s.id, wf, s.input_json))
                try:
                    s.next_run_at = compute_next(s.cron, t)
                except CronError:
                    s.enabled = False
                s.last_run_at = t
                db.add(s)
            db.commit()
        import json
        for sid, wf, input_json in items:
            try:
                run = await self.wf_engine.start(wf, member_id="scheduler", trigger="schedule", input=json.loads(input_json or "{}"))
                with Session(self.db_engine) as db:
                    s = db.get(WorkflowSchedule, sid)
                    if s:
                        s.last_run_id = run.id
                        db.add(s)
                        db.commit()
                fired += 1
            except Exception:
                log.exception("scheduled run failed to start for %s", wf.id)
        return fired
