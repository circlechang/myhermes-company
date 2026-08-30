"""E. 看板：profile 感知 board、卡片詳情、移動、指派、留言、附件、封存、診斷、派工。"""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Request, UploadFile
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, current_principal, get_db
from ...errors import ApiError, bad_request
from ...hermes.cli import CliError
from ...models import now
from .cli import PRIORITY_TO_INT, STATUSES, KanbanCli, priority_label
from .models import KanbanMeta

router = APIRouter(prefix="/kanban", tags=["kanban-board"])


def _kc(request: Request) -> KanbanCli:
    return KanbanCli(request.app.state.cli._run)


def _wrap(e: CliError) -> ApiError:
    return ApiError(502, "hermes_cli_error", str(e))


def _tags_map(db: Session, company_id: str) -> dict[str, list[str]]:
    rows = db.exec(select(KanbanMeta).where(KanbanMeta.company_id == company_id)).all()
    return {r.task_id: json.loads(r.tags_json or "[]") for r in rows}


def _card(t: dict[str, Any], tags: dict[str, list[str]]) -> dict[str, Any]:
    return {"diagnostics": [], **t, "priority_label": priority_label(t.get("priority")), "tags": tags.get(t.get("id", ""), [])}


@router.get("/board")
async def board(request: Request, assignee: Optional[str] = None, archived: bool = False,
                p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """一次拿齊：卡片（可依 assignee/profile 篩）＋診斷＋可指派的 profile 清單。"""
    kc = _kc(request)
    try:
        tasks = await kc.list(assignee=assignee or None, archived=archived)
    except CliError as e:
        raise _wrap(e)
    try:
        diags = await kc.diagnostics()
    except CliError:
        diags = []
    tags = _tags_map(db, p.company_id)
    profiles = request.app.state.cli.list_profiles_fs()
    diag_by_task: dict[str, list[dict[str, Any]]] = {}
    for d in diags:
        diag_by_task.setdefault(d.get("task_id", ""), []).extend(d.get("diagnostics") or [])
    cards = [{**_card(t, tags), "diagnostics": diag_by_task.get(t.get("id", ""), [])} for t in tasks]
    return {"tasks": cards, "diagnostics": diags, "profiles": profiles, "statuses": list(STATUSES),
            "assignee": assignee or None, "archived": archived}


class CardCreate(BaseModel):
    title: str
    body: str = ""
    assignee: str = ""
    priority: str | int = "medium"
    tags: list[str] = []
    skills: list[str] = []
    model: str = ""
    max_runtime: str = ""
    parent: str = ""
    triage: bool = False


def _prio_int(v: str | int) -> int:
    if isinstance(v, int):
        return v
    if v in PRIORITY_TO_INT:
        return PRIORITY_TO_INT[v]
    try:
        return int(v)
    except ValueError:
        raise bad_request(f"priority 必須是 {list(PRIORITY_TO_INT)} 或整數")


@router.post("/cards", status_code=201)
async def create_card(body: CardCreate, request: Request, p: Principal = Depends(current_principal),
                      db: Session = Depends(get_db)):
    if not body.title.strip():
        raise bad_request("title 不可為空")
    try:
        out = await _kc(request).create(body.title.strip(), body=body.body, assignee=body.assignee,
                                        priority=_prio_int(body.priority), skills=body.skills, model=body.model,
                                        max_runtime=body.max_runtime, parent=body.parent, triage=body.triage)
    except CliError as e:
        raise _wrap(e)
    tid = out.get("id") or (out.get("task") or {}).get("id")
    if tid and body.tags:
        db.add(KanbanMeta(task_id=tid, company_id=p.company_id, tags_json=json.dumps(body.tags, ensure_ascii=False)))
        db.commit()
    return {**out, "id": tid, "tags": body.tags}


@router.get("/cards/{task_id}")
async def get_card(task_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    try:
        data = await _kc(request).show(task_id)
    except CliError as e:
        raise _wrap(e)
    tags = _tags_map(db, p.company_id)
    task = data.get("task") or {}
    if task:
        task = _card(task, tags)
        try:
            diags = await _kc(request).diagnostics(task_id=task_id)
        except CliError:
            diags = []
        task["diagnostics"] = [x for d in diags for x in (d.get("diagnostics") or [])]
    data["task"] = task
    return data


class TagsBody(BaseModel):
    tags: list[str]


@router.put("/cards/{task_id}/tags")
def set_tags(task_id: str, body: TagsBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    meta = db.get(KanbanMeta, task_id)
    tags = sorted({t.strip() for t in body.tags if t.strip()})
    if meta is None:
        meta = KanbanMeta(task_id=task_id, company_id=p.company_id)
    meta.tags_json = json.dumps(tags, ensure_ascii=False)
    meta.updated_at = now()
    db.add(meta)
    db.commit()
    return {"task_id": task_id, "tags": tags}


class MoveBody(BaseModel):
    status: str
    reason: str = ""
    result: str = ""


@router.post("/cards/{task_id}/move")
async def move_card(task_id: str, body: MoveBody, request: Request, p: Principal = Depends(current_principal)):
    if body.status not in STATUSES:
        raise bad_request(f"status 必須是 {STATUSES}")
    try:
        return await _kc(request).move(task_id, body.status, reason=body.reason, result=body.result)
    except CliError as e:
        raise _wrap(e)


class AssignBody(BaseModel):
    profile: str  # '' 或 'none' = 取消指派


@router.post("/cards/{task_id}/assign")
async def assign_card(task_id: str, body: AssignBody, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await _kc(request).assign(task_id, body.profile.strip() or "none")
    except CliError as e:
        raise _wrap(e)


class CommentBody(BaseModel):
    text: str


@router.post("/cards/{task_id}/comments", status_code=201)
async def comment_card(task_id: str, body: CommentBody, request: Request, p: Principal = Depends(current_principal)):
    if not body.text.strip():
        raise bad_request("text 不可為空")
    try:
        return await _kc(request).comment(task_id, body.text.strip(), author=p.member.username)
    except CliError as e:
        raise _wrap(e)


@router.get("/cards/{task_id}/attachments")
async def list_attachments(task_id: str, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await _kc(request).attachments(task_id)
    except CliError as e:
        raise _wrap(e)


@router.post("/cards/{task_id}/attachments", status_code=201)
async def upload_attachment(task_id: str, request: Request, file: UploadFile = File(...),
                            p: Principal = Depends(current_principal)):
    name = Path(file.filename or "attachment").name
    tmpdir = Path(tempfile.mkdtemp(prefix="studio-kanban-"))
    dest = tmpdir / name
    try:
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        return await _kc(request).attach(task_id, str(dest), name=name, content_type=file.content_type or "",
                                         author=p.member.username)
    except CliError as e:
        raise _wrap(e)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


@router.delete("/cards/{task_id}/attachments/{attachment_id}")
async def delete_attachment(task_id: str, attachment_id: str, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await _kc(request).attach_rm(attachment_id)
    except CliError as e:
        raise _wrap(e)


@router.post("/cards/{task_id}/archive")
async def archive_card(task_id: str, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await _kc(request).archive(task_id)
    except CliError as e:
        raise _wrap(e)


class EditBody(BaseModel):
    result: str
    summary: str = ""


@router.post("/cards/{task_id}/edit")
async def edit_card(task_id: str, body: EditBody, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await _kc(request).edit(task_id, body.result, body.summary)
    except CliError as e:
        raise _wrap(e)


class DispatchBody(BaseModel):
    profile: str = ""  # 先指派給這個 AI 員工
    dry_run: bool = False
    max_spawn: Optional[int] = None


@router.post("/cards/{task_id}/dispatch")
async def dispatch_card(task_id: str, body: DispatchBody, request: Request, p: Principal = Depends(current_principal)):
    """派給 AI 員工執行：assign（可選）→ promote 到 ready → dispatch 一輪。
    `hermes kanban dispatch` 是整板一輪（reclaim stale → promote → spawn），沒有單卡參數，
    所以這裡的做法是把卡片推到 ready 再跑一輪，讓 dispatcher 依優先權撿走。"""
    kc = _kc(request)
    steps: dict[str, Any] = {}
    try:
        if body.profile.strip():
            steps["assign"] = await kc.assign(task_id, body.profile.strip())
        try:
            steps["promote"] = await kc.move(task_id, "ready")
        except CliError as e:  # 已經 ready/running 時 promote 會失敗，不算錯
            steps["promote"] = {"ok": False, "raw": str(e)}
        steps["dispatch"] = await kc.dispatch(dry_run=body.dry_run, max_spawn=body.max_spawn)
    except CliError as e:
        raise _wrap(e)
    return steps


@router.get("/diagnostics")
async def diagnostics(request: Request, severity: Optional[str] = None, p: Principal = Depends(current_principal)):
    try:
        return await _kc(request).diagnostics(severity=severity)
    except CliError as e:
        raise _wrap(e)


@router.get("/stats")
async def stats(request: Request, p: Principal = Depends(current_principal)):
    try:
        return await _kc(request).stats()
    except CliError as e:
        raise _wrap(e)


@router.post("/dispatch")
async def dispatch_all(body: DispatchBody, request: Request, p: Principal = Depends(current_principal)):
    try:
        return await _kc(request).dispatch(dry_run=body.dry_run, max_spawn=body.max_spawn)
    except CliError as e:
        raise _wrap(e)
