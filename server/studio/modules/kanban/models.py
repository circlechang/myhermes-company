"""Studio 端的看板附加資料：hermes kanban 沒有的欄位（標籤）。"""
from __future__ import annotations

from datetime import datetime

from sqlmodel import Field, SQLModel

from ...models import now


class KanbanMeta(SQLModel, table=True):
    __tablename__ = "kanban_meta"
    task_id: str = Field(primary_key=True)
    company_id: str = Field(index=True)
    tags_json: str = "[]"
    updated_at: datetime = Field(default_factory=now)
