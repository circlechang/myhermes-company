"""D. 排程任務：走 gateway `/api/jobs`（`hermes cron list` 沒有 --json，CLI 不當資料源）。

- CRUD／暫停／恢復／立即執行 → gateway（帶 `?profile=` 就走 `/p/{profile}` 前綴，含 default）
- 執行歷史 → 唯讀 `~/.hermes/cron/executions.db`＋`cron/output/<job_id>/*.md`
- 投遞目標清單 → 已設定的平台（channels registry）＋ profile（bot-chat:<profile>）
"""
from __future__ import annotations

import logging
import sqlite3
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ...auth import Principal, allowed_profiles, current_principal, profile_visible
from ...errors import ApiError, not_found
from ..channels.registry import PLATFORMS
from ..profiles import files as F

log = logging.getLogger("studio.cron")
router = APIRouter(prefix="/cron", tags=["cron"])

PRESETS = [
    {"id": "every_15m", "label": "每 15 分鐘", "schedule": "*/15 * * * *"},
    {"id": "hourly", "label": "每小時", "schedule": "0 * * * *"},
    {"id": "daily_9", "label": "每天 09:00", "schedule": "0 9 * * *"},
    {"id": "daily_3", "label": "每天 03:00", "schedule": "0 3 * * *"},
    {"id": "weekdays_9", "label": "平日 09:00", "schedule": "0 9 * * 1-5"},
    {"id": "weekly_mon_9", "label": "每週一 09:00", "schedule": "0 9 * * 1"},
    {"id": "monthly_1", "label": "每月 1 日 09:00", "schedule": "0 9 1 * *"},
    {"id": "once_30m", "label": "30 分鐘後一次", "schedule": "30m", "repeat": 1},
]


async def _gw(request: Request, method: str, path: str, profile: Optional[str] = None, json: Any = None) -> Any:
    gw = request.app.state.gateway
    prefix = gw._prefix(profile)  # 統一規則：有 profile 就加 /p/{profile}（Hermes 對 /p/default 也接受，契約項 gw.prefix.default）
    try:
        async with httpx.AsyncClient(base_url=gw.base_url, headers={"Authorization": f"Bearer {gw.api_key}"}, timeout=30.0,
                                     transport=getattr(gw, "_transport", None)) as c:
            r = await c.request(method, prefix + path, json=json)
    except httpx.HTTPError as e:
        raise ApiError(502, "gateway_unreachable", str(e))
    if r.status_code >= 400:
        msg = r.text[:500]
        try:
            j = r.json()
            msg = j.get("error") if isinstance(j.get("error"), str) else (j.get("error") or {}).get("message") or j.get("message") or msg
        except Exception:
            pass
        code = "not_found" if r.status_code == 404 else "gateway_error"
        raise ApiError(404 if r.status_code == 404 else 502, code, str(msg))
    try:
        return r.json()
    except ValueError:
        return {}


def _check_profile(p: Principal, profile: Optional[str]) -> None:
    if profile and not profile_visible(p.member, profile):
        raise not_found("profile")


def _job_public(j: dict[str, Any]) -> dict[str, Any]:
    sched = j.get("schedule")
    return {
        **j,
        "schedule_display": j.get("schedule_display") or (sched.get("display") if isinstance(sched, dict) else sched),
        "paused": (j.get("state") == "paused") or (j.get("enabled") is False),
    }


@router.get("/presets")
def presets(p: Principal = Depends(current_principal)):
    return {"presets": PRESETS}


