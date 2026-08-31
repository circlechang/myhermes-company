"""O. 管理與執行環境 — Web 終端（terminal.py）、MCP 伺服器、Plugins、版本更新提示。

- MCP：讀 profile config.yaml `mcp_servers`（密鑰遮罩）；新增／刪除／測試走 `hermes [-p profile] mcp add|remove|test`
- Plugins：`hermes plugins list --json`、`hermes plugins enable|disable <name>`
- 版本：`hermes --version` 解析 ＋ Studio 版本 ＋ GitHub latest（`STUDIO_UPDATE_CHECK=0` 關閉，快取 1 小時）
- 自我更新提示：`studio_latest`／`studio_update_available`（公開 repo 的 release，快取 6 小時，`MHC_UPDATE_CHECK=0` 關閉）；
  `/version/studio` 是不呼叫 hermes CLI 的輕量版，給 TopBar 常駐提示用。
- 站內一鍵更新（selfupdate.py）：`POST /admin/update/start`（owner，先下載驗證再 spawn 脫離的更新器）、
  `GET /admin/update/status`（讀 `<MHC_HOME>/update-status.json`）。可編輯安裝（`pip install -e`）會被擋，
  改叫人 git pull；CLI 的 `myhermescompany update` 一樣可用。
- 裝置／區網節點不做（桌面版功能）。
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ... import __version__ as STUDIO_VERSION
from ... import update as studio_update
from ...auth import Principal, current_principal
from ...errors import ApiError
from ...hermes.cli import CliError, HermesCli
from ..skills import hermes_config
from . import selfupdate, terminal

router = APIRouter(tags=["admin"])
router.include_router(terminal.router)
router.include_router(selfupdate.router)

SECRET_KEY_RE = re.compile(r"(token|secret|key|password|authorization|bearer)", re.I)
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")
HERMES_REPO = os.environ.get("HERMES_GITHUB_REPO", "NousResearch/hermes-agent")


def _profile_args(profile: str) -> list[str]:
    return ["-p", profile] if profile and profile != "default" else []


async def _cli(cli: HermesCli, *args: str, timeout: float = 60) -> str:
    try:
        return await cli._run(*args, timeout=timeout)
    except CliError as e:
        raise ApiError(502, "hermes_cli_error", str(e))
    except AssertionError as e:  # FakeCli in tests
        raise ApiError(502, "hermes_cli_error", str(e))


def _mask(obj: Any, key: str = "") -> Any:
    if isinstance(obj, dict):
        return {k: _mask(v, str(k)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_mask(v, key) for v in obj]
    if isinstance(obj, str) and SECRET_KEY_RE.search(key) and obj:
        return obj[:3] + "•••" if len(obj) > 6 else "•••"
    return obj


# -- terminal ---------------------------------------------------------------

@router.get("/terminal/cwds")
def terminal_cwds(request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    return terminal.cwd_choices(request.app.state.cli, request.app.state.settings.db_path)


# -- MCP --------------------------------------------------------------------

@router.get("/mcp/servers")
def mcp_list(request: Request, profile: str = "default", p: Principal = Depends(current_principal)):
    cli: HermesCli = request.app.state.cli
    if profile not in cli.list_profiles_fs():
        raise ApiError(404, "not_found", "profile not found")
    servers = hermes_config.mcp_servers(cli, profile)
    out = []
    for name, cfg in servers.items():
        cfg = dict(cfg or {}) if hasattr(cfg, "items") else {}
        transport = "http" if cfg.get("url") else ("stdio" if cfg.get("command") else "unknown")
        out.append({"name": name, "transport": transport, "url": cfg.get("url"), "command": cfg.get("command"),
                    "args": list(cfg.get("args") or []), "auth": cfg.get("auth"),
                    "enabled": cfg.get("enabled", True) is not False,
                    "connect_timeout": cfg.get("connect_timeout"), "timeout": cfg.get("timeout"),
                    "env": _mask(dict(cfg.get("env") or {})), "headers": _mask(dict(cfg.get("headers") or {})),
                    "tools": cfg.get("tools") or cfg.get("include_tools") or "all"})
    return {"profile": profile, "servers": out}


class McpAdd(BaseModel):
    name: str
    profile: str = "default"
    url: Optional[str] = None
    command: Optional[str] = None
    args: list[str] = []
    auth: Optional[str] = None  # oauth | header
    env: dict[str, str] = {}
    connect_timeout: Optional[int] = None


@router.post("/mcp/servers")
async def mcp_add(body: McpAdd, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    cli: HermesCli = request.app.state.cli
    if not NAME_RE.match(body.name):
        raise ApiError(400, "bad_name", "invalid server name")
    if not body.url and not body.command:
        raise ApiError(400, "bad_request", "url 或 command 擇一必填")
    if body.auth and body.auth not in ("oauth", "header"):
        raise ApiError(400, "bad_request", "auth must be oauth|header")
    args = _profile_args(body.profile) + ["mcp", "add", body.name]
    if body.url:
        args += ["--url", body.url]
    if body.command:
        args += ["--command", body.command]
    if body.auth:
        args += ["--auth", body.auth]
    if body.connect_timeout:
        args += ["--connect-timeout", str(int(body.connect_timeout))]
    if body.env:
        args += ["--env", *[f"{k}={v}" for k, v in body.env.items()]]
    if body.args:
        args += ["--args", *body.args]  # must be last
    out = await _cli(cli, *args, timeout=180)
    return {"ok": True, "output": out[-3000:]}


@router.delete("/mcp/servers/{name}")
async def mcp_remove(name: str, request: Request, profile: str = "default", p: Principal = Depends(current_principal)):
    p.require_admin()
    if not NAME_RE.match(name):
        raise ApiError(400, "bad_name", "invalid server name")
    out = await _cli(request.app.state.cli, *_profile_args(profile), "mcp", "remove", name)
    return {"ok": True, "output": out[-3000:]}


@router.post("/mcp/servers/{name}/test")
async def mcp_test(name: str, request: Request, profile: str = "default", p: Principal = Depends(current_principal)):
    p.require_admin()
    if not NAME_RE.match(name):
        raise ApiError(400, "bad_name", "invalid server name")
    try:
        out = await request.app.state.cli._run(*_profile_args(profile), "mcp", "test", name, timeout=120)
        failed = ("✗" in out) or re.search(r"\b(failed|error)\b", out, re.I) is not None
        return {"ok": not failed, "output": out[-4000:]}
    except CliError as e:
        return {"ok": False, "output": str(e)}
    except AssertionError as e:
        return {"ok": False, "output": str(e)}


# -- plugins ----------------------------------------------------------------

@router.get("/plugins")
async def plugins_list(request: Request, p: Principal = Depends(current_principal)):
    raw = await _cli(request.app.state.cli, "plugins", "list", "--json", timeout=60)
    try:
        start = raw.index("[")
        data = json.loads(raw[start:])
    except (ValueError, json.JSONDecodeError):
        raise ApiError(502, "hermes_cli_error", "plugins list returned non-JSON output")
    for item in data:
        st = str(item.get("status", "")).lower()
        item["enabled"] = st.startswith("enabled") or st == "active" or st == "loaded"
    return data


@router.post("/plugins/{name}/{action}")
async def plugins_toggle(name: str, action: str, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    if action not in ("enable", "disable") or not NAME_RE.match(name):
        raise ApiError(400, "bad_request", "action must be enable|disable")
    out = await _cli(request.app.state.cli, "plugins", action, name, timeout=60)
    return {"ok": True, "name": name, "action": action, "output": out[-3000:]}


# -- version ----------------------------------------------------------------

_latest_cache: dict[str, Any] = {"at": 0.0, "data": None}


def _update_check_enabled() -> bool:
    return os.environ.get("STUDIO_UPDATE_CHECK", "1") not in ("0", "false", "no", "off")


async def _github_latest(repo: str) -> Optional[dict[str, Any]]:
    if time.time() - _latest_cache["at"] < 3600 and _latest_cache["data"] is not None:
        return _latest_cache["data"]
    try:
        async with httpx.AsyncClient(timeout=6.0, headers={"User-Agent": "myhermescompany"}) as c:
            r = await c.get(f"https://api.github.com/repos/{repo}/releases/latest")
            if r.status_code == 404:
                r = await c.get(f"https://api.github.com/repos/{repo}/tags?per_page=1")
                if r.status_code == 200 and r.json():
                    data = {"tag": r.json()[0]["name"], "url": f"https://github.com/{repo}/tags"}
                else:
                    data = None
            elif r.status_code == 200:
                j = r.json()
                data = {"tag": j.get("tag_name"), "url": j.get("html_url"), "published_at": j.get("published_at")}
            else:  # 403 rate limit etc.: follow the human releases/latest redirect instead
                r = await c.get(f"https://github.com/{repo}/releases/latest", follow_redirects=False)
                loc = r.headers.get("location", "")
                m = re.search(r"/tag/([^/?#]+)", loc)
                data = {"tag": m.group(1), "url": loc} if m else None
    except httpx.HTTPError:
        data = None
    _latest_cache.update(at=time.time(), data=data)
    return data


def parse_version(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {"version": "", "date": "", "upstream": "", "behind": None, "python": "", "raw": text[:2000]}
    m = re.search(r"v?(\d+\.\d+\.\d+)", text)
    if m:
        out["version"] = m.group(1)
    m = re.search(r"\((\d{4}\.\d{1,2}\.\d{1,2})\)", text)
    if m:
        out["date"] = m.group(1)
    m = re.search(r"upstream\s+([0-9a-f]{6,})", text)
    if m:
        out["upstream"] = m.group(1)
    m = re.search(r"(\d+)\s+commits? behind", text)
    if m:
        out["behind"] = int(m.group(1))
    m = re.search(r"Python:\s*([\d.]+)", text)
    if m:
        out["python"] = m.group(1)
    return out


async def _studio_update_state(check: bool) -> dict[str, Any]:
    """MyHermesCompany 自己的新版（公開 repo 的 release；快取 6 小時，見 studio/update.py）。"""
    out: dict[str, Any] = {"studio_latest": None, "studio_update_available": None,
                           "studio_release": None, "studio_repo": studio_update.public_repo(),
                           "studio_update_cmd": "myhermescompany update",
                           "studio_update_check_enabled": studio_update.update_check_enabled(),
                           # 站內一鍵更新能不能按：開發（可編輯）安裝要走 git pull，不給按
                           "studio_editable_install": False, "studio_editable_reason": None}
    info = selfupdate.install_info()
    out["studio_editable_install"] = info["editable"]
    out["studio_editable_reason"] = info["editable_reason"]
    if not check or not studio_update.update_check_enabled():
        return out
    rel = await studio_update.fetch_latest_async()
    if rel is not None:
        out["studio_latest"] = rel.version
        out["studio_update_available"] = studio_update.is_newer(STUDIO_VERSION, rel.tag)
        out["studio_release"] = {"tag": rel.tag, "url": rel.url}
    return out


@router.get("/version/studio")
async def version_studio(request: Request, check: int = 1, p: Principal = Depends(current_principal)):
    """只查 MyHermesCompany 自己的版本（不呼叫 hermes CLI）——給 TopBar 這種常駐提示用。"""
    state = await _studio_update_state(bool(check) and _update_check_enabled())
    return {"studio": {"version": STUDIO_VERSION}, **state}


@router.get("/version")
async def version(request: Request, check: int = 1, p: Principal = Depends(current_principal)):
    cli: HermesCli = request.app.state.cli
    hermes: dict[str, Any]
    try:
        hermes = parse_version(await cli._run("--version", timeout=30))
    except Exception as e:
        hermes = {"version": "", "error": str(e)[:300]}
    latest = None
    enabled = _update_check_enabled()
    if check and enabled:
        latest = await _github_latest(HERMES_REPO)
    cur = hermes.get("version") or ""
    latest_tag = (latest or {}).get("tag") or ""
    update_available = None
    if cur and latest_tag:
        def key(v: str):
            return tuple(int(x) for x in re.findall(r"\d+", v)[:3])
        try:
            update_available = key(latest_tag) > key(cur)
        except ValueError:
            update_available = None
    return {"studio": {"version": STUDIO_VERSION}, "hermes": hermes, "latest": latest,
            "update_check_enabled": enabled, "update_available": update_available, "repo": HERMES_REPO,
            **await _studio_update_state(bool(check) and enabled)}
