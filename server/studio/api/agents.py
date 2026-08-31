from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import Principal, allowed_profiles, current_principal, get_db, profile_visible
from ..errors import ApiError, bad_request, not_found
from ..hermes.cli import HermesCli
from ..hermes.gateway import GatewayError
from ..models import Agent, Company, now
from ..modules.coding_agents import detect, staff

log = logging.getLogger("studio.agents")
router = APIRouter(tags=["agents"])


def _soul_excerpt(cli: HermesCli, profile: str, n: int = 200) -> str:
    text = cli.read_soul(profile).strip()
    return text[:n]


def agent_public(a: Agent, cli: HermesCli, app=None) -> dict:
    runtime = staff.runtime_of(a)
    d = {
        "id": a.id, "name": a.name, "profile": a.profile, "title": a.title, "description": a.description,
        "avatar": a.avatar, "model": a.model, "enabled": a.enabled,
        "runtime": runtime, "workspace": a.workspace or "",
        "created_at": a.created_at, "updated_at": a.updated_at,
    }
    if staff.is_coding(runtime):
        aid = staff.cli_id(runtime)
        spec = detect.AGENTS[aid]
        d.update({
            "soul_excerpt": "",
            "coding_config": staff.config_public(a),
            "runtime_name": spec["name"],
            "install_cmd": spec["install_cmd"],
            "installed": bool(staff.bin_for(app, runtime)) if app is not None else None,
            "workspace_vpath": staff.virtual_workspace(app, a.workspace or "") if app is not None else "",
        })
    else:
        d.update({"soul_excerpt": _soul_excerpt(cli, a.profile), "runtime_name": "Hermes", "installed": True,
                  "install_cmd": "", "coding_config": None, "workspace_vpath": ""})
    return d


async def sync_agents_from_profiles(engine, cli: HermesCli) -> int:
    """Create an Agent row per Hermes profile for every company (idempotent)."""
    profiles = await cli.list_profiles()
    created = 0
    with Session(engine) as db:
        companies = db.exec(select(Company)).all()
        for co in companies:
            existing = {a.profile: a for a in db.exec(select(Agent).where(Agent.company_id == co.id)).all()}
            for info in profiles:
                name = info["name"]
                if name in existing:
                    a = existing[name]
                    if info.get("model") and a.model != info["model"]:
                        a.model = info["model"]
                        a.updated_at = now()
                        db.add(a)
                    continue
                db.add(Agent(company_id=co.id, name=name, profile=name, model=info.get("model", ""),
                             enabled=(name == "default"), title="", description=""))
                created += 1
        db.commit()
    return created


