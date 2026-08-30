"""soul_history 模組：SOUL.md 版本歷史。

- 透過 Studio 寫 SOUL.md 請走 `PUT /soul-history/{profile}`（寫檔＋記版本）；`PUT /agents/{id}/soul` 也已改呼叫本模組 `write_versioned()`，
  另外提供「漂移偵測」（CLI／編輯器外部改檔）：GET /soul-history/{profile}/current 會告訴你檔案內容是否與最新版本不同，可按一鍵 snapshot 補記。
- on_startup 把每個 profile 現有的 SOUL.md 快照為版本 0（冪等：已有版本就跳過）。
- 版本是全域的（profile 是 Hermes 層的東西，不分公司）；讀取套 profile 可見性，寫入需 owner/admin。
"""
from __future__ import annotations

import difflib
import logging
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, allowed_profiles, current_principal, get_db, profile_visible
from ...errors import ApiError, bad_request, not_found
from ...models import new_id, now

log = logging.getLogger("studio.soul_history")
router = APIRouter(prefix="/soul-history", tags=["soul-history"])


class SoulVersion(SQLModel, table=True):
    __tablename__ = "soul_versions"
    id: str = Field(default_factory=lambda: new_id("sv"), primary_key=True)
    profile: str = Field(index=True)
    version: int = Field(default=0, index=True)
    content: str = ""
    member_id: str = ""  # 寫入者；startup 快照為 ""
    ts: datetime = Field(default_factory=now)
    note: str = ""
    company_id: str = ""  # 寫入者所屬公司（僅供追溯）

    def meta(self) -> dict[str, Any]:
        return {"id": self.id, "profile": self.profile, "version": self.version, "member_id": self.member_id, "ts": self.ts,
                "note": self.note, "chars": len(self.content or ""), "lines": (self.content or "").count("\n") + (1 if self.content else 0)}

    def to_dict(self) -> dict[str, Any]:
        d = self.meta()
        d["content"] = self.content
        return d


def _cli(request: Request):
    return request.app.state.cli


def _latest(db: Session, profile: str) -> Optional[SoulVersion]:
    return db.exec(select(SoulVersion).where(SoulVersion.profile == profile).order_by(SoulVersion.version.desc())).first()


def _check_profile(request: Request, p: Principal, profile: str) -> None:
    if not profile_visible(p.member, profile):
        raise not_found("profile")
    if profile not in _cli(request).list_profiles_fs():
        raise not_found("profile")


def save_version(db: Session, profile: str, content: str, *, member_id: str = "", note: str = "", company_id: str = "") -> SoulVersion:
    last = _latest(db, profile)
    v = SoulVersion(profile=profile, version=(last.version + 1 if last else 0), content=content, member_id=member_id, note=note, company_id=company_id)
    db.add(v)
    return v


def snapshot_all(engine, cli) -> int:
    """每個 profile 沒有任何版本時，把現在的 SOUL.md 存成版本 0。冪等。"""
    n = 0
    with Session(engine) as db:
        for name in cli.list_profiles_fs():
            if _latest(db, name) is not None:
                continue
            try:
                content = cli.read_soul(name)
            except Exception as e:
                log.warning("read SOUL.md for %s failed: %s", name, e)
                continue
            save_version(db, name, content, note="startup snapshot")
            n += 1
        db.commit()
    return n


