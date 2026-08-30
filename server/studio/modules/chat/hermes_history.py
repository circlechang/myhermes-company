"""Hermes 歷史 session：唯讀讀取 `$HERMES_HOME/state.db`（profile=default）與
`$HERMES_HOME/profiles/<p>/state.db`。只用 `file:...?mode=ro` 開啟，絕不寫入。

- GET  /chat/hermes-history?profile=&source=&q=&limit=&offset=  → sessions（依 started_at 新→舊）
- GET  /chat/hermes-history/sources                             → 各 profile 的 source 計數（側欄 badge）
- GET  /chat/hermes-history/{profile}/{sid}/messages            → 對話內容（user/assistant/tool）
- POST /chat/hermes-history/{profile}/{sid}/import {agent_id?}  → 複製成 Studio session（source=原 source）
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, current_principal, get_db
from ...errors import not_found
from ...models import Agent, ChatSession, Message, new_id, now

router = APIRouter()


def state_dbs(hermes_home: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    root = hermes_home / "state.db"
    if root.exists():
        out["default"] = root
    prof = hermes_home / "profiles"
    if prof.is_dir():
        for d in sorted(prof.iterdir()):
            f = d / "state.db"
            if d.is_dir() and f.exists():
                out[d.name] = f
    return out


def _connect(path: Path) -> sqlite3.Connection:
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=2.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _ts(v: Any) -> Optional[datetime]:
    try:
        return datetime.fromtimestamp(float(v), tz=timezone.utc).replace(tzinfo=None) if v else None
    except (TypeError, ValueError, OSError):
        return None


def _cols(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def session_row(profile: str, r: sqlite3.Row, cols: set[str]) -> dict[str, Any]:
    g = lambda k: r[k] if k in cols else None  # noqa: E731
    title = g("display_name") or g("title") or ""
    return {
        "profile": profile, "id": r["id"], "source": r["source"], "title": title or f"{r['source']} · {r['id'][:18]}",
        "model": g("model"), "started_at": _ts(r["started_at"]), "ended_at": _ts(g("ended_at")),
        "last_activity_at": _ts(g("last_activity_at")) or _ts(r["started_at"]),
        "message_count": g("message_count") or 0, "tool_call_count": g("tool_call_count") or 0,
        "input_tokens": g("input_tokens") or 0, "output_tokens": g("output_tokens") or 0,
        "archived": bool(g("archived") or 0), "user_id": g("user_id"), "chat_id": g("chat_id"),
    }


def iter_sessions(hermes_home: Path, profile: Optional[str] = None) -> Iterator[tuple[str, sqlite3.Connection]]:
    for name, path in state_dbs(hermes_home).items():
        if profile and name != profile:
            continue
        try:
            conn = _connect(path)
        except sqlite3.Error:
            continue
        try:
            yield name, conn
        finally:
            conn.close()


@router.get("/hermes-history/sources")
def history_sources(request: Request, p: Principal = Depends(current_principal)):
    home = Path(request.app.state.settings.hermes_home)
    out = []
    for name, conn in iter_sessions(home):
        try:
            rows = conn.execute("SELECT source, COUNT(*) AS n FROM sessions WHERE message_count > 0 GROUP BY source").fetchall()
            total = sum(r["n"] for r in rows)
            out.append({"profile": name, "total": total, "sources": {r["source"]: r["n"] for r in rows}})
        except sqlite3.Error as e:
            out.append({"profile": name, "total": 0, "sources": {}, "error": str(e)})
    return out


@router.get("/hermes-history")
def history_list(request: Request, profile: Optional[str] = None, source: Optional[str] = None, q: Optional[str] = None,
                 limit: int = 50, offset: int = 0, p: Principal = Depends(current_principal)):
    home = Path(request.app.state.settings.hermes_home)
    limit = max(1, min(limit, 500))
    rows_out: list[dict[str, Any]] = []
    for name, conn in iter_sessions(home, profile):
        try:
            cols = _cols(conn, "sessions")
            where = ["message_count > 0"]
            params: list[Any] = []
            if source:
                where.append("source = ?")
                params.append(source)
            if q:
                like = f"%{q}%"
                parts = ["title LIKE ?", "id LIKE ?"]
                params += [like, like]
                if "display_name" in cols:
                    parts.append("display_name LIKE ?")
                    params.append(like)
                where.append("(" + " OR ".join(parts) + ")")
            sql = f"SELECT * FROM sessions WHERE {' AND '.join(where)} ORDER BY started_at DESC LIMIT ? OFFSET ?"
            for r in conn.execute(sql, [*params, limit, offset]).fetchall():
                rows_out.append(session_row(name, r, cols))
        except sqlite3.Error:
            continue
    rows_out.sort(key=lambda s: (s["started_at"] or datetime.min), reverse=True)
    return rows_out[:limit] if profile is None else rows_out


def _parse_tool_calls(raw: Any) -> list[dict[str, Any]]:
    try:
        calls = json.loads(raw) if isinstance(raw, str) else (raw or [])
    except json.JSONDecodeError:
        return []
    out = []
    for c in calls if isinstance(calls, list) else []:
        fn = (c or {}).get("function") or {}
        args = fn.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                pass
        out.append({"call_id": c.get("call_id") or c.get("id"), "name": fn.get("name") or c.get("name") or "tool", "args": args})
    return out


def load_messages(conn: sqlite3.Connection, sid: str) -> list[dict[str, Any]]:
    cols = _cols(conn, "messages")
    rows = conn.execute("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, id", (sid,)).fetchall()
    items: list[dict[str, Any]] = []
    pending: dict[str, dict[str, Any]] = {}
    for r in rows:
        role = r["role"]
        content = r["content"] or ""
        ts = _ts(r["timestamp"])
        if role == "assistant":
            calls = _parse_tool_calls(r["tool_calls"]) if r["tool_calls"] else []
            reasoning = (r["reasoning"] if "reasoning" in cols else None) or (r["reasoning_content"] if "reasoning_content" in cols else None)
            if content.strip():
                items.append({"id": f"h{r['id']}", "role": "assistant", "content": content, "created_at": ts, "reasoning": reasoning})
            for c in calls:
                it = {"id": f"h{r['id']}_{c['call_id'] or len(items)}", "role": "tool", "content": "", "tool_name": c["name"],
                      "tool_args": c["args"], "tool_result": None, "created_at": ts}
                items.append(it)
                if c["call_id"]:
                    pending[c["call_id"]] = it
        elif role == "tool":
            cid = r["tool_call_id"]
            target = pending.pop(cid, None) if cid else None
            if target is not None:
                target["tool_result"] = content
            else:
                items.append({"id": f"h{r['id']}", "role": "tool", "content": "", "tool_name": r["tool_name"] or "tool",
                              "tool_args": None, "tool_result": content, "created_at": ts})
        elif role == "user":
            items.append({"id": f"h{r['id']}", "role": "user", "content": content, "created_at": ts})
        # system / others skipped
    return items


def _open_session(home: Path, profile: str, sid: str):
    dbs = state_dbs(home)
    path = dbs.get(profile)
    if path is None:
        raise not_found("profile")
    conn = _connect(path)
    row = conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
    if row is None:
        conn.close()
        raise not_found("hermes session")
    return conn, row


@router.get("/hermes-history/{profile}/{sid}/messages")
def history_messages(request: Request, profile: str, sid: str, p: Principal = Depends(current_principal)):
    home = Path(request.app.state.settings.hermes_home)
    conn, row = _open_session(home, profile, sid)
    try:
        return {"session": session_row(profile, row, _cols(conn, "sessions")), "messages": load_messages(conn, sid)}
    finally:
        conn.close()


class ImportBody(BaseModel):
    agent_id: Optional[str] = None
    title: Optional[str] = None


@router.post("/hermes-history/{profile}/{sid}/import", status_code=201)
def history_import(request: Request, profile: str, sid: str, body: ImportBody,
                   p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    home = Path(request.app.state.settings.hermes_home)
    conn, row = _open_session(home, profile, sid)
    try:
        meta = session_row(profile, row, _cols(conn, "sessions"))
        msgs = load_messages(conn, sid)
    finally:
        conn.close()
    agent = None
    if body.agent_id:
        agent = db.get(Agent, body.agent_id)
        if agent is None or agent.company_id != p.company_id:
            raise not_found("agent")
    if agent is None:
        agent = db.exec(select(Agent).where(Agent.company_id == p.company_id, Agent.profile == profile)).first()
    if agent is None:
        agent = db.exec(select(Agent).where(Agent.company_id == p.company_id, Agent.enabled == True)).first()  # noqa: E712
    if agent is None:
        raise not_found("agent")
    existing = db.exec(select(ChatSession).where(ChatSession.member_id == p.member.id,
                                                 ChatSession.imported_from == f"{profile}:{sid}")).first()
    if existing is not None:
        return _public(existing)
    s = ChatSession(company_id=p.company_id, member_id=p.member.id, agent_id=agent.id,
                    title=(body.title or meta["title"] or "")[:200], source=meta["source"] or "hermes",
                    hermes_session_id=new_id("studio"), model=meta.get("model") or "",
                    imported_from=f"{profile}:{sid}", input_tokens=meta["input_tokens"], output_tokens=meta["output_tokens"],
                    total_tokens=(meta["input_tokens"] or 0) + (meta["output_tokens"] or 0),
                    created_at=meta["started_at"] or now(), last_message_at=meta["last_activity_at"] or meta["started_at"])
    db.add(s)
    db.flush()
    for m in msgs:
        db.add(Message(session_id=s.id, role=m["role"], content=m.get("content") or "", tool_name=m.get("tool_name"),
                       tool_args=json.dumps(m.get("tool_args"), ensure_ascii=False) if m.get("tool_args") is not None else None,
                       tool_result=json.dumps(m.get("tool_result"), ensure_ascii=False) if m.get("tool_result") is not None else None,
                       reasoning=m.get("reasoning"), created_at=m.get("created_at") or now()))
    db.commit()
    db.refresh(s)
    return _public(s)


def _public(s: ChatSession) -> dict:
    from ...api.sessions import session_public
    return session_public(s)
