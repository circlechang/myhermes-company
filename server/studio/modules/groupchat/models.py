"""群聊資料表：rooms / room_members / room_messages / room_summaries。"""
from __future__ import annotations

import secrets
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Field, SQLModel

from ...models import new_id, now


def _invite() -> str:
    return secrets.token_urlsafe(6).replace("-", "x").replace("_", "y")[:8].upper()


class Room(SQLModel, table=True):
    __tablename__ = "rooms"
    id: str = Field(default_factory=lambda: new_id("room"), primary_key=True)
    company_id: str = Field(index=True)
    name: str
    invite_code: str = Field(default_factory=_invite, index=True)
    # 無 @mention 時的策略：none | round_robin | host
    no_mention_policy: str = "none"
    host_member_id: Optional[str] = None  # room_members.id（AI）
    summarizer_member_id: Optional[str] = None  # 負責壓縮摘要的 AI（預設第一位 AI）
    history_n: int = 20  # 送給 AI 的近期訊息數
    compress_threshold_tokens: int = 6000  # 摘要後的歷史超過此估算 token 就再壓縮
    max_ai_depth: int = 3  # AI 互 @ 的深度上限（人類訊息 depth=0）
    rr_cursor: int = 0
    created_by: str = ""
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "name": self.name, "invite_code": self.invite_code,
            "no_mention_policy": self.no_mention_policy, "host_member_id": self.host_member_id,
            "summarizer_member_id": self.summarizer_member_id, "history_n": self.history_n,
            "compress_threshold_tokens": self.compress_threshold_tokens, "max_ai_depth": self.max_ai_depth,
            "created_by": self.created_by, "created_at": self.created_at, "updated_at": self.updated_at,
        }


class RoomMember(SQLModel, table=True):
    __tablename__ = "room_members"
    id: str = Field(default_factory=lambda: new_id("rm"), primary_key=True)
    room_id: str = Field(foreign_key="rooms.id", index=True)
    kind: str = "human"  # human | ai
    member_id: Optional[str] = Field(default=None, index=True)  # members.id（human）
    agent_id: Optional[str] = Field(default=None, index=True)  # agents.id（ai）
    display_name: str
    profile: str = ""  # ai：Hermes profile
    model: str = ""  # ai：模型覆寫（空＝profile 預設）
    system_prompt: str = ""  # ai：角色提示
    joined_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "room_id": self.room_id, "kind": self.kind, "member_id": self.member_id,
            "agent_id": self.agent_id, "display_name": self.display_name, "profile": self.profile,
            "model": self.model, "system_prompt": self.system_prompt, "joined_at": self.joined_at,
        }


class RoomMessage(SQLModel, table=True):
    __tablename__ = "room_messages"
    id: str = Field(default_factory=lambda: new_id("rmsg"), primary_key=True)
    room_id: str = Field(foreign_key="rooms.id", index=True)
    seq: int = Field(default=0, index=True)  # 房間內遞增序號（排序、摘要涵蓋範圍）
    sender_id: Optional[str] = None  # room_members.id；系統訊息為 None
    sender_name: str = ""
    sender_kind: str = "human"  # human | ai | system
    content: str = ""
    depth: int = 0  # AI 互 @ 深度；人類＝0
    run_id: Optional[str] = None
    status: str = "done"  # done | failed
    created_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "room_id": self.room_id, "seq": self.seq, "sender_id": self.sender_id,
            "sender_name": self.sender_name, "sender_kind": self.sender_kind, "content": self.content,
            "depth": self.depth, "run_id": self.run_id, "status": self.status, "created_at": self.created_at,
        }


class RoomSummary(SQLModel, table=True):
    __tablename__ = "room_summaries"
    id: str = Field(default_factory=lambda: new_id("rsum"), primary_key=True)
    room_id: str = Field(foreign_key="rooms.id", index=True)
    content: str
    covers_until_seq: int = 0  # 摘要涵蓋到哪個 seq（含）
    made_by: str = ""
    created_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "room_id": self.room_id, "content": self.content,
                "covers_until_seq": self.covers_until_seq, "made_by": self.made_by, "created_at": self.created_at}
