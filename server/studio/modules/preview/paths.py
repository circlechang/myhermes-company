"""統一預覽的路徑白名單。

一個 `path` 參數同時吃兩種寫法：

1. **絕對路徑**（`/...` 或 `~/...`）— 沿用聊天模組的規則：
   uploads/<company>、Hermes workspace、檔案瀏覽器的允許根、
   或「這位成員讀得到的訊息內文裡原文出現過」的路徑。
2. **虛擬路徑**（`workspace/a/b`、`profile:researcher/SOUL.md`、`uploads/...`）—
   沿用檔案瀏覽器 `modules.files.paths.resolve` 的根目錄限定。

兩條路徑都先 `resolve()` 再比對根，所以 symlink 與 `..` 都逃不出去。
比對失敗一律 404（不透露檔案存不存在）。
"""
from __future__ import annotations

from pathlib import Path

from fastapi import Request
from sqlmodel import Session

from ...auth import Principal
from ...errors import ApiError, not_found
from ..chat.files import _is_under, _mentioned_in_messages, upload_root, workspace_root
from ..files.paths import list_roots, resolve as resolve_virtual


def _file_roots(request: Request) -> list[Path]:
    """檔案瀏覽器公開的根目錄（workspace / profiles / uploads / STUDIO_FILE_ROOTS）。"""
    try:
        roots = list_roots(request.app.state.cli, request.app.state.settings.db_path)
    except Exception:
        return []
    out: list[Path] = []
    for r in roots:
        try:
            out.append(r.path.resolve())
        except OSError:
            continue
    return out


def allowed_roots(request: Request, p: Principal) -> list[Path]:
    settings = request.app.state.settings
    roots: list[Path] = []
    for candidate in (upload_root(settings) / p.company_id, workspace_root(settings)):
        try:
            roots.append(candidate.resolve())
        except OSError:
            continue
    roots.extend(_file_roots(request))
    return roots


def resolve_absolute(request: Request, db: Session, p: Principal, raw: str) -> Path:
    path = Path(raw).expanduser()
    try:
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):
        raise not_found("file")
    if not real.is_file():
        raise not_found("file")
    if any(_is_under(real, r) for r in allowed_roots(request, p)):
        return real
    if _mentioned_in_messages(db, p, raw) or (str(real) != raw and _mentioned_in_messages(db, p, str(real))):
        return real
    raise not_found("file")


def resolve_preview_path(request: Request, db: Session, p: Principal, raw: str) -> Path:
    """把使用者給的 path（絕對或虛擬）解析成一個確定可讀的實體檔案。"""
    raw = (raw or "").strip()
    if not raw:
        raise not_found("file")
    if "\x00" in raw:
        raise ApiError(400, "bad_path", "invalid character in path")
    if raw.startswith(("/", "~")):
        return resolve_absolute(request, db, p, raw)
    # 虛擬路徑：檔案瀏覽器的根目錄限定（自己會擋 '..' 與逃出根）
    try:
        roots = list_roots(request.app.state.cli, request.app.state.settings.db_path)
    except Exception:
        raise not_found("file")
    _, target, _ = resolve_virtual(roots, raw)
    if not target.is_file():
        raise not_found("file")
    return target


__all__ = ["resolve_preview_path", "resolve_absolute", "allowed_roots"]
