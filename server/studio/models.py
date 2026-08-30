"""SQLModel tables. Kept flat; JSON columns stored as text."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlmodel import Field, SQLModel


def now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class Company(SQLModel, table=True):
    __tablename__ = "companies"
    id: str = Field(default_factory=lambda: new_id("co"), primary_key=True)
    name: str
    created_at: datetime = Field(default_factory=now)


class Member(SQLModel, table=True):
    __tablename__ = "members"
    id: str = Field(default_factory=lambda: new_id("m"), primary_key=True)
    company_id: str = Field(foreign_key="companies.id", index=True)
    username: str = Field(index=True)
    password_hash: str
    role: str = "member"  # owner | admin | member
    created_at: datetime = Field(default_factory=now)
    profiles_json: str = "[]"  # 指派的 Hermes profile 清單（JSON list）；owner 不受限


class Agent(SQLModel, table=True):
    __tablename__ = "agents"
    id: str = Field(default_factory=lambda: new_id("ag"), primary_key=True)
    company_id: str = Field(foreign_key="companies.id", index=True)
    name: str
    profile: str = Field(index=True)
    title: str = ""
    description: str = ""
    avatar: str = ""
    model: str = ""
    enabled: bool = True
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)


class ChatSession(SQLModel, table=True):
    __tablename__ = "sessions"
    id: str = Field(default_factory=lambda: new_id("s"), primary_key=True)
    company_id: str = Field(foreign_key="companies.id", index=True)
    member_id: str = Field(foreign_key="members.id", index=True)
    agent_id: str = Field(foreign_key="agents.id", index=True)
    title: str = ""
    source: str = "workbench"  # workbench | workflow
    hermes_session_id: str = ""  # stable id handed to gateway /v1/runs {session_id}
    last_run_id: str = ""
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)
    last_message_at: Optional[datetime] = None
    # --- chat module additions (additive only) ---
    archived: bool = False
    category_id: Optional[str] = Field(default=None, index=True)
    model: str = ""  # per-session model override ("" = agent/profile default)
    provider: str = ""
    run_status: str = ""  # "" | running | completed | failed | cancelled
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    context_tokens: int = 0  # last run's input+output (approx. context size)
    imported_from: str = ""  # "<profile>:<hermes session id>" when imported from state.db


class Message(SQLModel, table=True):
    __tablename__ = "messages"
    id: str = Field(default_factory=lambda: new_id("msg"), primary_key=True)
    session_id: str = Field(foreign_key="sessions.id", index=True)
    role: str  # user | assistant | tool
    content: str = ""
    tool_name: Optional[str] = None
    tool_args: Optional[str] = None  # JSON text
    tool_result: Optional[str] = None  # JSON text
    run_id: Optional[str] = None
    created_at: datetime = Field(default_factory=now)
    # --- chat module additions ---
    reply_to: Optional[str] = None  # quoted message id
    attachments: Optional[str] = None  # JSON list [{name,path,mime,size}]
    reasoning: Optional[str] = None
    usage: Optional[str] = None  # JSON usage of the run that produced this message


class SessionCategory(SQLModel, table=True):
    __tablename__ = "session_categories"
    id: str = Field(default_factory=lambda: new_id("cat"), primary_key=True)
    company_id: str = Field(foreign_key="companies.id", index=True)
    member_id: str = Field(index=True)
    name: str
    color: str = ""
    position: int = 0
    created_at: datetime = Field(default_factory=now)


class Workflow(SQLModel, table=True):
    __tablename__ = "workflows"
    id: str = Field(default_factory=lambda: new_id("wf"), primary_key=True)
    company_id: str = Field(foreign_key="companies.id", index=True)
    name: str
    description: str = ""
    profile: str = Field(default="", index=True)  # 工作區（profile 感知），空字串＝不限
    version: int = 1  # 每次儲存 +1；匯出 JSON 帶此版本
    nodes_json: str = "[]"
    edges_json: str = "[]"
    viewport_json: str = "{}"
    budget_json: str = "{}"  # {max_tokens?, max_cost_usd?, deadline_seconds?}
    created_by: str = ""
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "company_id": self.company_id,
            "name": self.name,
            "description": self.description,
            "profile": self.profile,
            "version": self.version,
            "nodes": json.loads(self.nodes_json),
            "edges": json.loads(self.edges_json),
            "viewport": json.loads(self.viewport_json),
            "budget": json.loads(self.budget_json or "{}"),
            "created_by": self.created_by,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class WorkflowRun(SQLModel, table=True):
    __tablename__ = "workflow_runs"
    id: str = Field(default_factory=lambda: new_id("wr"), primary_key=True)
    company_id: str = Field(index=True)
    workflow_id: str = Field(foreign_key="workflows.id", index=True)
    workflow_name: str = ""
    status: str = "pending"  # pending|running|waiting_approval|completed|failed|stopped|timeout|budget_exceeded
    trigger: str = "manual"  # manual|schedule|webhook|rerun
    snapshot_json: str = "{}"  # 凍結：nodes/edges/viewport/profile/version/budget
    node_states_json: str = "{}"  # node_id -> {status, session_id, hermes_session_id, output, error, usage, started_at, finished_at, attempt}
    events_json: str = "[]"  # 時間軸：node.status / edge.decision / run.status / approval
    input_json: str = "{}"  # webhook payload 或手動輸入
    usage_json: str = "{}"  # {input_tokens, output_tokens, total_tokens, cost_usd}
    error: str = ""
    created_by: str = ""
    parent_run_id: str = ""
    created_at: datetime = Field(default_factory=now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None

    def to_dict(self, *, full: bool = True) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "workflow_id": self.workflow_id,
            "workflow_name": self.workflow_name,
            "status": self.status,
            "trigger": self.trigger,
            "usage": json.loads(self.usage_json or "{}"),
            "error": self.error,
            "created_by": self.created_by,
            "parent_run_id": self.parent_run_id,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }
        if full:
            d.update({
                "snapshot": json.loads(self.snapshot_json or "{}"),
                "node_states": json.loads(self.node_states_json or "{}"),
                "events": json.loads(self.events_json or "[]"),
                "input": json.loads(self.input_json or "{}"),
            })
        return d


class WorkflowRunNode(SQLModel, table=True):
    """每個 run 的每個節點一列（可查詢的快照；node_states_json 是同一份資料的整體副本）。"""
    __tablename__ = "workflow_run_nodes"
    id: Optional[int] = Field(default=None, primary_key=True)
    run_id: str = Field(foreign_key="workflow_runs.id", index=True)
    node_id: str
    kind: str = ""
    status: str = "pending"
    attempt: int = 0
    session_id: str = ""
    hermes_session_id: str = ""
    output: str = ""
    error: str = ""
    usage_json: str = "{}"
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None


class WorkflowSchedule(SQLModel, table=True):
    __tablename__ = "workflow_schedules"
    id: str = Field(default_factory=lambda: new_id("ws"), primary_key=True)
    company_id: str = Field(index=True)
    workflow_id: str = Field(foreign_key="workflows.id", index=True)
    cron: str  # 5 欄位 cron 表達式（分 時 日 月 週），伺服器本地時間
    enabled: bool = True
    input_json: str = "{}"
    last_run_at: Optional[datetime] = None
    last_run_id: str = ""
    next_run_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "workflow_id": self.workflow_id, "cron": self.cron, "enabled": self.enabled,
                "input": json.loads(self.input_json or "{}"), "last_run_at": self.last_run_at, "last_run_id": self.last_run_id,
                "next_run_at": self.next_run_at, "created_at": self.created_at}


class WorkflowWebhook(SQLModel, table=True):
    __tablename__ = "workflow_webhooks"
    id: str = Field(default_factory=lambda: new_id("wh"), primary_key=True)
    company_id: str = Field(index=True)
    workflow_id: str = Field(foreign_key="workflows.id", index=True)
    token: str = Field(default_factory=lambda: uuid.uuid4().hex + uuid.uuid4().hex[:8], index=True)
    enabled: bool = True
    hits: int = 0
    last_hit_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "workflow_id": self.workflow_id, "token": self.token, "enabled": self.enabled,
                "path": f"/webhooks/wf/{self.token}", "hits": self.hits, "last_hit_at": self.last_hit_at, "created_at": self.created_at}


class WorkflowApproval(SQLModel, table=True):
    __tablename__ = "workflow_approvals"
    id: str = Field(default_factory=lambda: new_id("wa"), primary_key=True)
    company_id: str = Field(index=True)
    run_id: str = Field(foreign_key="workflow_runs.id", index=True)
    workflow_id: str = ""
    workflow_name: str = ""
    node_id: str
    node_title: str = ""
    status: str = "pending"  # pending|approved|rejected|cancelled
    payload: str = ""  # 給審批者看的上游結果
    comment: str = ""
    decided_by: str = ""
    decided_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "run_id": self.run_id, "workflow_id": self.workflow_id, "workflow_name": self.workflow_name,
                "node_id": self.node_id, "node_title": self.node_title, "status": self.status, "payload": self.payload,
                "comment": self.comment, "decided_by": self.decided_by, "decided_at": self.decided_at, "created_at": self.created_at}


class Audit(SQLModel, table=True):
    __tablename__ = "audit"
    id: Optional[int] = Field(default=None, primary_key=True)
    company_id: str = Field(index=True)
    member_id: str = ""
    action: str
    target: str = ""
    detail: str = ""
    created_at: datetime = Field(default_factory=now)


class LoginLock(SQLModel, table=True):
    """登入失敗計數與鎖定（同帳號／同 IP 連續失敗 N 次鎖 M 分鐘）。key = "u:<username>" | "ip:<addr>"。"""
    __tablename__ = "login_locks"
    key: str = Field(primary_key=True)
    failures: int = 0
    locked_until: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=now)
