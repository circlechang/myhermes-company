"""events REST：列表／篩選／單筆／手動記錄／CSV 匯出／來源統計／立即掃描。"""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select

from ...auth import Principal, allowed_profiles, current_principal, get_db
from ...errors import bad_request, not_found
from .kinds import KNOWN_KINDS, KNOWN_PREFIXES, next_seq, normalize_kind
from .models import Event

router = APIRouter(prefix="/events", tags=["events"])


def read_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    """讀取端點：接受一般 JWT，或 search 模組發的唯讀機器 token（`mhc_…`，給 Hermes skill 用）。"""
    auth = request.headers.get("authorization", "")
    tok = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if tok.startswith("mhc_"):
        try:
            from ..search.tokens import resolve_machine_token
        except Exception:  # search 模組不在
            resolve_machine_token = None
        if resolve_machine_token is not None:
            return resolve_machine_token(tok, db)
    return current_principal(request, db)


def _parse_ts(v: Optional[str], name: str) -> Optional[datetime]:
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        raise bad_request(f"{name} 需為 ISO 8601 時間", "bad_time")


def _query(p: Principal, source: Optional[str], kind: Optional[str], agent: Optional[str], member_id: Optional[str],
           subject: Optional[str], since: Optional[str], until: Optional[str], q: Optional[str]):
    stmt = select(Event).where(Event.company_id.in_([p.company_id, ""]))
    allowed = allowed_profiles(p.member)
    if allowed is not None:
        stmt = stmt.where(Event.agent.in_(list(allowed) + [""]))
    if source:
        stmt = stmt.where(Event.source == source)
    if kind:
        stmt = stmt.where(Event.kind == kind) if "*" not in kind else stmt.where(Event.kind.like(kind.replace("*", "%")))
    if agent:
        stmt = stmt.where(Event.agent == agent)
    if member_id:
        stmt = stmt.where(Event.member_id == member_id)
    if subject:
        stmt = stmt.where(Event.subject == subject)
    s, u = _parse_ts(since, "since"), _parse_ts(until, "until")
    if s:
        stmt = stmt.where(Event.ts >= s)
    if u:
        stmt = stmt.where(Event.ts <= u)
    if q:
        like = f"%{q}%"
        stmt = stmt.where((Event.payload_json.like(like)) | (Event.subject.like(like)) | (Event.kind.like(like)))
    return stmt


