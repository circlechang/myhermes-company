from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ..auth import Principal, allowed_profiles, current_principal, get_db, profile_visible
from ..errors import ApiError, not_found
from ..hermes.cli import HermesCli
from ..hermes.gateway import GatewayError
from ..models import Agent, Company, now

log = logging.getLogger("studio.agents")
router = APIRouter(tags=["agents"])


def _soul_excerpt(cli: HermesCli, profile: str, n: int = 200) -> str:
    text = cli.read_soul(profile).strip()
    return text[:n]


def agent_public(a: Agent, cli: HermesCli) -> dict:
    return {
        "id": a.id, "name": a.name, "profile": a.profile, "title": a.title, "description": a.description,
        "avatar": a.avatar, "model": a.model, "enabled": a.enabled, "soul_excerpt": _soul_excerpt(cli, a.profile),
        "created_at": a.created_at, "updated_at": a.updated_at,
    }


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
    allowed = allowed_profiles(p.member)  # H 帳號綁定：None=全部可見
    return [agent_public(a, cli) for a in rows if allowed is None or a.profile in allowed]


class AgentCreate(BaseModel):
    name: str
    profile: str
    title: str = ""
    description: str = ""
    avatar: str = ""
    model: str = ""
    enabled: bool = True


class AgentPatch(BaseModel):
    name: Optional[str] = None
    profile: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    avatar: Optional[str] = None
    model: Optional[str] = None
    enabled: Optional[bool] = None


def _get_agent(db: Session, p: Principal, agent_id: str) -> Agent:
    a = db.get(Agent, agent_id)
    if a is None or a.company_id != p.company_id or not profile_visible(p.member, a.profile):
        raise not_found("agent")
    return a


@router.post("/agents", status_code=201)
def create_agent(body: AgentCreate, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    cli: HermesCli = request.app.state.cli
    if body.profile not in cli.list_profiles_fs():
        raise ApiError(400, "unknown_profile", f"profile 不存在: {body.profile}")
    a = Agent(company_id=p.company_id, name=body.name, profile=body.profile, title=body.title,
              description=body.description, avatar=body.avatar, model=body.model or cli.profile_model(body.profile),
              enabled=body.enabled)
    db.add(a)
    db.commit()
    db.refresh(a)
    return agent_public(a, cli)


@router.patch("/agents/{agent_id}")
def patch_agent(agent_id: str, body: AgentPatch, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    a = _get_agent(db, p, agent_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(a, k, v)
    a.updated_at = now()
    db.add(a)
    db.commit()
    db.refresh(a)
    return agent_public(a, request.app.state.cli)


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
    return {"content": request.app.state.cli.read_soul(a.profile)}


class SoulBody(BaseModel):
    content: str
    note: str = ""


@router.put("/agents/{agent_id}/soul")
def put_soul(agent_id: str, body: SoulBody, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    a = _get_agent(db, p, agent_id)
    # 走 soul_history：寫檔＋記版本（每次儲存都有版本可回滾）
    from ..modules.soul_history import write_versioned
    v = write_versioned(request, db, p, a.profile, body.content, note=body.note or f"agents page ({p.member.username})")
    return {"ok": True, "version": v.get("version"), "same": v.get("same", False)}


@router.get("/agents/{agent_id}/skills")
async def get_skills(agent_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    a = _get_agent(db, p, agent_id)
    try:
        skills = await request.app.state.gateway.skills(a.profile)
    except GatewayError as e:
        raise ApiError(502, "gateway_error", e.message)
    except Exception as e:  # connection refused etc.
        raise ApiError(502, "gateway_unreachable", str(e))
    return [{"name": s.get("name"), "enabled": not s.get("disabled", False), "description": s.get("description", ""),
             "category": s.get("category", "")} for s in skills]
