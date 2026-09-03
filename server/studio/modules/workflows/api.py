"""REST + WS for workflow execution (prefix-less, see docs/API.md Workflows)."""
from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, allowed_profiles, current_principal, get_db, principal_from_ws
from ...errors import ApiError, not_found
from ...hermes.gateway import GatewayError
from ...models import Agent, Workflow, WorkflowApproval, WorkflowRun, WorkflowRunNode, WorkflowSchedule, WorkflowWebhook, now
from ...workflow_validate import WorkflowValidationError, node_kind, validate_workflow
from ..coding_agents import staff
from .cron import CronError, parse_cron
from .draft import DraftFailed, draft_workflow
from .engine import NOT_TRIABLE_KINDS, TERMINAL_RUN, TRY_TRIGGER
from .runners import coding_tools_status, line_token
from .scheduler import compute_next

router = APIRouter(tags=["workflow-runs"])
EXPORT_FORMAT = "myhermescompany.workflow"
LEGACY_EXPORT_FORMATS = {"hermes-studio-tw.workflow"}  # 改名前匯出的檔仍可匯入
EXPORT_VERSION = 1


def _engine(request: Request):
    eng = getattr(request.app.state, "workflow_engine", None)
    if eng is None:
        raise ApiError(503, "unavailable", "工作流執行器尚未啟動")
    return eng


def _wf(db: Session, p: Principal, wf_id: str) -> Workflow:
    wf = db.get(Workflow, wf_id)
    if wf is None or wf.company_id != p.company_id:
        raise not_found("workflow")
    return wf


def _run(db: Session, p: Principal, run_id: str) -> WorkflowRun:
    r = db.get(WorkflowRun, run_id)
    if r is None or r.company_id != p.company_id:
        raise not_found("workflow run")
    return r


class RunBody(BaseModel):
    input: Optional[dict[str, Any]] = None


class RerunBody(BaseModel):
    from_node: Optional[str] = None
    force: bool = False  # True＝不用效果快取，全部重跑


class TryBody(BaseModel):
    input: Optional[str] = None  # 當 [外部輸入] 塞給這一站
    use_latest_upstream: bool = True  # 帶上一次正式執行的上游輸出當 [上游結果]


class DecisionBody(BaseModel):
    comment: str = ""
    choice: str = ""  # doc_select 閘門：選了哪一份文件（doc_id）


class ScheduleBody(BaseModel):
    cron: str
    enabled: bool = True
    input: dict[str, Any] = {}


class SchedulePatch(BaseModel):
    cron: Optional[str] = None
    enabled: Optional[bool] = None
    input: Optional[dict[str, Any]] = None


class ImportBody(BaseModel):
    data: dict[str, Any]
    name: Optional[str] = None


class DraftBody(BaseModel):
    text: str
    agent_id: Optional[str] = None  # 指定排草稿的員工；不給就用第一位啟用的 Hermes 員工


# -- runs -------------------------------------------------------------------
@router.post("/workflows/{wf_id}/run", status_code=202)
async def run_workflow(wf_id: str, request: Request, body: Optional[RunBody] = None, p: Principal = Depends(current_principal),
                       db: Session = Depends(get_db)):
    wf = _wf(db, p, wf_id)
    try:
        validate_workflow(json.loads(wf.nodes_json), json.loads(wf.edges_json))
    except WorkflowValidationError as e:
        raise ApiError(422, "workflow_invalid", "; ".join(e.errors))
    db.expunge(wf)
    run = await _engine(request).start(wf, member_id=p.member.id, trigger="manual", input=(body.input if body else None) or {})
    return {"run_id": run.id, "status": run.status}


