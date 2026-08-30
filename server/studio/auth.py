"""Password hashing (bcrypt) + JWT + FastAPI dependencies."""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, Request, WebSocket
from sqlmodel import Session, select

from .errors import ApiError
from .models import Member


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("ascii")


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("ascii"))
    except ValueError:
        return False


def make_token(member: Member, secret: str, ttl: int) -> str:
    payload = {"sub": member.id, "cid": member.company_id, "role": member.role, "exp": int(time.time()) + ttl}
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_token(token: str, secret: str) -> dict:
    try:
        return jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.PyJWTError as e:
        raise ApiError(401, "unauthorized", f"invalid token: {e}")


@dataclass
class Principal:
    member: Member

    @property
    def company_id(self) -> str:
        return self.member.company_id

    @property
    def role(self) -> str:
        return self.member.role

    def require_admin(self) -> None:
        if self.role not in ("owner", "admin"):
            raise ApiError(403, "forbidden", "需要 owner 或 admin 權限")


def _resolve(token: str, secret: str, db: Session) -> Principal:
    claims = decode_token(token, secret)
    member = db.get(Member, claims.get("sub", ""))
    if member is None:
        raise ApiError(401, "unauthorized", "member no longer exists")
    return Principal(member=member)


def get_db(request: Request):
    with Session(request.app.state.engine) as s:
        yield s


def current_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise ApiError(401, "unauthorized", "missing bearer token")
    return _resolve(auth[7:].strip(), request.app.state.settings.secret, db)


def principal_from_ws(ws: WebSocket, db: Session) -> Principal:
    token = ws.query_params.get("token") or ""
    if not token:
        auth = ws.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
    if not token:
        raise ApiError(401, "unauthorized", "missing token")
    return _resolve(token, ws.app.state.settings.secret, db)


def member_profiles(m: Member) -> list[str]:
    """已指派的 profile 清單（純資料，不含權限判斷）。"""
    import json
    try:
        v = json.loads(getattr(m, "profiles_json", None) or "[]")
        return [str(x) for x in v] if isinstance(v, list) else []
    except (TypeError, ValueError):
        return []


def allowed_profiles(m: Member) -> Optional[list[str]]:
    """回傳成員可見的 Hermes profile 清單；None 代表不受限（super admin）。

    規則（H 多 Profile 帳號綁定）：
    - owner：None（全部可見）
    - admin：有指派就只看指派；沒指派（空清單）視為全部可見（向下相容既有 admin）
    - member：只看指派；沒指派 → 空清單（什麼都看不到）
    其他模組用 `profile_visible(m, name)` 判斷。"""
    if m.role == "owner":
        return None
    assigned = member_profiles(m)
    if m.role == "admin" and not assigned:
        return None
    return assigned


def profile_visible(m: Member, profile: str) -> bool:
    allowed = allowed_profiles(m)
    return True if allowed is None else profile in allowed


def member_public(m: Member) -> dict:
    return {"id": m.id, "username": m.username, "role": m.role, "company_id": m.company_id, "created_at": m.created_at,
            "profiles": member_profiles(m), "all_profiles": allowed_profiles(m) is None}