@router.get("/targets")
def targets(request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    """投遞目標：origin/local ＋ 已設定平台 ＋ bot-chat:<profile>。"""
    home = Path(request.app.state.settings.hermes_home)
    env = F.read_env(home / ".env")
    if profile and profile != "default":
        env = {**env, **F.read_env(F.profile_dir(home, profile) / ".env")}
    out = [{"id": "local", "label": "本機（僅記錄）", "kind": "builtin"}, {"id": "origin", "label": "建立來源", "kind": "builtin"}]
    for pl in PLATFORMS:
        req = [f for f in pl.fields if f.required]
        if req and all(env.get(f.name, "") for f in req):
            out.append({"id": pl.id, "label": pl.label, "kind": "platform", "hint": f"{pl.id}:<chat_id> 可指定對象"})
    allowed = allowed_profiles(p.member)
    for name in F.list_profile_names(home):
        if allowed is None or name in allowed:
            out.append({"id": f"bot-chat:{name}", "label": f"Bot Chat（{name}）", "kind": "profile"})
    return {"targets": out}


@router.get("/jobs")
async def list_jobs(request: Request, profile: Optional[str] = None, include_disabled: bool = True,
                    p: Principal = Depends(current_principal)):
    _check_profile(p, profile)
    data = await _gw(request, "GET", f"/api/jobs?include_disabled={'true' if include_disabled else 'false'}", profile)
    jobs = data.get("jobs") if isinstance(data, dict) else data
    return {"jobs": [_job_public(j) for j in (jobs or [])], "profile": profile or "default"}


class JobCreate(BaseModel):
    name: str
    schedule: str
    prompt: str = ""
    deliver: str = "local"
    skills: Optional[list[str]] = None
    repeat: Optional[int] = None
    profile: Optional[str] = None


@router.post("/jobs", status_code=201)
async def create_job(body: JobCreate, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    _check_profile(p, body.profile)
    if not body.name.strip() or not body.schedule.strip():
        raise ApiError(400, "bad_request", "name 與 schedule 必填")
    payload: dict[str, Any] = {"name": body.name.strip(), "schedule": body.schedule.strip(), "prompt": body.prompt, "deliver": body.deliver or "local"}
    if body.skills:
        payload["skills"] = body.skills
    if body.repeat:
        payload["repeat"] = body.repeat
    data = await _gw(request, "POST", "/api/jobs", body.profile, json=payload)
    return _job_public(data.get("job") or data)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    _check_profile(p, profile)
    data = await _gw(request, "GET", f"/api/jobs/{job_id}", profile)
    return _job_public(data.get("job") or data)


class JobPatch(BaseModel):
    name: Optional[str] = None
    schedule: Optional[str] = None
    prompt: Optional[str] = None
    deliver: Optional[str] = None
    skills: Optional[list[str]] = None
    repeat: Optional[int] = None
    enabled: Optional[bool] = None
    profile: Optional[str] = None


@router.patch("/jobs/{job_id}")
async def update_job(job_id: str, body: JobPatch, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    _check_profile(p, body.profile)
    patch = {k: v for k, v in body.model_dump(exclude_none=True).items() if k != "profile"}
    if not patch:
        raise ApiError(400, "bad_request", "沒有可更新的欄位")
    data = await _gw(request, "PATCH", f"/api/jobs/{job_id}", body.profile, json=patch)
    return _job_public(data.get("job") or data)


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    _check_profile(p, profile)
    await _gw(request, "DELETE", f"/api/jobs/{job_id}", profile)
    return {"ok": True}


async def _action(request: Request, job_id: str, action: str, profile: Optional[str]) -> dict[str, Any]:
    data = await _gw(request, "POST", f"/api/jobs/{job_id}/{action}", profile, json={})
    return _job_public(data.get("job") or data)


@router.post("/jobs/{job_id}/pause")
async def pause_job(job_id: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    _check_profile(p, profile)
    return await _action(request, job_id, "pause", profile)


@router.post("/jobs/{job_id}/resume")
async def resume_job(job_id: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    _check_profile(p, profile)
    return await _action(request, job_id, "resume", profile)


@router.post("/jobs/{job_id}/run")
async def run_job(job_id: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    _check_profile(p, profile)
    return await _action(request, job_id, "run", profile)


@router.get("/jobs/{job_id}/runs")
def job_runs(job_id: str, request: Request, profile: Optional[str] = None, limit: int = 50,
             p: Principal = Depends(current_principal)):
    """執行歷史：唯讀 executions.db ＋ output 檔案清單。"""
    _check_profile(p, profile)
    home = Path(request.app.state.settings.hermes_home)
    cron_dir = F.profile_dir(home, profile or "default") / "cron"
    return {"runs": read_executions(cron_dir, job_id, limit), "outputs": list_outputs(cron_dir, job_id)}


@router.get("/jobs/{job_id}/output/{filename}")
def job_output(job_id: str, filename: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    _check_profile(p, profile)
    home = Path(request.app.state.settings.hermes_home)
    cron_dir = F.profile_dir(home, profile or "default") / "cron"
    if "/" in filename or ".." in filename or "/" in job_id or ".." in job_id:
        raise ApiError(400, "bad_request", "bad filename")
    f = cron_dir / "output" / job_id / filename
    if not f.is_file():
        raise not_found("output")
    return {"filename": filename, "text": f.read_text(encoding="utf-8", errors="replace")[:200_000]}


def read_executions(cron_dir: Path, job_id: str, limit: int = 50) -> list[dict[str, Any]]:
    db = cron_dir / "executions.db"
    if not db.exists():
        return []
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2.0)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT id, job_id, source, status, claimed_at, started_at, finished_at, error FROM executions "
            "WHERE job_id = ? ORDER BY claimed_at DESC LIMIT ?", (job_id, max(1, min(limit, 500)))).fetchall()
        con.close()
    except sqlite3.Error as e:
        log.warning("executions.db read failed: %s", e)
        return []
    out = []
    for r in rows:
        d = dict(r)
        try:
            from datetime import datetime
            if d.get("started_at") and d.get("finished_at"):
                d["duration_s"] = round((datetime.fromisoformat(d["finished_at"]) - datetime.fromisoformat(d["started_at"])).total_seconds(), 2)
        except Exception:
            pass
        out.append(d)
    return out


def list_outputs(cron_dir: Path, job_id: str, limit: int = 30) -> list[dict[str, Any]]:
    d = cron_dir / "output" / job_id
    if not d.is_dir():
        return []
    files = sorted((f for f in d.iterdir() if f.is_file()), key=lambda f: f.name, reverse=True)[:limit]
    return [{"filename": f.name, "size": f.stat().st_size} for f in files]
