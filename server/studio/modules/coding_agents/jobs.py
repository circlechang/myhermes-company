"""派工作給 coding 員工的機器介面（給 Hermes 員工的 `mhc-code` skill 用）。

    POST /coding/jobs        {agent_id|agent, task, workspace?, timeout_seconds?}  → job
    GET  /coding/jobs/{id}                                                        → 進度＋檔案改動摘要
    GET  /coding/jobs/{id}/diff                                                   → 完整 diff
    GET  /coding/staff                                                            → 可派工作的 coding 員工

安全邊界（三層，缺一不可）：
1. **token**：機器 token 預設唯讀；派工作要 owner 發的 `can_write` token（`POST /search/tokens {"can_write": true}`）。
2. **工作目錄**：一律過 `staff.check_workspace`（檔案模組的根白名單），預設不允許任意路徑。
3. **員工**：只能派給同公司、runtime 是 coding 的 AI 員工，設定（模型／權限）以員工那筆為準，呼叫端改不了。
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, current_principal, get_db
from ...errors import bad_request, forbidden, not_found
from ...models import Agent, new_id, now
from . import staff
from .router import PROCESSES

log = logging.getLogger("studio.coding.jobs")
router = APIRouter(prefix="/coding", tags=["coding"])

MAX_TIMEOUT = 3600.0
DEFAULT_TIMEOUT = 600.0  # 10 分鐘：skill 的 run 同步等結果的上限
_TASKS: set = set()  # 背景任務的強參考（避免被 GC 掉）


class CodingJob(SQLModel, table=True):
    __tablename__ = "coding_jobs"
    id: str = Field(default_factory=lambda: new_id("cjob"), primary_key=True)
    company_id: str = Field(index=True)
    member_id: str = ""
    agent_id: str = Field(default="", index=True)
    agent_name: str = ""
    runtime: str = ""
    workspace: str = ""
    task: str = ""
    status: str = "queued"  # queued | running | completed | failed | cancelled
    output: str = ""
    error: str = ""
    exit_code: Optional[int] = None
    diff: str = ""
    before_paths_json: str = "[]"  # 開工前工作區就已經有的改動（用來區分「這次改的」與「本來就髒的」）
    files_json: str = "[]"
    usage_json: str = "{}"
    source: str = "api"  # api | skill
    created_at: datetime = Field(default_factory=now)
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None

    def to_dict(self, *, with_diff: bool = False) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id, "agent_id": self.agent_id, "agent": self.agent_name, "runtime": self.runtime,
            "workspace": self.workspace, "task": self.task, "status": self.status, "output": self.output,
            "error": self.error, "exit_code": self.exit_code,
            "files": json.loads(self.files_json or "[]"),
            "changes": self._changes(),
            "usage": json.loads(self.usage_json or "{}"),
            "created_at": self.created_at, "started_at": self.started_at, "finished_at": self.finished_at,
            "done": self.status in ("completed", "failed", "cancelled"),
        }
        if with_diff:
            d["diff"] = self.diff
        return d

    def _changes(self) -> list[dict[str, Any]]:
        """每個檔案加幾行／刪幾行；`preexisting=true` 代表開工前工作區就已經有這個改動，不是這次做的。"""
        try:
            before = set(json.loads(self.before_paths_json or "[]"))
        except (TypeError, ValueError):
            before = set()
        out = staff.diff_stat(self.diff)
        for c in out:
            c["preexisting"] = c["path"] in before
        return out


# ---------------------------------------------------------------- 認證
def _machine(request: Request, db: Session) -> Optional[Principal]:
    auth = request.headers.get("authorization", "")
    tok = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if not tok.startswith("mhc_"):
        return None
    from ..search.tokens import resolve_machine_token
    return resolve_machine_token(tok, db)


def read_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    """JWT 或機器 token（唯讀也可以）。"""
    return _machine(request, db) or current_principal(request, db)


def write_principal(request: Request, db: Session = Depends(get_db)) -> Principal:
    """JWT，或**標了 can_write 的**機器 token。唯讀 token 會被擋在這裡。"""
    p = _machine(request, db)
    if p is None:
        return current_principal(request, db)
    if not getattr(p, "can_write", False):
        raise forbidden("這是唯讀機器 token，不能派工作；請 owner 發一個 can_write 的 token（POST /search/tokens {\"can_write\": true}）")
    return p


# ---------------------------------------------------------------- coding 員工清單
@router.get("/staff")
def list_staff(request: Request, p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    rows = db.exec(select(Agent).where(Agent.company_id == p.company_id).order_by(Agent.created_at)).all()
    out = []
    for a in rows:
        rt = staff.runtime_of(a)
        if not staff.is_coding(rt):
            continue
        out.append({"id": a.id, "name": a.name, "title": a.title, "runtime": rt, "workspace": a.workspace or "",
                    "enabled": bool(a.enabled), "installed": bool(staff.bin_for(request.app, rt)),
                    "model": staff.config_public(a)["model"]})
    return out


# ---------------------------------------------------------------- 派工作
class JobCreate(BaseModel):
    agent_id: str = ""
    agent: str = ""  # 也接受員工名稱，方便 skill 直接寫「派給 devbot」
    task: str
    workspace: str = ""
    timeout_seconds: Optional[float] = None


def _resolve_agent(db: Session, p: Principal, body: JobCreate) -> Agent:
    a: Optional[Agent] = None
    if body.agent_id:
        a = db.get(Agent, body.agent_id)
    elif body.agent:
        a = db.exec(select(Agent).where(Agent.company_id == p.company_id, Agent.name == body.agent)).first()
    if a is None or a.company_id != p.company_id:
        raise not_found("agent")
    if not staff.is_coding(staff.runtime_of(a)):
        raise bad_request(f"「{a.name}」是 Hermes 員工，不是 coding 員工", "not_a_coding_agent")
    if not a.enabled:
        raise bad_request(f"「{a.name}」目前停用中", "agent_disabled")
    return a


@router.post("/jobs", status_code=201)
async def create_job(body: JobCreate, request: Request, p: Principal = Depends(write_principal), db: Session = Depends(get_db)):
    task = (body.task or "").strip()
    if not task:
        raise bad_request("task 不能是空的")
    a = _resolve_agent(db, p, body)
    ws = staff.check_workspace(request.app, body.workspace or a.workspace)
    timeout = float(body.timeout_seconds or DEFAULT_TIMEOUT)
    if timeout <= 0 or timeout > MAX_TIMEOUT:
        raise bad_request(f"timeout_seconds 必須介於 1–{int(MAX_TIMEOUT)}", "bad_timeout")
    spec = staff.build_spec(request.app, a, task, workspace=ws, db=db)  # CLI 沒裝會在這裡 400
    job = CodingJob(company_id=p.company_id, member_id=p.member.id, agent_id=a.id, agent_name=a.name,
                    runtime=a.runtime, workspace=ws, task=task,
                    source="skill" if getattr(p, "token_id", "") else "api")
    db.add(job)
    db.commit()
    db.refresh(job)
    # 端點是 async：直接掛在事件迴圈上跑，呼叫端立刻拿到 job id（skill 自己輪詢）
    bg = asyncio.create_task(_run_job(request.app.state.engine, job.id, spec, timeout))
    _TASKS.add(bg)
    bg.add_done_callback(_TASKS.discard)
    return job.to_dict()


async def _run_job(engine, job_id: str, spec, timeout: float) -> None:
    with Session(engine) as db:
        j = db.get(CodingJob, job_id)
        if j:
            j.status = "running"
            j.started_at = now()
            db.add(j)
            db.commit()

    async def on_event(ev: dict[str, Any]) -> None:  # 派工作是背景任務，事件不外送（結果由 GET 取）
        return

    try:
        result = await staff.execute(spec, job_id, on_event, registry=PROCESSES, timeout=timeout)
    except Exception as e:  # pragma: no cover
        log.exception("coding job failed")
        result = {"status": "failed", "error": str(e), "output": "", "exit_code": None, "usage": {},
                  "diff": {"after": "", "files": [], "before": "", "is_git": False}}
    with Session(engine) as db:
        j = db.get(CodingJob, job_id)
        if j is None:
            return
        j.status = result.get("status") or "failed"
        j.output = str(result.get("output") or "")
        j.error = str(result.get("error") or "")
        j.exit_code = result.get("exit_code")
        diff = result.get("diff") or {}
        j.diff = str(diff.get("after") or "")
        j.before_paths_json = json.dumps(sorted({c["path"] for c in staff.diff_stat(str(diff.get("before") or ""))}
                                                | set(result.get("before_paths") or [])), ensure_ascii=False)
        j.files_json = json.dumps(diff.get("files") or [], ensure_ascii=False)
        j.usage_json = json.dumps(result.get("usage") or {}, ensure_ascii=False, default=str)
        j.finished_at = now()
        db.add(j)
        db.commit()


def _owned_job(db: Session, p: Principal, job_id: str) -> CodingJob:
    j = db.get(CodingJob, job_id)
    if j is None or j.company_id != p.company_id:
        raise not_found("job")
    return j


@router.get("/jobs")
def list_jobs(limit: int = 20, p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    rows = db.exec(select(CodingJob).where(CodingJob.company_id == p.company_id)
                   .order_by(CodingJob.created_at.desc()).limit(max(1, min(limit, 100)))).all()
    return [j.to_dict() for j in rows]


@router.get("/jobs/{job_id}")
def get_job(job_id: str, p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    return _owned_job(db, p, job_id).to_dict()


@router.get("/jobs/{job_id}/diff")
def get_job_diff(job_id: str, p: Principal = Depends(read_principal), db: Session = Depends(get_db)):
    j = _owned_job(db, p, job_id)
    return {"id": j.id, "workspace": j.workspace, "changes": j._changes(), "diff": j.diff,
            "files": json.loads(j.files_json or "[]")}
