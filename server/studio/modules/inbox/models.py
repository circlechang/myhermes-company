"""inbox 表：聊天危險指令的待核准（chat 模組只在 WS 記憶體裡有，這裡落庫）＋其他模組推進來的一般待辦＋已處理標記。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Field, SQLModel

from ...models import new_id, now


class PendingApproval(SQLModel, table=True):
    """對話中的 approval.request（危險指令）。chat 模組收到 approval.request 時呼叫 POST /inbox/approvals 記一筆，
    成員在對話或收件匣任一處決定後 resolve。"""
    __tablename__ = "pending_approvals"
    id: str = Field(default_factory=lambda: new_id("pa"), primary_key=True)
    company_id: str = Field(index=True)
    member_id: str = Field(default="", index=True)  # 發起對話的成員
    session_id: str = Field(default="", index=True)
    run_id: str = Field(default="", index=True)
    approval_id: str = ""  # gateway 沒有獨立 id 時＝run_id
    agent: str = ""  # Hermes profile
    command: str = ""
    context_json: str = "{}"
    status: str = Field(default="pending", index=True)  # pending | resolved | expired
    decision: str = ""  # once | session | always | deny
    decided_by: str = ""
    created_at: datetime = Field(default_factory=now)
    resolved_at: Optional[datetime] = None

    def to_dict(self) -> dict[str, Any]:
        try:
            ctx = json.loads(self.context_json or "{}")
        except ValueError:
            ctx = {}
        return {"id": self.id, "member_id": self.member_id, "session_id": self.session_id, "run_id": self.run_id,
                "approval_id": self.approval_id, "agent": self.agent, "command": self.command, "context": ctx,
                "status": self.status, "decision": self.decision, "decided_by": self.decided_by,
                "created_at": self.created_at, "resolved_at": self.resolved_at}


class InboxItem(SQLModel, table=True):
    """一般待辦（例：limits 超額停用、其他模組推進來要人看的事）。"""
    __tablename__ = "inbox_items"
    id: str = Field(default_factory=lambda: new_id("ib"), primary_key=True)
    company_id: str = Field(index=True)
    kind: str = Field(index=True)  # limit_exceeded | notice | …
    title: str
    detail: str = ""
    ref: str = ""  # 對象（agent:<id> / task:<id> …）
    link: str = ""  # 前端「前往」的路徑
    agent: str = ""
    status: str = Field(default="open", index=True)  # open | done
    created_at: datetime = Field(default_factory=now)
    done_by: str = ""
    done_at: Optional[datetime] = None

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "title": self.title, "detail": self.detail, "ref": self.ref, "link": self.link,
                "agent": self.agent, "status": self.status, "created_at": self.created_at, "done_by": self.done_by, "done_at": self.done_at}


class InboxDone(SQLModel, table=True):
    """外部聚合來源（看板 blocked 卡、群聊 @ 人類）沒有自己的「已處理」狀態，用這張表記成員按過「已處理」。"""
    __tablename__ = "inbox_done"
    id: Optional[int] = Field(default=None, primary_key=True)
    company_id: str = Field(index=True)
    ref: str = Field(index=True)  # kanban:<task_id> / mention:<room_message_id>
    member_id: str = ""
    created_at: datetime = Field(default_factory=now)
