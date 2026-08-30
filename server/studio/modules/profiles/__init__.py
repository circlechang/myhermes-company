"""H. 多 Profile：建立／重新命名／刪除／預設／複製／匯出／匯入／設定（config.yaml）／帳號綁定。

CLI 有的走 `hermes profile ...`（create/delete/rename/use/export/import），
沒有的直接操作 `~/.hermes/profiles/<name>/`。config.yaml 用 ruamel 保留註解。
帳號綁定的資料在 members.profiles_json；可見性判斷在 studio.auth.allowed_profiles()。
"""
from __future__ import annotations

import json
import logging
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import text
from sqlmodel import Session, select

from ...auth import Principal, allowed_profiles, current_principal, get_db, member_public, profile_visible
from ...errors import ApiError, not_found
from ...hermes.cli import CliError, HermesCli
from ...models import Agent, Member, now
from . import files as F

log = logging.getLogger("studio.profiles")
router = APIRouter(prefix="/profiles", tags=["profiles"])


async def on_startup(app) -> None:
    """既有 DB 沒有 members.profiles_json 時補欄位（SQLite create_all 不會加欄位）。"""
    engine = app.state.engine
    with engine.begin() as conn:
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(members)").fetchall()}
        if cols and "profiles_json" not in cols:
            conn.exec_driver_sql("ALTER TABLE members ADD COLUMN profiles_json TEXT NOT NULL DEFAULT '[]'")
            log.info("members.profiles_json column added")


# -- helpers ---------------------------------------------------------------
def _cli(request: Request) -> HermesCli:
    return request.app.state.cli


def _home(request: Request) -> Path:
    return Path(request.app.state.settings.hermes_home)


def _active_profile(home: Path) -> str:
    f = home / "active_profile"
    try:
        v = f.read_text(encoding="utf-8").strip() if f.exists() else ""
    except OSError:
        v = ""
    return v or "default"


def _require_visible(p: Principal, name: str) -> None:
    if not profile_visible(p.member, name):
        raise not_found("profile")


def _exists(home: Path, name: str) -> bool:
    return name == "default" or F.profile_dir(home, name).is_dir()


def _profile_info(home: Path, name: str, extra: dict[str, Any], active: str) -> dict[str, Any]:
    d = F.profile_dir(home, name)
    cfg = F.load_yaml(d / "config.yaml") if (d / "config.yaml").exists() else {}
    model = F.get_path(cfg, "model.default", "") or extra.get("model", "")
    if not model and name != "default":  # 新建 profile 沒寫 model → 繼承 default 的
        model = F.get_path(F.load_yaml(home / "config.yaml"), "model.default", "") or ""
    desc = ""
    py = d / "profile.yaml"
    if py.exists():
        try:
            desc = str(F.get_path(F.load_yaml(py), "description", "") or "")
        except Exception:
            desc = ""
    return {
        "name": name,
        "display_name": extra.get("display_name") or name,
        "model": model or "",
        "provider": F.get_path(cfg, "model.provider", "") or "",
        "gateway": extra.get("gateway", ""),
        "is_default": name == active,
        "description": desc,
        "path": str(d),
        "has_soul": (d / "SOUL.md").exists(),
        "has_env": (d / ".env").exists(),
        "skills": len([x for x in (d / "skills").iterdir() if x.is_dir()]) if (d / "skills").is_dir() else 0,
    }


async def _run(cli: HermesCli, *args: str, timeout: float = 60.0) -> str:
    try:
        return await cli._run(*args, timeout=timeout)
    except CliError as e:
        raise ApiError(502, "hermes_cli_error", str(e))


# -- list / detail ---------------------------------------------------------
@router.get("")
async def list_profiles(request: Request, p: Principal = Depends(current_principal)):
    cli, home = _cli(request), _home(request)
    try:
        infos = {i["name"]: i for i in await cli.list_profiles()}
    except Exception as e:  # CLI down → filesystem only
        log.warning("profile list via CLI failed: %s", e)
        infos = {}
    active = _active_profile(home)
    allowed = allowed_profiles(p.member)
    out = []
    for name in F.list_profile_names(home):
        if allowed is not None and name not in allowed:
            continue
        out.append(_profile_info(home, name, infos.get(name, {}), active))
    return {"profiles": out, "active": active, "restricted": allowed is not None}


@router.get("/{name}")
async def get_profile(name: str, request: Request, p: Principal = Depends(current_principal)):
    home = _home(request)
    _require_visible(p, name)
    if not _exists(home, name):
        raise not_found("profile")
    return _profile_info(home, name, {}, _active_profile(home))


# -- create / clone / rename / delete / use --------------------------------
class ProfileCreate(BaseModel):
    name: str
    clone_from: Optional[str] = None
    description: Optional[str] = None
    no_skills: bool = False


