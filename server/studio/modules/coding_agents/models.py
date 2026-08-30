"""Coding Agents 模組的資料表。

對話本身落在共用的 sessions / messages（source=coding:<agent>），這裡只放
coding 專屬的補充資料：session 中繼資料、每次執行的 diff、各 agent 設定。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Field, SQLModel

from ...models import new_id, now


class CodingSessionMeta(SQLModel, table=True):
    __tablename__ = "coding_session_meta"
    session_id: str = Field(primary_key=True)  # -> sessions.id
    agent: str = Field(index=True)  # claude | codex | pi
    workspace: str = ""
    model: str = ""
    external_session_id: str = ""  # claude session_id / codex thread_id / pi session path
    status: str = "idle"  # idle | running | failed
    created_at: datetime = Field(default_factory=now)


class CodingRun(SQLModel, table=True):
    __tablename__ = "coding_runs"
    id: str = Field(default_factory=lambda: new_id("crun"), primary_key=True)
    session_id: str = Field(index=True)
    agent: str = ""
    prompt: str = ""
    status: str = "running"  # running | completed | failed | cancelled
    exit_code: Optional[int] = None
    diff_before: str = ""
    diff_after: str = ""
    files_json: str = "[]"  # git status --porcelain after run
    usage_json: str = "{}"
    error: str = ""
    started_at: datetime = Field(default_factory=now)
    finished_at: Optional[datetime] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "session_id": self.session_id, "agent": self.agent, "prompt": self.prompt,
            "status": self.status, "exit_code": self.exit_code, "diff_before": self.diff_before,
            "diff_after": self.diff_after, "files": json.loads(self.files_json or "[]"),
            "usage": json.loads(self.usage_json or "{}"), "error": self.error,
            "started_at": self.started_at, "finished_at": self.finished_at,
        }


class CodingAgentSetting(SQLModel, table=True):
    __tablename__ = "coding_agent_settings"
    id: str = Field(default_factory=lambda: new_id("cas"), primary_key=True)
    company_id: str = Field(index=True)
    agent: str = Field(index=True)
    workspace: str = ""
    model: str = ""
    api_mode: str = "direct"  # direct | hermes（走本機相容 proxy 轉 Hermes gateway）
    hermes_profile: str = ""  # api_mode=hermes 時要用的 profile（空＝default）
    extra_json: str = "{}"  # permission_mode / sandbox / max_turns / max_budget_usd ...
    updated_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent": self.agent, "workspace": self.workspace, "model": self.model, "api_mode": self.api_mode,
            "hermes_profile": self.hermes_profile, "extra": json.loads(self.extra_json or "{}"),
            "updated_at": self.updated_at,
        }


class CodingProxyToken(SQLModel, table=True):
    """每家公司一把 proxy token：外部 CLI 用它打本機 Anthropic／OpenAI 相容端點。"""
    __tablename__ = "coding_proxy_tokens"
    company_id: str = Field(primary_key=True)
    token: str = Field(index=True)
    created_at: datetime = Field(default_factory=now)
