"""報告組裝、判定與能力降級推導。"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from .surface import Surface

VERDICTS = ("compatible", "partial", "incompatible")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def build_report(surface: Surface, results: Iterable[Any], *, hermes: dict[str, Any], mode: dict[str, Any],
                 started: float, cleanups: Optional[list[str]] = None) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for r in results:
        it = surface.by_id(r.id)
        items.append({
            "id": r.id, "status": r.status, "reason": r.reason, "ms": r.ms,
            "kind": it.kind if it else "", "risk": it.risk if it else "", "label": it.label if it else r.id,
            "critical": bool(it and it.critical), "affects": list(it.affects) if it else [],
            "note": it.note if it else "", "detail": r.detail or {},
        })
    summary = summarize(items)
    return {
        "schema": 1,
        "surface_version": surface.version,
        "surface_hermes_tested": surface.hermes_tested,
        "hermes": hermes,
        "mode": mode,
        "started_at": datetime.fromtimestamp(started, timezone.utc).isoformat(timespec="seconds"),
        "finished_at": _now_iso(),
        "duration_ms": int((time.time() - started) * 1000),
        "summary": summary,
        "items": items,
        "cleanups": cleanups or [],
    }


def summarize(items: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {"pass": 0, "fail": 0, "skip": 0}
    for it in items:
        counts[it.get("status", "skip")] = counts.get(it.get("status", "skip"), 0) + 1
    failed = [it for it in items if it.get("status") == "fail"]
    return {
        **counts,
        "total": len(items),
        "verdict": verdict_of(items),
        "failed_ids": [it["id"] for it in failed],
        "affected_modules": affected_modules(items),
        "by_risk": {r: {"pass": sum(1 for i in items if i.get("risk") == r and i["status"] == "pass"),
                        "fail": sum(1 for i in items if i.get("risk") == r and i["status"] == "fail"),
                        "skip": sum(1 for i in items if i.get("risk") == r and i["status"] == "skip")}
                    for r in ("low", "medium", "high")},
    }


def verdict_of(items: list[dict[str, Any]]) -> str:
    failed = [it for it in items if it.get("status") == "fail"]
    if not failed:
        return "compatible"
    if any(it.get("critical") for it in failed):
        return "incompatible"
    return "partial"


def affected_modules(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """失敗項 → 受影響模組（每個模組列出失敗的接觸面 id）。"""
    out: dict[str, list[str]] = {}
    for it in items:
        if it.get("status") != "fail":
            continue
        for m in it.get("affects") or []:
            out.setdefault(m, []).append(it["id"])
    return [{"module": m, "failed": ids} for m, ids in sorted(out.items())]


def capabilities(report: Optional[dict[str, Any]], surface: Optional[Surface] = None) -> dict[str, Any]:
    """由最近一次契約測試推導：每個 Studio 模組可不可用、缺哪些接觸面。

    沒有報告 → 全部 unknown（不阻擋任何功能）。
    模組只要有一個 affects 它的項目 fail 就標 degraded；critical 的項目 fail 標 unavailable。
    """
    from .surface import load_surface
    surface = surface or load_surface()
    mods: dict[str, dict[str, Any]] = {m: {"module": m, "description": d, "status": "unknown", "missing": [], "degraded": []}
                                       for m, d in surface.modules.items()}
    if not report:
        return {"source": None, "modules": list(mods.values())}
    for m in mods.values():
        m["status"] = "available"
    for it in report.get("items") or []:
        for m in it.get("affects") or []:
            entry = mods.setdefault(m, {"module": m, "description": "", "status": "available", "missing": [], "degraded": []})
            if it.get("status") == "fail":
                if it.get("critical"):
                    entry["status"] = "unavailable"
                    entry["missing"].append(it["id"])
                else:
                    if entry["status"] != "unavailable":
                        entry["status"] = "degraded"
                    entry["degraded"].append(it["id"])
    return {"source": {"finished_at": report.get("finished_at"), "verdict": (report.get("summary") or {}).get("verdict"),
                       "hermes_version": (report.get("hermes") or {}).get("version")},
            "modules": list(mods.values())}
