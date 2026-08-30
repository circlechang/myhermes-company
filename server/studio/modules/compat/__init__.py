"""compat 模組：Hermes 升級會不會斷 → 一個指令就能檢查。

- 接觸面清單：studio/hermes/contract/surface.yaml（機器可讀；`GET /compat/surface`）
- 契約測試：`POST /compat/check`（對正式 Hermes 跑；`writes` 才做會建資料的呼叫）；CLI `python -m studio.modules.compat hermes-check [--json]`
- 升級預檢：`POST /compat/precheck {version|"latest"}` 背景任務，`GET /compat/precheck/{id}` 輪詢；沙盒絕不碰 ~/.hermes
- 每週自動盯：on_startup 起一個 loop（預設週六 22:00），抓 GitHub tag，比已測版本新就預檢；fail → event + inbox；全 pass → 更新已測版本
- 能力降級：`capabilities()`／`GET /compat/capabilities` 由最近一次契約測試推導哪些模組不可用

表：compat_runs（每次 check／precheck 的報告）、compat_state（單列：排程設定、已測版本）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, current_principal, get_db
from ...errors import ApiError, not_found
from ...hermes import contract
from ...models import new_id, now
from . import precheck as _pc
from . import scheduler as _sched

log = logging.getLogger("studio.compat")
router = APIRouter(prefix="/compat", tags=["compat"])

_engine = None
_jobs: dict[str, _pc.PrecheckJob] = {}
_check_lock = asyncio.Lock()


# ---------------------------------------------------------------- models
class CompatRun(SQLModel, table=True):
    __tablename__ = "compat_runs"
    id: str = Field(default_factory=lambda: new_id("cr"), primary_key=True)
    kind: str = "check"  # check | precheck
    want: str = ""       # precheck 要求的版本（latest / tag）
    tag: str = ""
    version: str = ""    # Hermes 回報的版本（0.20.5）
    status: str = "done"  # done | failed | timeout
    verdict: str = ""    # compatible | partial | incompatible
    summary_json: str = "{}"
    report_json: str = ""
    error: str = ""
    log_path: str = ""
    triggered_by: str = "manual"  # manual | schedule | cli
    created_at: datetime = Field(default_factory=now)
    finished_at: Optional[datetime] = None

    def to_dict(self, with_report: bool = False) -> dict[str, Any]:
        d = {"id": self.id, "kind": self.kind, "want": self.want, "tag": self.tag, "version": self.version, "status": self.status,
             "verdict": self.verdict, "summary": json.loads(self.summary_json or "{}"), "error": self.error, "log_path": self.log_path,
             "triggered_by": self.triggered_by, "created_at": self.created_at, "finished_at": self.finished_at}
        if with_report:
            d["report"] = json.loads(self.report_json) if self.report_json else None
        return d


class CompatState(SQLModel, table=True):
    __tablename__ = "compat_state"
    id: str = Field(default="default", primary_key=True)
    schedule_enabled: bool = True
    schedule_weekday: int = 5  # 0=一 … 5=六 6=日
    schedule_hour: int = 22
    schedule_minute: int = 0
    tested_tag: str = ""       # 最近一次全 pass 的 Hermes tag（vYYYY.M.D）
    tested_version: str = ""   # 對應的 X.Y.Z
    tested_at: Optional[datetime] = None
    latest_seen_tag: str = ""
    latest_seen_at: Optional[datetime] = None
    last_schedule_run: Optional[datetime] = None
    updated_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {"schedule": {"enabled": self.schedule_enabled, "weekday": self.schedule_weekday, "hour": self.schedule_hour,
                             "minute": self.schedule_minute, "last_run": self.last_schedule_run},
                "tested": {"tag": self.tested_tag, "version": self.tested_version, "at": self.tested_at},
                "latest_seen": {"tag": self.latest_seen_tag, "at": self.latest_seen_at}}


def _state(db: Session) -> CompatState:
    st = db.get(CompatState, "default")
    if not st:
        # 第一次建立就把 last_schedule_run 設成現在：等下一個排定時刻才跑，不會一啟動就開預檢
        st = CompatState(last_schedule_run=datetime.now())
        db.add(st)
        db.commit()
        db.refresh(st)
    return st


# ---------------------------------------------------------------- core ops
def _settings(request: Optional[Request] = None):
    if request is not None:
        return request.app.state.settings
    from ...config import Settings
    return Settings.from_env()


def _save_run(engine, *, kind: str, report: Optional[dict[str, Any]], want: str = "", tag: str = "", error: str = "",
              status: str = "done", log_path: str = "", triggered_by: str = "manual") -> CompatRun:
    summ = (report or {}).get("summary") or {}
    row = CompatRun(kind=kind, want=want, tag=tag or ((report or {}).get("precheck") or {}).get("tag", ""),
                    version=((report or {}).get("hermes") or {}).get("version", ""), status=status,
                    verdict=summ.get("verdict", ""), summary_json=json.dumps(summ, ensure_ascii=False, default=str),
                    report_json=json.dumps(report, ensure_ascii=False, default=str) if report else "", error=error,
                    log_path=log_path, triggered_by=triggered_by, finished_at=now())
    with Session(engine) as s:
        s.add(row)
        s.commit()
        s.refresh(row)
    return row


def _latest_check(engine, kind: str = "check") -> Optional[CompatRun]:
    if engine is None:
        return None
    with Session(engine) as s:
        return s.exec(select(CompatRun).where(CompatRun.kind == kind, CompatRun.status == "done")
                      .order_by(CompatRun.created_at.desc())).first()


async def run_check(settings, *, writes: bool = False, triggered_by: str = "manual", engine=None) -> dict[str, Any]:
    """對正式 Hermes 跑契約測試並存檔。"""
    async with _check_lock:
        report = await contract.run_async(settings.hermes_home, settings.hermes_api_url, settings.hermes_api_key,
                                          hermes_bin=settings.hermes_bin, writes=writes)
    eng = engine or _engine
    if eng is not None:
        row = _save_run(eng, kind="check", report=report, triggered_by=triggered_by)
        report["run_id"] = row.id
        _after_check(eng, report, kind="check")
    return report


def _after_check(engine, report: dict[str, Any], *, kind: str, tag: str = "") -> None:
    """fail → event + inbox；全 pass（precheck）→ 更新已測版本。"""
    summ = report.get("summary") or {}
    verdict = summ.get("verdict")
    ver = (report.get("hermes") or {}).get("version", "")
    try:
        from ..events import record as _record
        _record(f"compat.{kind}", "compat", tag or ver, {"verdict": verdict, "fail": summ.get("fail"), "pass": summ.get("pass"),
                                                          "affected": summ.get("affected_modules")})
    except Exception as e:  # noqa: BLE001
        log.debug("compat event skipped: %s", e)
    if verdict in ("partial", "incompatible"):
        mods = ", ".join(m["module"] for m in summ.get("affected_modules") or []) or "-"
        title = (f"Hermes {tag or ver} 升級預檢：{'不相容' if verdict == 'incompatible' else '部分相容'}" if kind == "precheck"
                 else f"Hermes {ver} 契約測試有 {summ.get('fail')} 項失敗")
        try:
            from ..inbox import add_item
            from ...models import Company
            with Session(engine) as s:
                for c in s.exec(select(Company)).all():
                    add_item(c.id, "compat", title, f"受影響模組：{mods}；失敗項：{', '.join(summ.get('failed_ids') or [])}",
                             ref=f"compat:{kind}:{tag or ver}", link="/compat", db=s)
                s.commit()
        except Exception as e:  # noqa: BLE001
            log.warning("compat inbox item failed: %s", e)
    elif kind == "precheck" and verdict == "compatible" and tag:
        with Session(engine) as s:
            st = _state(s)
            if not st.tested_tag or _pc.is_newer(tag, st.tested_tag) or tag == st.tested_tag:
                st.tested_tag, st.tested_version, st.tested_at, st.updated_at = tag, ver, now(), now()
                s.add(st)
                s.commit()


async def _run_precheck_job(job: _pc.PrecheckJob, engine, *, triggered_by: str) -> None:
    root = Path(os.environ.get("STUDIO_PRECHECK_DIR") or Path(tempfile_dir()))
    await _pc.run_precheck(job, workdir_root=root, keep=os.environ.get("STUDIO_PRECHECK_KEEP") == "1")
    if engine is not None:
        status = "done" if job.report else ("timeout" if job.status == "timeout" else "failed")
        _save_run(engine, kind="precheck", report=job.report, want=job.want, tag=job.tag, error=job.error, status=status,
                  log_path=job.log_path, triggered_by=triggered_by)
        if job.report:
            _after_check(engine, job.report, kind="precheck", tag=job.tag)


def tempfile_dir() -> str:
    import tempfile
    return tempfile.gettempdir()


def start_precheck(want: str, *, engine=None, triggered_by: str = "manual") -> _pc.PrecheckJob:
    running = [j for j in _jobs.values() if j.status not in ("done", "failed", "timeout")]
    if running:
        raise ApiError(409, "precheck_running", f"已有預檢在跑（{running[0].id}）")
    job = _pc.PrecheckJob(id=f"pc_{uuid.uuid4().hex[:10]}", want=want or "latest")
    _jobs[job.id] = job
    asyncio.create_task(_run_precheck_job(job, engine if engine is not None else _engine, triggered_by=triggered_by))
    return job


def capabilities(engine=None) -> dict[str, Any]:
    """給其他模組用：由最近一次契約測試推導模組可用性。沒跑過 → 全 unknown。"""
    row = _latest_check(engine if engine is not None else _engine)
    report = json.loads(row.report_json) if row and row.report_json else None
    return contract.capabilities(report)


# ---------------------------------------------------------------- scheduler
async def scheduler_tick(engine, settings, *, now_dt: Optional[datetime] = None) -> str:
    """一次排程判斷；回傳做了什麼（noop|precheck:<tag>|skip:<why>）。"""
    now_dt = now_dt or datetime.now()
    with Session(engine) as s:
        st = _state(s)
        if not _sched.due(now_dt, enabled=st.schedule_enabled, weekday=st.schedule_weekday, hour=st.schedule_hour,
                          minute=st.schedule_minute, last_run=st.last_schedule_run):
            return "noop"
        st.last_schedule_run = now_dt
        s.add(st)
        s.commit()
    return await check_latest(engine, triggered_by="schedule")


async def check_latest(engine, *, triggered_by: str = "manual") -> str:
    tags = await _pc.fetch_remote_tags()
    latest = tags[-1] if tags else ""
    with Session(engine) as s:
        st = _state(s)
        if latest:
            st.latest_seen_tag, st.latest_seen_at = latest, now()
        # 已測版本沒設定時，用本機 hermes --version 的日期當基準
        tested = st.tested_tag
        s.add(st)
        s.commit()
    if not latest:
        return "skip:no-tags"
    if not tested:
        tested = _local_tag(engine)
    action = _sched.decide(latest, tested, is_newer=_pc.is_newer)
    if action != "precheck":
        return f"noop:{latest}"
    try:
        job = start_precheck(latest, engine=engine, triggered_by=triggered_by)
    except ApiError as e:
        return f"skip:{e.message if hasattr(e, 'message') else e}"
    return f"precheck:{latest}:{job.id}"


def _local_tag(engine) -> str:
    row = _latest_check(engine)
    if row and row.report_json:
        date = ((json.loads(row.report_json).get("hermes") or {}).get("date")) or ""
        return _pc.date_to_tag(date)
    return ""


async def _loop(app) -> None:
    interval = float(os.environ.get("STUDIO_COMPAT_TICK_SECONDS", "60"))
    await asyncio.sleep(5)
    while True:
        try:
            r = await scheduler_tick(app.state.engine, app.state.settings)
            if r != "noop":
                log.info("compat scheduler: %s", r)
        except Exception as e:  # noqa: BLE001
            log.warning("compat scheduler tick failed: %s", e)
        await asyncio.sleep(interval)


async def on_startup(app) -> None:
    global _engine
    _engine = app.state.engine
    if os.environ.get("STUDIO_COMPAT_SCHEDULER", "1") not in ("0", "false", "no", "off") and \
            not getattr(app.state.settings, "_no_scheduler", False):
        app.state.compat_task = asyncio.create_task(_loop(app))


async def on_shutdown(app) -> None:
    t = getattr(app.state, "compat_task", None)
    if t:
        t.cancel()


# ---------------------------------------------------------------- API
class CheckBody(BaseModel):
    writes: bool = False


class PrecheckBody(BaseModel):
    version: str = "latest"


class ScheduleBody(BaseModel):
    enabled: Optional[bool] = None
    weekday: Optional[int] = None
    hour: Optional[int] = None
    minute: Optional[int] = None


@router.get("/surface")
def get_surface(p: Principal = Depends(current_principal)):
    s = contract.load_surface()
    return {"version": s.version, "hermes_tested": s.hermes_tested, "modules": s.modules,
            "items": [{"id": i.id, "kind": i.kind, "risk": i.risk, "label": i.label, "note": i.note, "critical": i.critical,
                       "affects": i.affects, "probe": i.get("probe", ""),
                       "target": (f"{i.get('method')} {i.get('path')}" if i.kind == "endpoint"
                                  else "hermes " + " ".join(str(a) for a in (i.get("argv") or [])) if i.kind == "cli"
                                  else str(i.get("path")) + (f" [{i.get('table')}]" if i.kind == "db" else ""))}
                      for i in s.items]}


@router.get("/status")
def get_status(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    st = _state(db)
    last = _latest_check(request.app.state.engine, "check")
    last_pc = _latest_check(request.app.state.engine, "precheck")
    running = [j.to_dict(with_report=False) for j in _jobs.values() if j.status not in ("done", "failed", "timeout")]
    return {**st.to_dict(),
            "current": {"version": last.version if last else "", "checked_at": last.created_at if last else None,
                        "verdict": last.verdict if last else "", "run_id": last.id if last else ""},
            "last_precheck": last_pc.to_dict() if last_pc else None,
            "running": running}


@router.get("/runs")
def list_runs(request: Request, kind: Optional[str] = None, limit: int = 30, p: Principal = Depends(current_principal),
              db: Session = Depends(get_db)):
    q = select(CompatRun).order_by(CompatRun.created_at.desc())
    if kind:
        q = q.where(CompatRun.kind == kind)
    return [r.to_dict() for r in db.exec(q.limit(max(1, min(limit, 200)))).all()]


@router.get("/runs/{run_id}")
def get_run(run_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    r = db.get(CompatRun, run_id)
    if not r:
        raise not_found("run")
    return r.to_dict(with_report=True)


@router.post("/check")
async def post_check(body: CheckBody, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    return await run_check(request.app.state.settings, writes=body.writes, engine=request.app.state.engine)


@router.post("/precheck")
async def post_precheck(body: PrecheckBody, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    job = start_precheck(body.version, engine=request.app.state.engine)
    return job.to_dict(with_report=False)


@router.get("/precheck/{job_id}")
def get_precheck(job_id: str, p: Principal = Depends(current_principal)):
    j = _jobs.get(job_id)
    if not j:
        raise not_found("precheck job")
    return j.to_dict(with_report=True)


@router.post("/check-latest")
async def post_check_latest(request: Request, p: Principal = Depends(current_principal)):
    """手動「立即檢查」：抓最新 tag，比已測版本新就開預檢。"""
    p.require_admin()
    r = await check_latest(request.app.state.engine, triggered_by="manual")
    return {"result": r}


@router.get("/capabilities")
def get_capabilities(request: Request, p: Principal = Depends(current_principal)):
    return capabilities(request.app.state.engine)


@router.get("/schedule")
def get_schedule(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return _state(db).to_dict()["schedule"]


@router.patch("/schedule")
def patch_schedule(body: ScheduleBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    st = _state(db)
    if body.enabled is not None:
        st.schedule_enabled = body.enabled
    if body.weekday is not None:
        if not 0 <= body.weekday <= 6:
            raise ApiError(400, "bad_request", "weekday 0..6")
        st.schedule_weekday = body.weekday
    if body.hour is not None:
        if not 0 <= body.hour <= 23:
            raise ApiError(400, "bad_request", "hour 0..23")
        st.schedule_hour = body.hour
    if body.minute is not None:
        if not 0 <= body.minute <= 59:
            raise ApiError(400, "bad_request", "minute 0..59")
        st.schedule_minute = body.minute
    st.updated_at = now()
    db.add(st)
    db.commit()
    db.refresh(st)
    return st.to_dict()["schedule"]
