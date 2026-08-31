"""search REST：`GET /search`、機器 token、重建索引、安裝 skill。"""
from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, allowed_profiles, current_principal, get_db
from ...errors import ApiError, bad_request, not_found
from . import fts, install as installer
from .tokens import SearchToken, issue_token, resolve_machine_token

router = APIRouter(prefix="/search", tags=["search"])

SCOPE_ALIASES = {"all": list(fts.SCOPES), "chat": ["chat"], "group": ["group"], "groupchat": ["group"],
                 "workflow": ["workflow"], "workflows": ["workflow"], "events": ["events"], "event": ["events"]}


def read_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    auth = request.headers.get("authorization", "")
    tok = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if tok.startswith("mhc_"):
        return resolve_machine_token(tok, db)
    return current_principal(request, db)


def _iso(v: Optional[str], name: str) -> Optional[str]:
    if not v:
        return None
    s = v.strip()
    try:
        if len(s) == 10:
            return datetime.fromisoformat(s).isoformat()
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None).isoformat()
    except ValueError:
        raise bad_request(f"{name} 需為 ISO 8601 時間", "bad_time")


def _sync(request: Request) -> None:
    fts.drain(request.app.state.engine)


@router.get("")
def search(request: Request, q: str = "", scope: str = "all", frm: Optional[str] = Query(None, alias="from"),
           to: Optional[str] = None, agent: Optional[str] = None, limit: int = 20, offset: int = 0,
           p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    """全站搜尋（FTS5）：`q` 必填；`scope`＝chat|group|workflow|events|all（可逗號並列）；`from`/`to` ISO 時間；`agent` 篩 profile。"""
    term = (q or "").strip()
    if not term:
        return {"items": [], "total": 0, "q": "", "scopes": []}
    scopes: list[str] = []
    for s in scope.split(","):
        s = s.strip().lower()
        if not s:
            continue
        if s not in SCOPE_ALIASES:
            raise bad_request(f"scope 只能是 {', '.join(sorted(SCOPE_ALIASES))}", "bad_scope")
        scopes.extend(x for x in SCOPE_ALIASES[s] if x not in scopes)
    scopes = scopes or list(fts.SCOPES)
    limit = max(1, min(limit, 200))
    _sync(request)
    allowed = allowed_profiles(p.member)
    member_id = None if p.role in ("owner", "admin") else p.member.id
    items, total = fts.query(request.app.state.engine, term, company_id=p.company_id, scopes=scopes,
                             since=_iso(frm, "from"), until=_iso(to, "to"), agent=agent or None, member_id=member_id,
                             allowed_agents=list(allowed) if allowed is not None else None, limit=limit, offset=offset)
    return {"items": items, "total": total, "q": term, "scopes": scopes, "match": fts.build_match(term), "limit": limit, "offset": offset}


@router.post("/reindex")
def reindex(request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    fts.ensure_schema(request.app.state.engine)
    n = fts.reindex_all(request.app.state.engine)
    return {"ok": True, "indexed": n}


@router.get("/status")
def status(request: Request, p: Principal = Depends(current_principal)):
    from sqlalchemy import text
    with request.app.state.engine.connect() as conn:
        docs = int(conn.execute(text("SELECT COUNT(*) FROM search_index")).scalar() or 0)
        by = conn.execute(text("SELECT scope, COUNT(*) FROM search_index GROUP BY scope")).fetchall()
        dirty = int(conn.execute(text("SELECT COUNT(*) FROM search_dirty")).scalar() or 0)
    return {"documents": docs, "by_scope": {s: int(c) for s, c in by}, "dirty": dirty, "scopes": list(fts.SCOPES)}


# ---------------------------------------------------------------- 機器 token（owner）

class TokenBody(BaseModel):
    label: str = ""
    can_write: bool = False  # 讓 mhc-code 可以派工作給 coding 員工（寫入動作），預設 false＝唯讀


def _require_owner(p: Principal) -> None:
    if p.role != "owner":
        raise ApiError(403, "forbidden", "需要 owner 權限")


@router.post("/tokens", status_code=201)
def create_token(body: TokenBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """發一個唯讀機器 token；明文只回這一次。"""
    _require_owner(p)
    row, raw = issue_token(db, p.member, body.label, can_write=body.can_write)
    try:
        from ..events import record
        record("search.token.created", "studio", f"search_token:{row.id}", {"label": row.label, "can_write": row.can_write}, member_id=p.member.id,
               company_id=p.company_id, db=db)
    except Exception:
        pass
    db.commit()
    db.refresh(row)
    return {**row.to_dict(), "token": raw}


@router.get("/tokens")
def list_tokens(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _require_owner(p)
    rows = db.exec(select(SearchToken).where(SearchToken.company_id == p.company_id).order_by(SearchToken.created_at.desc())).all()
    return [r.to_dict() for r in rows]


@router.delete("/tokens/{token_id}")
def revoke_token(token_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _require_owner(p)
    row = db.get(SearchToken, token_id)
    if row is None or row.company_id != p.company_id:
        raise not_found("token")
    row.revoked = True
    db.add(row)
    try:
        from ..events import record
        record("search.token.revoked", "studio", f"search_token:{row.id}", {"label": row.label}, member_id=p.member.id,
               company_id=p.company_id, db=db)
    except Exception:
        pass
    db.commit()
    return {"ok": True, "id": row.id, "revoked": True}


# ---------------------------------------------------------------- 安裝 skill（owner）

class InstallBody(BaseModel):
    profile: str = ""  # 空＝default（~/.hermes/skills/）
    name: str = "mhc-search"  # mhc-search（唯讀查詢）| mhc-code（派工作給 coding 員工）
    write_env: bool = False  # 把 MHC_STUDIO_URL／token 寫進該 profile 的 .env
    create_token: bool = False  # write_env 時順便發一個新 token（否則只寫 URL）
    can_write: bool = False  # 發的 token 可不可以派工作（mhc-code 需要）
    studio_url: str = ""  # 空＝依本伺服器 host/port


@router.post("/install-skill")
def install_skill(body: InstallBody, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """把 hermes-skills/mhc-search 複製到 Hermes profile 的 skills 目錄。只新增／覆寫該 skill 目錄，不碰 profile 其他內容。"""
    _require_owner(p)
    settings = request.app.state.settings
    home = Path(getattr(settings, "hermes_home", "~/.hermes")).expanduser()
    name = (body.name or installer.SKILL_NAME).strip()
    if name not in installer.SKILL_TOKEN_ENV:
        raise bad_request(f"未知的 skill：{name}", "unknown_skill")
    try:
        dst = installer.install_skill(home, body.profile or None, name)
    except FileNotFoundError as e:
        raise not_found(str(e))
    out: dict[str, Any] = {"ok": True, "skill": name, "installed_to": str(dst), "profile": body.profile or "default",
                           "env_written": False}
    if body.write_env:
        url = body.studio_url or f"http://{getattr(settings, 'host', '127.0.0.1')}:{getattr(settings, 'port', 8700)}"
        raw = None
        if body.create_token:
            can_write = body.can_write or name == "mhc-code"
            row, raw = issue_token(db, p.member, f"{name}:{body.profile or 'default'}", can_write=can_write)
            out["token_id"] = row.id
            out["token_can_write"] = can_write
        path = installer.write_env(home, body.profile or None, raw, url, name=name)
        out.update({"env_written": True, "env_file": str(path), "studio_url": url, "token_created": raw is not None,
                    "env_key": installer.SKILL_TOKEN_ENV[name]})
    try:
        from ..events import record
        record("search.skill.installed", "studio", f"profile:{body.profile or 'default'}", {"skill": name, "path": str(dst), "env": out["env_written"]},
               member_id=p.member.id, company_id=p.company_id, db=db)
    except Exception:
        pass
    db.commit()
    return out