@router.get("")
def list_profiles(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """每個 profile 的版本數與最新版本摘要。"""
    allowed = allowed_profiles(p.member)
    names = [n for n in _cli(request).list_profiles_fs() if allowed is None or n in allowed]
    out = []
    for name in names:
        last = _latest(db, name)
        cnt = db.exec(select(func.count()).select_from(SoulVersion).where(SoulVersion.profile == name)).one()
        out.append({"profile": name, "versions": int(cnt), "latest": last.meta() if last else None})
    return out


@router.get("/{profile}")
def list_versions(profile: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _check_profile(request, p, profile)
    rows = db.exec(select(SoulVersion).where(SoulVersion.profile == profile).order_by(SoulVersion.version.desc())).all()
    return [v.meta() for v in rows]


@router.get("/{profile}/current")
def current(profile: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _check_profile(request, p, profile)
    content = _cli(request).read_soul(profile)
    last = _latest(db, profile)
    return {"profile": profile, "content": content, "latest_version": last.version if last else None,
            "drift": (last is None) or (last.content != content)}


@router.get("/{profile}/diff")
def diff(profile: str, request: Request, a: Optional[int] = None, b: Optional[int] = None,
         p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """a→b 的 unified diff。b 省略＝最新；a 省略＝b 的前一版；b=-1 代表「檔案現況」。"""
    _check_profile(request, p, profile)
    last = _latest(db, profile)
    if last is None:
        raise not_found("version")
    if b == -1:
        b_text, b_label = _cli(request).read_soul(profile), "current file"
        b_num = last.version
    else:
        b_num = last.version if b is None else b
        vb = db.exec(select(SoulVersion).where(SoulVersion.profile == profile, SoulVersion.version == b_num)).first()
        if vb is None:
            raise not_found("version")
        b_text, b_label = vb.content, f"v{vb.version}"
    a_num = (b_num - 1 if b != -1 else last.version) if a is None else a
    va = db.exec(select(SoulVersion).where(SoulVersion.profile == profile, SoulVersion.version == a_num)).first()
    a_text = va.content if va else ""
    a_label = f"v{a_num}" if va else "(empty)"
    lines = list(difflib.unified_diff(a_text.splitlines(), b_text.splitlines(), fromfile=a_label, tofile=b_label, lineterm=""))
    return {"profile": profile, "from": a_num if va else None, "to": (None if b == -1 else b_num), "diff": "\n".join(lines),
            "added": sum(1 for l in lines if l.startswith("+") and not l.startswith("+++")),
            "removed": sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))}


@router.get("/{profile}/{version}")
def get_version(profile: str, version: int, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _check_profile(request, p, profile)
    v = db.exec(select(SoulVersion).where(SoulVersion.profile == profile, SoulVersion.version == version)).first()
    if v is None:
        raise not_found("version")
    return v.to_dict()


class WriteBody(BaseModel):
    content: str
    note: str = ""


def _write(request: Request, db: Session, p: Principal, profile: str, content: str, note: str, kind: str, extra: dict) -> SoulVersion:
    p.require_admin()
    _check_profile(request, p, profile)
    cli = _cli(request)
    cli.write_soul(profile, content)
    v = save_version(db, profile, content, member_id=p.member.id, note=note, company_id=p.company_id)
    db.commit()
    db.refresh(v)
    try:
        from ..events import record
        record(kind, "studio", f"profile:{profile}", {"version": v.version, "note": note, "chars": len(content), **extra},
               member_id=p.member.id, agent=profile, company_id=p.company_id, db=db)
        db.commit()
    except Exception as e:
        log.debug("event skipped: %s", e)
    return v


def write_versioned(request: Request, db: Session, p: Principal, profile: str, content: str, note: str = "") -> dict[str, Any]:
    """給其他模組（agents.put_soul）直接呼叫：寫 SOUL.md＋記版本。內容沒變就不新增版本（same:true）。"""
    last = _latest(db, profile)
    if last is not None and last.content == content and _cli(request).read_soul(profile) == content:
        return {**last.meta(), "same": True}
    v = _write(request, db, p, profile, content, note, "soul.write", {})
    return {**v.meta(), "same": False}


@router.put("/{profile}")
def write_soul(profile: str, body: WriteBody, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """寫入 SOUL.md 並記一版。內容與最新版相同時不新增版本（回 same:true）。"""
    return write_versioned(request, db, p, profile, body.content, body.note)


class SnapshotBody(BaseModel):
    note: str = "manual snapshot"


@router.post("/{profile}/snapshot")
def snapshot(profile: str, request: Request, body: Optional[SnapshotBody] = None, p: Principal = Depends(current_principal),
             db: Session = Depends(get_db)):
    """把檔案現況記成新版本（用在別的路徑改了 SOUL.md、出現漂移時）。"""
    p.require_admin()
    _check_profile(request, p, profile)
    content = _cli(request).read_soul(profile)
    last = _latest(db, profile)
    if last is not None and last.content == content:
        return {**last.meta(), "same": True}
    v = save_version(db, profile, content, member_id=p.member.id, note=(body.note if body else "manual snapshot"), company_id=p.company_id)
    db.commit()
    db.refresh(v)
    return {**v.meta(), "same": False}


class RollbackBody(BaseModel):
    version: int
    note: str = ""


@router.post("/{profile}/rollback")
def rollback(profile: str, body: RollbackBody, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """回滾＝把指定版本的內容寫回檔案並產生一個新版本（歷史不可變）。"""
    p.require_admin()
    _check_profile(request, p, profile)
    target = db.exec(select(SoulVersion).where(SoulVersion.profile == profile, SoulVersion.version == body.version)).first()
    if target is None:
        raise not_found("version")
    note = body.note or f"rollback to v{target.version}"
    v = _write(request, db, p, profile, target.content, note, "soul.rollback", {"from_version": target.version})
    return {**v.meta(), "rolled_back_to": target.version}


async def on_startup(app) -> None:
    try:
        n = snapshot_all(app.state.engine, app.state.cli)
        if n:
            log.info("soul_history: snapshot %d profile(s) as version 0", n)
    except Exception as e:
        log.warning("soul_history startup snapshot failed: %s", e)
