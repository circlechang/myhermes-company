"""L. 記憶管理 — 讀寫各 profile `memories/` 下的檔案（MEMORY.md / USER.md …）。

`hermes memory` CLI 只管外部 provider（setup/status/off/reset），內建記憶就是這些檔案，
所以直接讀寫檔案；`GET /memory/status` 轉 `hermes memory status` 文字。
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ...auth import Principal, current_principal
from ...errors import ApiError
from ...hermes.cli import CliError, HermesCli

router = APIRouter(prefix="/memory", tags=["memory"])
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\- ]{0,120}$")


def memories_dir(cli: HermesCli, profile: str) -> Path:
    return cli.profile_dir(profile) / "memories"


def _check(cli: HermesCli, profile: str) -> str:
    profile = profile or "default"
    if profile not in cli.list_profiles_fs():
        raise ApiError(404, "not_found", f"profile not found: {profile}")
    return profile


def _target(cli: HermesCli, profile: str, name: str) -> Path:
    if not NAME_RE.match(name) or name in (".", ".."):
        raise ApiError(400, "path_traversal", "invalid memory file name")
    base = memories_dir(cli, profile).resolve()
    t = (base / name).resolve()
    if t.parent != base:
        raise ApiError(400, "path_traversal", "invalid memory file name")
    return t


@router.get("/files")
def files(request: Request, profile: str = "default", p: Principal = Depends(current_principal)):
    cli = request.app.state.cli
    profile = _check(cli, profile)
    d = memories_dir(cli, profile)
    out = []
    if d.is_dir():
        for f in sorted(d.iterdir()):
            if f.is_file() and not f.name.startswith(".") and not f.name.endswith(".lock"):
                st = f.stat()
                out.append({"name": f.name, "size": st.st_size, "mtime": st.st_mtime,
                            "primary": f.name in ("MEMORY.md", "USER.md")})
    return {"profile": profile, "dir": str(d), "files": out}


@router.get("/file")
def read(request: Request, name: str, profile: str = "default", p: Principal = Depends(current_principal)):
    cli = request.app.state.cli
    profile = _check(cli, profile)
    t = _target(cli, profile, name)
    if not t.is_file():
        return {"profile": profile, "name": name, "content": "", "exists": False, "mtime": 0}
    return {"profile": profile, "name": name, "content": t.read_text(encoding="utf-8", errors="replace"),
            "exists": True, "mtime": t.stat().st_mtime}


class WriteBody(BaseModel):
    profile: str = "default"
    name: str
    content: str


@router.put("/file")
def write(body: WriteBody, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    cli = request.app.state.cli
    profile = _check(cli, body.profile)
    t = _target(cli, profile, body.name)
    t.parent.mkdir(parents=True, exist_ok=True)
    t.write_text(body.content, encoding="utf-8")
    return {"profile": profile, "name": body.name, "size": t.stat().st_size, "mtime": t.stat().st_mtime}


@router.delete("/file")
def delete(request: Request, name: str, profile: str = "default", p: Principal = Depends(current_principal)):
    p.require_admin()
    cli = request.app.state.cli
    profile = _check(cli, profile)
    t = _target(cli, profile, name)
    if name in ("MEMORY.md", "USER.md"):
        raise ApiError(400, "protected", "MEMORY.md / USER.md 不可刪除，請清空內容")
    if t.is_file():
        t.unlink()
    return {"ok": True}


@router.get("/status")
async def status(request: Request, profile: str = "default", p: Principal = Depends(current_principal)):
    cli = request.app.state.cli
    profile = _check(cli, profile)
    args = (["-p", profile] if profile != "default" else []) + ["memory", "status"]
    try:
        out = await cli._run(*args, timeout=20)
    except CliError as e:
        return {"profile": profile, "ok": False, "output": str(e)}
    except Exception as e:  # FakeCli in tests
        return {"profile": profile, "ok": False, "output": str(e)}
    return {"profile": profile, "ok": True, "output": out}
