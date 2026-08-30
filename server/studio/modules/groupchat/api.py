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
from ...models import Agent, Member
from .models import Room, RoomMember, RoomMessage, RoomSummary
from .service import Orchestrator, estimate_tokens

log = logging.getLogger("studio.groupchat")
router = APIRouter(prefix="/groupchat", tags=["groupchat"])

POLICIES = ("none", "round_robin", "host")


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
    app.state.groupchat = Orchestrator(app.state.engine, app.state.gateway, hub.broadcast)


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


def _room_view(db: Session, room: Room) -> dict[str, Any]:
    d = room.to_dict()
    d["members"] = [m.to_dict() for m in _members(db, room.id)]
    last = db.exec(select(RoomMessage).where(RoomMessage.room_id == room.id).order_by(RoomMessage.seq.desc())).first()
    d["last_message"] = last.to_dict() if last else None
    d["message_count"] = len(db.exec(select(RoomMessage.id).where(RoomMessage.room_id == room.id)).all())
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
def list_rooms(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    rooms = db.exec(select(Room).where(Room.company_id == p.company_id).order_by(Room.updated_at.desc())).all()
    if p.role not in ("owner", "admin"):
        mine = {m.room_id for m in db.exec(select(RoomMember).where(RoomMember.member_id == p.member.id)).all()}
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
    return _room_view(db, room)


@router.patch("/rooms/{room_id}")
def patch_room(room_id: str, body: RoomPatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    if body.no_mention_policy is not None and body.no_mention_policy not in POLICIES:
        raise bad_request(f"no_mention_policy 必須是 {POLICIES}")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(room, k, v)
    db.add(room)
    db.commit()
    db.refresh(room)
    return _room_view(db, room)


@router.delete("/rooms/{room_id}", status_code=204)
def delete_room(room_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    if room.created_by != p.member.id and p.role not in ("owner", "admin"):
        raise ApiError(403, "forbidden", "只有建立者或管理者可以刪除房間")
    for model in (RoomMessage, RoomSummary, RoomMember):
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
def add_member(room_id: str, body: MemberAdd, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
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
def remove_member(room_id: str, rm_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
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
    db.delete(m)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# messages / summaries
# ---------------------------------------------------------------------------
@router.get("/rooms/{room_id}/messages")
def list_messages(room_id: str, before_seq: Optional[int] = None, limit: int = 100,
                  p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    _my_membership(db, p, room)
    q = select(RoomMessage).where(RoomMessage.room_id == room.id)
    if before_seq is not None:
        q = q.where(RoomMessage.seq < before_seq)
    rows = db.exec(q.order_by(RoomMessage.seq.desc()).limit(max(1, min(limit, 500)))).all()
    return [m.to_dict() for m in reversed(rows)]


class MessageIn(BaseModel):
    content: str


@router.post("/rooms/{room_id}/messages", status_code=201)
async def post_message(room_id: str, body: MessageIn, request: Request, p: Principal = Depends(current_principal),
                       db: Session = Depends(get_db)):
    room = _get_room(db, p, room_id)
    me = _my_membership(db, p, room)
    text = body.content.strip()
    if not text:
        raise bad_request("content 不可為空")
    db.expunge(me)
    msg = await _orch(request).post(room.id, me, text)
    return msg.to_dict()


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
                await orch.post(room_id, me, text)
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