@router.post("", status_code=201)
async def create_profile(body: ProfileCreate, request: Request, p: Principal = Depends(current_principal),
                         db: Session = Depends(get_db)):
    p.require_admin()
    cli, home = _cli(request), _home(request)
    try:
        name = F.validate_profile_name(body.name)
    except ValueError as e:
        raise ApiError(400, "bad_profile_name", str(e))
    if _exists(home, name):
        raise ApiError(409, "conflict", f"profile 已存在: {name}")
    args = ["profile", "create", name, "--no-alias"]
    if body.clone_from:
        if not _exists(home, body.clone_from):
            raise ApiError(400, "unknown_profile", f"來源 profile 不存在: {body.clone_from}")
        _require_visible(p, body.clone_from)
        args += ["--clone-from", body.clone_from]
    if body.description:
        args += ["--description", body.description]
    if body.no_skills:
        args.append("--no-skills")
    await _run(cli, *args, timeout=120.0)
    if not _exists(home, name):
        raise ApiError(502, "hermes_cli_error", "CLI 回報成功但 profile 目錄不存在")
    _sync_agent(db, p.company_id, name, cli)
    return _profile_info(home, name, {}, _active_profile(home))


class CloneBody(BaseModel):
    new_name: str


@router.post("/{name}/clone", status_code=201)
async def clone_profile(name: str, body: CloneBody, request: Request, p: Principal = Depends(current_principal),
                        db: Session = Depends(get_db)):
    return await create_profile(ProfileCreate(name=body.new_name, clone_from=name), request, p, db)


class RenameBody(BaseModel):
    new_name: str


@router.post("/{name}/rename")
async def rename_profile(name: str, body: RenameBody, request: Request, p: Principal = Depends(current_principal),
                         db: Session = Depends(get_db)):
    p.require_admin()
    cli, home = _cli(request), _home(request)
    _require_visible(p, name)
    if not _exists(home, name):
        raise not_found("profile")
    if name == "default":
        new = body.new_name.strip()  # default 只改顯示名稱
        if not new:
            raise ApiError(400, "bad_request", "顯示名稱不可空白")
    else:
        try:
            new = F.validate_profile_name(body.new_name)
        except ValueError as e:
            raise ApiError(400, "bad_profile_name", str(e))
        if _exists(home, new):
            raise ApiError(409, "conflict", f"profile 已存在: {new}")
    await _run(cli, "profile", "rename", name, new)
    if name != "default":
        for a in db.exec(select(Agent).where(Agent.profile == name)).all():
            a.profile = new
            a.updated_at = now()
            db.add(a)
        for m in db.exec(select(Member)).all():
            lst = json.loads(m.profiles_json or "[]")
            if name in lst:
                m.profiles_json = json.dumps(sorted({new if x == name else x for x in lst}))
                db.add(m)
        db.commit()
    return _profile_info(home, new if name != "default" else "default", {}, _active_profile(home))


@router.delete("/{name}")
async def delete_profile(name: str, request: Request, p: Principal = Depends(current_principal),
                         db: Session = Depends(get_db)):
    p.require_admin()
    cli, home = _cli(request), _home(request)
    _require_visible(p, name)
    if name == "default":
        raise ApiError(400, "bad_request", "default profile 不能刪除")
    if not _exists(home, name):
        raise not_found("profile")
    await _run(cli, "profile", "delete", name, "-y", timeout=120.0)
    if F.profile_dir(home, name).exists():
        raise ApiError(502, "hermes_cli_error", "CLI 回報成功但目錄仍存在")
    for a in db.exec(select(Agent).where(Agent.profile == name)).all():
        db.delete(a)
    db.commit()
    return {"ok": True}


