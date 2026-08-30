"""REST：套件清單／安裝／狀態 ＋ 主題資料夾與階段推進（docs/API.md「Packs」）。"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, current_principal, get_db
from ...errors import ApiError, not_found
from ...models import Agent
from . import install as inst
from .loader import Pack, PackError, discover, load_hooks, pack_roots
from .models import InstalledPack
from .stages import StageError, TopicStore, refresh, run_state, start_stage

log = logging.getLogger("studio.packs")
router = APIRouter(prefix="/packs", tags=["packs"])


# ------------------------------------------------------------------ helpers
def _roots(request: Request) -> list[Path]:
    settings = request.app.state.settings
    return pack_roots(Path(settings.db_path).parent)


def _available(request: Request) -> tuple[dict[str, Pack], dict[str, str]]:
    return discover(_roots(request))


def _pack(request: Request, name: str) -> Pack:
    packs, errors = _available(request)
    p = packs.get(name)
    if p is None:
        if name in errors:
            raise ApiError(422, "pack_invalid", errors[name])
        raise not_found("pack")
    return p


def _workspace(request: Request) -> Path:
    eng = getattr(request.app.state, "workflow_engine", None)
    if eng is not None:
        return Path(eng.workspace)
    return Path(request.app.state.settings.db_path).parent / "workspace"


def _store(request: Request, pack: Pack) -> TopicStore:
    return TopicStore(pack, _workspace(request))


def _installed_or_404(db: Session, p: Principal, name: str) -> InstalledPack:
    row = inst.installed(db, p.company_id, name)
    if row is None:
        raise ApiError(409, "not_installed", f"套件 {name} 尚未安裝")
    return row


def _hook(pack: Pack, fn_name: str, *args: Any) -> None:
    try:
        mod = load_hooks(pack)
    except PackError as e:
        log.warning("pack %s hooks 載入失敗：%s", pack.name, e)
        return
    fn = getattr(mod, fn_name, None) if mod else None
    if fn is None:
        return
    try:
        from ... import sdk
        fn(sdk, *args)
    except Exception as e:
        log.warning("pack %s hook %s 失敗：%s", pack.name, fn_name, e)


def _status(db: Session, request: Request, p: Principal, pack: Pack) -> dict[str, Any]:
    row = inst.installed(db, p.company_id, pack.name)
    hermes_home = Path(request.app.state.settings.hermes_home)
    profiles = {prof: (hermes_home / "profiles" / prof / "SOUL.md").is_file() for prof in pack.profiles}
    agents: list[dict[str, Any]] = []
    if row:
        for prof, aid in json.loads(row.agents_json or "{}").items():
            a = db.get(Agent, aid)
            agents.append({"profile": prof, "agent_id": aid, "name": a.name if a else prof, "title": a.title if a else "",
                           "enabled": bool(a and a.enabled), "exists": a is not None})
    topics = _store(request, pack).list_topics() if row else []
    return {"name": pack.name, "installed": row.to_dict() if row else None, "profiles": profiles, "agents": agents,
            "topics_count": len(topics), "workspace": str(_store(request, pack).root)}


def _raise(e: StageError):
    return ApiError(e.status, e.code, e.message)


# ------------------------------------------------------------------ packs
@router.get("")
def list_packs(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    packs, errors = _available(request)
    rows = {r.name: r for r in db.exec(select(InstalledPack).where(InstalledPack.company_id == p.company_id)).all()}
    items = []
    for name, pk in packs.items():
        d = pk.to_dict()
        d["installed"] = rows[name].to_dict() if name in rows else None
        items.append(d)
    return {"items": items, "errors": errors, "roots": [str(r) for r in _roots(request)]}


@router.get("/{name}")
def get_pack(name: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    pack = _pack(request, name)
    d = pack.to_dict()
    d["status"] = _status(db, request, p, pack)
    d["topic_files"] = list(pack.topic_files)
    return d


@router.get("/{name}/status")
def pack_status(name: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return _status(db, request, p, _pack(request, name))


@router.post("/{name}/install", status_code=201)
def install_pack(name: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    pack = _pack(request, name)
    try:
        row = inst.install(db, pack, company_id=p.company_id, member_id=p.member.id, hermes_home=Path(request.app.state.settings.hermes_home))
    except PackError as e:
        db.rollback()
        raise ApiError(422, "pack_invalid", str(e))
    _store(request, pack).root.mkdir(parents=True, exist_ok=True)
    from ... import sdk
    sdk.record_event("pack.install", "pack", f"pack:{pack.name}", {"version": pack.version, "agents": json.loads(row.agents_json),
                                                                     "workflows": json.loads(row.workflows_json)},
                     member_id=p.member.id, company_id=p.company_id)
    _hook(pack, "on_install", {"company_id": p.company_id, "member_id": p.member.id, "installed": row.to_dict()})
    return _status(db, request, p, pack)


@router.delete("/{name}")
def uninstall_pack(name: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    row = _installed_or_404(db, p, name)
    res = inst.uninstall(db, row)
    from ... import sdk
    sdk.record_event("pack.uninstall", "pack", f"pack:{name}", res, member_id=p.member.id, company_id=p.company_id)
    return res


# ------------------------------------------------------------------ topics
class TopicBody(BaseModel):
    title: str
    slug: str = ""
    notes: str = ""


class FileBody(BaseModel):
    path: str
    content: str


class RunBody(BaseModel):
    force: bool = False


class DecisionBody(BaseModel):
    comment: str = ""
    to: str = ""  # reject 專用：退回到指定階段（該階段及其後全部重置成 draft）


class EnabledBody(BaseModel):
    enabled: bool = True


def _ctx(request: Request, db: Session, p: Principal, name: str) -> tuple[Pack, InstalledPack, TopicStore]:
    pack = _pack(request, name)
    row = _installed_or_404(db, p, name)
    return pack, row, _store(request, pack)


def _on_finish(pack: Pack):
    def cb(topic_id: str, sid: str, status: str):
        _hook(pack, "on_stage_finished", {"topic_id": topic_id, "stage": sid, "status": status})
    return cb


@router.get("/{name}/topics")
def list_topics(name: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    pack, row, store = _ctx(request, db, p, name)
    return store.list_topics()


@router.post("/{name}/topics", status_code=201)
def create_topic(name: str, body: TopicBody, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    pack, row, store = _ctx(request, db, p, name)
    try:
        st = store.create_topic(body.title, slug=body.slug, notes=body.notes, member_id=p.member.id)
    except StageError as e:
        raise _raise(e)
    from ... import sdk
    sdk.record_event("pack.topic.created", "pack", f"pack:{pack.name}:{st['id']}", {"title": st["title"]}, member_id=p.member.id,
                     company_id=p.company_id)
    _hook(pack, "on_topic_created", {"topic_id": st["id"], "title": st["title"], "dir": str(store.root / st["id"])})
    return store.detail(st["id"])


@router.get("/{name}/topics/{topic_id}")
def get_topic(name: str, topic_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    pack, row, store = _ctx(request, db, p, name)
    try:
        refresh(store, topic_id, company_id=p.company_id, on_finish=_on_finish(pack))
        return store.detail(topic_id)
    except StageError as e:
        raise _raise(e)


@router.get("/{name}/topics/{topic_id}/file")
def read_file(name: str, topic_id: str, path: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    pack, row, store = _ctx(request, db, p, name)
    try:
        return store.read_file(topic_id, path)
    except StageError as e:
        raise _raise(e)


@router.put("/{name}/topics/{topic_id}/file")
def write_file(name: str, topic_id: str, body: FileBody, request: Request, p: Principal = Depends(current_principal),
               db: Session = Depends(get_db)):
    pack, row, store = _ctx(request, db, p, name)
    try:
        return store.write_file(topic_id, body.path, body.content)
    except StageError as e:
        raise _raise(e)


@router.post("/{name}/topics/{topic_id}/stages/{stage_id}/run", status_code=202)
async def run_stage(name: str, topic_id: str, stage_id: str, request: Request, body: Optional[RunBody] = None,
                    p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    pack, row, store = _ctx(request, db, p, name)
    wf_id = json.loads(row.workflows_json or "{}").get(stage_id)
    if not wf_id:
        raise ApiError(409, "no_workflow", f"階段 {stage_id} 沒有對應工作流（請重新安裝套件）")
    try:
        refresh(store, topic_id, company_id=p.company_id, on_finish=_on_finish(pack))
        return await start_stage(store, topic_id, stage_id, workflow_id=wf_id, company_id=p.company_id, member_id=p.member.id,
                                 force=bool(body and body.force), on_finish=_on_finish(pack))
    except StageError as e:
        raise _raise(e)
    except LookupError as e:
        raise ApiError(409, "no_workflow", str(e))
    except ValueError as e:
        raise ApiError(422, "workflow_invalid", str(e))
    except RuntimeError as e:
        raise ApiError(503, "unavailable", str(e))


@router.get("/{name}/topics/{topic_id}/stages/{stage_id}/run")
def stage_run(name: str, topic_id: str, stage_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    pack, row, store = _ctx(request, db, p, name)
    try:
        refresh(store, topic_id, company_id=p.company_id, on_finish=_on_finish(pack))
        st = store.read_status(store.topic_dir(topic_id))
    except StageError as e:
        raise _raise(e)
    ss = st["stages"].get(stage_id) or {}
    rs = run_state(ss["run_id"]) if ss.get("run_id") else None
    return {"stage": stage_id, "status": ss.get("status", "draft"), "run_id": ss.get("run_id"), "session_id": ss.get("session_id") or (rs or {}).get("session_id"),
            "run": rs, "history": ss.get("history", [])}


def _decide(request: Request, db: Session, p: Principal, name: str, topic_id: str, stage_id: str, event: str, comment: str,
            to: str = "") -> dict[str, Any]:
    pack, row, store = _ctx(request, db, p, name)
    try:
        refresh(store, topic_id, company_id=p.company_id, on_finish=_on_finish(pack))
        if event == "reject":
            ss = store.reject_to(topic_id, stage_id, to or stage_id, comment, member_id=p.member.id)
        else:
            ss = store.apply(topic_id, stage_id, event, member_id=p.member.id, comment=comment)
    except StageError as e:
        raise _raise(e)
    # 收件匣那筆標完成
    if ss.get("inbox_item_id"):
        try:
            from ..inbox.models import InboxItem
            from ...models import now
            it = db.get(InboxItem, ss["inbox_item_id"])
            if it and it.status == "open":
                it.status, it.done_by, it.done_at = "done", p.member.id, now()
                db.add(it)
                db.commit()
        except Exception as e:  # pragma: no cover
            log.debug("inbox item close skipped: %s", e)
    from ... import sdk
    sdk.record_event("pack.stage.decided", "pack", f"pack:{pack.name}:{topic_id}:{stage_id}",
                     {"comment": comment, "status": ss["status"], "to": to or stage_id if event == "reject" else ""},
                     member_id=p.member.id, company_id=p.company_id, decision="approved" if event == "approve" else "rejected")
    return {"ok": True, "stage": stage_id, "status": ss["status"], "to": (to or stage_id) if event == "reject" else ""}


@router.post("/{name}/topics/{topic_id}/stages/{stage_id}/approve")
def approve_stage(name: str, topic_id: str, stage_id: str, request: Request, body: Optional[DecisionBody] = None,
                  p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return _decide(request, db, p, name, topic_id, stage_id, "approve", body.comment if body else "")


@router.post("/{name}/topics/{topic_id}/stages/{stage_id}/reject")
def reject_stage(name: str, topic_id: str, stage_id: str, request: Request, body: Optional[DecisionBody] = None,
                 p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return _decide(request, db, p, name, topic_id, stage_id, "reject", body.comment if body else "", body.to if body else "")


@router.post("/{name}/topics/{topic_id}/stages/{stage_id}/enabled")
def set_stage_enabled(name: str, topic_id: str, stage_id: str, body: EnabledBody, request: Request,
                      p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """可關閉的階段（stages.yaml optional: true）：關閉＝skipped（視同完成放行下一階段），開啟＝回 draft。"""
    pack, row, store = _ctx(request, db, p, name)
    try:
        refresh(store, topic_id, company_id=p.company_id, on_finish=_on_finish(pack))
        ss = store.set_enabled(topic_id, stage_id, body.enabled, member_id=p.member.id)
    except StageError as e:
        raise _raise(e)
    from ... import sdk
    sdk.record_event("pack.stage.toggled", "pack", f"pack:{pack.name}:{topic_id}:{stage_id}", {"enabled": body.enabled, "status": ss["status"]},
                     member_id=p.member.id, company_id=p.company_id)
    return {"ok": True, "stage": stage_id, "status": ss["status"], "enabled": ss["status"] != "skipped"}
