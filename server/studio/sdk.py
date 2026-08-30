"""studio.sdk — 行業套件（packs）唯一可以 import 的核心入口。

套件的 hooks.py 只能 `import studio.sdk`（載入時用 AST 檢查），核心改版只要保住這四個函式簽名：

- record_event(kind, source, subject, payload=None, **kw) → Event | None
- add_inbox_item(company_id, kind, title, detail="", *, ref="", link="", agent="") → InboxItem | None
- async run_workflow(workflow_id, *, company_id, member_id="pack", input=None, trigger="pack") → {run_id, status}
- list_agents(company_id) → [{id, name, profile, title, enabled}]

`bind(app)` 由 packs 模組在 on_startup 呼叫；沒綁定時函式回 None / 丟 RuntimeError，不會炸核心。
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

log = logging.getLogger("studio.sdk")

_app = None


def bind(app) -> None:
    global _app
    _app = app


def _state():
    if _app is None:
        raise RuntimeError("studio.sdk 尚未綁定 app（packs 模組未啟動）")
    return _app.state


def record_event(kind: str, source: str, subject: str, payload: Optional[dict[str, Any]] = None, **kw):
    """寫一筆事件（SPEC §9）。`pack.*` 是白名單前綴族原樣存；其他不在白名單的 kind 自動加 `custom.` 前綴。
    events 模組不在或失敗回 None。"""
    try:
        from .modules.events import record
        try:
            from .modules.events.kinds import is_known
            if not is_known(kind):
                kind = f"custom.{kind}"
        except Exception:  # pragma: no cover
            pass
        return record(kind, source, subject, payload, **kw)
    except Exception as e:  # pragma: no cover - defensive
        log.debug("sdk.record_event skipped: %s", e)
        return None


def add_inbox_item(company_id: str, kind: str, title: str, detail: str = "", *, ref: str = "", link: str = "", agent: str = ""):
    """塞一筆需要人決定的待辦到收件匣（同 company+kind+ref 未完成的不重複）。"""
    try:
        from .modules.inbox import add_item
        return add_item(company_id, kind, title, detail, ref=ref, link=link, agent=agent)
    except Exception as e:  # pragma: no cover - defensive
        log.debug("sdk.add_inbox_item skipped: %s", e)
        return None


async def run_workflow(workflow_id: str, *, company_id: str, member_id: str = "pack", input: Optional[dict[str, Any]] = None,
                       trigger: str = "pack") -> dict[str, Any]:
    """用既有工作流引擎跑一個工作流；input.text 會以 [外部輸入] 餵給根節點。回 {run_id, status}。"""
    from sqlmodel import Session

    from .models import Workflow
    from .workflow_validate import WorkflowValidationError, validate_workflow

    st = _state()
    eng = getattr(st, "workflow_engine", None)
    if eng is None:
        raise RuntimeError("工作流執行器尚未啟動")
    with Session(st.engine) as db:
        wf = db.get(Workflow, workflow_id)
        if wf is None or wf.company_id != company_id:
            raise LookupError(f"workflow {workflow_id} 不存在")
        try:
            validate_workflow(json.loads(wf.nodes_json), json.loads(wf.edges_json))
        except WorkflowValidationError as e:
            raise ValueError("; ".join(e.errors))
        db.expunge(wf)
    run = await eng.start(wf, member_id=member_id, trigger=trigger, input=input or {})
    return {"run_id": run.id, "status": run.status}


def list_agents(company_id: str) -> list[dict[str, Any]]:
    from sqlmodel import Session, select

    from .models import Agent

    st = _state()
    with Session(st.engine) as db:
        rows = db.exec(select(Agent).where(Agent.company_id == company_id)).all()
        return [{"id": a.id, "name": a.name, "profile": a.profile, "title": a.title, "enabled": a.enabled} for a in rows]
