"""I. 檔案瀏覽器 — 本機路徑瀏覽／上傳／下載／編輯，根目錄限定，防路徑穿越。

Docker / SSH / Singularity 後端不做：本產品定位單機部署，只操作本機檔案系統。
"""
from __future__ import annotations

import mimetypes
import shutil
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ...auth import Principal, current_principal
from ...errors import ApiError
from .paths import Root, list_roots, resolve, to_virtual

router = APIRouter(prefix="/files", tags=["files"])

MAX_TEXT_BYTES = 2 * 1024 * 1024
TEXT_EXT = {".md", ".txt", ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
            ".env", ".sh", ".zsh", ".bash", ".html", ".htm", ".css", ".csv", ".tsv", ".xml", ".svg", ".log", ".sql",
            ".rs", ".go", ".java", ".c", ".h", ".cpp", ".hpp", ".rb", ".php", ".lua", ".r", ".jsonl", ".mjs", ".cjs"}


def _roots(request: Request) -> list[Root]:
    return list_roots(request.app.state.cli, request.app.state.settings.db_path)


def _ensure_writable(root: Root, p: Principal) -> None:
    if not root.writable_by_member and p.role not in ("owner", "admin"):
        raise ApiError(403, "forbidden", "此根目錄僅 owner/admin 可寫入")


def _stat_entry(root: Root, path: Path) -> dict:
    try:
        st = path.stat()
    except OSError:
        return {"name": path.name, "path": to_virtual(root, path), "kind": "missing", "size": 0, "mtime": 0}
    return {
        "name": path.name,
        "path": to_virtual(root, path),
        "kind": "dir" if path.is_dir() else "file",
        "size": st.st_size if path.is_file() else 0,
        "mtime": st.st_mtime,
        "ext": path.suffix.lower(),
    }


def is_probably_text(path: Path, sample: bytes) -> bool:
    if path.suffix.lower() in TEXT_EXT or path.name in ("SOUL.md", "Dockerfile", "Makefile"):
        return b"\x00" not in sample
    if not sample:
        return True
    if b"\x00" in sample:
        return False
    try:
        sample.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


@router.get("/roots")
def roots(request: Request, p: Principal = Depends(current_principal)):
    out = []
    for r in _roots(request):
        out.append({"id": r.id, "label": r.label, "kind": r.kind, "exists": r.path.is_dir(),
                    "writable": r.writable_by_member or p.role in ("owner", "admin")})
    return out


