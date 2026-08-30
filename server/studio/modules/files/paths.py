"""Root-confined path resolution shared by files / skills / memory / logs / terminal.

A *virtual path* looks like ``<root_id>/<relative/path>``. Root ids:
- ``workspace``        → ``$HERMES_HOME/workspace``
- ``profile:<name>``   → the profile directory (``$HERMES_HOME`` for default)
- ``uploads``          → ``<studio db dir>/uploads``
- extra roots from ``STUDIO_FILE_ROOTS="label=/abs/path,label2=/abs/path2"``

Every resolved path must stay inside its root (symlinks resolved) — otherwise
``ApiError(400, "path_traversal")``.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from ...errors import ApiError
from ...hermes.cli import HermesCli


@dataclass(frozen=True)
class Root:
    id: str
    label: str
    path: Path
    kind: str  # workspace | profile | uploads | extra
    writable_by_member: bool = True


def extra_roots() -> list[Root]:
    raw = os.environ.get("STUDIO_FILE_ROOTS", "")
    out: list[Root] = []
    for part in raw.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        label, p = part.split("=", 1)
        label = label.strip()
        path = Path(p.strip()).expanduser()
        if label and path.is_dir():
            out.append(Root(id=f"extra:{label}", label=label, path=path, kind="extra"))
    return out


def list_roots(cli: HermesCli, db_path: Path) -> list[Root]:
    roots = [Root(id="workspace", label="Hermes workspace", path=cli.home / "workspace", kind="workspace")]
    for name in cli.list_profiles_fs():
        roots.append(Root(id=f"profile:{name}", label=f"profile {name}", path=cli.profile_dir(name), kind="profile",
                          writable_by_member=False))
    roots.append(Root(id="uploads", label="Studio uploads", path=Path(db_path).expanduser().parent / "uploads", kind="uploads"))
    roots.extend(extra_roots())
    return roots


def split_virtual(vpath: str) -> tuple[str, str]:
    vpath = (vpath or "").strip().lstrip("/")
    if not vpath:
        raise ApiError(400, "bad_path", "path is required")
    root_id, _, rel = vpath.partition("/")
    return root_id, rel


def _check_rel(rel: str) -> None:
    if "\x00" in rel:
        raise ApiError(400, "bad_path", "invalid character in path")
    for part in rel.replace("\\", "/").split("/"):
        if part == "..":
            raise ApiError(400, "path_traversal", "'..' is not allowed")
    if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
        raise ApiError(400, "path_traversal", "absolute paths are not allowed")


def resolve(roots: list[Root], vpath: str) -> tuple[Root, Path, str]:
    """Return (root, absolute path, relative) for a virtual path, or raise."""
    root_id, rel = split_virtual(vpath)
    root = next((r for r in roots if r.id == root_id), None)
    if root is None:
        raise ApiError(404, "root_not_found", f"unknown root: {root_id}")
    _check_rel(rel)
    base = root.path.resolve()
    target = (root.path / rel).resolve() if rel else base
    try:
        target.relative_to(base)
    except ValueError:
        raise ApiError(400, "path_traversal", "path escapes its root")
    return root, target, rel


def to_virtual(root: Root, target: Path) -> str:
    try:
        rel = target.resolve().relative_to(root.path.resolve())
    except ValueError:
        return root.id
    return f"{root.id}/{rel.as_posix()}" if str(rel) != "." else root.id
