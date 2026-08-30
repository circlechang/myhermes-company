from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import Principal, current_principal, get_db, hash_password, member_public
from ..errors import ApiError, not_found
from ..models import Company, Member

router = APIRouter(tags=["company"])


@router.get("/companies/current")
def current_company(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    co = db.get(Company, p.company_id)
    if co is None:
        raise not_found("company")
    return {"id": co.id, "name": co.name, "created_at": co.created_at}


@router.get("/members")
def list_members(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    rows = db.exec(select(Member).where(Member.company_id == p.company_id).order_by(Member.created_at)).all()
    return [member_public(m) for m in rows]


class MemberCreate(BaseModel):
    username: str
    password: str
    role: str = "member"
    profiles: Optional[list[str]] = None  # 指派的 Hermes profile（H 帳號綁定）


class MemberPatch(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None
    profiles: Optional[list[str]] = None


ROLES = {"owner", "admin", "member"}


def _profiles_json(profiles: Optional[list[str]]) -> str:
    import json
    import re
    names = [x.strip() for x in (profiles or []) if isinstance(x, str) and x.strip()]
    for n in names:
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", n):
            raise ApiError(400, "bad_profile", f"profile 名稱不合法: {n}")
    return json.dumps(sorted(set(names)))


@router.post("/members", status_code=201)
def create_member(body: MemberCreate, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    if body.role not in ROLES:
        raise ApiError(400, "bad_role", "role 必須是 owner/admin/member")
    if not body.username.strip() or len(body.password) < 4:
        raise ApiError(400, "bad_request", "username 不可空白，password 至少 4 碼")
    if db.exec(select(Member).where(Member.username == body.username)).first():
        raise ApiError(409, "conflict", "username 已存在")
    m = Member(company_id=p.company_id, username=body.username.strip(), password_hash=hash_password(body.password), role=body.role,
               profiles_json=_profiles_json(body.profiles))
    db.add(m)
    db.commit()
    db.refresh(m)
    return member_public(m)


@router.patch("/members/{member_id}")
def patch_member(member_id: str, body: MemberPatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    m = db.get(Member, member_id)
    if m is None or m.company_id != p.company_id:
        raise not_found("member")
    if m.id != p.member.id:
        p.require_admin()
    if body.role is not None:
        p.require_admin()
        if body.role not in ROLES:
            raise ApiError(400, "bad_role", "role 必須是 owner/admin/member")
        m.role = body.role
    if body.profiles is not None:
        p.require_admin()
        m.profiles_json = _profiles_json(body.profiles)
    if body.username:
        m.username = body.username.strip()
    if body.password:
        m.password_hash = hash_password(body.password)
    db.add(m)
    db.commit()
    db.refresh(m)
    return member_public(m)


@router.delete("/members/{member_id}")
def delete_member(member_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    m = db.get(Member, member_id)
    if m is None or m.company_id != p.company_id:
        raise not_found("member")
    if m.id == p.member.id:
        raise ApiError(400, "bad_request", "不能刪除自己")
    db.delete(m)
    db.commit()
    return {"ok": True}
