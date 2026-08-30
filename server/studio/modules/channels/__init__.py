"""B. 平台頻道：11 個平台單頁設定（LINE 優先）。

- 憑證與連線參數寫 `~/.hermes/.env`（只改對應 key，其他行原樣保留）
- 行為設定寫 `config.yaml` 的平台區段（ruamel 保留註解）
- 已設定／未設定：只看必填 key 是否存在且非空，永不回傳密鑰值
- gateway 狀態：解析 `hermes gateway status`；啟用後可 `hermes gateway restart`
欄位名稱依 Hermes `gateway/config.py` 與各 `plugins/platforms/<p>/plugin.yaml` 的 env 名稱。
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ...auth import Principal, current_principal
from ...errors import ApiError, not_found
from ...hermes.cli import CliError
from ..profiles import files as F
from .registry import PLATFORMS, Field, Platform

log = logging.getLogger("studio.channels")
router = APIRouter(prefix="/channels", tags=["channels"])


def _home(request: Request) -> Path:
    return Path(request.app.state.settings.hermes_home)


def _env_path(home: Path, profile: Optional[str]) -> Path:
    """profile 有自己的 .env 才用它，否則共用 ~/.hermes/.env。"""
    if profile and profile != "default":
        p = F.profile_dir(home, profile) / ".env"
        return p
    return home / ".env"


def _config_path(home: Path, profile: Optional[str]) -> Path:
    return F.profile_dir(home, profile or "default") / "config.yaml"


def _field_public(f: Field, env: dict[str, str]) -> dict[str, Any]:
    present = env.get(f.name, "") != ""
    d = {"name": f.name, "label": f.label, "required": f.required, "secret": f.secret, "kind": f.kind,
         "set": present, "hint": f.hint, "default": f.default}
    if not f.secret:
        d["value"] = env.get(f.name, "")
    return d


def _platform_public(pl: Platform, env: dict[str, str], cfg: dict) -> dict[str, Any]:
    fields = [_field_public(f, env) for f in pl.fields]
    required = [f for f in pl.fields if f.required]
    configured = all(env.get(f.name, "") != "" for f in required) if required else any(env.get(f.name, "") != "" for f in pl.fields)
    section = cfg.get(pl.config_section) if pl.config_section else None
    behaviour = {k.name: (section.get(k.name) if isinstance(section, dict) and k.name in section else k.default) for k in pl.config_keys}
    out = {"id": pl.id, "label": pl.label, "description": pl.description, "docs_url": pl.docs_url, "configured": configured,
           "fields": fields, "config_section": pl.config_section,
           "config_keys": [{"name": k.name, "label": k.label, "kind": k.kind, "default": k.default, "hint": k.hint} for k in pl.config_keys],
           "config": behaviour, "plugin": pl.plugin}
    if pl.id == "line":
        port = env.get("LINE_PORT", "") or "8646"
        public = env.get("LINE_PUBLIC_URL", "").rstrip("/")
        out["webhook_path"] = "/line/webhook"
        out["webhook_url"] = f"{public}/line/webhook" if public else f"http://<你的主機或隧道>:{port}/line/webhook"
        out["webhook_hint"] = "到 LINE Developers Console → Messaging API → Webhook URL 貼上，並開啟 Use webhook；沒有公開網址時可用 cloudflared/ngrok 對外開 LINE_PORT。"
    return out


@router.get("")
def list_channels(request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    home = _home(request)
    env = F.read_env(_env_path(home, profile))
    if profile and profile != "default":  # profile .env 疊在共用 .env 之上（Hermes 的載入順序）
        env = {**F.read_env(home / ".env"), **env}
    cfg = F.plain(F.load_yaml(_config_path(home, profile)))
    return {"platforms": [_platform_public(pl, env, cfg) for pl in PLATFORMS],
            "env_path": str(_env_path(home, profile)), "config_path": str(_config_path(home, profile))}


@router.get("/gateway/status")
async def gateway_status(request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    cli = request.app.state.cli
    try:
        raw = await cli._run("gateway", "status", timeout=30.0)
        ok = True
    except CliError as e:
        raw, ok = str(e), False
    return {"ok": ok, **parse_gateway_status(raw)}


def parse_gateway_status(raw: str) -> dict[str, Any]:
    """解析 `hermes gateway status` 的人類可讀輸出。"""
    text = re.sub(r"\x1b\[[0-9;]*m", "", raw or "")
    running = bool(re.search(r"(?i)gateway is (supervised|running)|✓ Gateway", text)) and not re.search(r"(?i)not running|stopped", text.split("Other profiles")[0])
    pid = None
    m = re.search(r"PID (\d+)", text)
    if m:
        pid = int(m.group(1))
    profiles = []
    for line in text.splitlines():
        m = re.match(r"^\s*([✓✗•\-*]?)\s*([A-Za-z0-9_.-]+)\s+—\s*(?:PID (\d+)|(.*))$", line.strip())
        if m and m.group(2) not in ("Gateway",):
            profiles.append({"name": m.group(2), "running": m.group(1) == "✓" or bool(m.group(3)),
                             "pid": int(m.group(3)) if m.group(3) else None, "note": (m.group(4) or "").strip()})
    stale = bool(re.search(r"(?i)stale", text))
    return {"running": running, "pid": pid, "supervised": "launchd" in text or "systemd" in text,
            "stale_service": stale, "profiles": profiles, "raw": text[:4000]}


@router.post("/gateway/restart")
async def gateway_restart(request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    cli = request.app.state.cli
    try:
        out = await cli._run("gateway", "restart", timeout=120.0)
    except CliError as e:
        raise ApiError(502, "hermes_cli_error", str(e))
    return {"ok": True, "output": re.sub(r"\x1b\[[0-9;]*m", "", out)[-2000:]}


class ChannelUpdate(BaseModel):
    env: Optional[dict[str, Optional[str]]] = None  # value None / "" → 移除該 key
    config: Optional[dict[str, Any]] = None  # config.yaml 平台區段
    restart: bool = False
    profile: Optional[str] = None


@router.put("/{platform_id}")
async def update_channel(platform_id: str, body: ChannelUpdate, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    pl = next((x for x in PLATFORMS if x.id == platform_id), None)
    if pl is None:
        raise not_found("platform")
    home = _home(request)
    allowed = {f.name for f in pl.fields}
    env_result: dict[str, str] = {}
    if body.env:
        updates: dict[str, Optional[str]] = {}
        for k, v in body.env.items():
            if k not in allowed:
                raise ApiError(400, "bad_field", f"{pl.label} 沒有這個欄位: {k}")
            if v is None or v == "":
                updates[k] = None
            else:
                updates[k] = str(v).strip()
        env_result = F.write_env(_env_path(home, body.profile), updates)
    cfg_result = None
    if body.config is not None and pl.config_section:
        known = {k.name: k for k in pl.config_keys}
        patch: dict[str, Any] = {}
        for k, v in body.config.items():
            if k not in known:
                raise ApiError(400, "bad_field", f"{pl.label} 沒有這個行為設定: {k}")
            kind = known[k].kind
            if kind == "bool":
                v = bool(v) if not isinstance(v, str) else v.strip().lower() in ("1", "true", "yes", "on")
            elif kind == "int":
                try:
                    v = int(v)
                except (TypeError, ValueError):
                    raise ApiError(400, "bad_field", f"{k} 需要整數")
            patch[k] = v
        F.update_yaml(_config_path(home, body.profile), {pl.config_section: patch})
        cfg_result = patch
    restart_out = None
    if body.restart:
        try:
            restart_out = await request.app.state.cli._run("gateway", "restart", timeout=120.0)
        except CliError as e:
            restart_out = f"restart failed: {e}"
    env = F.read_env(_env_path(home, body.profile))
    cfg = F.plain(F.load_yaml(_config_path(home, body.profile)))
    return {"ok": True, "env": env_result, "config": cfg_result, "restart": restart_out,
            "platform": _platform_public(pl, env, cfg)}


@router.delete("/{platform_id}")
async def clear_channel(platform_id: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    """移除該平台所有 env key（不動 config.yaml 區段）。"""
    p.require_admin()
    pl = next((x for x in PLATFORMS if x.id == platform_id), None)
    if pl is None:
        raise not_found("platform")
    res = F.write_env(_env_path(_home(request), profile), {f.name: None for f in pl.fields})
    return {"ok": True, "env": res}
