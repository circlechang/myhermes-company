from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import Principal, current_principal, get_db
from ..errors import ApiError, not_found
from ..models import Workflow, now
from ..workflow_validate import WorkflowValidationError, validate_workflow

router = APIRouter(tags=["workflows"])


class WorkflowCreate(BaseModel):
    name: str
    nodes: list[dict[str, Any]]
    edges: list[dict[str, Any]] = []
    viewport: dict[str, Any] = {}
    description: str = ""
    profile: str = ""
    budget: dict[str, Any] = {}


class WorkflowPatch(BaseModel):
    name: Optional[str] = None
    nodes: Optional[list[dict[str, Any]]] = None
    edges: Optional[list[dict[str, Any]]] = None
    viewport: Optional[dict[str, Any]] = None
    description: Optional[str] = None
    profile: Optional[str] = None
    budget: Optional[dict[str, Any]] = None


class BatchDelete(BaseModel):
    ids: list[str]


def _validate(nodes, edges) -> None:
    try:
        validate_workflow(nodes, edges)
    except WorkflowValidationError as e:
        raise ApiError(422, "workflow_invalid", "; ".join(e.errors))


def _get(db: Session, p: Principal, wf_id: str) -> Workflow:
    wf = db.get(Workflow, wf_id)
    if wf is None or wf.company_id != p.company_id:
        raise not_found("workflow")
    return wf


@router.get("/workflows")
def list_workflows(profile: Optional[str] = None, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    q = select(Workflow).where(Workflow.company_id == p.company_id)
    if profile:
        q = q.where(Workflow.profile == profile)
    rows = db.exec(q.order_by(Workflow.updated_at.desc())).all()
    return [w.to_dict() for w in rows]


@router.post("/workflows/batch-delete")
def batch_delete(body: BatchDelete, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    n = 0
    for wid in body.ids:
        wf = db.get(Workflow, wid)
        if wf and wf.company_id == p.company_id:
            _delete_workflow_rows(db, wf)
            n += 1
    db.commit()
    return {"ok": True, "deleted": n}


def _delete_workflow_rows(db: Session, wf: Workflow) -> None:
    from ..models import WorkflowApproval, WorkflowRun, WorkflowRunNode, WorkflowSchedule, WorkflowWebhook
    for r in db.exec(select(WorkflowRun).where(WorkflowRun.workflow_id == wf.id)).all():
        for n in db.exec(select(WorkflowRunNode).where(WorkflowRunNode.run_id == r.id)).all():
            db.delete(n)
        for a in db.exec(select(WorkflowApproval).where(WorkflowApproval.run_id == r.id)).all():
            db.delete(a)
        db.delete(r)
    for s in db.exec(select(WorkflowSchedule).where(WorkflowSchedule.workflow_id == wf.id)).all():
        db.delete(s)
    for w in db.exec(select(WorkflowWebhook).where(WorkflowWebhook.workflow_id == wf.id)).all():
        db.delete(w)
    db.delete(wf)


@router.post("/workflows", status_code=201)
def create_workflow(body: WorkflowCreate, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    if not body.name.strip():
        raise ApiError(400, "bad_request", "name 不可空白")
    _validate(body.nodes, body.edges)
    wf = Workflow(company_id=p.company_id, name=body.name.strip(), nodes_json=json.dumps(body.nodes, ensure_ascii=False),
                  edges_json=json.dumps(body.edges, ensure_ascii=False), viewport_json=json.dumps(body.viewport, ensure_ascii=False),
                  description=body.description, profile=body.profile, budget_json=json.dumps(body.budget, ensure_ascii=False),
                  created_by=p.member.id)
    db.add(wf)
    db.commit()
    db.refresh(wf)
    return wf.to_dict()


@router.get("/workflows/{wf_id}")
def get_workflow(wf_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return _get(db, p, wf_id).to_dict()


@router.patch("/workflows/{wf_id}")
def patch_workflow(wf_id: str, body: WorkflowPatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    wf = _get(db, p, wf_id)
    nodes = body.nodes if body.nodes is not None else json.loads(wf.nodes_json)
    edges = body.edges if body.edges is not None else json.loads(wf.edges_json)
    if body.nodes is not None or body.edges is not None:
        _validate(nodes, edges)
    if body.name is not None:
        wf.name = body.name.strip() or wf.name
    wf.nodes_json = json.dumps(nodes, ensure_ascii=False)
    wf.edges_json = json.dumps(edges, ensure_ascii=False)
    if body.viewport is not None:
        wf.viewport_json = json.dumps(body.viewport, ensure_ascii=False)
    if body.description is not None:
        wf.description = body.description
    if body.profile is not None:
        wf.profile = body.profile
    if body.budget is not None:
        wf.budget_json = json.dumps(body.budget, ensure_ascii=False)
    if body.nodes is not None or body.edges is not None:
        wf.version = (wf.version or 1) + 1
    wf.updated_at = now()
    db.add(wf)
    db.commit()
    db.refresh(wf)
    return wf.to_dict()


@router.delete("/workflows/{wf_id}")
def delete_workflow(wf_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    wf = _get(db, p, wf_id)
    _delete_workflow_rows(db, wf)
    db.commit()
    return {"ok": True}


# 執行／run 歷史／審批／排程／webhook／匯入匯出 → studio/modules/workflows/api.py
