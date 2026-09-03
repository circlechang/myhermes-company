"""AI 員工人事檔案：`GET /agents/{id}/dossier?days=7`。

老闆派工前想知道的四件事：這個人最近做了什麼、做了多少、花了多少錢、被退回幾次。
全部從既有表算（sessions / messages / workflow_run_nodes / workflow_approvals / pending_approvals / doc_versions），
不加欄位、唯讀。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session, select

from ..auth import Principal, current_principal, get_db
from ..models import ChatSession, Message, WorkflowApproval, WorkflowRun, WorkflowRunNode, now
from .agents import _get_agent

log = logging.getLogger("studio.agent_dossier")
router = APIRouter(tags=["agents"])

CHAT_APPROVED = {"once", "session", "always"}
NODE_FAILED = {"failed", "timeout", "outcome_unknown"}


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _usage_sum(db: Session, company_id: str, session_ids: list[str], since: datetime, models: dict[str, str]) -> dict[str, Any]:
    """assistant 訊息帶的 run usage 加總；美元估法沿用 limits 模組（先信 usage 自帶的 cost，沒有才查價格表）。"""
    out = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0}
    if not session_ids:
        return out
    from ..modules.limits import _usage_cost
    try:
        from ..modules.usage import load_prices
        prices = load_prices(db, company_id)
    except Exception:
        prices = None
    rows = db.exec(select(Message).where(Message.session_id.in_(session_ids), Message.role == "assistant",  # type: ignore[attr-defined]
                                         Message.usage.isnot(None), Message.created_at >= since)).all()  # type: ignore[attr-defined]
    for m in rows:
        try:
            u = json.loads(m.usage or "{}")
        except ValueError:
            continue
        if not isinstance(u, dict):
            continue
        i = int(u.get("input_tokens") or u.get("prompt_tokens") or 0)
        o = int(u.get("output_tokens") or u.get("completion_tokens") or 0)
        out["input_tokens"] += i
        out["output_tokens"] += o
        out["total_tokens"] += int(u.get("total_tokens") or (i + o))
        out["cost_usd"] += _usage_cost(u, models.get(m.session_id, ""), prices)
    out["cost_usd"] = round(out["cost_usd"], 6)
    return out


@router.get("/agents/{agent_id}/dossier")
def agent_dossier(agent_id: str, days: int = Query(7, ge=1, le=90),
                  p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    a = _get_agent(db, p, agent_id)
    since = now() - timedelta(days=days)
    recent: list[dict[str, Any]] = []

    # --- 對話：這位員工的 session（不含工作流自動開的）---
    sessions = db.exec(select(ChatSession).where(ChatSession.company_id == p.company_id, ChatSession.agent_id == a.id)).all()
    models = {s.id: (s.model or a.model or "") for s in sessions}
    chat_sessions = [s for s in sessions if s.source != "workflow" and s.last_message_at and s.last_message_at >= since]
    chat_ids = [s.id for s in chat_sessions]
    chat_messages = 0
    if chat_ids:
        chat_messages = len(db.exec(select(Message.id).where(Message.session_id.in_(chat_ids))).all())  # type: ignore[attr-defined]
    for s in chat_sessions:
        recent.append({"kind": "chat", "title": s.title or "（未命名對話）", "at": s.last_message_at,
                       "status": s.run_status or "", "link": f"/workbench?session={s.id}"})

    # --- 工作流：節點 session 掛在這位員工名下 ---
    all_ids = {s.id for s in sessions}
    node_runs = completed = failed = 0
    wf_counts: dict[str, int] = {}
    node_keys: set[tuple[str, str]] = set()
    if all_ids:
        nodes = db.exec(select(WorkflowRunNode).where(WorkflowRunNode.session_id.in_(list(all_ids)),  # type: ignore[attr-defined]
                                                     WorkflowRunNode.started_at >= since)).all()  # type: ignore[operator]
        run_ids = {n.run_id for n in nodes}
        runs = {r.id: r for r in db.exec(select(WorkflowRun).where(WorkflowRun.id.in_(list(run_ids)))).all()} if run_ids else {}  # type: ignore[attr-defined]
        for n in nodes:
            r = runs.get(n.run_id)
            if r is None or r.company_id != p.company_id:
                continue
            node_runs += 1
            if n.status in ("completed", "reused"):
                completed += 1
            elif n.status in NODE_FAILED:
                failed += 1
            wf_counts[r.workflow_name] = wf_counts.get(r.workflow_name, 0) + 1
            node_keys.add((n.run_id, n.node_id))
            recent.append({"kind": "workflow", "title": f"{r.workflow_name or r.workflow_id} · {n.node_id}", "at": n.started_at,
                           "status": n.status, "link": f"/workflows/runs/{n.run_id}"})
    workflows = sorted(({"workflow_name": k, "count": v} for k, v in wf_counts.items()), key=lambda x: -x["count"])

    # --- 花費：這位員工所有 session（含工作流）在區間內的 assistant usage ---
    usage = _usage_sum(db, p.company_id, list(all_ids), since, models)

    # --- 退回：對話端的指令審批 ＋ 工作流端的閘門 ---
    requested = approved = rejected = 0
    try:
        from ..modules.inbox.models import PendingApproval
        pas = db.exec(select(PendingApproval).where(PendingApproval.company_id == p.company_id, PendingApproval.agent == a.profile,
                                                    PendingApproval.created_at >= since)).all() if a.profile else []
        for x in pas:
            requested += 1
            if x.decision == "deny":
                rejected += 1
            elif x.decision in CHAT_APPROVED:
                approved += 1
    except Exception as e:  # inbox 模組沒載入就只算工作流端
        log.debug("pending approvals skipped: %s", e)
    if node_keys:
        was = db.exec(select(WorkflowApproval).where(WorkflowApproval.company_id == p.company_id, WorkflowApproval.created_at >= since)).all()
        for w in was:
            if (w.run_id, w.node_id) not in node_keys:
                continue
            requested += 1
            if w.status == "approved":
                approved += 1
            elif w.status == "rejected":
                rejected += 1

    # --- 產出文件 ---
    versions = 0
    doc_ids: set[str] = set()
    try:
        from ..modules.docs.models import Doc, DocVersion
        authors = [x for x in (a.id, a.profile) if x]
        dvs = db.exec(select(DocVersion).where(DocVersion.author_kind == "agent", DocVersion.author_id.in_(authors),  # type: ignore[attr-defined]
                                               DocVersion.created_at >= since)).all() if authors else []
        docs = {d.id: d for d in db.exec(select(Doc).where(Doc.id.in_(list({v.doc_id for v in dvs})))).all()} if dvs else {}  # type: ignore[attr-defined]
        for v in dvs:
            d = docs.get(v.doc_id)
            if d is None or d.company_id != p.company_id:
                continue
            versions += 1
            doc_ids.add(v.doc_id)
            recent.append({"kind": "doc", "title": d.title or v.doc_id, "at": v.created_at, "status": f"v{v.version}",
                           "link": f"/docs/{v.doc_id}"})
    except Exception as e:  # docs 模組沒載入
        log.debug("doc versions skipped: %s", e)

    recent.sort(key=lambda x: x["at"] or datetime.min, reverse=True)
    return {
        "agent_id": a.id, "days": days, "since": since.isoformat(),
        "chat": {"sessions": len(chat_sessions), "messages": chat_messages},
        "workflow": {"node_runs": node_runs, "completed": completed, "failed": failed, "workflows": workflows},
        "usage": usage,
        "approvals": {"requested": requested, "approved": approved, "rejected": rejected},
        "docs": {"versions": versions, "docs": len(doc_ids)},
        "recent": [{**x, "at": _iso(x["at"])} for x in recent[:8]],
    }
