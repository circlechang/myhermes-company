"""limits 模組：成本護欄（公司／AI 員工每日 token 與美元上限）。

- 表 usage_limits：scope=company（整家公司）或 agent（某個 AI 員工）；daily_tokens / daily_usd 為 0＝不限。
- 今日用量：Studio `messages.usage`（assistant 訊息帶的 run usage）依 session→agent 彙總（UTC 當日）；
  美元＝usage 內的 cost_usd/estimated_cost_usd，沒有就用 usage 模組價格表（session.model 或 agent.model）估。
- 檢查器每分鐘跑一次（STUDIO_LIMITS_CHECK_SECONDS）；超過上限 → 該 agent（或公司全部 agent）enabled=false，
  寫 event `limit.exceeded` ＋ inbox 待辦。每個 limit 每天只觸發一次（last_triggered_on）。
- 解除：管理者到 /agents 或 PATCH /agents/{id} 重新啟用；或提高上限。`POST /limits/{id}/reset` 清掉今天的觸發記錄並重新啟用被它停掉的 agent。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import date, datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, allowed_profiles, current_principal, get_db, profile_visible
from ...errors import bad_request, not_found
from ...models import Agent, ChatSession, Message, new_id, now

log = logging.getLogger("studio.limits")
router = APIRouter(prefix="/limits", tags=["limits"])


class UsageLimit(SQLModel, table=True):
    __tablename__ = "usage_limits"
    id: str = Field(default_factory=lambda: new_id("ul"), primary_key=True)
    company_id: str = Field(index=True)
    scope: str = "agent"  # company | agent
    agent_id: str = Field(default="", index=True)  # scope=agent 時必填
    daily_tokens: int = 0  # 0 = 不限
    daily_usd: float = 0.0  # 0 = 不限
    enabled: bool = True
    action: str = "disable"  # disable | notify（只記事件與待辦、不停用）
    last_triggered_on: str = ""  # YYYY-MM-DD（UTC）
    disabled_agents_json: str = "[]"  # 上次觸發時被停用的 agent ids（reset 用）
    created_by: str = ""
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "scope": self.scope, "agent_id": self.agent_id, "daily_tokens": self.daily_tokens, "daily_usd": self.daily_usd,
                "enabled": self.enabled, "action": self.action, "last_triggered_on": self.last_triggered_on,
                "disabled_agents": json.loads(self.disabled_agents_json or "[]"), "created_at": self.created_at, "updated_at": self.updated_at}


# -- 今日用量 ------------------------------------------------------------------
def _today() -> date:
    return now().date()


def _usage_cost(u: dict[str, Any], model: str, prices: Optional[dict]) -> float:
    for k in ("cost_usd", "estimated_cost_usd", "cost"):
        v = u.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    if not prices:
        return 0.0
    try:
        from ..usage import price_for
        pr = price_for(model, prices)
    except Exception:
        pr = None
    if not pr:
        return 0.0
    i = int(u.get("input_tokens") or u.get("prompt_tokens") or 0)
    o = int(u.get("output_tokens") or u.get("completion_tokens") or 0)
    cr = int(u.get("cache_read_tokens") or u.get("cache_read_input_tokens") or 0)
    return (i * pr.get("input", 0) + o * pr.get("output", 0) + cr * pr.get("cache_read", 0)) / 1_000_000


def today_usage(db: Session, company_id: str, day: Optional[date] = None) -> dict[str, dict[str, float]]:
    """回 {agent_id: {tokens, usd, runs}}，另含 '*' 為公司合計。"""
    day = day or _today()
    start = datetime(day.year, day.month, day.day)
    end = start + timedelta(days=1)
    try:
        from ..usage import load_prices
        prices = load_prices(db, company_id)
    except Exception:
        prices = None
    agents = {a.id: a for a in db.exec(select(Agent).where(Agent.company_id == company_id)).all()}
    sessions = {s.id: s for s in db.exec(select(ChatSession).where(ChatSession.company_id == company_id)).all()}
    out: dict[str, dict[str, float]] = {"*": {"tokens": 0, "usd": 0.0, "runs": 0}}
    rows = db.exec(select(Message).where(Message.role == "assistant", Message.usage.isnot(None),
                                         Message.created_at >= start, Message.created_at < end)).all()
    for m in rows:
        s = sessions.get(m.session_id)
        if s is None:
            continue
        try:
            u = json.loads(m.usage or "{}")
        except ValueError:
            continue
        if not isinstance(u, dict):
            continue
        tokens = int(u.get("total_tokens") or (int(u.get("input_tokens") or 0) + int(u.get("output_tokens") or 0)))
        ag = agents.get(s.agent_id)
        model = s.model or (ag.model if ag else "")
        usd = _usage_cost(u, model, prices)
        for key in (s.agent_id or "", "*"):
            b = out.setdefault(key, {"tokens": 0, "usd": 0.0, "runs": 0})
            b["tokens"] += tokens
            b["usd"] += usd
            b["runs"] += 1
    return out


def _progress(lim: UsageLimit, usage: dict[str, dict[str, float]]) -> dict[str, Any]:
    u = usage.get("*" if lim.scope == "company" else lim.agent_id, {"tokens": 0, "usd": 0.0, "runs": 0})
    tok_pct = (u["tokens"] / lim.daily_tokens * 100) if lim.daily_tokens else None
    usd_pct = (u["usd"] / lim.daily_usd * 100) if lim.daily_usd else None
    exceeded = (lim.daily_tokens > 0 and u["tokens"] >= lim.daily_tokens) or (lim.daily_usd > 0 and u["usd"] >= lim.daily_usd)
    return {"tokens": int(u["tokens"]), "usd": round(float(u["usd"]), 6), "runs": int(u["runs"]), "tokens_pct": tok_pct, "usd_pct": usd_pct,
            "exceeded": exceeded, "triggered_today": lim.last_triggered_on == _today().isoformat()}


def check_company(db: Session, company_id: str) -> list[dict[str, Any]]:
    """檢查一家公司的所有上限；回傳這次觸發的清單。"""
    usage = today_usage(db, company_id)
    today = _today().isoformat()
    fired: list[dict[str, Any]] = []
    for lim in db.exec(select(UsageLimit).where(UsageLimit.company_id == company_id, UsageLimit.enabled == True)).all():  # noqa: E712
        pg = _progress(lim, usage)
        if not pg["exceeded"] or lim.last_triggered_on == today:
            continue
        if lim.scope == "agent":
            targets = [a for a in [db.get(Agent, lim.agent_id)] if a and a.company_id == company_id]
        else:
            targets = db.exec(select(Agent).where(Agent.company_id == company_id, Agent.enabled == True)).all()  # noqa: E712
        disabled: list[str] = []
        if lim.action == "disable":
            for a in targets:
                if a.enabled:
                    a.enabled = False
                    a.updated_at = now()
                    db.add(a)
                    disabled.append(a.id)
        lim.last_triggered_on = today
        lim.disabled_agents_json = json.dumps(disabled)
        lim.updated_at = now()
        db.add(lim)
        names = ", ".join(a.name or a.profile for a in targets) or "(無)"
        scope_label = "公司" if lim.scope == "company" else f"AI 員工 {names}"
        title = f"{scope_label} 今日用量超過上限"
        detail = (f"今日 {pg['tokens']:,} tokens / ${pg['usd']:.4f}；上限 {lim.daily_tokens:,} tokens / ${lim.daily_usd}。"
                  + ("已停用：" + names if disabled else "（僅通知，未停用）"))
        payload = {"limit_id": lim.id, "scope": lim.scope, "usage": pg, "daily_tokens": lim.daily_tokens, "daily_usd": lim.daily_usd,
                   "disabled_agents": disabled, "action": lim.action}
        agent_profile = targets[0].profile if lim.scope == "agent" and targets else ""
        try:
            from ..events import record
            record("limit.exceeded", "studio", f"limit:{lim.id}", payload, agent=agent_profile, company_id=company_id, db=db)
        except Exception as e:
            log.debug("event skipped: %s", e)
        try:
            from ..inbox import add_item
            add_item(company_id, "limit_exceeded", title, detail, ref=f"limit:{lim.id}:{today}", link="/limits", agent=agent_profile, db=db)
        except Exception as e:
            log.debug("inbox skipped: %s", e)
        fired.append({"limit_id": lim.id, "disabled": disabled, "usage": pg})
    db.commit()
    return fired


def check_all(engine) -> list[dict[str, Any]]:
    from ...models import Company
    fired: list[dict[str, Any]] = []
    with Session(engine) as db:
        ids = [c.id for c in db.exec(select(Company)).all()]
    for cid in ids:
        with Session(engine) as db:
            try:
                fired += check_company(db, cid)
            except Exception as e:
                log.warning("limits check for %s failed: %s", cid, e)
    return fired


# -- API ------------------------------------------------------------------------
class LimitBody(BaseModel):
    scope: str = "agent"
    agent_id: str = ""
    daily_tokens: int = 0
    daily_usd: float = 0.0
    enabled: bool = True
    action: str = "disable"


class LimitPatch(BaseModel):
    daily_tokens: Optional[int] = None
    daily_usd: Optional[float] = None
    enabled: Optional[bool] = None
    action: Optional[str] = None
    agent_id: Optional[str] = None


def _validate(body: LimitBody | LimitPatch, db: Session, p: Principal, scope: str) -> None:
    if scope not in ("company", "agent"):
        raise bad_request("scope 需為 company|agent", "bad_scope")
    if body.action is not None and body.action not in ("disable", "notify"):
        raise bad_request("action 需為 disable|notify", "bad_action")
    if body.daily_tokens is not None and body.daily_tokens < 0:
        raise bad_request("daily_tokens 不可為負")
    if body.daily_usd is not None and body.daily_usd < 0:
        raise bad_request("daily_usd 不可為負")
    if scope == "agent" and body.agent_id is not None:
        a = db.get(Agent, body.agent_id or "")
        if a is None or a.company_id != p.company_id:
            raise not_found("agent")


def _get(db: Session, p: Principal, limit_id: str) -> UsageLimit:
    lim = db.get(UsageLimit, limit_id)
    if lim is None or lim.company_id != p.company_id:
        raise not_found("limit")
    return lim


@router.get("")
def list_limits(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    usage = today_usage(db, p.company_id)
    agents = {a.id: a for a in db.exec(select(Agent).where(Agent.company_id == p.company_id)).all()}
    out = []
    for lim in db.exec(select(UsageLimit).where(UsageLimit.company_id == p.company_id).order_by(UsageLimit.created_at)).all():
        ag = agents.get(lim.agent_id)
        if lim.scope == "agent" and ag and not profile_visible(p.member, ag.profile):
            continue
        d = lim.to_dict()
        d["agent"] = {"id": ag.id, "name": ag.name, "profile": ag.profile, "enabled": ag.enabled} if ag else None
        d["today"] = _progress(lim, usage)
        out.append(d)
    return out


@router.get("/today")
def today(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """今日各 AI 員工用量（不管有沒有設上限）。"""
    usage = today_usage(db, p.company_id)
    agents = db.exec(select(Agent).where(Agent.company_id == p.company_id)).all()
    allowed = allowed_profiles(p.member)
    rows = [{"agent_id": a.id, "name": a.name, "profile": a.profile, "enabled": a.enabled, "model": a.model,
             **usage.get(a.id, {"tokens": 0, "usd": 0.0, "runs": 0})}
            for a in agents if allowed is None or a.profile in allowed]
    return {"date": _today().isoformat(), "company": usage["*"], "agents": rows}


@router.post("", status_code=201)
def create_limit(body: LimitBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    _validate(body, db, p, body.scope)
    if body.scope == "agent" and not body.agent_id:
        raise bad_request("scope=agent 需指定 agent_id")
    if body.daily_tokens == 0 and body.daily_usd == 0:
        raise bad_request("daily_tokens 與 daily_usd 至少設一個")
    lim = UsageLimit(company_id=p.company_id, scope=body.scope, agent_id=body.agent_id if body.scope == "agent" else "",
                     daily_tokens=body.daily_tokens, daily_usd=body.daily_usd, enabled=body.enabled, action=body.action,
                     created_by=p.member.id)
    db.add(lim)
    db.commit()
    db.refresh(lim)
    return lim.to_dict()


@router.patch("/{limit_id}")
def update_limit(limit_id: str, body: LimitPatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    lim = _get(db, p, limit_id)
    _validate(body, db, p, lim.scope)
    for k in ("daily_tokens", "daily_usd", "enabled", "action"):
        v = getattr(body, k)
        if v is not None:
            setattr(lim, k, v)
    if body.agent_id is not None and lim.scope == "agent":
        lim.agent_id = body.agent_id
    lim.updated_at = now()
    db.add(lim)
    db.commit()
    db.refresh(lim)
    return lim.to_dict()


@router.delete("/{limit_id}", status_code=204)
def delete_limit(limit_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    db.delete(_get(db, p, limit_id))
    db.commit()


@router.post("/{limit_id}/reset")
def reset_limit(limit_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """清掉今天的觸發記錄，並把這條上限停掉的 agent 重新啟用。"""
    p.require_admin()
    lim = _get(db, p, limit_id)
    ids = json.loads(lim.disabled_agents_json or "[]")
    re_enabled = []
    for aid in ids:
        a = db.get(Agent, aid)
        if a and a.company_id == p.company_id and not a.enabled:
            a.enabled = True
            a.updated_at = now()
            db.add(a)
            re_enabled.append(aid)
    lim.last_triggered_on = ""
    lim.disabled_agents_json = "[]"
    lim.updated_at = now()
    db.add(lim)
    db.commit()
    try:
        from ..events import record
        record("limit.reset", "studio", f"limit:{lim.id}", {"re_enabled": re_enabled}, member_id=p.member.id, company_id=p.company_id)
    except Exception:
        pass
    return {"ok": True, "re_enabled": re_enabled}


@router.post("/check")
def check_now(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    return {"fired": check_company(db, p.company_id)}


# -- 背景檢查器 ------------------------------------------------------------------
async def _loop(app, interval: float) -> None:
    while True:
        try:
            await asyncio.sleep(interval)
            fired = await asyncio.to_thread(check_all, app.state.engine)
            if fired:
                log.warning("limits fired: %s", fired)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("limits checker failed: %s", e)


async def on_startup(app) -> None:
    interval = float(os.environ.get("STUDIO_LIMITS_CHECK_SECONDS", "60"))
    if interval > 0 and not getattr(app.state.settings, "_no_scheduler", False):
        app.state.limits_task = asyncio.create_task(_loop(app, interval))


async def on_shutdown(app) -> None:
    task = getattr(app.state, "limits_task", None)
    if task:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
