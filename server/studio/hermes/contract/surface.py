"""surface.yaml 載入與結構驗證。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

KINDS = ("endpoint", "cli", "file", "db")
RISKS = ("low", "medium", "high")


@dataclass
class SurfaceItem:
    id: str
    kind: str
    risk: str
    affects: list[str]
    label: str = ""
    note: str = ""
    critical: bool = False
    raw: dict[str, Any] = field(default_factory=dict)

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)


@dataclass
class Surface:
    version: int
    hermes_tested: str
    modules: dict[str, str]
    items: list[SurfaceItem]

    def by_id(self, item_id: str) -> Optional[SurfaceItem]:
        return next((i for i in self.items if i.id == item_id), None)

    def by_kind(self, kind: str) -> list[SurfaceItem]:
        return [i for i in self.items if i.kind == kind]

    def modules_affected_by(self, ids: list[str]) -> list[str]:
        out: list[str] = []
        for i in self.items:
            if i.id in ids:
                for m in i.affects:
                    if m not in out:
                        out.append(m)
        return out


def surface_path() -> Path:
    return Path(__file__).with_name("surface.yaml")


def load_surface(path: Optional[Path] = None) -> Surface:
    p = Path(path) if path else surface_path()
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    items: list[SurfaceItem] = []
    seen: set[str] = set()
    for raw in data.get("items") or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            raise ValueError(f"surface item without id: {raw!r}")
        iid = str(raw["id"])
        if iid in seen:
            raise ValueError(f"duplicate surface id: {iid}")
        seen.add(iid)
        kind = str(raw.get("kind") or "")
        if kind not in KINDS:
            raise ValueError(f"{iid}: kind must be one of {KINDS}, got {kind!r}")
        risk = str(raw.get("risk") or "")
        if risk not in RISKS:
            raise ValueError(f"{iid}: risk must be one of {RISKS}, got {risk!r}")
        affects = raw.get("affects") or []
        if not isinstance(affects, list) or not affects:
            raise ValueError(f"{iid}: affects must be a non-empty list of module names")
        if kind == "endpoint" and not (raw.get("method") and raw.get("path")):
            raise ValueError(f"{iid}: endpoint needs method + path")
        if kind == "cli" and raw.get("argv") is None:
            raise ValueError(f"{iid}: cli needs argv")
        if kind in ("file", "db") and not raw.get("path"):
            raise ValueError(f"{iid}: {kind} needs path")
        items.append(SurfaceItem(id=iid, kind=kind, risk=risk, affects=[str(a) for a in affects],
                                 label=str(raw.get("label") or iid), note=str(raw.get("note") or ""),
                                 critical=bool(raw.get("critical", False)), raw=raw))
    return Surface(version=int(data.get("version") or 1), hermes_tested=str(data.get("hermes_tested") or ""),
                   modules={str(k): str(v) for k, v in (data.get("modules") or {}).items()}, items=items)
