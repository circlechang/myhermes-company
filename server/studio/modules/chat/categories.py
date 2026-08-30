from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, current_principal, get_db
from ...errors import bad_request, not_found
from ...models import ChatSession, SessionCategory, now

router = APIRouter()


def cat_public(c: SessionCategory) -> dict:
    return {"id": c.id, "name": c.name, "color": c.color, "position": c.position, "created_at": c.created_at}


def _own(db: Session, p: Principal, cid: str) -> SessionCategory:
    c = db.get(SessionCategory, cid)
    if c is None or c.company_id != p.company_id or c.member_id != p.member.id:
        raise not_found("category")
    return c


@router.get("/categories")
def list_categories(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    rows = db.exec(select(SessionCategory).where(SessionCategory.company_id == p.company_id,
                                                 SessionCategory.member_id == p.member.id)
                   .order_by(SessionCategory.position, SessionCategory.created_at)).all()
    return [cat_public(c) for c in rows]


class CategoryBody(BaseModel):
    name: str
    color: str = ""
    position: Optional[int] = None


@router.post("/categories", status_code=201)
def create_category(body: CategoryBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name:
        raise bad_request("name 不可為空")
    count = len(db.exec(select(SessionCategory).where(SessionCategory.member_id == p.member.id)).all())
    c = SessionCategory(company_id=p.company_id, member_id=p.member.id, name=name[:60], color=body.color[:20],
                        position=body.position if body.position is not None else count)
    db.add(c)
    db.commit()
    db.refresh(c)
    return cat_public(c)


class CategoryPatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    position: Optional[int] = None


@router.patch("/categories/{cid}")
def patch_category(cid: str, body: CategoryPatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    c = _own(db, p, cid)
    if body.name is not None:
        if not body.name.strip():
            raise bad_request("name 不可為空")
        c.name = body.name.strip()[:60]
    if body.color is not None:
        c.color = body.color[:20]
    if body.position is not None:
        c.position = body.position
    db.add(c)
    db.commit()
    db.refresh(c)
    return cat_public(c)


@router.delete("/categories/{cid}")
def delete_category(cid: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    c = _own(db, p, cid)
    for s in db.exec(select(ChatSession).where(ChatSession.category_id == c.id)).all():
        s.category_id = None
        s.updated_at = now()
        db.add(s)
    db.delete(c)
    db.commit()
    return {"ok": True}