@router.post("/workflows/{wf_id}/nodes/{node_id}/try", status_code=202)
async def try_node(wf_id: str, node_id: str, request: Request, body: Optional[TryBody] = None, p: Principal = Depends(current_principal),
                   db: Session = Depends(get_db)):
    """試跑這一站：只跑這一個節點，上游結果從上一次正式執行借來（找不到就只用 input 當 [外部輸入]）。
    產生的 run trigger="try"，不進執行歷史、不能當重跑父 run。"""
    wf = _wf(db, p, wf_id)
    nodes = json.loads(wf.nodes_json)
    node = next((n for n in nodes if str(n.get("id")) == node_id), None)
    if node is None:
        raise not_found("node")
    kind = node_kind(node)
    if kind in NOT_TRIABLE_KINDS:
        raise ApiError(422, "node_not_triable", "這一站要靠上游結果才有意義（等我確認／看情況分岔／重複直到），請執行整條線")
    try:
        validate_workflow([node], [])
    except WorkflowValidationError as e:
        raise ApiError(422, "workflow_invalid", "; ".join(e.errors))
    body = body or TryBody()
    inp: dict[str, Any] = {"source": TRY_TRIGGER, "node_id": node_id}
    if body.input:
        inp["text"] = body.input
    if body.use_latest_upstream:
        sources = [str(e["source"]) for e in json.loads(wf.edges_json) if str(e.get("target")) == node_id and not e.get("loop_back")]
        if sources:
            titles = {str(n.get("id")): (n.get("title") or str(n.get("id"))) for n in nodes}
            latest = db.exec(select(WorkflowRun).where(WorkflowRun.workflow_id == wf.id, WorkflowRun.trigger != TRY_TRIGGER,
                                                        WorkflowRun.status.in_(list(TERMINAL_RUN)))  # type: ignore[attr-defined]
                             .order_by(WorkflowRun.created_at.desc())).first()
            if latest is not None:
                states = json.loads(latest.node_states_json or "{}")
                ups = [{"node_id": s, "title": titles.get(s, s), "output": states[s].get("output") or ""}
                       for s in sources if states.get(s, {}).get("status") in ("completed", "reused") and states[s].get("output")]
                if ups:
                    inp["upstream"] = ups
                    inp["upstream_run_id"] = latest.id
    db.expunge(wf)
    try:
        run = await _engine(request).start(wf, member_id=p.member.id, trigger=TRY_TRIGGER, input=inp, only_node=node_id)
    except ValueError as e:
        raise ApiError(422, "bad_request", str(e))
    return {"run_id": run.id, "status": run.status, "upstream_run_id": inp.get("upstream_run_id")}


