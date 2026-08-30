"""C. 用量分析：唯讀 Hermes state.db（default ＋ 每個 profile 自己的 state.db）＋ Studio sessions。

- 總 token 輸入／輸出／快取讀寫／推理、session 數與日均、API 呼叫數
- 估算成本：Hermes 自己算的 estimated_cost_usd 優先；沒有就用內建價格表（每 1M token，USD，可編輯）
- 快取命中率 = cache_read / (input + cache_read)
- 模型分佈、來源分佈、profile 分佈、N 日趨勢（每日）
- 篩選：profile（哪一個 state.db）、company=1（只算這家公司 Studio 建立的 session，用 hermes_session_id 對回 state.db）
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, allowed_profiles, current_principal, get_db, profile_visible
from ...errors import ApiError, not_found
from ...models import Agent, ChatSession, Message, new_id, now
from ..profiles import files as F

log = logging.getLogger("studio.usage")
router = APIRouter(prefix="/usage", tags=["usage"])

# 內建價格表（USD / 1M tokens）。鍵是模型 id 的「包含比對」關鍵字，較長者優先。
DEFAULT_PRICES: dict[str, dict[str, float]] = {
    "gpt-5.6-luna": {"input": 1.25, "output": 10.0, "cache_read": 0.125},
    "gpt-5.6-sol": {"input": 2.5, "output": 15.0, "cache_read": 0.25},
    "gpt-5.5": {"input": 1.25, "output": 10.0, "cache_read": 0.125},
    "gpt-5.4-mini": {"input": 0.25, "output": 2.0, "cache_read": 0.025},
    "gpt-5.4": {"input": 2.5, "output": 15.0, "cache_read": 0.25},
    "claude-opus": {"input": 15.0, "output": 75.0, "cache_read": 1.5},
    "claude-sonnet": {"input": 3.0, "output": 15.0, "cache_read": 0.3},
    "claude-haiku": {"input": 0.8, "output": 4.0, "cache_read": 0.08},
    "kimi-k2": {"input": 0.6, "output": 2.5, "cache_read": 0.15},
    "deepseek": {"input": 0.28, "output": 0.42, "cache_read": 0.028},
    "gemini-3.1-pro": {"input": 2.0, "output": 12.0, "cache_read": 0.2},
    "gemini": {"input": 0.3, "output": 2.5, "cache_read": 0.03},
    "minimax": {"input": 0.3, "output": 1.2, "cache_read": 0.03},
    "glm-5": {"input": 1.0, "output": 3.2, "cache_read": 0.2},
    "grok": {"input": 3.0, "output": 15.0, "cache_read": 0.75},
    ":free": {"input": 0.0, "output": 0.0, "cache_read": 0.0},
    "stealth/": {"input": 0.0, "output": 0.0, "cache_read": 0.0},
}


class UsagePrice(SQLModel, table=True):
    """公司自訂價格（覆蓋內建）。"""
    __tablename__ = "usage_prices"
    id: str = Field(default_factory=lambda: new_id("up"), primary_key=True)
    company_id: str = Field(index=True)
    model: str = Field(index=True)  # 關鍵字（包含比對）或完整 id
    input: float = 0.0
    output: float = 0.0
    cache_read: float = 0.0
    updated_at: datetime = Field(default_factory=now)


def _home(request: Request) -> Path:
    return Path(request.app.state.settings.hermes_home)


def _state_db(home: Path, profile: str) -> Path:
    return F.profile_dir(home, profile) / "state.db"


def _connect_ro(path: Path) -> Optional[sqlite3.Connection]:
    if not path.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
        con.row_factory = sqlite3.Row
        return con
    except sqlite3.Error as e:
        log.warning("state.db open failed %s: %s", path, e)
        return None


def price_for(model: str, prices: dict[str, dict[str, float]]) -> Optional[dict[str, float]]:
    m = (model or "").lower()
    if not m:
        return None
    if m in prices:
        return prices[m]
    best = None
    for key in sorted(prices, key=len, reverse=True):
        if key.lower() in m:
            best = prices[key]
            break
    return best


def estimate_cost(row: dict[str, Any], prices: dict[str, dict[str, float]]) -> tuple[float, str]:
    """回傳 (usd, source)。source: hermes | table | none"""
    hermes = row.get("estimated_cost_usd")
    if hermes is not None and float(hermes) > 0:
        return float(hermes), "hermes"
    pr = price_for(row.get("model") or "", prices)
    if pr is None:
        return 0.0, "none"
    inp = int(row.get("input_tokens") or 0)
    out = int(row.get("output_tokens") or 0)
    cr = int(row.get("cache_read_tokens") or 0)
    usd = (inp * pr.get("input", 0) + out * pr.get("output", 0) + cr * pr.get("cache_read", 0)) / 1_000_000
    return usd, "table"


def load_prices(db: Session, company_id: str) -> dict[str, dict[str, float]]:
    prices = dict(DEFAULT_PRICES)
    for r in db.exec(select(UsagePrice).where(UsagePrice.company_id == company_id)).all():
        prices[r.model] = {"input": r.input, "output": r.output, "cache_read": r.cache_read}
    return prices


def aggregate(rows: list[dict[str, Any]], prices: dict[str, dict[str, float]], days: int, since_ts: float) -> dict[str, Any]:
    tot = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 0,
           "sessions": 0, "api_calls": 0, "messages": 0, "tool_calls": 0, "cost_usd": 0.0, "cost_hermes_usd": 0.0, "cost_table_usd": 0.0,
           "sessions_unpriced": 0}
    by_day: dict[str, dict[str, Any]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    by_source: dict[str, dict[str, Any]] = {}
    by_profile: dict[str, dict[str, Any]] = {}

    def bucket(d: dict, key: str) -> dict[str, Any]:
        return d.setdefault(key, {"key": key, "sessions": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cost_usd": 0.0})

    for r in rows:
        usd, src = estimate_cost(r, prices)
        inp, out, cr = int(r.get("input_tokens") or 0), int(r.get("output_tokens") or 0), int(r.get("cache_read_tokens") or 0)
        tot["input_tokens"] += inp
        tot["output_tokens"] += out
        tot["cache_read_tokens"] += cr
        tot["cache_write_tokens"] += int(r.get("cache_write_tokens") or 0)
        tot["reasoning_tokens"] += int(r.get("reasoning_tokens") or 0)
        tot["sessions"] += 1
        tot["api_calls"] += int(r.get("api_call_count") or 0)
        tot["messages"] += int(r.get("message_count") or 0)
        tot["tool_calls"] += int(r.get("tool_call_count") or 0)
        tot["cost_usd"] += usd
        if src == "hermes":
            tot["cost_hermes_usd"] += usd
        elif src == "table":
            tot["cost_table_usd"] += usd
        elif inp or out:
            tot["sessions_unpriced"] += 1
        day = datetime.fromtimestamp(float(r.get("started_at") or 0), tz=timezone.utc).astimezone().strftime("%Y-%m-%d")
        for d, key in ((by_day, day), (by_model, r.get("model") or "(unknown)"), (by_source, r.get("source") or "(unknown)"),
                       (by_profile, r.get("_profile") or "default")):
            b = bucket(d, key)
            b["sessions"] += 1
            b["input_tokens"] += inp
            b["output_tokens"] += out
            b["cache_read_tokens"] += cr
            b["cost_usd"] += usd
    # 補齊沒有資料的日期
    start = datetime.fromtimestamp(since_ts).astimezone().date()
    for i in range(days + 1):
        d = (start + timedelta(days=i)).strftime("%Y-%m-%d")
        if d <= datetime.now().astimezone().strftime("%Y-%m-%d"):
            bucket(by_day, d)
    denom = tot["input_tokens"] + tot["cache_read_tokens"]
    tot["cache_hit_rate"] = round(tot["cache_read_tokens"] / denom, 4) if denom else 0.0
    tot["total_tokens"] = tot["input_tokens"] + tot["output_tokens"]
    tot["days"] = days
    tot["sessions_per_day"] = round(tot["sessions"] / max(days, 1), 2)
    tot["cost_usd"] = round(tot["cost_usd"], 4)
    tot["cost_hermes_usd"] = round(tot["cost_hermes_usd"], 4)
    tot["cost_table_usd"] = round(tot["cost_table_usd"], 4)
    rounder = lambda lst: [{**b, "cost_usd": round(b["cost_usd"], 4)} for b in lst]  # noqa: E731
    return {
        "totals": tot,
        "daily": rounder(sorted(by_day.values(), key=lambda b: b["key"])),
        "by_model": rounder(sorted(by_model.values(), key=lambda b: -(b["input_tokens"] + b["output_tokens"]))),
        "by_source": rounder(sorted(by_source.values(), key=lambda b: -b["sessions"])),
        "by_profile": rounder(sorted(by_profile.values(), key=lambda b: -b["sessions"])),
    }


def read_sessions(db_path: Path, since_ts: float, profile: str, only_ids: Optional[set[str]] = None) -> list[dict[str, Any]]:
    con = _connect_ro(db_path)
    if con is None:
        return []
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(sessions)").fetchall()}
        want = ["id", "source", "model", "started_at", "message_count", "tool_call_count", "input_tokens", "output_tokens",
                "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "estimated_cost_usd", "api_call_count", "billing_provider"]
        sel = ", ".join(c if c in cols else f"NULL AS {c}" for c in want)
        rows = con.execute(f"SELECT {sel} FROM sessions WHERE started_at >= ? ORDER BY started_at", (since_ts,)).fetchall()
    except sqlite3.Error as e:
        log.warning("state.db query failed %s: %s", db_path, e)
        return []
    finally:
        con.close()
    out = []
    for r in rows:
        d = dict(r)
        if only_ids is not None and d["id"] not in only_ids:
            continue
        d["_profile"] = profile
        out.append(d)
    return out


@router.get("/summary")
def summary(request: Request, days: int = 30, profile: Optional[str] = None, company: bool = False,
            p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    days = max(1, min(days, 365))
    home = _home(request)
    allowed = allowed_profiles(p.member)
    if profile:
        if not profile_visible(p.member, profile):
            raise not_found("profile")
        profiles = [profile]
    else:
        profiles = [n for n in F.list_profile_names(home) if allowed is None or n in allowed]
    since = time.time() - days * 86400
    only_ids: Optional[set[str]] = None
    if company:
        only_ids = {s.hermes_session_id for s in db.exec(select(ChatSession).where(ChatSession.company_id == p.company_id)).all() if s.hermes_session_id}
    prices = load_prices(db, p.company_id)
    rows: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    for name in profiles:
        path = _state_db(home, name)
        got = read_sessions(path, since, name, only_ids)
        rows.extend(got)
        sources.append({"profile": name, "path": str(path), "exists": path.exists(), "sessions": len(got)})
    agg = aggregate(rows, prices, days, since)
    agg["studio"] = studio_usage(db, p.company_id, since, allowed)
    agg["sources"] = sources
    agg["filters"] = {"days": days, "profile": profile, "company": company}
    return agg


def studio_usage(db: Session, company_id: str, since_ts: float, allowed: Optional[list[str]]) -> dict[str, Any]:
    """Studio 自己記的用量（chat_ws 累計在 sessions.input_tokens/output_tokens）。"""
    since_dt = datetime.fromtimestamp(since_ts, tz=timezone.utc).replace(tzinfo=None)
    agents = {a.id: a for a in db.exec(select(Agent).where(Agent.company_id == company_id)).all()}
    q = select(ChatSession).where(ChatSession.company_id == company_id, ChatSession.created_at >= since_dt)
    sessions = db.exec(q).all()
    inp = out = n = msgs = 0
    for s in sessions:
        a = agents.get(s.agent_id)
        if allowed is not None and (a is None or a.profile not in allowed):
            continue
        n += 1
        inp += int(getattr(s, "input_tokens", 0) or 0)
        out += int(getattr(s, "output_tokens", 0) or 0)
        msgs += len(db.exec(select(Message.id).where(Message.session_id == s.id)).all())
    return {"sessions": n, "messages": msgs, "input_tokens": inp, "output_tokens": out}


# -- price table ------------------------------------------------------------
@router.get("/prices")
def get_prices(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    custom = {r.model: r for r in db.exec(select(UsagePrice).where(UsagePrice.company_id == p.company_id)).all()}
    rows = []
    for k, v in DEFAULT_PRICES.items():
        if k in custom:
            continue
        rows.append({"model": k, **v, "source": "builtin"})
    for k, r in custom.items():
        rows.append({"model": k, "input": r.input, "output": r.output, "cache_read": r.cache_read, "source": "custom"})
    rows.sort(key=lambda r: r["model"])
    return {"prices": rows, "unit": "USD per 1M tokens"}


class PriceBody(BaseModel):
    model: str
    input: float
    output: float
    cache_read: float = 0.0


@router.put("/prices")
def put_price(body: PriceBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    key = body.model.strip()
    if not key:
        raise ApiError(400, "bad_request", "model 必填")
    r = db.exec(select(UsagePrice).where(UsagePrice.company_id == p.company_id, UsagePrice.model == key)).first()
    if r is None:
        r = UsagePrice(company_id=p.company_id, model=key)
    r.input, r.output, r.cache_read, r.updated_at = body.input, body.output, body.cache_read, now()
    db.add(r)
    db.commit()
    return {"ok": True, "model": key, "input": r.input, "output": r.output, "cache_read": r.cache_read}


@router.delete("/prices/{model:path}")
def delete_price(model: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    r = db.exec(select(UsagePrice).where(UsagePrice.company_id == p.company_id, UsagePrice.model == model)).first()
    if r is None:
        raise not_found("price")
    db.delete(r)
    db.commit()
    return {"ok": True}
