"""L. Skills — 清單／搜尋／分類／詳情／附檔／啟用停用／建立編輯／Bundles／用量／筆記。

資料來源：
- profile skills 目錄：`~/.hermes/skills`（default）或 `~/.hermes/profiles/<p>/skills`
- Hermes 內建 skills：`~/.hermes/hermes-agent/skills`（source=builtin；profile 有 `.no-bundled-skills` 時標記 seeded=false）
- 停用清單：profile `config.yaml` 的 `skills.disabled`（與 `hermes skills config` 同一份設定，ruamel 保留註解）
- Bundles：`~/.hermes/skill-bundles/*.yaml`，建立／刪除走 `hermes bundles create|delete`
- 用量：Studio messages（tool_name/tool_args 含 skill 名）＋ `~/.hermes/state.db`（唯讀）messages.tool_calls
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, current_principal, get_db
from ...errors import ApiError
from ...hermes.cli import CliError, HermesCli
from ...models import Message, new_id, now
from . import hermes_config

router = APIRouter(prefix="/skills", tags=["skills"])

SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$")


class SkillNote(SQLModel, table=True):
    __tablename__ = "skill_notes"
    id: str = Field(default_factory=lambda: new_id("sn"), primary_key=True)
    company_id: str = Field(index=True)
    member_id: str = Field(index=True)
    skill: str = Field(index=True)
    content: str = ""
    updated_at: datetime = Field(default_factory=now)


# -- discovery -------------------------------------------------------------

def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---"):
        return {}, text
    parts = text.split("\n---", 2)
    if len(parts) < 2:
        return {}, text
    try:
        fm = yaml.safe_load(parts[0][3:]) or {}
    except Exception:
        fm = {}
    body = parts[1].lstrip("-").lstrip("\n") if len(parts) == 2 else ("\n---".join(parts[1:])).lstrip("-\n")
    return (fm if isinstance(fm, dict) else {}), body


def profile_skills_dir(cli: HermesCli, profile: str) -> Path:
    return cli.profile_dir(profile) / "skills"


def builtin_skills_dir(cli: HermesCli) -> Path:
    return cli.home / "hermes-agent" / "skills"


def _iter_skill_files(base: Path, max_depth: int = 3) -> list[Path]:
    """SKILL.md under base, following symlinked dirs (Path.rglob does not), skipping dotdirs."""
    import os
    out: list[Path] = []
    base_depth = len(base.resolve().parts)
    for root, dirs, files in os.walk(base, followlinks=True):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        depth = len(Path(root).resolve().parts) - base_depth
        if depth >= max_depth:
            dirs[:] = []
        if "SKILL.md" in files:
            out.append(Path(root) / "SKILL.md")
            dirs[:] = []  # a skill dir does not nest other skills
    return sorted(out)


def _scan_dir(base: Path, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not base.is_dir():
        return out
    for skill_md in _iter_skill_files(base):
        d = skill_md.parent
        rel = d.relative_to(base)
        category = rel.parts[0] if len(rel.parts) >= 2 else None
        try:
            text = skill_md.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        fm, body = parse_frontmatter(text)
        name = str(fm.get("name") or d.name)
        tags = fm.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        try:
            mtime = skill_md.stat().st_mtime
        except OSError:
            mtime = 0
        out.append({
            "name": name, "dir": d.name, "path": str(d), "source": source,
            "category": str(fm.get("category") or category or "uncategorized"),
            "description": str(fm.get("description") or body.strip().splitlines()[0] if body.strip() else ""),
            "version": str(fm.get("version") or ""), "tags": [str(t) for t in tags],
            "mtime": mtime, "files": sum(1 for f in d.rglob("*") if f.is_file()),
        })
    return out


def list_skills(cli: HermesCli, profile: str) -> list[dict[str, Any]]:
    disabled = hermes_config.disabled_skills(cli, profile)
    local = _scan_dir(profile_skills_dir(cli, profile), "local")
    seen = {s["name"] for s in local}
    builtin = [s for s in _scan_dir(builtin_skills_dir(cli), "builtin") if s["name"] not in seen]
    seeded = not (cli.profile_dir(profile) / ".no-bundled-skills").exists()
    for s in builtin:
        s["seeded"] = seeded
    items = local + builtin
    for s in items:
        s["enabled"] = s["name"] not in disabled
        s["profile"] = profile
    return items


def find_skill(cli: HermesCli, profile: str, name: str) -> dict[str, Any]:
    for s in list_skills(cli, profile):
        if s["name"] == name or s["dir"] == name:
            return s
    raise ApiError(404, "not_found", f"skill not found: {name}")


def _check_profile(cli: HermesCli, profile: str) -> str:
    profile = profile or "default"
    if profile not in cli.list_profiles_fs():
        raise ApiError(404, "not_found", f"profile not found: {profile}")
    return profile


# -- routes: list / detail --------------------------------------------------

@router.get("")
def skills_index(request: Request, profile: str = "default", q: str = "", category: str = "", source: str = "",
                 p: Principal = Depends(current_principal)):
    cli = request.app.state.cli
    profile = _check_profile(cli, profile)
    items = list_skills(cli, profile)
    ql = q.strip().lower()
    if ql:
        items = [s for s in items if ql in s["name"].lower() or ql in s["description"].lower()
                 or any(ql in t.lower() for t in s["tags"])]
    if category:
        items = [s for s in items if s["category"] == category]
    if source:
        items = [s for s in items if s["source"] == source]
    cats: dict[str, int] = {}
    for s in list_skills(cli, profile):
        cats[s["category"]] = cats.get(s["category"], 0) + 1
    return {"profile": profile, "items": items, "categories": [{"name": k, "count": v} for k, v in sorted(cats.items())]}


@router.get("/categories")
def categories(request: Request, profile: str = "default", p: Principal = Depends(current_principal)):
    return skills_index(request, profile=profile, p=p)["categories"]


@router.get("/usage")
def usage(request: Request, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    """Count skill mentions in Studio tool messages and (read-only) Hermes state.db."""
    cli: HermesCli = request.app.state.cli
    names = {s["name"] for prof in cli.list_profiles_fs() for s in list_skills(cli, prof)}
    counts: dict[str, int] = {n: 0 for n in names}
    # 一個 alternation regex 一次找出所有出現的 skill 名稱（長名在前），每篇文字每個名稱最多算一次；
    # 原本 names × rows 的 `in` 掃描在 20000 筆 tool_calls 上要跑 7 秒以上。
    name_re = re.compile("|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))) if names else None

    def bump(text: str) -> None:
        if not text or name_re is None:
            return
        for n in set(name_re.findall(text)):
            counts[n] += 1

    for m in db.exec(select(Message).where(Message.role == "tool")).all():
        bump(f"{m.tool_name} {m.tool_args}")
    state_db = cli.home / "state.db"
    if state_db.exists():
        try:
            con = sqlite3.connect(f"file:{state_db}?mode=ro", uri=True, timeout=2)
            try:
                for (tc,) in con.execute("SELECT tool_calls FROM messages WHERE tool_calls LIKE '%skill%' LIMIT 20000"):
                    bump(tc or "")
            finally:
                con.close()
        except sqlite3.Error:
            pass
    return {"counts": counts, "top": sorted(((k, v) for k, v in counts.items() if v), key=lambda kv: -kv[1])[:30]}


@router.get("/bundles")
def bundles(request: Request, p: Principal = Depends(current_principal)):
    cli: HermesCli = request.app.state.cli
    d = cli.home / "skill-bundles"
    out = []
    if d.is_dir():
        for f in sorted(list(d.glob("*.yaml")) + list(d.glob("*.yml"))):
            try:
                data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            except Exception:
                data = {}
            out.append({"name": data.get("name") or f.stem, "file": f.name, "description": data.get("description", ""),
                        "instruction": data.get("instruction", ""), "skills": data.get("skills") or [],
                        "mtime": f.stat().st_mtime})
    return out


class BundleBody(BaseModel):
    name: str
    skills: list[str]
    description: str = ""
    instruction: str = ""


@router.post("/bundles")
async def create_bundle(body: BundleBody, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    if not SKILL_NAME_RE.match(body.name) or not body.skills:
        raise ApiError(400, "bad_request", "name/skills invalid")
    cli: HermesCli = request.app.state.cli
    args = ["bundles", "create", body.name, "--force"]
    for s in body.skills:
        args += ["--skill", s]
    if body.description:
        args += ["--description", body.description]
    if body.instruction:
        args += ["--instruction", body.instruction]
    try:
        out = await cli._run(*args)
    except CliError as e:
        raise ApiError(502, "hermes_cli_error", str(e))
    return {"ok": True, "output": out[-2000:]}


@router.delete("/bundles/{name}")
async def delete_bundle(name: str, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    cli: HermesCli = request.app.state.cli
    try:
        out = await cli._run("bundles", "delete", name)
    except CliError as e:
        raise ApiError(502, "hermes_cli_error", str(e))
    return {"ok": True, "output": out[-2000:]}


@router.get("/{name}")
def skill_detail(name: str, request: Request, profile: str = "default", p: Principal = Depends(current_principal)):
    cli = request.app.state.cli
    profile = _check_profile(cli, profile)
    s = find_skill(cli, profile, name)
    d = Path(s["path"])
    files = []
    for f in sorted(d.rglob("*")):
        if f.is_file() and not any(part.startswith(".") for part in f.relative_to(d).parts):
            files.append({"rel": f.relative_to(d).as_posix(), "size": f.stat().st_size})
    text = (d / "SKILL.md").read_text(encoding="utf-8", errors="replace")
    fm, body = parse_frontmatter(text)
    return {**s, "content": text, "frontmatter": fm, "body": body, "attachments": files}


@router.get("/{name}/file")
def skill_file(name: str, rel: str, request: Request, profile: str = "default", p: Principal = Depends(current_principal)):
    cli = request.app.state.cli
    profile = _check_profile(cli, profile)
    s = find_skill(cli, profile, name)
    base = Path(s["path"]).resolve()
    target = (base / rel).resolve()
    if not target.is_relative_to(base) or not target.is_file():
        raise ApiError(400, "path_traversal", "invalid attachment path")
    data = target.read_bytes()
    if len(data) > 1024 * 1024 or b"\x00" in data[:4096]:
        return {"rel": rel, "binary": True, "size": len(data), "content": None}
    return {"rel": rel, "binary": False, "size": len(data), "content": data.decode("utf-8", "replace")}


class SkillWrite(BaseModel):
    content: str
    profile: str = "default"
    category: str = ""


@router.put("/{name}")
def write_skill(name: str, body: SkillWrite, request: Request, p: Principal = Depends(current_principal)):
    """Create or overwrite <profile skills dir>/[category/]<name>/SKILL.md (owner/admin)."""
    p.require_admin()
    cli = request.app.state.cli
    profile = _check_profile(cli, body.profile)
    if not SKILL_NAME_RE.match(name):
        raise ApiError(400, "bad_name", "invalid skill name")
    existing = next((s for s in list_skills(cli, profile) if s["name"] == name and s["source"] == "local"), None)
    if existing:
        target = Path(existing["path"]) / "SKILL.md"
    else:
        cat = body.category.strip()
        if cat and not SKILL_NAME_RE.match(cat):
            raise ApiError(400, "bad_name", "invalid category")
        d = profile_skills_dir(cli, profile) / (cat if cat else "") / name
        d.mkdir(parents=True, exist_ok=True)
        target = d / "SKILL.md"
    content = body.content
    if not content.startswith("---"):
        content = f"---\nname: {name}\ndescription: \"\"\n---\n\n" + content
    target.write_text(content, encoding="utf-8")
    return find_skill(cli, profile, name)


class ToggleBody(BaseModel):
    enabled: bool
    profile: str = "default"


@router.post("/{name}/toggle")
def toggle(name: str, body: ToggleBody, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    cli = request.app.state.cli
    profile = _check_profile(cli, body.profile)
    find_skill(cli, profile, name)
    disabled = hermes_config.set_skill_enabled(cli, profile, name, body.enabled)
    return {"name": name, "profile": profile, "enabled": name not in disabled, "disabled": sorted(disabled)}


@router.get("/{name}/note")
def get_note(name: str, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    row = db.exec(select(SkillNote).where(SkillNote.member_id == p.member.id, SkillNote.skill == name)).first()
    return {"skill": name, "content": row.content if row else "", "updated_at": row.updated_at if row else None}


class NoteBody(BaseModel):
    content: str


@router.put("/{name}/note")
def put_note(name: str, body: NoteBody, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    row = db.exec(select(SkillNote).where(SkillNote.member_id == p.member.id, SkillNote.skill == name)).first()
    if row is None:
        row = SkillNote(company_id=p.company_id, member_id=p.member.id, skill=name)
    row.content = body.content
    row.updated_at = now()
    db.add(row)
    db.commit()
    return {"skill": name, "content": row.content, "updated_at": row.updated_at}