@router.get("/workflows/{wf_id}/runs")
def list_runs(wf_id: str, limit: int = 50, include_try: bool = False, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    wf = _wf(db, p, wf_id)
    q = select(WorkflowRun).where(WorkflowRun.workflow_id == wf.id)
    if not include_try:  # 試跑不算「上一次的產出」，也不進歷史清單
        q = q.where(WorkflowRun.trigger != TRY_TRIGGER)
    rows = db.exec(q.order_by(WorkflowRun.created_at.desc()).limit(limit)).all()
    return [r.to_dict(full=False) for r in rows]


@router.get("/workflow-runs")
def list_all_runs(status: Optional[str] = None, limit: int = 100, include_try: bool = False, p: Principal = Depends(current_principal),
                  db: Session = Depends(get_db)):
    q = select(WorkflowRun).where(WorkflowRun.company_id == p.company_id)
    if not include_try:
        q = q.where(WorkflowRun.trigger != TRY_TRIGGER)
    if status:
        q = q.where(WorkflowRun.status == status)
    rows = db.exec(q.order_by(WorkflowRun.created_at.desc()).limit(limit)).all()
    return [r.to_dict(full=False) for r in rows]


@router.get("/workflow-runs/{run_id}")
def get_run(run_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    r = _run(db, p, run_id)
    d = r.to_dict()
    eng = getattr(request.app.state, "workflow_engine", None)
    live = eng.snapshot_of(run_id) if eng else None
    if live:  # in-memory is fresher than the last persist
        d.update({"status": live["status"], "node_states": live["node_states"], "events": live["events"], "usage": live["usage"], "error": live["error"]})
    d["edge_decisions"] = {ev["edge"]: ev["taken"] for ev in d["events"] if ev.get("type") == "edge.decision"}
    d["nodes"] = [n.model_dump() for n in db.exec(select(WorkflowRunNode).where(WorkflowRunNode.run_id == run_id)).all()]
    d["approvals"] = [a.to_dict() for a in db.exec(select(WorkflowApproval).where(WorkflowApproval.run_id == run_id)).all()]
    return d


@router.post("/workflow-runs/{run_id}/stop")
async def stop_run(run_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    r = _run(db, p, run_id)
    ok = await _engine(request).stop(r.id)
    if not ok:
        raise ApiError(409, "not_running", "此 run 不在執行中")
    return {"ok": True, "status": "stopped"}


@router.post("/workflow-runs/{run_id}/rerun", status_code=202)
async def rerun(run_id: str, request: Request, body: Optional[RerunBody] = None, p: Principal = Depends(current_principal),
                db: Session = Depends(get_db)):
    parent = _run(db, p, run_id)
    if parent.status not in ("completed", "failed", "stopped", "timeout", "budget_exceeded", "needs_attention"):
        raise ApiError(409, "still_running", "run 尚未結束，無法重跑")
    if parent.trigger == TRY_TRIGGER:
        raise ApiError(422, "try_run", "試跑只有一站，不能當重跑的起點；請重跑正式執行")
    wf = db.get(Workflow, parent.workflow_id)
    if wf is None:
        raise not_found("workflow")
    from_node = body.from_node if body else None
    snap = json.loads(parent.snapshot_json)
    if from_node and from_node not in {str(n["id"]) for n in snap.get("nodes", [])}:
        raise ApiError(400, "bad_request", f"快照中沒有節點 {from_node}")
    db.expunge(wf)
    db.expunge(parent)
    run = await _engine(request).start(wf, member_id=p.member.id, trigger="rerun", input=json.loads(parent.input_json or "{}"),
                                       parent=parent, from_node=from_node, force=bool(body and body.force))
    return {"run_id": run.id, "status": run.status, "parent_run_id": parent.id}


@router.get("/workflow-runs/{run_id}/nodes/{node_id}/output")
def node_output(run_id: str, node_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """節點完整輸出：有溢出檔就回檔案內容（可下載），否則回快照裡的輸出。"""
    r = _run(db, p, run_id)
    states = json.loads(r.node_states_json or "{}")
    eng = getattr(request.app.state, "workflow_engine", None)
    live = eng.snapshot_of(run_id) if eng else None
    if live:
        states = live["node_states"]
    st = states.get(node_id)
    if st is None:
        raise not_found("node")
    spill = st.get("spill")
    if spill and eng is not None:
        path = eng.spill_path(run_id, node_id)
        if path.exists():
            return {"run_id": run_id, "node_id": node_id, "spilled": True, "bytes": spill.get("bytes"), "path": spill.get("path"),
                    "content": path.read_text(encoding="utf-8")}
    return {"run_id": run_id, "node_id": node_id, "spilled": False, "bytes": len((st.get("output") or "").encode("utf-8")), "path": None,
            "content": st.get("output") or ""}


@router.delete("/workflow-runs/{run_id}")
def delete_run(run_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    r = _run(db, p, run_id)
    eng = getattr(request.app.state, "workflow_engine", None)
    if eng and run_id in eng.runs:
        raise ApiError(409, "still_running", "run 執行中，請先停止")
    for n in db.exec(select(WorkflowRunNode).where(WorkflowRunNode.run_id == run_id)).all():
        db.delete(n)
    for a in db.exec(select(WorkflowApproval).where(WorkflowApproval.run_id == run_id)).all():
        db.delete(a)
    db.delete(r)
    db.commit()
    return {"ok": True}


# -- approvals ---------------------------------------------------------------
@router.get("/workflow-approvals")
def list_approvals(status: Optional[str] = "pending", p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    q = select(WorkflowApproval).where(WorkflowApproval.company_id == p.company_id)
    if status and status != "all":
        q = q.where(WorkflowApproval.status == status)
    return [a.to_dict() for a in db.exec(q.order_by(WorkflowApproval.created_at.desc())).all()]


async def _decide(approval_id: str, decision: str, comment: str, request: Request, p: Principal, db: Session,
                  choice: str = ""):
    a = db.get(WorkflowApproval, approval_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("approval")
    if a.status != "pending":
        raise ApiError(409, "already_decided", f"此閘門已{a.status}")
    if a.kind == "doc_select" and decision == "approve":
        import json as _json
        options = _json.loads(a.options_json or "[]")
        ids = [str(o.get("doc_id")) for o in options]
        if not choice and ids:
            choice = ids[0]
        if ids and choice not in ids:
            raise ApiError(400, "bad_choice", f"choice 必須是這些文件之一：{', '.join(ids)}")
    db.expunge(a)
    try:
        await _engine(request).decide_approval(a, decision, comment, p.member.id, choice)
    except RuntimeError as e:
        raise ApiError(409, "not_waiting", str(e))
    return {"ok": True, "approval_id": approval_id, "decision": decision, "choice": choice}


@router.post("/workflow-approvals/{approval_id}/approve")
async def approve(approval_id: str, request: Request, body: Optional[DecisionBody] = None, p: Principal = Depends(current_principal),
                  db: Session = Depends(get_db)):
    return await _decide(approval_id, "approve", (body.comment if body else ""), request, p, db,
                         (body.choice if body else ""))


@router.post("/workflow-approvals/{approval_id}/reject")
async def reject(approval_id: str, request: Request, body: Optional[DecisionBody] = None, p: Principal = Depends(current_principal),
                 db: Session = Depends(get_db)):
    return await _decide(approval_id, "reject", (body.comment if body else ""), request, p, db)


# -- schedules ---------------------------------------------------------------
@router.get("/workflows/{wf_id}/schedules")
def list_schedules(wf_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    wf = _wf(db, p, wf_id)
    return [s.to_dict() for s in db.exec(select(WorkflowSchedule).where(WorkflowSchedule.workflow_id == wf.id)).all()]


@router.post("/workflows/{wf_id}/schedules", status_code=201)
def create_schedule(wf_id: str, body: ScheduleBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    wf = _wf(db, p, wf_id)
    try:
        parse_cron(body.cron)
        nxt = compute_next(body.cron)
    except CronError as e:
        raise ApiError(422, "bad_cron", str(e))
    s = WorkflowSchedule(company_id=p.company_id, workflow_id=wf.id, cron=body.cron.strip(), enabled=body.enabled,
                         input_json=json.dumps(body.input, ensure_ascii=False), next_run_at=nxt)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s.to_dict()


@router.patch("/workflow-schedules/{sid}")
def patch_schedule(sid: str, body: SchedulePatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s = db.get(WorkflowSchedule, sid)
    if s is None or s.company_id != p.company_id:
        raise not_found("schedule")
    if body.cron is not None:
        try:
            parse_cron(body.cron)
            s.cron = body.cron.strip()
            s.next_run_at = compute_next(s.cron)
        except CronError as e:
            raise ApiError(422, "bad_cron", str(e))
    if body.enabled is not None:
        s.enabled = body.enabled
        if body.enabled:
            s.next_run_at = compute_next(s.cron)
    if body.input is not None:
        s.input_json = json.dumps(body.input, ensure_ascii=False)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s.to_dict()


@router.delete("/workflow-schedules/{sid}")
def delete_schedule(sid: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s = db.get(WorkflowSchedule, sid)
    if s is None or s.company_id != p.company_id:
        raise not_found("schedule")
    db.delete(s)
    db.commit()
    return {"ok": True}


# -- webhooks ----------------------------------------------------------------
@router.get("/workflows/{wf_id}/webhooks")
def list_webhooks(wf_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    wf = _wf(db, p, wf_id)
    return [w.to_dict() for w in db.exec(select(WorkflowWebhook).where(WorkflowWebhook.workflow_id == wf.id)).all()]


@router.post("/workflows/{wf_id}/webhooks", status_code=201)
def create_webhook(wf_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    wf = _wf(db, p, wf_id)
    w = WorkflowWebhook(company_id=p.company_id, workflow_id=wf.id)
    db.add(w)
    db.commit()
    db.refresh(w)
    return w.to_dict()


@router.delete("/workflow-webhooks/{wid}")
def delete_webhook(wid: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    w = db.get(WorkflowWebhook, wid)
    if w is None or w.company_id != p.company_id:
        raise not_found("webhook")
    db.delete(w)
    db.commit()
    return {"ok": True}


@router.post("/webhooks/wf/{token}", status_code=202)
async def webhook_trigger(token: str, request: Request):
    """公開端點（token 即憑證）：payload 進第一個節點當 [外部輸入]。"""
    with Session(request.app.state.engine) as db:
        w = db.exec(select(WorkflowWebhook).where(WorkflowWebhook.token == token, WorkflowWebhook.enabled == True)).first()  # noqa: E712
        if w is None:
            raise not_found("webhook")
        wf = db.get(Workflow, w.workflow_id)
        if wf is None:
            raise not_found("workflow")
        w.hits += 1
        w.last_hit_at = now()
        db.add(w)
        db.commit()
        db.refresh(wf)
        db.expunge(wf)
    try:
        payload = await request.json()
    except Exception:
        raw = (await request.body()).decode("utf-8", "replace")
        payload = {"text": raw} if raw else {}
    inp: dict[str, Any] = {"payload": payload, "source": "webhook"}
    if isinstance(payload, dict) and isinstance(payload.get("text"), str):
        inp["text"] = payload["text"]
    run = await _engine(request).start(wf, member_id="webhook", trigger="webhook", input=inp)
    return {"run_id": run.id, "status": run.status}


# -- import / export ---------------------------------------------------------
@router.get("/workflows/{wf_id}/export")
def export_workflow(wf_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    wf = _wf(db, p, wf_id)
    return {"format": EXPORT_FORMAT, "format_version": EXPORT_VERSION, "exported_at": now(), "workflow": {
        "name": wf.name, "description": wf.description, "profile": wf.profile, "version": wf.version,
        "nodes": json.loads(wf.nodes_json), "edges": json.loads(wf.edges_json), "viewport": json.loads(wf.viewport_json or "{}"),
        "budget": json.loads(wf.budget_json or "{}")}}


@router.post("/workflows/import", status_code=201)
def import_workflow(body: ImportBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    data = body.data
    if data.get("format") != EXPORT_FORMAT and data.get("format") not in LEGACY_EXPORT_FORMATS:
        raise ApiError(422, "bad_format", f"format 必須是 {EXPORT_FORMAT}")
    if int(data.get("format_version") or 0) > EXPORT_VERSION:
        raise ApiError(422, "bad_format", "檔案版本比本伺服器新")
    w = data.get("workflow") or {}
    nodes, edges = w.get("nodes") or [], w.get("edges") or []
    try:
        validate_workflow(nodes, edges)
    except WorkflowValidationError as e:
        raise ApiError(422, "workflow_invalid", "; ".join(e.errors))
    wf = Workflow(company_id=p.company_id, name=(body.name or w.get("name") or "匯入的工作流").strip(), description=str(w.get("description") or ""),
                  profile=str(w.get("profile") or ""), version=int(w.get("version") or 1), nodes_json=json.dumps(nodes, ensure_ascii=False),
                  edges_json=json.dumps(edges, ensure_ascii=False), viewport_json=json.dumps(w.get("viewport") or {}, ensure_ascii=False),
                  budget_json=json.dumps(w.get("budget") or {}, ensure_ascii=False), created_by=p.member.id)
    db.add(wf)
    db.commit()
    db.refresh(wf)
    return wf.to_dict()


# -- draft（一句話建流程）------------------------------------------------------
@router.post("/workflows/draft")
async def draft(body: DraftBody, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """請一位 Hermes 員工把老闆的一句話排成草稿鏈。只回草稿，不建流程（對話框確認後才 POST /workflows）。"""
    text = body.text.strip()
    if not text:
        raise ApiError(400, "bad_request", "text 不可空白")
    allowed = allowed_profiles(p.member)
    rows = db.exec(select(Agent).where(Agent.company_id == p.company_id, Agent.enabled == True)  # noqa: E712
                   .order_by(Agent.created_at)).all()
    # 給 LLM 看的名單＝這個人看得到的啟用員工（coding 員工也列，讓它知道有誰；但排草稿只能是 Hermes）
    agents = [a for a in rows if staff.is_coding(staff.runtime_of(a)) or allowed is None or a.profile in allowed]
    hermes = [a for a in agents if not staff.is_coding(staff.runtime_of(a))]
    drafter = next((a for a in hermes if a.id == body.agent_id), None) if body.agent_id else (hermes[0] if hermes else None)
    if drafter is None:
        raise ApiError(422, "no_agent", "沒有可用的 Hermes 員工；先在「AI 員工」啟用一位")
    for a in agents:
        db.expunge(a)
    try:
        return await draft_workflow(request.app.state.gateway, drafter, agents, text)
    except DraftFailed as e:
        raise ApiError(422, "draft_failed", str(e), detail=e.excerpt)
    except GatewayError as e:
        raise ApiError(502, "gateway_error", f"問 AI 員工失敗：{e}")


# -- environment -------------------------------------------------------------
@router.get("/workflow-env")
def workflow_env(request: Request, p: Principal = Depends(current_principal)):
    settings = request.app.state.settings
    from pathlib import Path
    return {"coding_tools": coding_tools_status(), "line_configured": bool(line_token(Path(settings.hermes_home))),
            "workspace": str(Path(settings.db_path).parent / "workspace")}


# -- websocket ---------------------------------------------------------------
@router.websocket("/ws/workflows")
async def ws_workflows(ws: WebSocket):
    with Session(ws.app.state.engine) as db:
        try:
            principal = principal_from_ws(ws, db)
        except ApiError as e:
            await ws.close(code=4401, reason=e.message)
            return
        company_id = principal.company_id
    hub = ws.app.state.workflow_hub
    await ws.accept()
    await hub.add(ws, company_id)
    await ws.send_text(json.dumps({"type": "ready"}))
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("type") == "subscribe":
                await hub.subscribe(ws, msg.get("run_ids"))
            elif msg.get("type") == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        await hub.remove(ws)
