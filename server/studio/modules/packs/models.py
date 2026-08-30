"""packs 模組資料表：哪家公司裝了哪個套件、對應到哪些 AI 員工／工作流。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlmodel import Field, SQLModel

from ...models import new_id, now


class InstalledPack(SQLModel, table=True):
    __tablename__ = "installed_packs"
    id: str = Field(default_factory=lambda: new_id("pk"), primary_key=True)
    company_id: str = Field(index=True)
    name: str = Field(index=True)
    version: str = ""
    installed_by: str = ""
    installed_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)
    agents_json: str = "{}"  # profile -> agent id
    workflows_json: str = "{}"  # stage id -> workflow id
    profiles_created_json: str = "[]"  # 安裝時從套件建立的 profile（既有的不算，移除時也不動）

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "company_id": self.company_id, "name": self.name, "version": self.version, "installed_by": self.installed_by,
                "installed_at": self.installed_at, "updated_at": self.updated_at, "agents": json.loads(self.agents_json or "{}"),
                "workflows": json.loads(self.workflows_json or "{}"), "profiles_created": json.loads(self.profiles_created_json or "[]")}