@router.post("/{name}/use")
async def use_profile(name: str, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    cli, home = _cli(request), _home(request)
    _require_visible(p, name)
    if not _exists(home, name):
        raise not_found("profile")
    await _run(cli, "profile", "use", name)
    return {"ok": True, "active": _active_profile(home)}


# -- export / import -------------------------------------------------------
@router.get("/{name}/export")
async def export_profile(name: str, request: Request, bg: BackgroundTasks, p: Principal = Depends(current_principal)):
    p.require_admin()
    cli, home = _cli(request), _home(request)
    _require_visible(p, name)
    if not _exists(home, name):
        raise not_found("profile")
    tmpdir = Path(tempfile.mkdtemp(prefix="studio-profile-export-"))
    out = tmpdir / f"{name}.tar.gz"
    await _run(cli, "profile", "export", name, "-o", str(out), timeout=300.0)
    if not out.exists():
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise ApiError(502, "hermes_cli_error", "匯出檔案未產生")
    bg.add_task(shutil.rmtree, tmpdir, True)
    return FileResponse(str(out), media_type="application/gzip", filename=f"{name}.tar.gz")


@router.post("/import", status_code=201)
async def import_profile(request: Request, file: UploadFile = File(...), name: Optional[str] = Form(None),
                         p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    cli, home = _cli(request), _home(request)
    if name:
        try:
            name = F.validate_profile_name(name)
        except ValueError as e:
            raise ApiError(400, "bad_profile_name", str(e))
        if _exists(home, name):
            raise ApiError(409, "conflict", f"profile 已存在: {name}")
    tmpdir = Path(tempfile.mkdtemp(prefix="studio-profile-import-"))
    try:
        fname = re.sub(r"[^A-Za-z0-9_.-]", "_", file.filename or "profile.tar.gz")
        if not fname.endswith((".tar.gz", ".tgz")):
            fname += ".tar.gz"
        dst = tmpdir / fname
        with dst.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        before = set(F.list_profile_names(home))
        args = ["profile", "import", str(dst)]
        if name:
            args += ["--name", name]
        await _run(cli, *args, timeout=300.0)
        after = set(F.list_profile_names(home))
        created = name or next(iter(after - before), None)
        if not created or not _exists(home, created):
            raise ApiError(502, "hermes_cli_error", "匯入後找不到新 profile")
        _sync_agent(db, p.company_id, created, cli)
        return _profile_info(home, created, {}, _active_profile(home))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# -- config.yaml (profile scope) ---------------------------------------------
@router.get("/{name}/config")
async def get_config(name: str, request: Request, raw: bool = False, p: Principal = Depends(current_principal)):
    home = _home(request)
    _require_visible(p, name)
    if not _exists(home, name):
        raise not_found("profile")
    path = F.profile_dir(home, name) / "config.yaml"
    if raw:
        p.require_admin()  # 原文含密鑰
        return {"path": str(path), "text": path.read_text(encoding="utf-8") if path.exists() else ""}
    data = F.plain(F.load_yaml(path))
    return {"path": str(path), "config": F.redact(data)}


class ConfigPatch(BaseModel):
    patch: Optional[dict[str, Any]] = None  # 深度合併；值 None → 刪 key
    set: Optional[dict[str, Any]] = None  # dotted key → value
    unset: Optional[list[str]] = None
    text: Optional[str] = None  # 整份原文覆寫（進階）


@router.put("/{name}/config")
async def put_config(name: str, body: ConfigPatch, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    home = _home(request)
    _require_visible(p, name)
    if not _exists(home, name):
        raise not_found("profile")
    path = F.profile_dir(home, name) / "config.yaml"
    if body.text is not None:
        try:
            from ruamel.yaml import YAML
            YAML().load(body.text)
        except Exception as e:
            raise ApiError(400, "bad_yaml", f"YAML 解析失敗: {e}")
        F._atomic_write(path, body.text)
        return {"ok": True, "config": F.redact(F.plain(F.load_yaml(path)))}
    data = F.load_yaml(path)
    if body.patch:
        F.merge_into(data, body.patch)
    for k, v in (body.set or {}).items():
        F.set_path(data, k, v)
    for k in body.unset or []:
        F.unset_path(data, k)
    F.dump_yaml(path, data)
    return {"ok": True, "config": F.redact(F.plain(data))}


# -- member ↔ profile assignment (H 帳號綁定) -------------------------------
@router.get("/assignments/members")
def list_assignments(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    rows = db.exec(select(Member).where(Member.company_id == p.company_id).order_by(Member.created_at)).all()
    return [member_public(m) for m in rows]


class AssignBody(BaseModel):
    profiles: list[str]


@router.put("/assignments/members/{member_id}")
def assign(member_id: str, body: AssignBody, request: Request, p: Principal = Depends(current_principal),
           db: Session = Depends(get_db)):
    p.require_admin()
    m = db.get(Member, member_id)
    if m is None or m.company_id != p.company_id:
        raise not_found("member")
    home = _home(request)
    names = []
    for n in body.profiles:
        n = n.strip()
        if not n:
            continue
        if not _exists(home, n):
            raise ApiError(400, "unknown_profile", f"profile 不存在: {n}")
        names.append(n)
    m.profiles_json = json.dumps(sorted(set(names)))
    db.add(m)
    db.commit()
    db.refresh(m)
    return member_public(m)


def _sync_agent(db: Session, company_id: str, profile: str, cli: HermesCli) -> None:
    """新 profile → 幫這家公司補一筆 Agent（AI 員工＝profile）。"""
    if db.exec(select(Agent).where(Agent.company_id == company_id, Agent.profile == profile)).first():
        return
    db.add(Agent(company_id=company_id, name=profile, profile=profile, model=cli.profile_model(profile), enabled=False))
    db.commit()
