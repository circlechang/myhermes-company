"""首次設定精靈（Setup Wizard）— owner 專用。

讓使用者裝好 Studio 後不用碰指令就把 Hermes 的 API 門打開並完成基本設定：
- `GET  /setup/status`            偵測 hermes CLI／~/.hermes／API key／8642／gateway／profiles／admin 預設密碼
- `POST /setup/enable-api`        key 未設 → 產生強隨機 key 寫入 ~/.hermes/.env（先備份 .env.bak-<ts>，只動該行）、
                                   同步到 Studio 的 GatewayClient，再背景 `hermes gateway restart|start` 並輪詢 /v1/health（≤90s）
- `GET  /setup/enable-api/progress` 背景工作進度（輪詢）
- `POST /setup/admin-password`    改自己的（owner）密碼
- `POST /setup/complete`          記 `completed` flag（Studio DB `setup_state`）；`POST /setup/reset` 清掉
安全：全部要 owner；key 值永不回傳、不寫 log。`MHC_SETUP_DRY_RUN=1`（或 body.dry_run）只寫檔不碰 gateway，給測試用。
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, current_principal, get_db, hash_password, verify_password
from ...errors import ApiError
from ...hermes.gateway import GatewayAuthError
from ...hermes.cli import CliError
from ...models import Member, now
from ..channels import parse_gateway_status
from ..profiles import files as F

log = logging.getLogger("studio.setup")
router = APIRouter(prefix="/setup", tags=["setup"])

MIN_KEY_LEN = 16  # Hermes gateway/config.py：key 太短視同沒設
HEALTH_WAIT_SECONDS = 90
DEFAULT_ADMIN_PASSWORD = "admin"
INSTALL_CMD = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
DOCS_URL = "https://hermes-agent.nousresearch.com/docs"


class SetupState(SQLModel, table=True):
    __tablename__ = "setup_state"
    key: str = Field(primary_key=True)
    value: str = ""
    updated_at: datetime = Field(default_factory=now)


# -- helpers ---------------------------------------------------------------
def _require_owner(p: Principal) -> None:
    if p.role != "owner":
        raise ApiError(403, "forbidden", "設定精靈只有 owner 可以使用")


def _get_state(db: Session, key: str) -> str:
    row = db.get(SetupState, key)
    return row.value if row else ""


def _set_state(db: Session, key: str, value: str) -> None:
    row = db.get(SetupState, key) or SetupState(key=key)
    row.value = value
    row.updated_at = now()
    db.add(row)
    db.commit()


def is_completed(db: Session) -> bool:
    return _get_state(db, "completed") == "1"


def _env_path(request: Request) -> Path:
    return Path(request.app.state.settings.hermes_home) / ".env"


def key_configured(env_path: Path) -> bool:
    """只回布林，不回值。"""
    v = F.read_env(env_path).get("API_SERVER_KEY", "")
    return len(v) >= MIN_KEY_LEN


def _dry_run(flag: Optional[bool]) -> bool:
    if flag is not None:
        return bool(flag)
    return os.environ.get("MHC_SETUP_DRY_RUN", "") in ("1", "true", "yes")


def _strip_ansi(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", s or "")


def parse_version(raw: str) -> str:
    m = re.search(r"v?(\d+\.\d+\.\d+[\w.-]*)", _strip_ansi(raw))
    return m.group(1) if m else ""


def _resolve_bin(bin_: str) -> Optional[str]:
    p = Path(bin_).expanduser()
    if p.is_file():
        return str(p)
    return shutil.which(bin_)


async def detect_hermes(cli) -> dict[str, Any]:
    path = _resolve_bin(cli.bin)
    out: dict[str, Any] = {"installed": bool(path), "bin": path or cli.bin, "version": "", "error": ""}
    if path:
        try:
            out["version"] = parse_version(await cli._run("--version", timeout=20.0))
        except CliError as e:
            out["error"] = str(e)[:300]
    return out


async def detect_gateway(cli) -> dict[str, Any]:
    try:
        raw = await cli._run("gateway", "status", timeout=30.0)
        parsed = parse_gateway_status(raw)
        return {"ok": True, "running": parsed["running"], "pid": parsed["pid"], "supervised": parsed["supervised"],
                "stale_service": parsed["stale_service"], "profiles": parsed["profiles"], "raw_tail": parsed["raw"][-1500:]}
    except CliError as e:
        # `gateway status` 沒在跑時也可能非零結束；把輸出交給 parser 再判斷
        text = _strip_ansi(str(e))
        parsed = parse_gateway_status(text)
        return {"ok": False, "running": parsed["running"], "pid": parsed["pid"], "supervised": parsed["supervised"],
                "stale_service": False, "profiles": [], "raw_tail": text[-1500:]}


async def probe_api(gateway) -> dict[str, Any]:
    """`/v1/health` 不驗 key；再打 `/v1/models` 確認 Studio 手上的 key 被接受（錯 key → `auth_failed: true`）。"""
    try:
        h = await gateway.health()
        out = {"reachable": h.get("status") == "ok", "version": h.get("version", ""), "error": "", "auth_failed": False}
    except GatewayAuthError:
        return {"reachable": False, "version": "", "error": "API key 錯誤（gateway 回 gateway_auth_failed）", "auth_failed": True}
    except Exception as e:  # noqa: BLE001 — 任何連線錯都只回訊息
        return {"reachable": False, "version": "", "error": str(e)[:300], "auth_failed": False}
    if out["reachable"]:
        try:
            await gateway.models()
        except GatewayAuthError:
            out.update(reachable=False, auth_failed=True, error="API key 錯誤（gateway 回 gateway_auth_failed）")
        except Exception:  # noqa: BLE001 — models 端點壞掉不代表 key 錯
            pass
    return out


def admin_uses_default_password(db: Session) -> bool:
    for m in db.exec(select(Member).where(Member.role == "owner")):
        if verify_password(DEFAULT_ADMIN_PASSWORD, m.password_hash):
            return True
    return False


# -- status ----------------------------------------------------------------
@router.get("/state")
def setup_state(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """任何已登入成員都能看：精靈完成了沒（非 owner 用來顯示「請管理員完成設定」）。"""
    return {"completed": is_completed(db), "is_owner": p.role == "owner"}


@router.get("/status")
async def setup_status(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _require_owner(p)
    st = request.app.state.settings
    cli = request.app.state.cli
    gw = request.app.state.gateway
    home = Path(st.hermes_home)
    env_path = home / ".env"
    hermes = await detect_hermes(cli)
    in_file = key_configured(env_path)
    in_env = bool(os.environ.get("HERMES_API_KEY"))
    api = {"key_configured": in_file or in_env, "key_source": "env_file" if in_file else ("env" if in_env else "none"),
           "studio_key_loaded": bool(getattr(gw, "api_key", "") or st.hermes_api_key), "url": st.hermes_api_url,
           "env_path": str(env_path)}
    api.update(await probe_api(gw) if api["studio_key_loaded"] else {"reachable": False, "version": "", "error": "Studio 尚未載入 API key"})
    gateway = await detect_gateway(cli) if hermes["installed"] else {"ok": False, "running": False, "pid": None, "supervised": False,
                                                                     "stale_service": False, "profiles": [], "raw_tail": ""}
    names = cli.list_profiles_fs() if home.is_dir() else []
    completed = is_completed(db)
    default_pw = admin_uses_default_password(db)
    if not hermes["installed"] or not home.is_dir():
        next_step = "install"
    elif not (api["key_configured"] and api["reachable"]):
        next_step = "api"
    elif default_pw:
        next_step = "password"
    else:
        next_step = "done" if completed else "agents"
    return {
        "completed": completed,
        "hermes": {**hermes, "home": str(home), "home_exists": home.is_dir(), "install_cmd": INSTALL_CMD, "docs_url": DOCS_URL},
        "api": api,
        "gateway": gateway,
        "profiles": {"count": len(names), "names": names},
        "admin": {"default_password": default_pw, "username": p.member.username},
        "next_step": next_step,
        "dry_run": _dry_run(None),
    }


# -- enable-api ------------------------------------------------------------
class EnableApiBody(BaseModel):
    dry_run: Optional[bool] = None
    restart: bool = True


class EnableJob:
    """單一背景工作（同時只允許一個）；所有欄位可直接序列化，不含 key。"""

    def __init__(self, dry_run: bool):
        self.id = f"setup_{secrets.token_hex(4)}"
        self.dry_run = dry_run
        self.started_at = time.time()
        self.done = False
        self.ok: Optional[bool] = None
        self.phase = "write_key"
        self.error = ""
        self.log_tail = ""
        self.steps: list[dict[str, Any]] = []
        self.manual_cmd = "hermes gateway restart   # 然後 curl -H \"Authorization: Bearer $API_SERVER_KEY\" http://127.0.0.1:8642/v1/health"

    def step(self, name: str, status: str, detail: str = "") -> None:
        for s in self.steps:
            if s["name"] == name:
                s.update({"status": status, "detail": detail})
                break
        else:
            self.steps.append({"name": name, "status": status, "detail": detail})
        if status in ("running", "ok"):
            self.phase = name

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "dry_run": self.dry_run, "done": self.done, "ok": self.ok, "phase": self.phase,
                "error": self.error, "log_tail": self.log_tail[-2000:], "steps": self.steps,
                "elapsed": round(time.time() - self.started_at, 1), "manual_cmd": self.manual_cmd}


def backup_env(env_path: Path) -> Optional[str]:
    if not env_path.exists():
        return None
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = env_path.with_name(f"{env_path.name}.bak-{ts}")
    shutil.copy2(env_path, bak)
    try:
        bak.chmod(0o600)
    except OSError:
        pass
    return str(bak)


def write_key(env_path: Path) -> dict[str, Any]:
    """產生並寫入 API_SERVER_KEY（只動該行）；回傳不含 key 的結果。已設就不覆寫。"""
    if key_configured(env_path):
        return {"changed": False, "backup": None, "key": F.read_env(env_path)["API_SERVER_KEY"]}
    backup = backup_env(env_path)
    key = secrets.token_urlsafe(32)
    F.write_env(env_path, {"API_SERVER_KEY": key})
    return {"changed": True, "backup": backup, "key": key}


async def _run_enable_job(app, job: EnableJob, restart: bool) -> None:
    cli = app.state.cli
    gw = app.state.gateway
    try:
        if job.dry_run:
            job.step("gateway", "skipped", "dry-run：不重啟 gateway")
            job.step("health", "skipped", "dry-run：不輪詢 /v1/health")
            job.ok, job.done = True, True
            return
        if restart:
            job.step("gateway", "running")
            status = await detect_gateway(cli)
            verb = "restart" if status["running"] else "start"
            try:
                out = await cli._run("gateway", verb, timeout=120.0)
                job.log_tail = _strip_ansi(out)[-2000:]
                job.step("gateway", "ok", f"hermes gateway {verb}")
            except CliError as e:
                job.log_tail = _strip_ansi(str(e))[-2000:]
                job.step("gateway", "failed", f"hermes gateway {verb} 失敗")
                job.error = f"gateway {verb} 失敗：{_strip_ansi(str(e))[:300]}"
                job.ok, job.done = False, True
                return
        job.step("health", "running")
        deadline = time.time() + HEALTH_WAIT_SECONDS
        last_err = ""
        while time.time() < deadline:
            r = await probe_api(gw)
            if r["reachable"]:
                job.step("health", "ok", f"Hermes {r['version']}".strip())
                job.ok, job.done = True, True
                return
            last_err = r["error"]
            await asyncio.sleep(2.0)
        job.step("health", "failed", last_err)
        job.error = f"{HEALTH_WAIT_SECONDS} 秒內 /v1/health 沒有回應：{last_err}"
        job.ok, job.done = False, True
    except Exception as e:  # noqa: BLE001
        log.exception("setup enable-api job failed")
        job.error = str(e)[:300]
        job.ok, job.done = False, True


@router.post("/enable-api")
async def enable_api(body: EnableApiBody, request: Request, p: Principal = Depends(current_principal)):
    _require_owner(p)
    app = request.app
    st = app.state.settings
    gw = app.state.gateway
    env_path = _env_path(request)
    dry = _dry_run(body.dry_run)
    current: Optional[EnableJob] = getattr(app.state, "setup_job", None)
    if current and not current.done:
        raise ApiError(409, "busy", "已有一個開門工作在跑，請等它結束", job=current.public())
    if not Path(st.hermes_home).is_dir():
        raise ApiError(400, "hermes_home_missing", f"找不到 Hermes 目錄：{st.hermes_home}，請先安裝 Hermes Agent")
    # 已設好且 Studio 已載入、也連得上 → 什麼都不做
    if key_configured(env_path):
        file_key = F.read_env(env_path)["API_SERVER_KEY"]
        if not st.hermes_api_key or gw.api_key != file_key:
            st.hermes_api_key = file_key  # Studio 起動後才寫的 key：同步進來
            gw.api_key = file_key
        probe = await probe_api(gw)
        if probe["reachable"]:
            return {"status": "configured", "changed": False, "reachable": True, "job": None}
        # key 在檔案裡但 gateway 沒回應 → 只做重啟＋等待，不動 key
        job = EnableJob(dry)
        job.step("write_key", "ok", "API_SERVER_KEY 已存在，未改動")
        app.state.setup_job = job
        asyncio.create_task(_run_enable_job(app, job, body.restart))
        return {"status": "restarting", "changed": False, "reachable": False, "job": job.public()}
    res = write_key(env_path)
    st.hermes_api_key = res["key"]
    gw.api_key = res["key"]
    log.info("setup: API_SERVER_KEY 已寫入 %s（備份 %s）", env_path, res["backup"])
    job = EnableJob(dry)
    job.step("write_key", "ok", f"已寫入 {env_path}" + (f"，備份 {res['backup']}" if res["backup"] else ""))
    app.state.setup_job = job
    asyncio.create_task(_run_enable_job(app, job, body.restart))
    return {"status": "written", "changed": True, "backup": res["backup"], "reachable": False, "job": job.public()}


@router.get("/enable-api/progress")
def enable_api_progress(request: Request, p: Principal = Depends(current_principal)):
    _require_owner(p)
    job: Optional[EnableJob] = getattr(request.app.state, "setup_job", None)
    return {"job": job.public() if job else None}


# -- admin password ---------------------------------------------------------
class PasswordBody(BaseModel):
    password: str


@router.post("/admin-password")
def set_admin_password(body: PasswordBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _require_owner(p)
    pw = body.password
    if len(pw) < 8:
        raise ApiError(400, "weak_password", "密碼至少 8 碼")
    if pw == DEFAULT_ADMIN_PASSWORD:
        raise ApiError(400, "weak_password", "不能沿用預設密碼")
    m = db.get(Member, p.member.id)
    if m is None:
        raise ApiError(404, "not_found", "member")
    m.password_hash = hash_password(pw)
    db.add(m)
    db.commit()
    return {"ok": True, "default_password": admin_uses_default_password(db)}


# -- complete / reset -------------------------------------------------------
@router.post("/complete")
def complete(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _require_owner(p)
    _set_state(db, "completed", "1")
    _set_state(db, "completed_by", p.member.username)
    return {"ok": True, "completed": True}


@router.post("/reset")
def reset(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _require_owner(p)
    _set_state(db, "completed", "0")
    return {"ok": True, "completed": False}
