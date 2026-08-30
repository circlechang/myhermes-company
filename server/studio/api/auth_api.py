"""登入／me。登入鎖定：同帳號或同 IP 連續失敗 N 次（預設 5）鎖 M 秒（預設 900），回 423 與剩餘秒數。
計數存 DB `login_locks`（多 worker／重啟都一致；`myhermescompany clear-login-locks` 可清）。"""
from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import Principal, current_principal, get_db, make_token, member_public, verify_password
from ..errors import ApiError
from ..models import Audit, LoginLock, Member, now

log = logging.getLogger("studio.auth")
router = APIRouter(tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _lock_keys(username: str, ip: str) -> list[str]:
    return [f"u:{username.strip().lower()[:200]}", f"ip:{ip[:100]}"]


def _remaining(lock: LoginLock | None) -> int:
    if lock is None or lock.locked_until is None:
        return 0
    return max(0, int((lock.locked_until - now()).total_seconds()))


def _check_locked(db: Session, keys: list[str]) -> int:
    """回剩餘鎖定秒數（0＝沒鎖）。過期的鎖順手清掉。"""
    worst = 0
    for k in keys:
        lock = db.get(LoginLock, k)
        if lock is None:
            continue
        rem = _remaining(lock)
        if rem > 0:
            worst = max(worst, rem)
        elif lock.locked_until is not None:
            db.delete(lock)  # 鎖到期＝重新計數
    if worst == 0:
        db.commit()
    return worst


def _record_failure(db: Session, keys: list[str], max_failures: int, lock_seconds: int, username: str, ip: str, company_id: str = "") -> int:
    """失敗＋1；達門檻就鎖。回這次是否鎖定的秒數（0＝沒鎖）。"""
    locked = 0
    for k in keys:
        lock = db.get(LoginLock, k) or LoginLock(key=k)
        lock.failures += 1
        lock.updated_at = now()
        if lock.failures >= max_failures:
            lock.locked_until = now() + timedelta(seconds=lock_seconds)
            locked = lock_seconds
        db.add(lock)
    if locked:
        db.add(Audit(company_id=company_id, member_id="", action="login.locked", target=username,
                     detail=f"ip={ip} failures>={max_failures} lock={lock_seconds}s"))
        log.warning("login locked: user=%s ip=%s for %ss", username, ip, lock_seconds)
    db.commit()
    return locked


def clear_locks(db: Session, keys: list[str] | None = None) -> int:
    """成功登入或 CLI 清鎖：刪計數列。keys=None 清全部。"""
    q = select(LoginLock) if keys is None else select(LoginLock).where(LoginLock.key.in_(keys))
    n = 0
    for lock in db.exec(q).all():
        db.delete(lock)
        n += 1
    db.commit()
    return n


@router.post("/auth/login")
def login(body: LoginBody, request: Request, db: Session = Depends(get_db)):
    st = request.app.state.settings
    ip = _client_ip(request)
    keys = _lock_keys(body.username, ip)
    rem = _check_locked(db, keys)
    if rem > 0:
        raise ApiError(423, "locked", f"登入失敗次數過多，已暫時鎖定，請 {rem} 秒後再試", retry_after=rem)
    m = db.exec(select(Member).where(Member.username == body.username)).first()
    if m is None or not verify_password(body.password, m.password_hash):
        locked = _record_failure(db, keys, st.login_max_failures, st.login_lock_seconds, body.username, ip,
                                 company_id=m.company_id if m else "")
        if locked:
            raise ApiError(423, "locked", f"登入失敗次數過多，已暫時鎖定，請 {locked} 秒後再試", retry_after=locked)
        raise ApiError(401, "invalid_credentials", "帳號或密碼錯誤")
    clear_locks(db, keys)
    return {"token": make_token(m, st.secret, st.token_ttl_seconds), "member": member_public(m)}


@router.get("/auth/me")
def me(p: Principal = Depends(current_principal)):
    return member_public(p.member)
