"""工作流模組：執行器、排程、webhook、審批、WS 即時狀態。REST 在 api.py，CRUD 仍在 studio/api/workflows.py。"""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import inspect, text

from ...models import Workflow, WorkflowApproval, WorkflowRun, WorkflowRunNode, WorkflowSchedule, WorkflowWebhook  # noqa: F401 (register tables)
from .api import router  # noqa: F401
from .engine import WorkflowEngine
from .hub import WorkflowHub
from .scheduler import WorkflowScheduler

log = logging.getLogger("studio.workflows")

# 既有 DB 的 workflows / workflow_runs 缺欄位時自動補（SQLite ADD COLUMN）
_MIGRATIONS = {
    "workflows": {"description": "TEXT DEFAULT ''", "profile": "TEXT DEFAULT ''", "version": "INTEGER DEFAULT 1", "budget_json": "TEXT DEFAULT '{}'"},
    "workflow_runs": {"workflow_name": "TEXT DEFAULT ''", "trigger": "TEXT DEFAULT 'manual'", "events_json": "TEXT DEFAULT '[]'",
                      "input_json": "TEXT DEFAULT '{}'", "usage_json": "TEXT DEFAULT '{}'", "error": "TEXT DEFAULT ''",
                      "created_by": "TEXT DEFAULT ''", "parent_run_id": "TEXT DEFAULT ''", "started_at": "DATETIME"},
}


def migrate(engine) -> None:
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, cols in _MIGRATIONS.items():
            if table not in insp.get_table_names():
                continue
            have = {c["name"] for c in insp.get_columns(table)}
            for col, ddl in cols.items():
                if col not in have:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
                    log.info("migrated %s.%s", table, col)


async def on_startup(app) -> None:
    migrate(app.state.engine)
    settings = app.state.settings
    hub = WorkflowHub()
    workspace = Path(settings.db_path).parent / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    wf_engine = WorkflowEngine(app.state.engine, app.state.gateway, hub, hermes_home=Path(settings.hermes_home), workspace=workspace)
    app.state.workflow_hub = hub
    app.state.workflow_engine = wf_engine
    # 重啟修復：等閘門的 run 從 workflow_approvals 恢復等待；執行中被中斷的節點標 outcome_unknown → needs_attention + 收件匣
    try:
        report = await wf_engine.recover()
        if report:
            log.info("workflow recovery: %s", report)
    except Exception as e:
        log.warning("workflow recovery failed: %s", e, exc_info=True)
    sched = WorkflowScheduler(app.state.engine, wf_engine)
    app.state.workflow_scheduler = sched
    if not getattr(settings, "_no_scheduler", False):
        sched.start()


async def on_shutdown(app) -> None:
    sched = getattr(app.state, "workflow_scheduler", None)
    if sched:
        await sched.stop()
    eng = getattr(app.state, "workflow_engine", None)
    if eng:
        # 不標 stopped、不取消審批：DB（workflow_runs / workflow_approvals）就是真相，下次啟動由 recover() 接手
        await eng.park()
