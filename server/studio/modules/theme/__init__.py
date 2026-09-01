"""M. 主題 — 每成員的外觀偏好（Studio DB）＋ 背景圖上傳。"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, current_principal, get_db
from ...errors import ApiError
from ...models import new_id, now

router = APIRouter(prefix="/theme", tags=["theme"])

DEFAULTS: dict[str, Any] = {
    "mode": "system",        # light | dark | system
    "style": "rounded",      # rounded | square
    "density": "comfortable",  # comfortable | compact
    "font_size": 16,         # px, 12..20（16 = 瀏覽器預設，介面大量使用 text-xs/sm，基準再小就看不清）
    "text_color": "",        # css color or ""
    "primary": "#4f46e5",    # css color
    "background_opacity": 0.12,
}
ALLOWED_IMAGE = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_BG_BYTES = 8 * 1024 * 1024


class ThemePref(SQLModel, table=True):
    __tablename__ = "theme_prefs"
    id: str = Field(default_factory=lambda: new_id("th"), primary_key=True)
    member_id: str = Field(index=True, unique=True)
    settings_json: str = "{}"
    background_file: str = ""
    updated_at: datetime = Field(default_factory=now)


def _bg_dir(request: Request) -> Path:
    d = Path(request.app.state.settings.db_path).expanduser().parent / "theme-backgrounds"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _row(db: Session, member_id: str) -> Optional[ThemePref]:
    return db.exec(select(ThemePref).where(ThemePref.member_id == member_id)).first()


def _public(row: Optional[ThemePref]) -> dict[str, Any]:
    data = dict(DEFAULTS)
    if row:
        try:
            data.update(json.loads(row.settings_json or "{}"))
        except json.JSONDecodeError:
            pass
    return {"settings": data, "has_background": bool(row and row.background_file),
            "updated_at": row.updated_at if row else None}


def _validate(s: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "mode" in s:
        if s["mode"] not in ("light", "dark", "system"):
            raise ApiError(400, "bad_request", "mode must be light|dark|system")
        out["mode"] = s["mode"]
    if "style" in s:
        if s["style"] not in ("rounded", "square"):
            raise ApiError(400, "bad_request", "style must be rounded|square")
        out["style"] = s["style"]
    if "density" in s:
        if s["density"] not in ("comfortable", "compact"):
            raise ApiError(400, "bad_request", "density must be comfortable|compact")
        out["density"] = s["density"]
    if "font_size" in s:
        try:
            fs = int(s["font_size"])
        except (TypeError, ValueError):
            raise ApiError(400, "bad_request", "font_size must be int")
        out["font_size"] = max(12, min(20, fs))
    for key in ("text_color", "primary"):
        if key in s:
            v = str(s[key] or "")
            if len(v) > 40 or ";" in v or "url(" in v.lower():
                raise ApiError(400, "bad_request", f"{key} invalid")
            out[key] = v
    if "background_opacity" in s:
        try:
            out["background_opacity"] = max(0.0, min(1.0, float(s["background_opacity"])))
        except (TypeError, ValueError):
            raise ApiError(400, "bad_request", "background_opacity must be number")
    return out


@router.get("")
def get_theme(db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    return _public(_row(db, p.member.id))


class ThemeBody(BaseModel):
    settings: dict[str, Any]


@router.put("")
def put_theme(body: ThemeBody, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    row = _row(db, p.member.id) or ThemePref(member_id=p.member.id)
    try:
        current = json.loads(row.settings_json or "{}")
    except json.JSONDecodeError:
        current = {}
    current.update(_validate(body.settings))
    row.settings_json = json.dumps(current)
    row.updated_at = now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _public(row)


@router.delete("")
def reset_theme(request: Request, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    row = _row(db, p.member.id)
    if row:
        if row.background_file:
            try:
                (_bg_dir(request) / row.background_file).unlink()
            except OSError:
                pass
        db.delete(row)
        db.commit()
    return _public(None)


@router.post("/background")
async def upload_background(request: Request, file: UploadFile = File(...), db: Session = Depends(get_db),
                            p: Principal = Depends(current_principal)):
    if (file.content_type or "") not in ALLOWED_IMAGE:
        raise ApiError(400, "bad_request", "只接受 png/jpeg/webp/gif")
    data = await file.read(MAX_BG_BYTES + 1)
    if len(data) > MAX_BG_BYTES:
        raise ApiError(413, "too_large", "背景圖不可超過 8MB")
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}[file.content_type]
    row = _row(db, p.member.id) or ThemePref(member_id=p.member.id)
    d = _bg_dir(request)
    if row.background_file:
        try:
            (d / row.background_file).unlink()
        except OSError:
            pass
    name = f"{p.member.id}-{int(now().timestamp())}{ext}"
    (d / name).write_bytes(data)
    row.background_file = name
    row.updated_at = now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _public(row)


@router.get("/background")
def get_background(request: Request, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    row = _row(db, p.member.id)
    if not row or not row.background_file:
        raise ApiError(404, "not_found", "no background")
    f = _bg_dir(request) / row.background_file
    if not f.is_file():
        raise ApiError(404, "not_found", "no background")
    return FileResponse(str(f))


@router.delete("/background")
def delete_background(request: Request, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    row = _row(db, p.member.id)
    if row and row.background_file:
        try:
            (_bg_dir(request) / row.background_file).unlink()
        except OSError:
            pass
        row.background_file = ""
        row.updated_at = now()
        db.add(row)
        db.commit()
        db.refresh(row)
    return _public(row)
