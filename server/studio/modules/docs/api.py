"""REST：文件（Doc）＝第一級物件（docs/API.md「Docs」）。"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, current_principal, get_db
from ...errors import ApiError
from ...models import now
from . import service as svc
from .models import DOC_ORIGINS, DOC_STATUSES, LINK_KINDS, Doc, DocLink, DocVersion

log = logging.getLogger("studio.docs")
router = APIRouter(prefix="/docs", tags=["docs"])


def workspace_of(request: Request) -> Path:
    eng = getattr(request.app.state, "workflow_engine", None)
    if eng is not None:
        return Path(eng.workspace)
    return Path(request.app.state.settings.db_path).parent / "workspace"


def _err(e: svc.DocError) -> ApiError:
    return ApiError(e.status, e.code, e.message)


def _event(kind: str, doc: Doc, payload: dict[str, Any], *, member_id: str = "") -> None:
    try:
        from ..events import record
        record(kind, "docs", f"doc:{doc.id}", payload, member_id=member_id, company_id=doc.company_id)
    except Exception as e:  # pragma: no cover - 事件模組不在時不影響主流程
        log.debug("doc event skipped: %s", e)


def _doc(db: Session, p: Principal, doc_id: str) -> Doc:
    try:
        return svc.get_doc(db, p.company_id, doc_id)
    except svc.DocError as e:
        raise _err(e)


# ------------------------------------------------------------------ 清單／建立
@router.get("")
def list_docs(status: Optional[str] = None, stage: Optional[str] = None, origin: Optional[str] = None,
              session_id: Optional[str] = None, parent_doc_id: Optional[str] = None, q: Optional[str] = None,
              limit: int = 200, request: Request = None, p: Principal = Depends(current_principal),
              db: Session = Depends(get_db)):
    ws = workspace_of(request)
    sel = select(Doc).where(Doc.company_id == p.company_id)
    if status:
        sel = sel.where(Doc.status == status)
    if stage:
        sel = sel.where(Doc.stage == stage)
    if origin:
        sel = sel.where(Doc.origin == origin)
    if parent_doc_id:
        sel = sel.where(Doc.parent_doc_id == parent_doc_id)
    if q:
        like = f"%{q.strip()}%"
        sel = sel.where(Doc.title.ilike(like) | Doc.path.ilike(like))
    rows = db.exec(sel.order_by(Doc.updated_at.desc())).all()
    if session_id:
        rows = [d for d in rows if (d.meta().get("session_id") or "") == session_id]
    return [svc.public(db, ws, d) for d in rows[: max(1, min(limit, 500))]]


class DocCreate(BaseModel):
    title: str = ""
    path: str = ""
    content: Optional[str] = None
    status: str = "draft"
    stage: str = ""
    owner_agent_id: str = ""
    parent_doc_id: str = ""
    origin: str = "chat"
    meta: dict[str, Any] = {}
    summary: str = ""
    session_id: str = ""


@router.post("", status_code=201)
def create_doc(body: DocCreate, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    if body.status not in DOC_STATUSES:
        raise ApiError(400, "bad_request", f"status 必須是 {'/'.join(DOC_STATUSES)}")
    if body.origin not in DOC_ORIGINS:
        raise ApiError(400, "bad_request", f"origin 必須是 {'/'.join(DOC_ORIGINS)}")
    ws = workspace_of(request)
    if body.parent_doc_id:
        _doc(db, p, body.parent_doc_id)
    try:
        doc, v = svc.create_doc(db, ws, company_id=p.company_id, title=body.title, path=body.path, content=body.content,
                                status=body.status, stage=body.stage, owner_agent_id=body.owner_agent_id,
                                parent_doc_id=body.parent_doc_id, origin=body.origin, meta=body.meta,
                                created_by=p.member.id, author_kind="human", author_id=p.member.id,
                                summary=body.summary, session_id=body.session_id)
        if body.parent_doc_id:
            svc.link(db, body.parent_doc_id, doc.id, "derived", company_id=p.company_id)
        db.commit()
        db.refresh(doc)
    except svc.DocError as e:
        db.rollback()
        raise _err(e)
    _event("doc.created", doc, {"title": doc.title, "path": doc.path, "origin": doc.origin,
                                "version": v.version if v else None}, member_id=p.member.id)
    return svc.public(db, ws, doc, content=True)


# ------------------------------------------------------------------ 單一文件
@router.get("/{doc_id}")
def get_doc(doc_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return svc.public(db, workspace_of(request), _doc(db, p, doc_id), content=True)


class DocPatch(BaseModel):
    title: Optional[str] = None
    status: Optional[str] = None
    stage: Optional[str] = None
    owner_agent_id: Optional[str] = None
    path: Optional[str] = None
    meta: Optional[dict[str, Any]] = None


@router.patch("/{doc_id}")
def patch_doc(doc_id: str, body: DocPatch, request: Request, p: Principal = Depends(current_principal),
              db: Session = Depends(get_db)):
    ws = workspace_of(request)
    doc = _doc(db, p, doc_id)
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise ApiError(400, "bad_request", "title 不可為空")
        doc.title = t[:200]
    if body.status is not None:
        if body.status not in DOC_STATUSES:
            raise ApiError(400, "bad_request", f"status 必須是 {'/'.join(DOC_STATUSES)}")
        doc.status = body.status
    if body.stage is not None:
        doc.stage = body.stage[:80]
    if body.owner_agent_id is not None:
        doc.owner_agent_id = body.owner_agent_id
    if body.meta is not None:
        doc.meta_json = json.dumps(body.meta, ensure_ascii=False)
    if body.path is not None and body.path.strip():
        try:
            new_rel = svc.to_relative(ws, body.path.strip())
            old = svc.resolve(ws, doc.path)
            dst = svc.resolve(ws, new_rel)
        except svc.DocError as e:
            raise _err(e)
        if new_rel != doc.path:
            if svc.by_path(db, p.company_id, new_rel) is not None:
                raise ApiError(409, "path_taken", f"{new_rel} 已經有別的文件")
            dst.parent.mkdir(parents=True, exist_ok=True)
            last = svc.latest(db, doc.id)
            dst.write_text(last.content if last else "", encoding="utf-8")
            if old.is_file() and old != dst:
                old.unlink(missing_ok=True)
            doc.path = new_rel
            doc.file_mtime = dst.stat().st_mtime
    doc.updated_at = now()
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return svc.public(db, ws, doc, content=True)


@router.delete("/{doc_id}", status_code=204)
def delete_doc(doc_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """刪 DB 列與血緣邊；工作區的 .md 檔保留（人可能還要看）。"""
    p.require_admin()
    doc = _doc(db, p, doc_id)
    for v in db.exec(select(DocVersion).where(DocVersion.doc_id == doc.id)).all():
        db.delete(v)
    for l in db.exec(select(DocLink).where((DocLink.from_doc_id == doc.id) | (DocLink.to_doc_id == doc.id))).all():
        db.delete(l)
    db.delete(doc)
    db.commit()
    return None


# ------------------------------------------------------------------ 版本
@router.get("/{doc_id}/versions")
def list_versions(doc_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    doc = _doc(db, p, doc_id)
    rows = db.exec(select(DocVersion).where(DocVersion.doc_id == doc.id).order_by(DocVersion.version.desc())).all()
    return [v.meta() for v in rows]


class VersionCreate(BaseModel):
    content: str
    summary: str = ""
    author_kind: str = "human"
    author_id: str = ""
    session_id: str = ""
    run_id: str = ""


@router.post("/{doc_id}/versions", status_code=201)
def create_version(doc_id: str, body: VersionCreate, request: Request, p: Principal = Depends(current_principal),
                   db: Session = Depends(get_db)):
    ws = workspace_of(request)
    doc = _doc(db, p, doc_id)
    try:
        v, created = svc.add_version(db, ws, doc, body.content, author_kind=body.author_kind,
                                     author_id=body.author_id or p.member.id, summary=body.summary,
                                     session_id=body.session_id, run_id=body.run_id)
        db.commit()
        db.refresh(v)
    except svc.DocError as e:
        db.rollback()
        raise _err(e)
    if created:
        _event("doc.updated", doc, {"version": v.version, "summary": v.summary,
                                    "diff_stat": {"added": v.added, "removed": v.removed}}, member_id=p.member.id)
    return {**v.meta(), "same": not created}


@router.get("/{doc_id}/versions/{version}")
def get_version(doc_id: str, version: int, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    doc = _doc(db, p, doc_id)
    v = svc.version_at(db, doc.id, version)
    if v is None:
        raise ApiError(404, "not_found", "version not found")
    return v.to_dict()


@router.get("/{doc_id}/diff")
def diff(doc_id: str, request: Request, a: Optional[int] = None, b: Optional[int] = None,
         p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """a→b 的 unified diff。b 省略＝最新；a 省略＝b 的前一版；b=-1 代表「檔案現況」。"""
    ws = workspace_of(request)
    doc = _doc(db, p, doc_id)
    last = svc.latest(db, doc.id)
    if last is None:
        raise ApiError(404, "not_found", "version not found")
    if b == -1:
        b_text, b_label, b_num = (svc.read_file(ws, doc) or ""), "current file", last.version
    else:
        b_num = last.version if b is None else b
        vb = svc.version_at(db, doc.id, b_num)
        if vb is None:
            raise ApiError(404, "not_found", "version not found")
        b_text, b_label = vb.content, f"v{vb.version}"
    a_num = (b_num - 1 if b != -1 else last.version) if a is None else a
    va = svc.version_at(db, doc.id, a_num)
    res = svc.unified(va.content if va else "", b_text, f"v{a_num}" if va else "(empty)", b_label)
    return {"doc_id": doc.id, "from": a_num if va else None, "to": (None if b == -1 else b_num), **res}


class RevertBody(BaseModel):
    version: int
    summary: str = ""


@router.post("/{doc_id}/revert")
def revert(doc_id: str, body: RevertBody, request: Request, p: Principal = Depends(current_principal),
           db: Session = Depends(get_db)):
    """回滾＝把舊版內容寫成一個新版本（歷史不可變）。"""
    ws = workspace_of(request)
    doc = _doc(db, p, doc_id)
    target = svc.version_at(db, doc.id, body.version)
    if target is None:
        raise ApiError(404, "not_found", "version not found")
    try:
        v, created = svc.add_version(db, ws, doc, target.content, author_kind="human", author_id=p.member.id,
                                     summary=body.summary or f"還原到 v{target.version}", force=True)
        db.commit()
        db.refresh(v)
    except svc.DocError as e:
        db.rollback()
        raise _err(e)
    _event("doc.updated", doc, {"version": v.version, "reverted_to": target.version}, member_id=p.member.id)
    return {**v.meta(), "reverted_to": target.version}


class SnapshotBody(BaseModel):
    summary: str = "把檔案現況存成新版本"


@router.post("/{doc_id}/snapshot")
def snapshot(doc_id: str, request: Request, body: Optional[SnapshotBody] = None,
             p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """漂移修復：外部改了 .md → 把檔案現況記成新版本。"""
    ws = workspace_of(request)
    doc = _doc(db, p, doc_id)
    content = svc.read_file(ws, doc)
    if content is None:
        raise ApiError(404, "not_found", "檔案不存在")
    try:
        v, created = svc.add_version(db, ws, doc, content, author_kind="human", author_id=p.member.id,
                                     summary=(body.summary if body else "把檔案現況存成新版本"))
        db.commit()
        db.refresh(v)
    except svc.DocError as e:
        db.rollback()
        raise _err(e)
    return {**v.meta(), "same": not created}


# ------------------------------------------------------------------ 血緣／分身
@router.get("/{doc_id}/lineage")
def get_lineage(doc_id: str, request: Request, depth: int = 6, p: Principal = Depends(current_principal),
                db: Session = Depends(get_db)):
    try:
        return svc.lineage(db, workspace_of(request), p.company_id, doc_id, depth=depth)
    except svc.DocError as e:
        raise _err(e)


class ForkBody(BaseModel):
    title: str = ""
    path: str = ""
    kind: str = "derived"
    stage: str = ""


@router.post("/{doc_id}/fork", status_code=201)
def fork(doc_id: str, body: ForkBody, request: Request, p: Principal = Depends(current_principal),
         db: Session = Depends(get_db)):
    if body.kind not in LINK_KINDS:
        raise ApiError(400, "bad_request", f"kind 必須是 {'/'.join(LINK_KINDS)}")
    ws = workspace_of(request)
    src = _doc(db, p, doc_id)
    last = svc.latest(db, src.id)
    try:
        doc, _ = svc.create_doc(db, ws, company_id=p.company_id, title=body.title or f"{src.title}（分支）",
                                path=body.path, content=last.content if last else "", status="draft",
                                stage=body.stage or src.stage, owner_agent_id=src.owner_agent_id,
                                parent_doc_id=src.id, origin=src.origin, meta=src.meta(), created_by=p.member.id,
                                author_kind="human", author_id=p.member.id, summary=f"從 {src.title} 分出")
        svc.link(db, src.id, doc.id, body.kind, company_id=p.company_id)
        db.commit()
        db.refresh(doc)
    except svc.DocError as e:
        db.rollback()
        raise _err(e)
    _event("doc.created", doc, {"forked_from": src.id, "kind": body.kind}, member_id=p.member.id)
    return svc.public(db, ws, doc, content=True)