@router.get("")
def list_events(source: Optional[str] = None, kind: Optional[str] = None, agent: Optional[str] = None,
                member_id: Optional[str] = None, subject: Optional[str] = None, since: Optional[str] = None,
                until: Optional[str] = None, q: Optional[str] = None, limit: int = 100, offset: int = 0,
                p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    limit = max(1, min(limit, 1000))
    stmt = _query(p, source, kind, agent, member_id, subject, since, until, q)
    total = db.exec(select(func.count()).select_from(stmt.subquery())).one()
    rows = db.exec(stmt.order_by(Event.seq.desc(), Event.ts.desc(), Event.id.desc()).offset(offset).limit(limit)).all()
    return {"items": [e.to_dict() for e in rows], "total": int(total), "limit": limit, "offset": offset}


@router.get("/kinds")
def list_kinds():
    """kind 白名單（events/kinds.py）；不在名單的 kind 寫入時會變成 `other.<kind>`。"""
    return {"kinds": sorted(KNOWN_KINDS), "prefixes": list(KNOWN_PREFIXES)}


@router.get("/facets")
def facets(p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    base = select(Event).where(Event.company_id.in_([p.company_id, ""])).subquery()

    def group(col):
        rows = db.exec(select(getattr(base.c, col), func.count()).group_by(getattr(base.c, col))).all()
        return [{"value": v or "", "count": int(c)} for v, c in sorted(rows, key=lambda r: -r[1])]

    return {"sources": group("source"), "kinds": group("kind"), "agents": [x for x in group("agent") if x["value"]],
            "members": [x for x in group("member_id") if x["value"]]}


@router.get("/export.csv")
def export_csv(source: Optional[str] = None, kind: Optional[str] = None, agent: Optional[str] = None,
               member_id: Optional[str] = None, since: Optional[str] = None, until: Optional[str] = None,
               q: Optional[str] = None, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    stmt = _query(p, source, kind, agent, member_id, None, since, until, q).order_by(Event.ts.desc()).limit(50000)
    rows = db.exec(stmt).all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "ts", "kind", "source", "subject", "agent", "member_id", "company_id", "decision", "delivery", "payload"])
    for e in rows:
        w.writerow([e.id, e.ts.isoformat() if e.ts else "", e.kind, e.source, e.subject, e.agent, e.member_id, e.company_id,
                    e.decision, e.delivery, e.payload_json])
    data = ("\ufeff" + buf.getvalue()).encode("utf-8")  # BOM 讓 Excel 直接開繁中不亂碼
    return StreamingResponse(iter([data]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="events.csv"'})


class EventBody(BaseModel):
    kind: str
    source: str = "api"
    subject: str = ""
    payload: dict[str, Any] = {}
    agent: str = ""
    decision: str = ""
    delivery: str = ""
    causes: list[str] = []


@router.post("", status_code=201)
def create_event(body: EventBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """外部入口（表單／webhook 轉接／人工登記）直接記一筆事件。"""
    if not body.kind.strip():
        raise bad_request("kind 必填")
    causes = [c for c in (body.causes or []) if db.get(Event, c) is not None]
    ev = Event(kind=normalize_kind(body.kind), source=body.source or "api", subject=body.subject, agent=body.agent,
               member_id=p.member.id, company_id=p.company_id, decision=body.decision, delivery=body.delivery,
               payload_json=json.dumps(body.payload or {}, ensure_ascii=False, default=str),
               causes_json=json.dumps(causes), seq=next_seq(db))
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev.to_dict()


@router.post("/collect")
async def collect_now(request: Request, p: Principal = Depends(current_principal)):
    """立即掃描一次（admin）；平常由背景每分鐘掃。"""
    p.require_admin()
    from . import collector
    n = await collector.collect(request.app)
    return {"ok": True, "added": n}


def _visible(p: Principal, e: Event) -> bool:
    if e.company_id not in (p.company_id, ""):
        return False
    allowed = allowed_profiles(p.member)
    return allowed is None or not e.agent or e.agent in allowed


@router.get("/{event_id}")
def get_event(event_id: str, p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    e = db.get(Event, event_id)
    if e is None or not _visible(p, e):
        raise not_found("event")
    return e.to_dict()


@router.get("/{event_id}/chain")
def event_chain(event_id: str, depth: int = 10, p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    """因果鏈：沿 `causes` 往上游走（upstream，最多 depth 層）＋直接下游（downstream：causes 含此事件的）。
    回 `{event, upstream:[…由近到遠…], downstream:[…], truncated}`；看不見的事件（別家公司／不可見 profile）略過。"""
    e = db.get(Event, event_id)
    if e is None or not _visible(p, e):
        raise not_found("event")
    depth = max(1, min(depth, 50))
    upstream: list[dict[str, Any]] = []
    seen = {e.id}
    frontier = [e]
    truncated = False
    for _ in range(depth):
        nxt: list[Event] = []
        for cur in frontier:
            for cid in cur.causes:
                if cid in seen:
                    continue
                seen.add(cid)
                c = db.get(Event, cid)
                if c is not None and _visible(p, c):
                    d = c.to_dict()
                    d["effect"] = cur.id
                    upstream.append(d)
                    nxt.append(c)
        if not nxt:
            break
        frontier = nxt
    else:
        truncated = any(c.causes for c in frontier)
    down = db.exec(select(Event).where(Event.causes_json.like(f'%"{e.id}"%')).order_by(Event.seq)).all()
    downstream = [d.to_dict() for d in down if e.id in d.causes and _visible(p, d)]
    return {"event": e.to_dict(), "upstream": upstream, "downstream": downstream, "truncated": truncated}