@router.get("/agents")
def list_agents(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    cli = request.app.state.cli
    rows = db.exec(select(Agent).where(Agent.company_id == p.company_id).order_by(Agent.created_at)).all()
    allowed = allowed_profiles(p.member)  # H 帳號綁定：None=全部可見（coding 員工不綁 profile，一律可見）
    return [agent_public(a, cli, request.app) for a in rows
            if staff.is_coding(staff.runtime_of(a)) or allowed is None or a.profile in allowed]


class AgentCreate(BaseModel):
    name: str
    profile: str = ""  # runtime=hermes 時必填
    title: str = ""
    description: str = ""
    avatar: str = ""
    model: str = ""
    enabled: bool = True
    runtime: str = "hermes"  # hermes | claude-code | codex | pi
    workspace: str = ""  # coding 員工必填，且必須在檔案模組的根白名單內
    coding_config: Optional[dict] = None


class AgentPatch(BaseModel):
    name: Optional[str] = None
    profile: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    avatar: Optional[str] = None
    model: Optional[str] = None
    enabled: Optional[bool] = None
    workspace: Optional[str] = None
    coding_config: Optional[dict] = None


def _get_agent(db: Session, p: Principal, agent_id: str) -> Agent:
    a = db.get(Agent, agent_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("agent")
    if not staff.is_coding(staff.runtime_of(a)) and not profile_visible(p.member, a.profile):
        raise not_found("agent")
    return a


def _require_hermes(a: Agent) -> None:
    if staff.is_coding(staff.runtime_of(a)):
        raise bad_request("這是 coding 員工，沒有 SOUL.md／Hermes skills", "not_a_hermes_agent")


@router.get("/agents/runtimes")
async def list_runtimes(request: Request, p: Principal = Depends(current_principal)):
    """建立員工時可選的 runtime（未安裝的會標 installed=false 並附安裝指令）＋ 允許的工作目錄根。"""
    return {"runtimes": await staff.runtime_catalog(request.app), "workspace_roots": staff.roots_public(request.app)}


@router.post("/agents", status_code=201)
def create_agent(body: AgentCreate, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    cli: HermesCli = request.app.state.cli
    runtime = (body.runtime or staff.HERMES).strip()
    if runtime not in staff.VALID_RUNTIMES:
        raise bad_request(f"runtime 只能是 {'／'.join(sorted(staff.VALID_RUNTIMES))}", "bad_runtime")
    if not staff.is_coding(runtime):
        if body.profile not in cli.list_profiles_fs():
            raise ApiError(400, "unknown_profile", f"profile 不存在: {body.profile}")
        a = Agent(company_id=p.company_id, name=body.name, profile=body.profile, title=body.title,
                  description=body.description, avatar=body.avatar, model=body.model or cli.profile_model(body.profile),
                  enabled=body.enabled, runtime=staff.HERMES)
    else:
        if not staff.bin_for(request.app, runtime):
            spec = detect.AGENTS[staff.cli_id(runtime)]
            raise ApiError(400, "agent_not_installed",
                           f"{spec['name']} 尚未安裝，先跑：{spec['install_cmd']}")
        ws = staff.check_workspace(request.app, body.workspace)
        cfg = {**staff.default_config(runtime), **(body.coding_config or {})}
        if str(cfg.get("api_mode") or "direct") not in ("direct", "hermes"):
            raise bad_request("api_mode 只能是 direct 或 hermes", "bad_api_mode")
        if body.model:
            cfg["model"] = body.model
        a = Agent(company_id=p.company_id, name=body.name, profile="", title=body.title,
                  description=body.description, avatar=body.avatar, model=str(cfg.get("model") or ""),
                  enabled=body.enabled, runtime=runtime, workspace=ws,
                  coding_config_json=json.dumps(cfg, ensure_ascii=False))
    db.add(a)
    db.commit()
    db.refresh(a)
    return agent_public(a, cli, request.app)


@router.patch("/agents/{agent_id}")
def patch_agent(agent_id: str, body: AgentPatch, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    a = _get_agent(db, p, agent_id)
    patch = body.model_dump(exclude_none=True)
    coding_config = patch.pop("coding_config", None)
    workspace = patch.pop("workspace", None)
    if workspace is not None:
        if not staff.is_coding(staff.runtime_of(a)):
            raise bad_request("只有 coding 員工有工作目錄", "not_a_coding_agent")
        a.workspace = staff.check_workspace(request.app, workspace)
    if coding_config is not None:
        if not staff.is_coding(staff.runtime_of(a)):
            raise bad_request("只有 coding 員工有 coding 設定", "not_a_coding_agent")
        cfg = {**staff.config_public(a), **coding_config}
        if str(cfg.get("api_mode") or "direct") not in ("direct", "hermes"):
            raise bad_request("api_mode 只能是 direct 或 hermes", "bad_api_mode")
        a.coding_config_json = json.dumps(cfg, ensure_ascii=False)
        if cfg.get("model") is not None:
            a.model = str(cfg["model"] or "")
    for k, v in patch.items():
        setattr(a, k, v)
    a.updated_at = now()
    db.add(a)
    db.commit()
    db.refresh(a)
    return agent_public(a, request.app.state.cli, request.app)


@router.delete("/agents/{agent_id}")
def delete_agent(agent_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    a = _get_agent(db, p, agent_id)
    db.delete(a)
    db.commit()
    return {"ok": True}


@router.get("/agents/{agent_id}/soul")
def get_soul(agent_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    a = _get_agent(db, p, agent_id)
    _require_hermes(a)
    return {"content": request.app.state.cli.read_soul(a.profile)}


class SoulBody(BaseModel):
    content: str
    note: str = ""


@router.put("/agents/{agent_id}/soul")
def put_soul(agent_id: str, body: SoulBody, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    a = _get_agent(db, p, agent_id)
    _require_hermes(a)
    # 走 soul_history：寫檔＋記版本（每次儲存都有版本可回滾）
    from ..modules.soul_history import write_versioned
    v = write_versioned(request, db, p, a.profile, body.content, note=body.note or f"agents page ({p.member.username})")
    return {"ok": True, "version": v.get("version"), "same": v.get("same", False)}


@router.get("/agents/{agent_id}/skills")
async def get_skills(agent_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    a = _get_agent(db, p, agent_id)
    _require_hermes(a)
    try:
        skills = await request.app.state.gateway.skills(a.profile)
    except GatewayError as e:
        raise ApiError(502, "gateway_error", e.message)
    except Exception as e:  # connection refused etc.
        raise ApiError(502, "gateway_unreachable", str(e))
    return [{"name": s.get("name"), "enabled": not s.get("disabled", False), "description": s.get("description", ""),
             "category": s.get("category", "")} for s in skills]
