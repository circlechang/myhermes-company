"""docs 模組的表：文件本體、版本、血緣。

- `docs`：一份文件＝工作區內一個 `.md` 檔＋DB 裡的中繼資料。
- `doc_versions`：內容的真相在 DB（不可變、遞增版本）；最新版同時寫回 `.md`，讓人用 Finder 也看得到。
- `doc_links`：文件之間的血緣（derived / split / merged / selected），做 /docs/{id}/lineage 的圖。
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Field, SQLModel

from ...models import new_id, now

DOC_STATUSES = ("draft", "review", "final", "archived")
DOC_ORIGINS = ("chat", "workflow", "pack", "upload")
LINK_KINDS = ("derived", "split", "merged", "selected")
AUTHOR_KINDS = ("human", "agent")


class Doc(SQLModel, table=True):
    __tablename__ = "docs"
    id: str = Field(default_factory=lambda: new_id("doc"), primary_key=True)
    company_id: str = Field(index=True)
    title: str = ""
    path: str = Field(default="", index=True)  # 工作區內相對路徑，.md
    status: str = "draft"  # draft | review | final | archived
    stage: str = ""  # 屬於哪一站（工作流節點 id 或套件階段 id）
    owner_agent_id: str = ""
    parent_doc_id: str = ""
    origin: str = "chat"  # chat | workflow | pack | upload
    meta_json: str = "{}"
    # --- 檔案同步狀態（漂移偵測用；外部改檔時 mtime／hash 對不上） ---
    file_mtime: float = 0.0
    file_hash: str = ""
    created_by: str = ""
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)

    def meta(self) -> dict[str, Any]:
        try:
            m = json.loads(self.meta_json or "{}")
        except (TypeError, ValueError):
            m = {}
        return m if isinstance(m, dict) else {}

    def to_dict(self, **extra: Any) -> dict[str, Any]:
        return {"id": self.id, "company_id": self.company_id, "title": self.title, "path": self.path, "status": self.status,
                "stage": self.stage, "owner_agent_id": self.owner_agent_id, "parent_doc_id": self.parent_doc_id,
                "origin": self.origin, "meta": self.meta(), "created_by": self.created_by,
                "created_at": self.created_at, "updated_at": self.updated_at, **extra}


class DocVersion(SQLModel, table=True):
    __tablename__ = "doc_versions"
    id: str = Field(default_factory=lambda: new_id("dv"), primary_key=True)
    doc_id: str = Field(index=True)
    version: int = Field(default=1, index=True)
    content: str = ""
    author_kind: str = "agent"  # human | agent
    author_id: str = ""  # member id 或 agent profile
    summary: str = ""  # 這一版改了什麼，一句
    added: int = 0
    removed: int = 0
    session_id: str = ""
    run_id: str = ""
    created_at: datetime = Field(default_factory=now)

    def meta(self) -> dict[str, Any]:
        return {"id": self.id, "doc_id": self.doc_id, "version": self.version, "author_kind": self.author_kind,
                "author_id": self.author_id, "summary": self.summary,
                "diff_stat": {"added": self.added, "removed": self.removed},
                "session_id": self.session_id, "run_id": self.run_id, "created_at": self.created_at,
                "chars": len(self.content or ""), "lines": (self.content or "").count("\n") + (1 if self.content else 0)}

    def to_dict(self) -> dict[str, Any]:
        return {**self.meta(), "content": self.content}


class DocLink(SQLModel, table=True):
    __tablename__ = "doc_links"
    id: str = Field(default_factory=lambda: new_id("dl"), primary_key=True)
    company_id: str = Field(default="", index=True)
    from_doc_id: str = Field(index=True)
    to_doc_id: str = Field(index=True)
    kind: str = "derived"  # derived | split | merged | selected
    run_id: str = ""
    node_id: str = ""
    created_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "from_doc_id": self.from_doc_id, "to_doc_id": self.to_doc_id, "kind": self.kind,
                "run_id": self.run_id, "node_id": self.node_id, "created_at": self.created_at}


__all__ = ["Doc", "DocVersion", "DocLink", "DOC_STATUSES", "DOC_ORIGINS", "LINK_KINDS", "AUTHOR_KINDS"]
