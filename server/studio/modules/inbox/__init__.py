"""inbox 模組：把所有「需要人決定」的東西聚合成一頁。

來源：
1. 工作流閘門待核准 → workflow_approvals(status=pending)（workflows 模組的表，唯讀；決定走 /workflow-approvals/{id}/approve|reject）
2. 對話危險指令 approval.request → 本模組 pending_approvals（chat_ws 收到事件時直接 import 本模組 `record()`；對話頁決定→`mark_decided()`，收件匣決定→resolve 代呼 gateway 並推 approval.responded 回對話 WS；forward 只做一次）
3. 看板 blocked 卡 → `hermes kanban list --json --status blocked`（＋ diagnostics 補說明）
4. 群聊 @ 人類 → room_messages 內含 @<人類顯示名>（groupchat 沒有 mention 表，掃最近訊息）
5. 其他模組推進來的 inbox_items（例：limits 超額停用）

其他模組要塞待辦：`from studio.modules.inbox import add_item`。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, allowed_profiles, current_principal, get_db, profile_visible
from ...errors import ApiError, bad_request, not_found
from ...models import Agent, ChatSession, Member, WorkflowApproval, now
from .models import InboxDone, InboxItem, PendingApproval  # noqa: F401 (register tables)

log = logging.getLogger("studio.inbox")
router = APIRouter(prefix="/inbox", tags=["inbox"])

_engine = None


def add_item(company_id: str, kind: str, title: str, detail: str = "", *, ref: str = "", link: str = "", agent: str = "",
             db: Optional[Session] = None, dedupe: bool = True) -> Optional[InboxItem]:
    """給其他模組用：塞一筆一般待辦。dedupe=True 時同 company+kind+ref 已有 open 的就不重複。"""
    def _do(s: Session) -> Optional[InboxItem]:
        if dedupe and ref:
            ex = s.exec(select(InboxItem).where(InboxItem.company_id == company_id, InboxItem.kind == kind,
                                                InboxItem.ref == ref, InboxItem.status == "open")).first()
            if ex:
                return ex
        it = InboxItem(company_id=company_id, kind=kind, title=title, detail=detail, ref=ref, link=link, agent=agent)
        s.add(it)
        return it

    if db is not None:
        return _do(db)
    if _engine is None:
        return None
    try:
        with Session(_engine) as s:
            it = _do(s)
            s.commit()
            s.refresh(it)
            return it
    except Exception as e:
        log.warning("inbox.add_item failed: %s", e)
        return None


def _event(kind: str, source: str, subject: str, payload: dict, **kw) -> None:
    try:
        from ..events import record
        record(kind, source, subject, payload, **kw)
    except Exception as e:  # events 模組不在也不影響
        log.debug("event record skipped: %s", e)


# -- 給 chat_ws 直接呼叫的服務函式（不走 HTTP） ------------------------------------
def record(*, company_id: str, member_id: str, session_id: str, run_id: str, approval_id: str = "", agent: str = "",
           command: str = "", context: Optional[dict] = None, engine=None) -> Optional[str]:
    """chat_ws 收到 approval.request 時落一筆 pending；冪等（同 run_id＋approval_id 仍 pending 就回既有 id）。回 pending id。"""
    eng = engine or _engine
    if eng is None:
        return None
    approval_id = approval_id or run_id
    try:
        with Session(eng) as db:
            ex = db.exec(select(PendingApproval).where(PendingApproval.run_id == run_id, PendingApproval.approval_id == approval_id,
                                                        PendingApproval.status == "pending")).first()
            if ex:
                return ex.id
            a = PendingApproval(company_id=company_id, member_id=member_id, session_id=session_id, run_id=run_id, approval_id=approval_id,
                                agent=agent, command=command or "", context_json=json.dumps(context or {}, ensure_ascii=False, default=str))
            db.add(a)
            db.commit()
            db.refresh(a)
            _event("approval.request", "chat", f"run:{run_id}", {"command": a.command, "session_id": session_id, "pending_id": a.id},
                   member_id=member_id, agent=agent, company_id=company_id)
            return a.id
    except Exception as e:
        log.warning("inbox.record failed: %s", e)
        return None


def lookup(run_id: str, approval_id: str = "", engine=None) -> Optional[dict[str, Any]]:
    """查這筆 approval 的現況（None＝沒記錄）。chat_ws 在 forward 前先問：已決定就不要再送 gateway。"""
    eng = engine or _engine
    if eng is None:
        return None
    approval_id = approval_id or run_id
    with Session(eng) as db:
        a = db.exec(select(PendingApproval).where(PendingApproval.run_id == run_id, PendingApproval.approval_id == approval_id)
                    .order_by(PendingApproval.created_at.desc())).first()
        return a.to_dict() if a else None


def mark_decided(*, run_id: str, approval_id: str = "", decision: str, member_id: str, forwarded: bool = True, engine=None) -> Optional[dict[str, Any]]:
    """chat 端（對話頁）已把決定送去 gateway：把 pending 標 resolved。回 None＝沒有 pending 記錄。"""
    eng = engine or _engine
    if eng is None:
        return None
    approval_id = approval_id or run_id
    with Session(eng) as db:
        a = db.exec(select(PendingApproval).where(PendingApproval.run_id == run_id, PendingApproval.approval_id == approval_id,
                                                    PendingApproval.status == "pending")).first()
        if a is None:
            return None
        a.status = "resolved"
        a.decision = decision
        a.decided_by = member_id
        a.resolved_at = now()
        db.add(a)
        db.commit()
        db.refresh(a)
        out = a.to_dict()
        cid = a.company_id
    _event("approval.decided", "chat", f"run:{run_id}", {"command": out["command"], "forwarded": forwarded, "pending_id": out["id"], "via": "chat"},
           member_id=member_id, agent=out["agent"], company_id=cid, decision=decision)
    return out


async def _notify_chat(run_id: str, approval_id: str, decision: str, *, session_id: str = "", member_id: str = "") -> None:
    """收件匣決定後，把 approval.responded 推回還開著的對話 WS（chat_ws 提供 registry）。
    run 已經結束時用 session／成員退而求其次，對話頁才不會停在「等你決定」。"""
    try:
        from ...api.chat_ws import notify_approval_decided
        await notify_approval_decided(run_id, approval_id, decision, session_id=session_id, member_id=member_id)
    except Exception as e:
        log.debug("notify chat skipped: %s", e)


# -- 聚合 ----------------------------------------------------------------------
def _done_refs(db: Session, company_id: str) -> set[str]:
    return {r for r in db.exec(select(InboxDone.ref).where(InboxDone.company_id == company_id)).all()}


def _wf_items(db: Session, p: Principal) -> list[dict[str, Any]]:
    out = []
    for a in db.exec(select(WorkflowApproval).where(WorkflowApproval.company_id == p.company_id, WorkflowApproval.status == "pending")
                     .order_by(WorkflowApproval.created_at.desc())).all():
        out.append({"id": f"wf:{a.id}", "kind": "workflow_gate", "ref_id": a.id, "title": f"{a.workflow_name or a.workflow_id}／{a.node_title or a.node_id}",
                    "detail": (a.payload or "")[:2000], "agent": "", "created_at": a.created_at,
                    "link": f"/workflows/{a.workflow_id}/runs/{a.run_id}", "actions": ["approve", "reject", "goto"],
                    "api": {"approve": f"/workflow-approvals/{a.id}/approve", "reject": f"/workflow-approvals/{a.id}/reject"}})
    return out


def _chat_items(db: Session, p: Principal) -> list[dict[str, Any]]:
    out = []
    for a in db.exec(select(PendingApproval).where(PendingApproval.company_id == p.company_id, PendingApproval.status == "pending")
                     .order_by(PendingApproval.created_at.desc())).all():
        if a.agent and not profile_visible(p.member, a.agent):
            continue
        ctx = json.loads(a.context_json or "{}") if a.context_json else {}
        out.append({"id": f"chat:{a.id}", "kind": "chat_approval", "ref_id": a.id, "title": a.command or ctx.get("tool") or "危險指令",
                    "detail": json.dumps(ctx, ensure_ascii=False) if ctx else "", "agent": a.agent, "created_at": a.created_at,
                    "link": f"/?session={a.session_id}", "actions": ["once", "session", "always", "deny", "goto"],
                    "api": {"resolve": f"/inbox/approvals/{a.id}/resolve"}, "run_id": a.run_id, "session_id": a.session_id})
    return out


async def _kanban_items(request: Request, p: Principal, done: set[str]) -> tuple[list[dict[str, Any]], Optional[str]]:
    cli = getattr(request.app.state, "cli", None)
    if cli is None:
        return [], "no cli"
    try:
        tasks = await cli.kanban_list("blocked")
    except Exception as e:
        return [], f"kanban unavailable: {e}"
    diag: dict[str, list[dict]] = {}
    try:
        from ..kanban.cli import KanbanCli
        for d in await KanbanCli(cli._run).diagnostics():
            diag[str(d.get("task_id") or "")] = d.get("diagnostics") or []
    except Exception:
        pass
    out = []
    for t in tasks:
        tid = str(t.get("id") or "")
        if not tid or f"kanban:{tid}" in done:
            continue
        assignee = str(t.get("assignee") or "")
        if assignee and not profile_visible(p.member, assignee):
            continue
        ds = diag.get(tid) or []
        detail = "; ".join(x.get("title") or x.get("kind") or "" for x in ds) or (t.get("block_reason") or t.get("body") or "")
        out.append({"id": f"kanban:{tid}", "kind": "kanban_blocked", "ref_id": tid, "title": str(t.get("title") or tid),
                    "detail": str(detail)[:1000], "agent": assignee, "created_at": _ts(t.get("updated_at") or t.get("blocked_at") or t.get("created_at")),
                    "link": f"/kanban?task={tid}", "actions": ["goto", "done"], "api": {"done": f"/inbox/done"}, "ref": f"kanban:{tid}"})
    return out, None


def _ts(v: Any) -> Optional[datetime]:
    if v is None or v == "":
        return None
    try:
        if isinstance(v, (int, float)):
            return datetime.utcfromtimestamp(float(v))
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, OSError, OverflowError):
        return None


def _mention_items(db: Session, p: Principal, done: set[str], days: int = 7) -> list[dict[str, Any]]:
    try:
        from ..groupchat.models import Room, RoomMember, RoomMessage
    except Exception:
        return []
    since = now() - timedelta(days=days)
    rooms = {r.id: r for r in db.exec(select(Room).where(Room.company_id == p.company_id)).all()}
    if not rooms:
        return []
    humans: dict[str, list[RoomMember]] = {}
    for rm in db.exec(select(RoomMember).where(RoomMember.room_id.in_(list(rooms)), RoomMember.kind == "human")).all():
        humans.setdefault(rm.room_id, []).append(rm)
    out = []
    msgs = db.exec(select(RoomMessage).where(RoomMessage.room_id.in_(list(rooms)), RoomMessage.created_at >= since)
                   .order_by(RoomMessage.created_at.desc()).limit(500)).all()
    for m in msgs:
        ref = f"mention:{m.id}"
        if ref in done:
            continue
        hit = [h for h in humans.get(m.room_id, []) if h.display_name and re.search(r"(^|\s)@" + re.escape(h.display_name) + r"(\b|\s|$)", m.content or "")]
        if not hit:
            continue
        # 只顯示「@ 我」或 admin 看全部
        mine = any(h.member_id == p.member.id for h in hit)
        if not mine and p.role not in ("owner", "admin"):
            continue
        sender_rm = db.get(RoomMember, m.sender_id) if m.sender_id else None
        out.append({"id": ref, "kind": "groupchat_mention", "ref_id": m.id, "title": f"{m.sender_name} 在「{rooms[m.room_id].name}」@ {', '.join(h.display_name for h in hit)}",
                    "detail": (m.content or "")[:1000], "agent": (sender_rm.profile if sender_rm and sender_rm.kind == "ai" else ""),
                    "created_at": m.created_at, "link": f"/groupchat/{m.room_id}", "actions": ["goto", "done"], "ref": ref, "api": {"done": "/inbox/done"}})
    return out


def _generic_items(db: Session, p: Principal) -> list[dict[str, Any]]:
    out = []
    for it in db.exec(select(InboxItem).where(InboxItem.company_id == p.company_id, InboxItem.status == "open")
                      .order_by(InboxItem.created_at.desc())).all():
        if it.agent and not profile_visible(p.member, it.agent):
            continue
        out.append({"id": f"item:{it.id}", "kind": it.kind, "ref_id": it.id, "title": it.title, "detail": it.detail, "agent": it.agent,
                    "created_at": it.created_at, "link": it.link, "actions": ["goto", "done"] if it.link else ["done"],
                    "api": {"done": f"/inbox/items/{it.id}/done"}})
    return out


async def aggregate(request: Request, p: Principal, db: Session, *, with_kanban: bool = True) -> dict[str, Any]:
    done = _done_refs(db, p.company_id)
    items = _wf_items(db, p) + _chat_items(db, p) + _generic_items(db, p) + _mention_items(db, p, done)
    warnings: list[str] = []
    if with_kanban:
        k, warn = await _kanban_items(request, p, done)
        items += k
        if warn:
            warnings.append(warn)
    items.sort(key=lambda x: (x.get("created_at") or datetime.min), reverse=True)
    by_kind: dict[str, int] = {}
    for it in items:
        by_kind[it["kind"]] = by_kind.get(it["kind"], 0) + 1
    return {"items": items, "count": len(items), "by_kind": by_kind, "warnings": warnings}


@router.get("")
async def list_inbox(request: Request, kind: Optional[str] = None, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    data = await aggregate(request, p, db)
    if kind:
        data["items"] = [x for x in data["items"] if x["kind"] == kind]
    return data


@router.get("/count")
async def count_inbox(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    data = await aggregate(request, p, db)
    return {"count": data["count"], "by_kind": data["by_kind"]}


# -- 對話危險指令 -----------------------------------------------------------
class ApprovalBody(BaseModel):
    run_id: str
    session_id: str = ""
    approval_id: str = ""
    command: str = ""
    context: dict[str, Any] = {}
    agent: str = ""


class ResolveBody(BaseModel):
    decision: str  # once | session | always | deny
    forward: bool = True  # 是否代呼 gateway /v1/runs/{id}/approval（對話頁自己已送過就傳 false）


@router.post("/approvals", status_code=201)
def record_approval(body: ApprovalBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    if not body.run_id:
        raise bad_request("run_id 必填")
    ex = db.exec(select(PendingApproval).where(PendingApproval.run_id == body.run_id, PendingApproval.status == "pending",
                                                PendingApproval.approval_id == (body.approval_id or body.run_id))).first()
    if ex:
        return ex.to_dict()
    agent = body.agent
    if not agent and body.session_id:
        sess = db.get(ChatSession, body.session_id)
        if sess and sess.company_id != p.company_id:
            raise not_found("session")
        ag = db.get(Agent, sess.agent_id) if sess else None
        agent = ag.profile if ag else ""
    a = PendingApproval(company_id=p.company_id, member_id=p.member.id, session_id=body.session_id, run_id=body.run_id,
                        approval_id=body.approval_id or body.run_id, agent=agent, command=body.command,
                        context_json=json.dumps(body.context or {}, ensure_ascii=False))
    db.add(a)
    db.commit()
    db.refresh(a)
    _event("approval.request", "chat", f"run:{a.run_id}", {"command": a.command, "session_id": a.session_id, "pending_id": a.id},
           member_id=p.member.id, agent=agent, company_id=p.company_id)
    return a.to_dict()


@router.get("/approvals")
def list_approvals(status: str = "pending", p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    q = select(PendingApproval).where(PendingApproval.company_id == p.company_id)
    if status != "all":
        q = q.where(PendingApproval.status == status)
    return [a.to_dict() for a in db.exec(q.order_by(PendingApproval.created_at.desc())).all()]


@router.post("/approvals/{pa_id}/resolve")
async def resolve_approval(pa_id: str, body: ResolveBody, request: Request, p: Principal = Depends(current_principal),
                           db: Session = Depends(get_db)):
    a = db.get(PendingApproval, pa_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("approval")
    if body.decision not in ("once", "session", "always", "deny"):
        raise bad_request("decision 需為 once|session|always|deny", "bad_decision")
    if a.status != "pending":
        raise ApiError(409, "already_decided", f"已於 {a.resolved_at} 決定：{a.decision}")
    # 先落決定、先通知對話，最後才轉發 gateway：轉發後 run 可能瞬間跑完，對話 WS 就放掉這個 run，
    # 那時再通知會找不到人送（曾讓 test_ws_chat 的收件匣測試偶發卡死）。
    a.status = "resolved"
    a.decision = body.decision
    a.decided_by = p.member.id
    a.resolved_at = now()
    db.add(a)
    db.commit()
    await _notify_chat(a.run_id, a.approval_id or a.run_id, body.decision, session_id=a.session_id, member_id=a.member_id)
    forwarded = False
    if body.forward:
        gw = getattr(request.app.state, "gateway", None)
        if gw is not None:
            try:
                await gw.approve(a.agent or None, a.run_id, body.decision)
                forwarded = True
            except Exception as e:
                # run 可能已結束（對話頁先答了、或逾時）；決定已記錄，收件匣照樣清掉
                log.info("gateway approval forward failed for %s: %s", a.run_id, e)
    _event("approval.decided", "chat", f"run:{a.run_id}", {"command": a.command, "forwarded": forwarded, "pending_id": a.id, "via": "inbox"},
           member_id=p.member.id, agent=a.agent, company_id=p.company_id, decision=body.decision)
    return {"ok": True, "id": a.id, "decision": body.decision, "forwarded": forwarded}


# -- 一般待辦 / 已處理 ---------------------------------------------------------
class ItemBody(BaseModel):
    kind: str = "notice"
    title: str
    detail: str = ""
    ref: str = ""
    link: str = ""
    agent: str = ""


@router.post("/items", status_code=201)
def create_item(body: ItemBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    it = add_item(p.company_id, body.kind, body.title, body.detail, ref=body.ref, link=body.link, agent=body.agent, db=db, dedupe=False)
    db.commit()
    db.refresh(it)
    return it.to_dict()


@router.post("/items/{item_id}/done")
def done_item(item_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    it = db.get(InboxItem, item_id)
    if it is None or it.company_id != p.company_id:
        raise not_found("item")
    it.status = "done"
    it.done_by = p.member.id
    it.done_at = now()
    db.add(it)
    db.commit()
    return it.to_dict()


class DoneBody(BaseModel):
    ref: str  # kanban:<task_id> | mention:<room_message_id>


@router.post("/done")
def mark_done(body: DoneBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    if not re.match(r"^(kanban|mention):\S+$", body.ref):
        raise bad_request("ref 需為 kanban:<id> 或 mention:<id>", "bad_ref")
    if body.ref not in _done_refs(db, p.company_id):
        db.add(InboxDone(company_id=p.company_id, ref=body.ref, member_id=p.member.id))
        db.commit()
    return {"ok": True, "ref": body.ref}


@router.delete("/done")
def unmark_done(ref: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    for r in db.exec(select(InboxDone).where(InboxDone.company_id == p.company_id, InboxDone.ref == ref)).all():
        db.delete(r)
    db.commit()
    return {"ok": True}


async def on_startup(app) -> None:
    global _engine
    _engine = app.state.engine
    # 伺服器重啟後 WS 的 run 都斷了，殘留的 pending 標成 expired
    with Session(_engine) as db:
        n = 0
        for a in db.exec(select(PendingApproval).where(PendingApproval.status == "pending")).all():
            a.status = "expired"
            a.resolved_at = now()
            db.add(a)
            n += 1
        db.commit()
        if n:
            log.info("inbox: expired %d stale chat approvals", n)
