"""events 表：SPEC §9「存事件、不存交易」。所有進入中樞的事情記一筆，不存訂單／庫存／金流。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Field, SQLModel

from ...models import new_id, now


class Event(SQLModel, table=True):
    __tablename__ = "events"
    id: str = Field(default_factory=lambda: new_id("ev"), primary_key=True)
    ts: datetime = Field(default_factory=now, index=True)
    kind: str = Field(index=True)  # 例：chat.run / workflow.run / groupchat.message / kanban.status / soul.write / limit.exceeded / approval.decided
    source: str = Field(default="", index=True)  # 入口：chat | workflow | groupchat | kanban | line | webhook | cron | studio | api
    subject: str = Field(default="", index=True)  # 對象：session:<id> / run:<id> / task:<id> / profile:<name> …（同一 subject+kind 不重複收集）
    agent: str = Field(default="", index=True)  # 處理的 AI 員工（Hermes profile）
    member_id: str = Field(default="", index=True)  # 相關人類成員
    company_id: str = Field(default="", index=True)
    payload_json: str = "{}"
    decision: str = ""  # 人類決策：approve | reject | once | session | always | deny | ""
    delivery: str = ""  # 投遞結果：line:ok / webhook:500 / file:/path / ""
    seq: int = Field(default=0, index=True)  # 全域單調遞增（kinds.next_seq）；既有資料啟動時補號
    causes_json: str = "[]"  # 上游事件 id 陣列（因果鏈）

    @property
    def causes(self) -> list[str]:
        try:
            v = json.loads(self.causes_json or "[]")
        except ValueError:
            return []
        return [str(x) for x in v] if isinstance(v, list) else []

    def to_dict(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.payload_json or "{}")
        except ValueError:
            payload = {"raw": self.payload_json}
        return {"id": self.id, "ts": self.ts, "kind": self.kind, "source": self.source, "subject": self.subject,
                "agent": self.agent, "member_id": self.member_id, "company_id": self.company_id,
                "payload": payload, "decision": self.decision, "delivery": self.delivery,
                "seq": self.seq, "causes": self.causes}


class EventCursor(SQLModel, table=True):
    """collector 的掃描水位（每個來源一列），重啟後接著掃、不重複。"""
    __tablename__ = "event_cursors"
    source: str = Field(primary_key=True)
    last_ts: Optional[datetime] = None
    state_json: str = "{}"  # 來源自己的狀態（例：kanban 上次看到的 status map）
    updated_at: datetime = Field(default_factory=now)
