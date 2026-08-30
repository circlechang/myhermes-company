"""唯讀機器 token（給 Hermes skill 用）：`mhc_` 開頭，只存 sha256，owner 才能發。

拿這種 token 打 API 時，principal 是發 token 的成員，但只有掛 `read_principal` 的 GET 端點會接受
（`GET /search`、`GET /events*`）；其他端點走 JWT 解碼會回 401 —— 這就是「唯讀」的實作方式。"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal
from ...errors import ApiError
from ...models import Member, new_id, now

PREFIX = "mhc_"


class SearchToken(SQLModel, table=True):
    __tablename__ = "search_tokens"
    id: str = Field(default_factory=lambda: new_id("stk"), primary_key=True)
    token_hash: str = Field(index=True)
    company_id: str = Field(index=True)
    member_id: str = Field(index=True)  # 發 token 的 owner；查詢以他的可見範圍為準
    label: str = ""
    created_at: datetime = Field(default_factory=now)
    last_used_at: Optional[datetime] = None
    revoked: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "label": self.label, "company_id": self.company_id, "member_id": self.member_id,
                "created_at": self.created_at, "last_used_at": self.last_used_at, "revoked": self.revoked}


@dataclass
class MachinePrincipal(Principal):
    token_id: str = ""
    readonly: bool = True


def _hash(tok: str) -> str:
    return hashlib.sha256(tok.encode("utf-8")).hexdigest()


def issue_token(db: Session, member: Member, label: str = "") -> tuple[SearchToken, str]:
    raw = PREFIX + secrets.token_urlsafe(32)
    row = SearchToken(token_hash=_hash(raw), company_id=member.company_id, member_id=member.id, label=label or "")
    db.add(row)
    db.flush()
    return row, raw


def resolve_machine_token(tok: str, db: Session) -> Principal:
    if not tok.startswith(PREFIX):
        raise ApiError(401, "unauthorized", "not a machine token")
    row = db.exec(select(SearchToken).where(SearchToken.token_hash == _hash(tok))).first()
    if row is None or row.revoked:
        raise ApiError(401, "unauthorized", "machine token invalid or revoked")
    member = db.get(Member, row.member_id)
    if member is None:
        raise ApiError(401, "unauthorized", "token owner no longer exists")
    row.last_used_at = now()
    db.add(row)
    db.commit()
    return MachinePrincipal(member=member, token_id=row.id)