@router.get("/list")
def list_dir(request: Request, path: str, p: Principal = Depends(current_principal)):
    root, target, rel = resolve(_roots(request), path)
    if not target.exists():
        raise ApiError(404, "not_found", "directory not found")
    if not target.is_dir():
        raise ApiError(400, "not_a_directory", "path is not a directory")
    entries = []
    for child in sorted(target.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
        entries.append(_stat_entry(root, child))
    parent = to_virtual(root, target.parent) if rel else None
    return {"path": to_virtual(root, target), "root": root.id, "parent": parent, "entries": entries}


@router.get("/read")
def read_file(request: Request, path: str, p: Principal = Depends(current_principal)):
    root, target, _ = resolve(_roots(request), path)
    if not target.is_file():
        raise ApiError(404, "not_found", "file not found")
    st = target.stat()
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    with target.open("rb") as f:
        sample = f.read(min(st.st_size, 4096))
    text = is_probably_text(target, sample)
    body: dict = {"path": to_virtual(root, target), "name": target.name, "size": st.st_size, "mtime": st.st_mtime,
                  "mime": mime, "binary": not text, "truncated": False, "content": None}
    if text:
        if st.st_size > MAX_TEXT_BYTES:
            body["truncated"] = True
            body["content"] = target.read_bytes()[:MAX_TEXT_BYTES].decode("utf-8", "replace")
        else:
            body["content"] = target.read_text(encoding="utf-8", errors="replace")
    return body


class WriteBody(BaseModel):
    path: str
    content: str


@router.put("/write")
def write_file(body: WriteBody, request: Request, p: Principal = Depends(current_principal)):
    root, target, rel = resolve(_roots(request), body.path)
    _ensure_writable(root, p)
    if not rel:
        raise ApiError(400, "bad_path", "cannot write to a root")
    if target.is_dir():
        raise ApiError(400, "is_directory", "path is a directory")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return _stat_entry(root, target)


class PathBody(BaseModel):
    path: str


@router.post("/mkdir")
def mkdir(body: PathBody, request: Request, p: Principal = Depends(current_principal)):
    root, target, rel = resolve(_roots(request), body.path)
    _ensure_writable(root, p)
    if not rel:
        raise ApiError(400, "bad_path", "root already exists")
    if target.exists():
        raise ApiError(409, "exists", "already exists")
    target.mkdir(parents=True)
    return _stat_entry(root, target)


class RenameBody(BaseModel):
    path: str
    new_name: str


@router.post("/rename")
def rename(body: RenameBody, request: Request, p: Principal = Depends(current_principal)):
    root, target, rel = resolve(_roots(request), body.path)
    _ensure_writable(root, p)
    if not rel or not target.exists():
        raise ApiError(404, "not_found", "source not found")
    name = body.new_name.strip()
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise ApiError(400, "bad_name", "invalid name")
    dest = target.parent / name
    if dest.exists():
        raise ApiError(409, "exists", "target already exists")
    target.rename(dest)
    return _stat_entry(root, dest)


class MoveBody(BaseModel):
    path: str
    dest: str  # virtual path of destination directory


def _move_or_copy(request: Request, p: Principal, body: MoveBody, copy: bool) -> dict:
    roots = _roots(request)
    src_root, src, src_rel = resolve(roots, body.path)
    dst_root, dst_dir, _ = resolve(roots, body.dest)
    _ensure_writable(dst_root, p)
    if not copy:
        _ensure_writable(src_root, p)
    if not src_rel or not src.exists():
        raise ApiError(404, "not_found", "source not found")
    if not dst_dir.is_dir():
        raise ApiError(400, "not_a_directory", "destination is not a directory")
    dest = dst_dir / src.name
    if dest.exists():
        raise ApiError(409, "exists", "target already exists")
    if src.is_dir() and dest.resolve().is_relative_to(src.resolve()):
        raise ApiError(400, "bad_path", "cannot move a directory into itself")
    if copy:
        if src.is_dir():
            shutil.copytree(src, dest)
        else:
            shutil.copy2(src, dest)
    else:
        shutil.move(str(src), str(dest))
    return _stat_entry(dst_root, dest)


@router.post("/copy")
def copy(body: MoveBody, request: Request, p: Principal = Depends(current_principal)):
    return _move_or_copy(request, p, body, copy=True)


@router.post("/move")
def move(body: MoveBody, request: Request, p: Principal = Depends(current_principal)):
    return _move_or_copy(request, p, body, copy=False)


@router.delete("")
def delete(request: Request, path: str, p: Principal = Depends(current_principal)):
    root, target, rel = resolve(_roots(request), path)
    _ensure_writable(root, p)
    if not rel:
        raise ApiError(400, "bad_path", "cannot delete a root")
    if not target.exists():
        raise ApiError(404, "not_found", "not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"ok": True}


@router.post("/upload")
async def upload(request: Request, path: str, file: UploadFile = File(...), p: Principal = Depends(current_principal)):
    root, target_dir, _ = resolve(_roots(request), path)
    _ensure_writable(root, p)
    target_dir.mkdir(parents=True, exist_ok=True)
    if not target_dir.is_dir():
        raise ApiError(400, "not_a_directory", "destination is not a directory")
    name = Path(file.filename or "upload.bin").name
    if name in (".", "..") or not name:
        raise ApiError(400, "bad_name", "invalid file name")
    dest = target_dir / name
    if dest.exists():
        stem, suf = dest.stem, dest.suffix
        dest = target_dir / f"{stem}-{int(time.time())}{suf}"
    with dest.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            out.write(chunk)
    return _stat_entry(root, dest)


@router.get("/download")
def download(request: Request, path: str, p: Principal = Depends(current_principal)):
    _, target, _ = resolve(_roots(request), path)
    if not target.is_file():
        raise ApiError(404, "not_found", "file not found")
    return FileResponse(str(target), filename=target.name)


@router.post("/attach")
def attach(body: PathBody, request: Request, p: Principal = Depends(current_principal)):
    """Return a workspace:// link the chat module can attach to a message."""
    root, target, rel = resolve(_roots(request), body.path)
    if not target.exists():
        raise ApiError(404, "not_found", "not found")
    return {"uri": f"workspace://{root.id}/{rel}", "abs_path": str(target), "name": target.name}
