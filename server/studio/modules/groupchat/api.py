"""群聊 REST + WS。

REST 前綴 /groupchat；WS /ws/groupchat?token=<jwt>。
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, current_principal, get_db, principal_from_ws
from ...errors import ApiError, bad_request, not_found
from ...models import Agent, Member, now
from .models import Room, RoomDoc, RoomMember, RoomMessage, RoomPref, RoomReaction, RoomSummary
from .service import Orchestrator, estimate_tokens

log = logging.getLogger("studio.groupchat")
router = APIRouter(prefix="/groupchat", tags=["groupchat"])

POLICIES = ("none", "round_robin", "host", "auto")


# ---------------------------------------------------------------------------
# Hub：room_id -> 已 join 的 WebSocket
# ---------------------------------------------------------------------------
class Hub:
    def __init__(self):
        self.rooms: dict[str, set[WebSocket]] = {}
        self.lock = asyncio.Lock()

    async def join(self, room_id: str, ws: WebSocket) -> None:
        async with self.lock:
            self.rooms.setdefault(room_id, set()).add(ws)

    async def leave(self, ws: WebSocket, room_id: Optional[str] = None) -> None:
        async with self.lock:
            for rid, conns in list(self.rooms.items()):
                if room_id and rid != room_id:
                    continue
                conns.discard(ws)
                if not conns:
                    self.rooms.pop(rid, None)

    async def broadcast(self, room_id: str, payload: dict[str, Any]) -> None:
        payload = {**payload, "room_id": room_id}
        text = json.dumps(payload, ensure_ascii=False, default=str)
        conns = list(self.rooms.get(room_id, ()))
        for ws in conns:
            try:
                await ws.send_text(text)
            except Exception:
                await self.leave(ws, room_id)


def _orch(request: Request) -> Orchestrator:
    return request.app.state.groupchat


async def on_startup(app) -> None:
    hub = Hub()
    app.state.groupchat_hub = hub
    app.state.groupchat = Orchestrator(app.state.engine, app.state.gateway, hub.broadcast, app=app)


async def on_shutdown(app) -> None:
    orch = getattr(app.state, "groupchat", None)
    if orch:
        await orch.shutdown()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _get_room(db: Session, p: Principal, room_id: str) -> Room:
    room = db.get(Room, room_id)
    if room is None or room.company_id != p.company_id:
        raise not_found("room")
    return room


def _members(db: Session, room_id: str) -> list[RoomMember]:
    return list(db.exec(select(RoomMember).where(RoomMember.room_id == room_id).order_by(RoomMember.joined_at)).all())


def _my_membership(db: Session, p: Principal, room: Room) -> RoomMember:
    m = db.exec(select(RoomMember).where(RoomMember.room_id == room.id, RoomMember.member_id == p.member.id)).first()
    if m is None:
        if p.role in ("owner", "admin"):
            # 管理者可直接進任何房間：自動加入
            m = RoomMember(room_id=room.id, kind="human", member_id=p.member.id, display_name=p.member.username)
            db.add(m)
            db.commit()
            db.refresh(m)
        else:
            raise ApiError(403, "forbidden", "你不是這個房間的成員，請用邀請碼加入")
    return m


def _pref(db: Session, room_id: str, member_id: str, *, create: bool = False) -> Optional[RoomPref]:
    row = db.exec(select(RoomPref).where(RoomPref.room_id == room_id, RoomPref.member_id == member_id)).first()
    if row is None and create:
        row = RoomPref(room_id=room_id, member_id=member_id)
        db.add(row)
        db.flush()
    return row


def _room_view(db: Session, room: Room, member_id: str = "") -> dict[str, Any]:
    d = room.to_dict()
    members = _members(db, room.id)
    d["members"] = [m.to_dict() for m in members]
    main = select(RoomMessage).where(RoomMessage.room_id == room.id, RoomMessage.thread_root_id == "")
    last = db.exec(main.order_by(RoomMessage.seq.desc())).first()
    d["last_message"] = last.to_dict() if last else None
    d["message_count"] = len(db.exec(select(RoomMessage.id).where(RoomMessage.room_id == room.id)).all())
    if member_id:
        pref = _pref(db, room.id, member_id)
        mine = {m.id for m in members if m.member_id == member_id}
        last_read = pref.last_read_seq if pref else 0
        unread = [r for r in db.exec(select(RoomMessage.sender_id).where(
            RoomMessage.room_id == room.id, RoomMessage.thread_root_id == "", RoomMessage.seq > last_read)).all()
            if r not in mine]
        d.update(unread=len(unread), last_read_seq=last_read, pinned=bool(pref and pref.pinned), hidden=bool(pref and pref.hidden))
    return d


# ---------------------------------------------------------------------------
# rooms
# ---------------------------------------------------------------------------
class RoomCreate(BaseModel):
    name: str
    no_mention_policy: str = "none"
    history_n: int = 20
    compress_threshold_tokens: int = 6000
    max_ai_depth: int = 3
    agent_ids: list[str] = []  # 建立時直接加入的 AI 員工


class RoomPatch(BaseModel):
    name: Optional[str] = None
    no_mention_policy: Optional[str] = None
    host_member_id: Optional[str] = None
    summarizer_member_id: Optional[str] = None
    history_n: Optional[int] = None
    compress_threshold_tokens: Optional[int] = None
    max_ai_depth: Optional[int] = None


def _add_ai(db: Session, room: Room, agent: Agent, *, display_name: str = "", model: str = "",
            system_prompt: str = "") -> RoomMember:
    dup = db.exec(select(RoomMember).where(RoomMember.room_id == room.id, RoomMember.agent_id == agent.id)).first()
    if dup:
        return dup
    m = RoomMember(room_id=room.id, kind="ai", agent_id=agent.id, display_name=display_name or agent.name,
                   profile=agent.profile, model=model or agent.model or "", system_prompt=system_prompt)
    db.add(m)
    db.flush()
    if not room.summarizer_member_id:
        room.summarizer_member_id = m.id
        db.add(room)
    return m


@router.get("/rooms")
def list_rooms(view: str = "", p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """view=messenger：只列自己在裡面的房間（含私訊），附未讀／釘選／隱藏；舊群聊頁不帶 view，行為不變（私訊不列）。"""
    rooms = db.exec(select(Room).where(Room.company_id == p.company_id).order_by(Room.updated_at.desc())).all()
    mine = {m.room_id for m in db.exec(select(RoomMember).where(RoomMember.member_id == p.member.id)).all()}
    if view == "messenger":
        rooms = [r for r in rooms if r.id in mine]
        return [_room_view(db, r, p.member.id) for r in rooms]
    rooms = [r for r in rooms if r.kind != "dm"]
    if p.role not in ("owner", "admin"):
        rooms = [r for r in rooms if r.id in mine]
    return [_room_view(db, r) for r in rooms]


@router.post("/rooms", status_code=201)
def create_room(body: RoomCreate, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    if body.no_mention_policy not in POLICIES:
        raise bad_request(f"no_mention_policy 必須是 {POLICIES}")
    if not body.name.strip():
        raise bad_request("name 不可為空")
    room = Room(company_id=p.company_id, name=body.name.strip(), no_mention_policy=body.no_mention_policy,
                history_n=max(2, body.history_n), compress_threshold_tokens=max(50, body.compress_threshold_tokens),
                max_ai_depth=max(0, min(10, body.max_ai_depth)), created_by=p.member.id)
    db.add(room)
    db.flush()
    db.add(RoomMember(room_id=room.id, kind="human", member_id=p.member.id, display_name=p.member.username))
    for aid in body.agent_ids:
        a = db.get(Agent, aid)
        if a is None or a.company_id != p.company_id:
            raise not_found(f"agent {aid}")
        _add_ai(db, room, a)
    db.commit()
    db.refresh(room)
    return _room_view(db, room)


@router.get("/rooms/{room_id}")
def get_room(room_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    return _room_view(db, room, p.member.id)


@router.patch("/rooms/{room_id}")
async def patch_room(room_id: str, body: RoomPatch, request: Request, p: Principal = Depends(current_principal),
                     db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    if body.no_mention_policy is not None and body.no_mention_policy not in POLICIES:
        raise bad_request(f"no_mention_policy 必須是 {POLICIES}")
    old_name = room.name
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(room, k, v)
    db.add(room)
    db.commit()
    db.refresh(room)
    if body.name is not None and body.name.strip() and body.name != old_name:
        await _orch(request).system_event(room.id, f"{p.member.username} 把群組改名為「{room.name}」")
    return _room_view(db, room, p.member.id)


@router.delete("/rooms/{room_id}", status_code=204)
def delete_room(room_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    if room.created_by != p.member.id and p.role not in ("owner", "admin"):
        raise ApiError(403, "forbidden", "只有建立者或管理者可以刪除房間")
    for model in (RoomMessage, RoomSummary, RoomMember, RoomReaction, RoomPref, RoomDoc):
        for row in db.exec(select(model).where(model.room_id == room.id)).all():
            db.delete(row)
    db.delete(room)
    db.commit()
    return None


class JoinBody(BaseModel):
    invite_code: str


@router.post("/rooms/join")
def join_by_code(body: JoinBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    code = body.invite_code.strip().upper()
    room = db.exec(select(Room).where(Room.invite_code == code, Room.company_id == p.company_id)).first()
    if room is None:
        raise not_found("invite code")
    m = db.exec(select(RoomMember).where(RoomMember.room_id == room.id, RoomMember.member_id == p.member.id)).first()
    if m is None:
        db.add(RoomMember(room_id=room.id, kind="human", member_id=p.member.id, display_name=p.member.username))
        db.commit()
    return _room_view(db, room)


@router.post("/rooms/{room_id}/invite/regenerate")
def regenerate_invite(room_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    from .models import _invite
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    room.invite_code = _invite()
    db.add(room)
    db.commit()
    return {"invite_code": room.invite_code}


# ---------------------------------------------------------------------------
# members
# ---------------------------------------------------------------------------
class MemberAdd(BaseModel):
    agent_id: Optional[str] = None  # 加 AI
    member_id: Optional[str] = None  # 加人類（管理者）
    display_name: str = ""
    model: str = ""
    system_prompt: str = ""


class MemberPatch(BaseModel):
    display_name: Optional[str] = None
    model: Optional[str] = None
    system_prompt: Optional[str] = None
    agent_id: Optional[str] = None  # 換 profile


@router.get("/rooms/{room_id}/members")
def list_members(room_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    return [m.to_dict() for m in _members(db, room.id)]


@router.post("/rooms/{room_id}/members", status_code=201)
async def add_member(room_id: str, body: MemberAdd, request: Request, p: Principal = Depends(current_principal),
                     db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    if body.agent_id:
        a = db.get(Agent, body.agent_id)
        if a is None or a.company_id != p.company_id:
            raise not_found("agent")
        m = _add_ai(db, room, a, display_name=body.display_name, model=body.model, system_prompt=body.system_prompt)
    elif body.member_id:
        mem = db.get(Member, body.member_id)
        if mem is None or mem.company_id != p.company_id:
            raise not_found("member")
        m = db.exec(select(RoomMember).where(RoomMember.room_id == room.id, RoomMember.member_id == mem.id)).first()
        if m is None:
            m = RoomMember(room_id=room.id, kind="human", member_id=mem.id, display_name=body.display_name or mem.username)
            db.add(m)
    else:
        raise bad_request("需要 agent_id 或 member_id")
    db.commit()
    db.refresh(m)
    if room.kind == "group":
        await _orch(request).system_event(room.id, f"{p.member.username} 把 {m.display_name} 加進群組")
    return m.to_dict()


@router.patch("/rooms/{room_id}/members/{rm_id}")
def patch_member(room_id: str, rm_id: str, body: MemberPatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    m = db.get(RoomMember, rm_id)
    if m is None or m.room_id != room.id:
        raise not_found("room member")
    if body.agent_id and m.kind == "ai":
        a = db.get(Agent, body.agent_id)
        if a is None or a.company_id != p.company_id:
            raise not_found("agent")
        m.agent_id, m.profile = a.id, a.profile
        if body.model is None:
            m.model = a.model or ""
    for k in ("display_name", "model", "system_prompt"):
        v = getattr(body, k)
        if v is not None:
            setattr(m, k, v)
    db.add(m)
    db.commit()
    db.refresh(m)
    return m.to_dict()


@router.delete("/rooms/{room_id}/members/{rm_id}", status_code=204)
async def remove_member(room_id: str, rm_id: str, request: Request, p: Principal = Depends(current_principal),
                        db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    m = db.get(RoomMember, rm_id)
    if m is None or m.room_id != room.id:
        raise not_found("room member")
    if m.kind == "human" and m.member_id == room.created_by and p.member.id != room.created_by:
        raise ApiError(403, "forbidden", "不能移除房間建立者")
    if room.host_member_id == m.id:
        room.host_member_id = None
    if room.summarizer_member_id == m.id:
        room.summarizer_member_id = None
        db.add(room)
    name, kind = m.display_name, room.kind
    db.delete(m)
    db.commit()
    if kind == "group":
        await _orch(request).system_event(room.id, f"{p.member.username} 把 {name} 移出群組")
    return None


# ---------------------------------------------------------------------------
# messages / summaries
# ---------------------------------------------------------------------------
def _enrich(db: Session, room_id: str, rows: list[RoomMessage], my_rm_ids: set[str]) -> list[dict[str, Any]]:
    """訊息加上：引用預覽、討論串回覆數、emoji 反應統計。"""
    ids = [m.id for m in rows]
    quotes: dict[str, RoomMessage] = {}
    qids = {m.reply_to_id for m in rows if m.reply_to_id}
    if qids:
        for q in db.exec(select(RoomMessage).where(RoomMessage.id.in_(list(qids)))).all():
            quotes[q.id] = q
    threads: dict[str, list[RoomMessage]] = {}
    reacts: dict[str, list[RoomReaction]] = {}
    if ids:
        for r in db.exec(select(RoomMessage).where(RoomMessage.room_id == room_id, RoomMessage.thread_root_id.in_(ids))
                         .order_by(RoomMessage.seq)).all():
            threads.setdefault(r.thread_root_id, []).append(r)
        for x in db.exec(select(RoomReaction).where(RoomReaction.message_id.in_(ids)).order_by(RoomReaction.created_at)).all():
            reacts.setdefault(x.message_id, []).append(x)
    out = []
    for m in rows:
        d = m.to_dict()
        q = quotes.get(m.reply_to_id)
        d["reply_to"] = ({"id": q.id, "sender_name": q.sender_name, "content": (q.content or "")[:200],
                          "has_doc": any(a.get("type") == "doc" for a in q.attachments())} if q else None)
        t = threads.get(m.id, [])
        d["reply_count"] = len(t)
        d["thread_last_at"] = t[-1].created_at if t else None
        d["thread_participants"] = list(dict.fromkeys(r.sender_name for r in t))[:4]
        d["reactions"] = _reaction_summary(reacts.get(m.id, []), my_rm_ids)
        out.append(d)
    return out


def _reaction_summary(rows: list[RoomReaction], my_rm_ids: set[str]) -> list[dict[str, Any]]:
    by: dict[str, dict[str, Any]] = {}
    for x in rows:
        e = by.setdefault(x.emoji, {"emoji": x.emoji, "count": 0, "mine": False, "names": []})
        e["count"] += 1
        e["names"].append(x.name)
        if x.rm_id in my_rm_ids:
            e["mine"] = True
    return list(by.values())


@router.get("/rooms/{room_id}/messages")
def list_messages(room_id: str, before_seq: Optional[int] = None, limit: int = 100, scope: str = "all", thread: str = "",
                  p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """scope=all（舊頁預設，全部）｜main（只有主對話）｜thread（`thread`＝根訊息 id：根＋回覆）。"""
    room = _get_room(db, p, room_id)
    me = _my_membership(db, p, room)
    q = select(RoomMessage).where(RoomMessage.room_id == room.id)
    if scope == "main":
        q = q.where(RoomMessage.thread_root_id == "")
    elif scope == "thread":
        if not thread:
            raise bad_request("scope=thread 需要 thread＝根訊息 id")
        q = q.where((RoomMessage.thread_root_id == thread) | (RoomMessage.id == thread))
    if before_seq is not None:
        q = q.where(RoomMessage.seq < before_seq)
    rows = list(reversed(db.exec(q.order_by(RoomMessage.seq.desc()).limit(max(1, min(limit, 500)))).all()))
    return _enrich(db, room.id, rows, {me.id})


class MessageIn(BaseModel):
    content: str
    reply_to_id: str = ""
    thread_root_id: str = ""
    doc_id: str = ""


def _check_refs(db: Session, room: Room, body: "MessageIn") -> None:
    for mid in (body.reply_to_id, body.thread_root_id):
        if mid:
            m = db.get(RoomMessage, mid)
            if m is None or m.room_id != room.id:
                raise not_found("message")
    if body.thread_root_id:
        root = db.get(RoomMessage, body.thread_root_id)
        if root and root.thread_root_id:
            raise bad_request("討論串裡不能再開討論串")
    if body.doc_id:
        from ..docs.models import Doc
        d = db.get(Doc, body.doc_id)
        if d is None or d.company_id != room.company_id:
            raise not_found("doc")


@router.post("/rooms/{room_id}/messages", status_code=201)
async def post_message(room_id: str, body: MessageIn, request: Request, p: Principal = Depends(current_principal),
                       db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    me = _my_membership(db, p, room)
    text = body.content.strip()
    if not text:
        raise bad_request("content 不可為空")
    _check_refs(db, room, body)
    db.expunge(me)
    msg = await _orch(request).post(room.id, me, text, reply_to_id=body.reply_to_id, thread_root_id=body.thread_root_id,
                                    doc_id=body.doc_id)
    _mark_read(db, room.id, p.member.id, msg.seq)
    return _orch(request).public(msg)


def _mark_read(db: Session, room_id: str, member_id: str, seq: int) -> None:
    pref = _pref(db, room_id, member_id, create=True)
    if seq > pref.last_read_seq:
        pref.last_read_seq = seq
        pref.updated_at = now()
        db.add(pref)
        db.commit()


class ReadIn(BaseModel):
    seq: Optional[int] = None  # 不帶＝讀到最新


@router.post("/rooms/{room_id}/read")
def mark_read(room_id: str, body: ReadIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    seq = body.seq
    if seq is None:
        seq = db.exec(select(RoomMessage.seq).where(RoomMessage.room_id == room.id).order_by(RoomMessage.seq.desc())).first() or 0
    _mark_read(db, room.id, p.member.id, int(seq))
    return {"room_id": room.id, "last_read_seq": _pref(db, room.id, p.member.id).last_read_seq}


class PrefIn(BaseModel):
    pinned: Optional[bool] = None
    hidden: Optional[bool] = None


@router.patch("/rooms/{room_id}/prefs")
def patch_prefs(room_id: str, body: PrefIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """釘選／隱藏只影響自己的清單（隱藏不刪任何東西，Bot 照常運作）。"""
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    pref = _pref(db, room.id, p.member.id, create=True)
    if body.pinned is not None:
        pref.pinned = body.pinned
    if body.hidden is not None:
        pref.hidden = body.hidden
    pref.updated_at = now()
    db.add(pref)
    db.commit()
    return _room_view(db, room, p.member.id)


class ReactIn(BaseModel):
    emoji: str


@router.post("/rooms/{room_id}/messages/{message_id}/reactions")
async def toggle_reaction(room_id: str, message_id: str, body: ReactIn, request: Request,
                          p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """同一人同一 emoji 再按一次＝取消。"""
    room = _get_room(db, p, room_id)
    me = _my_membership(db, p, room)
    m = db.get(RoomMessage, message_id)
    if m is None or m.room_id != room.id:
        raise not_found("message")
    emoji = body.emoji.strip()[:16]
    if not emoji:
        raise bad_request("emoji 不可為空")
    ex = db.exec(select(RoomReaction).where(RoomReaction.message_id == m.id, RoomReaction.rm_id == me.id,
                                            RoomReaction.emoji == emoji)).first()
    if ex:
        db.delete(ex)
    else:
        db.add(RoomReaction(room_id=room.id, message_id=m.id, rm_id=me.id, name=me.display_name, emoji=emoji))
    db.commit()
    rows = list(db.exec(select(RoomReaction).where(RoomReaction.message_id == m.id).order_by(RoomReaction.created_at)).all())
    await request.app.state.groupchat_hub.broadcast(room.id, {"type": "reaction.updated", "message_id": m.id,
                                                              "reactions": _reaction_summary(rows, set())})
    return {"message_id": m.id, "reactions": _reaction_summary(rows, {me.id})}


@router.post("/rooms/{room_id}/stop")
async def stop_room(room_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    n = await _orch(request).stop_room(room.id)
    return {"stopped": n}


class ApprovalIn(BaseModel):
    choice: str  # once | always | deny


@router.post("/rooms/{room_id}/messages/{message_id}/approval")
async def approve(room_id: str, message_id: str, body: ApprovalIn, request: Request,
                  p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    if body.choice not in ("once", "always", "deny", "session"):
        raise bad_request("choice 只能是 once／always／deny")
    from ...hermes.gateway import GatewayError
    try:
        m = await _orch(request).respond_approval(room.id, message_id, body.choice, p.member.username)
    except GatewayError as e:
        raise ApiError(e.status if 400 <= e.status < 600 else 502, "approval_failed", e.message)
    return m.to_dict()


@router.get("/rooms/{room_id}/docs")
def room_docs(room_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """這個房間流過的文件（新到舊），附最新版本號與最後改的人。"""
    from ..docs import service as dsvc
    from ..docs.models import Doc
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    out = []
    for rd in db.exec(select(RoomDoc).where(RoomDoc.room_id == room.id).order_by(RoomDoc.updated_at.desc())).all():
        doc = db.get(Doc, rd.doc_id)
        if doc is None or doc.status == "archived":
            continue
        last = dsvc.latest(db, doc.id)
        out.append({"doc_id": doc.id, "title": doc.title, "format": doc.fmt(), "version": last.version if last else 0,
                    "summary": last.summary if last else "", "author_kind": last.author_kind if last else "",
                    "author_id": last.author_id if last else "", "updated_at": rd.updated_at,
                    "first_message_id": rd.first_message_id, "last_message_id": rd.last_message_id})
    return out


class DocEditIn(BaseModel):
    content: str
    summary: str = ""


@router.post("/rooms/{room_id}/docs/{doc_id}/versions", status_code=201)
async def edit_room_doc(room_id: str, doc_id: str, body: DocEditIn, request: Request,
                        p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """人在右側面板改文件：存成新版本，並在房間貼一張「你改了 → vN」的文件卡（不觸發 Bot）。"""
    from ..docs import service as dsvc
    from ..docs.models import Doc
    room = _get_room(db, p, room_id)
    me = _my_membership(db, p, room)
    doc = db.get(Doc, doc_id)
    if doc is None or doc.company_id != room.company_id:
        raise not_found("doc")
    orch = _orch(request)
    try:
        v, created = dsvc.add_version(db, orch._workspace(), doc, body.content, author_kind="human", author_id=p.member.id,
                                      summary=body.summary.strip() or "手動編輯")
        db.commit()
        db.refresh(v)
    except dsvc.DocError as e:
        db.rollback()
        raise ApiError(e.status, e.code, e.message)
    if not created:
        return {"same": True, "version": v.version}
    card = orch._doc_card(doc, v, me, "edited")
    db.expunge(me)
    msg = orch.save_message(room.id, me, "", attachments=[card], doc_id=doc.id)
    orch.track_docs(room.id, msg.id, [card])
    await request.app.state.groupchat_hub.broadcast(room.id, {"type": "message.new", "message": msg.to_dict()})
    await request.app.state.groupchat_hub.broadcast(room.id, {"type": "docs.changed", "doc_ids": [doc.id]})
    return {"same": False, "version": v.version, "message": msg.to_dict()}


@router.get("/search")
def search(q: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """指令面板：房間名稱、訊息內容、房間文件標題（只搜自己在裡面的房間）。"""
    from ..docs.models import Doc
    term = q.strip()
    if not term:
        return {"rooms": [], "messages": [], "docs": []}
    mine = {m.room_id for m in db.exec(select(RoomMember).where(RoomMember.member_id == p.member.id)).all()}
    rooms = [r for r in db.exec(select(Room).where(Room.company_id == p.company_id)).all() if r.id in mine]
    by_id = {r.id: r for r in rooms}
    like = f"%{term}%"
    msgs = db.exec(select(RoomMessage).where(RoomMessage.room_id.in_(list(by_id)), RoomMessage.content.like(like))
                   .order_by(RoomMessage.created_at.desc()).limit(20)).all() if by_id else []
    docs_out = []
    if by_id:
        seen = set()
        for rd in db.exec(select(RoomDoc).where(RoomDoc.room_id.in_(list(by_id))).order_by(RoomDoc.updated_at.desc())).all():
            if rd.doc_id in seen:
                continue
            d = db.get(Doc, rd.doc_id)
            if d and term.lower() in (d.title or "").lower():
                seen.add(d.id)
                docs_out.append({"doc_id": d.id, "title": d.title, "room_id": rd.room_id, "room_name": by_id[rd.room_id].name,
                                 "message_id": rd.last_message_id})
    return {
        "rooms": [{"id": r.id, "name": r.name, "kind": r.kind, "dm_agent_id": r.dm_agent_id} for r in rooms
                  if term.lower() in r.name.lower()][:10],
        "messages": [{"id": m.id, "room_id": m.room_id, "room_name": by_id[m.room_id].name, "sender_name": m.sender_name,
                      "content": m.content[:200], "thread_root_id": m.thread_root_id, "created_at": m.created_at} for m in msgs],
        "docs": docs_out[:10],
    }


@router.get("/rooms/{room_id}/summaries")
def list_summaries(room_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    rows = db.exec(select(RoomSummary).where(RoomSummary.room_id == room.id).order_by(RoomSummary.covers_until_seq)).all()
    return [s.to_dict() for s in rows]


@router.post("/rooms/{room_id}/compress")
async def compress_now(room_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """手動觸發壓縮（把摘要之後的所有訊息折成摘要）。"""
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    members = _members(db, room.id)
    for m in members:
        db.expunge(m)
    db.expunge(room)
    s = await _orch(request).maybe_compress(room, members, force=True)
    if s is None:
        raise ApiError(409, "nothing_to_compress", "沒有可壓縮的訊息或房間沒有 AI 成員")
    return s.to_dict()


@router.get("/rooms/{room_id}/context")
def context_stats(room_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """上下文狀態：摘要之後累積了多少訊息／估算 token，離壓縮門檻多遠。"""
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    summary = db.exec(select(RoomSummary).where(RoomSummary.room_id == room.id).order_by(RoomSummary.covers_until_seq.desc())).first()
    q = select(RoomMessage).where(RoomMessage.room_id == room.id, RoomMessage.status == "done")
    if summary:
        q = q.where(RoomMessage.seq > summary.covers_until_seq)
    rows = db.exec(q).all()
    tokens = sum(estimate_tokens(m.content) for m in rows)
    return {"messages_since_summary": len(rows), "estimated_tokens": tokens,
            "threshold": room.compress_threshold_tokens, "history_n": room.history_n,
            "summary": summary.to_dict() if summary else None}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------
@router.websocket("/ws")  # 實際路徑 /groupchat/ws（router 有 prefix）；另外也掛 /ws/groupchat（見 ws_router）
async def ws_groupchat_prefixed(ws: WebSocket):
    await _ws_main(ws)


ws_router = APIRouter()


@ws_router.websocket("/ws/groupchat")
async def ws_groupchat(ws: WebSocket):
    await _ws_main(ws)


async def _ws_main(ws: WebSocket) -> None:
    app = ws.app
    with Session(app.state.engine) as db:
        try:
            principal = principal_from_ws(ws, db)
        except ApiError as e:
            await ws.close(code=4401, reason=e.message)
            return
        db.refresh(principal.member)
        db.expunge(principal.member)
    await ws.accept()
    hub: Hub = app.state.groupchat_hub
    orch: Orchestrator = app.state.groupchat
    send_lock = asyncio.Lock()

    async def send(payload: dict[str, Any]) -> None:
        async with send_lock:
            await ws.send_text(json.dumps(payload, ensure_ascii=False, default=str))

    await send({"type": "ready", "member_id": principal.member.id})
    joined: dict[str, RoomMember] = {}
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await send({"type": "error", "code": "bad_message", "message": "invalid JSON"})
                continue
            t = msg.get("type") if isinstance(msg, dict) else None
            room_id = str(msg.get("room_id") or "") if isinstance(msg, dict) else ""
            if t == "ping":
                await send({"type": "pong"})
            elif t == "join":
                with Session(app.state.engine) as db:
                    try:
                        room = _get_room(db, principal, room_id)
                        me = _my_membership(db, principal, room)
                    except ApiError as e:
                        await send({"type": "error", "code": e.code, "message": e.message, "room_id": room_id})
                        continue
                    db.expunge(me)
                joined[room_id] = me
                await hub.join(room_id, ws)
                await send({"type": "joined", "room_id": room_id, "member": me.to_dict()})
            elif t == "leave":
                joined.pop(room_id, None)
                await hub.leave(ws, room_id)
                await send({"type": "left", "room_id": room_id})
            elif t == "message":
                me = joined.get(room_id)
                if me is None:
                    await send({"type": "error", "code": "not_joined", "message": "先 join 房間", "room_id": room_id})
                    continue
                text = str(msg.get("content") or "").strip()
                if not text:
                    continue
                refs = MessageIn(content=text, reply_to_id=str(msg.get("reply_to_id") or ""),
                                 thread_root_id=str(msg.get("thread_root_id") or ""), doc_id=str(msg.get("doc_id") or ""))
                with Session(app.state.engine) as db:
                    try:
                        _check_refs(db, db.get(Room, room_id), refs)
                    except ApiError as e:
                        await send({"type": "error", "code": e.code, "message": e.message, "room_id": room_id})
                        continue
                sent = await orch.post(room_id, me, text, reply_to_id=refs.reply_to_id, thread_root_id=refs.thread_root_id,
                                       doc_id=refs.doc_id)
                with Session(app.state.engine) as db:
                    _mark_read(db, room_id, principal.member.id, sent.seq)
            elif t == "typing":
                me = joined.get(room_id)
                if me is not None:
                    await hub.broadcast(room_id, {"type": "human.typing", "member_id": me.id, "name": me.display_name})
            else:
                await send({"type": "error", "code": "bad_message", "message": f"unknown type: {t}"})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.leave(ws)
