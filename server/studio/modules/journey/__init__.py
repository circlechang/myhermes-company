"""L. Journey 關係圖 — 以 skill / memory 檔案間的 wiki-link 與提及建圖。

節點：每個 skill（local + builtin）、每個記憶檔、記憶檔內每一條項目（bullet / 段落）。
邊：`[[name]]` wiki-link、`` `name` ``、或內文直接出現另一個 skill 名稱（≥4 字元，避免誤配）。
時間軸：節點 timestamp = 檔案 mtime（記憶條目沿用所屬檔案）。
可選 `merge_hermes=1`：把 `hermes journey --json` 的 edges 併入（同名節點）。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from starlette.concurrency import run_in_threadpool
from fastapi import APIRouter, Depends, Request

from ...auth import Principal, current_principal
from ...errors import ApiError
from ...hermes.cli import HermesCli
from ..memory import memories_dir
from ..skills import list_skills

router = APIRouter(prefix="/journey", tags=["journey"])
WIKI = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
TICK = re.compile(r"`([A-Za-z0-9][A-Za-z0-9_.-]{2,80})`")


def _memory_entries(text: str) -> list[str]:
    out: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line[:2] in ("- ", "* ") or re.match(r"^\d+[.)] ", line):
            line = re.sub(r"^(?:[-*]|\d+[.)])\s+", "", line)
        if len(line) >= 8:
            out.append(line)
    return out


def build_graph(cli: HermesCli, profile: str, include_entries: bool = True) -> dict[str, Any]:
    nodes: list[dict[str, Any]] = []
    texts: dict[str, str] = {}
    skills = list_skills(cli, profile)
    for s in skills:
        nid = f"skill:{s['name']}"
        nodes.append({"id": nid, "label": s["name"], "kind": "skill", "category": s["category"], "source": s["source"],
                      "enabled": s["enabled"], "timestamp": s["mtime"], "path": s["path"]})
        try:
            texts[nid] = (Path(s["path"]) / "SKILL.md").read_text(encoding="utf-8", errors="replace")
        except OSError:
            texts[nid] = ""
    mdir = memories_dir(cli, profile)
    if mdir.is_dir():
        for f in sorted(mdir.iterdir()):
            if not f.is_file() or f.name.startswith(".") or f.name.endswith(".lock") or ".bak" in f.name:
                continue
            fid = f"memory:{f.name}"
            text = f.read_text(encoding="utf-8", errors="replace")
            mtime = f.stat().st_mtime
            nodes.append({"id": fid, "label": f.name, "kind": "memory", "category": "memory", "timestamp": mtime, "path": str(f)})
            texts[fid] = text
            if include_entries:
                for i, entry in enumerate(_memory_entries(text)):
                    eid = f"{fid}#{i}"
                    nodes.append({"id": eid, "label": entry[:80], "kind": "memory_entry", "category": "memory",
                                  "timestamp": mtime, "parent": fid, "text": entry[:500]})
                    texts[eid] = entry
    by_label: dict[str, str] = {}
    for n in nodes:
        if n["kind"] in ("skill", "memory"):
            by_label[n["label"].lower()] = n["id"]
            if n["kind"] == "memory":
                by_label[Path(n["label"]).stem.lower()] = n["id"]
    skill_names = sorted(((n["label"], n["id"]) for n in nodes if n["kind"] == "skill" and len(n["label"]) >= 4),
                         key=lambda x: -len(x[0]))
    skill_by_lower = {name.lower(): sid for name, sid in skill_names}
    mention_re = (re.compile(r"(?<![a-z0-9_-])(?:" + "|".join(re.escape(n.lower()) for n, _ in skill_names) + r")(?![a-z0-9_-])")
                  if skill_names else None)  # 長名在前，避免短名搶先配對
    edges: dict[tuple[str, str], str] = {}

    def link(a: str, b: str, why: str) -> None:
        if a != b and (a, b) not in edges and (b, a) not in edges:
            edges[(a, b)] = why

    for nid, text in texts.items():
        if not text:
            continue
        for m in WIKI.finditer(text):
            tgt = by_label.get(m.group(1).strip().lower())
            if tgt:
                link(nid, tgt, "wikilink")
        for m in TICK.finditer(text):
            tgt = by_label.get(m.group(1).lower())
            if tgt:
                link(nid, tgt, "code")
        if mention_re is not None:
            # 一次掃描找出所有被提及的 skill（原本每篇文字 × 每個 skill 各跑一次 re.search，數百 skill × 數千條記憶會拖到數秒）
            for m in mention_re.finditer(text.lower()):
                sid = skill_by_lower[m.group(0)]
                if sid != nid:
                    link(nid, sid, "mention")
    for n in nodes:
        if n["kind"] == "memory_entry":
            link(n["id"], n["parent"], "contains")
    edge_list = [{"source": a, "target": b, "kind": why} for (a, b), why in edges.items()]
    cats: dict[str, int] = {}
    for n in nodes:
        cats[n["category"]] = cats.get(n["category"], 0) + 1
    ts = [n["timestamp"] for n in nodes if n["timestamp"]]
    return {"profile": profile, "nodes": nodes, "edges": edge_list,
            "categories": [{"name": k, "count": v} for k, v in sorted(cats.items())],
            "time_range": [min(ts) if ts else 0, max(ts) if ts else 0],
            "stats": {"nodes": len(nodes), "edges": len(edge_list), "skills": len(skills),
                      "linked": len({e["source"] for e in edge_list} | {e["target"] for e in edge_list})}}


@router.get("/graph")
async def graph(request: Request, profile: str = "default", entries: int = 1, merge_hermes: int = 0,
                p: Principal = Depends(current_principal)):
    cli: HermesCli = request.app.state.cli
    profile = profile or "default"
    if profile not in cli.list_profiles_fs():
        raise ApiError(404, "not_found", f"profile not found: {profile}")
    # build_graph 是純 CPU／檔案 I/O 的同步函式，放 threadpool 才不會卡住整個 event loop（聊天 WS 會一起停頓）
    g = await run_in_threadpool(build_graph, cli, profile, bool(entries))
    if merge_hermes:
        try:
            args = (["-p", profile] if profile != "default" else []) + ["journey", "--json"]
            raw = await cli._run(*args, timeout=40)
            data = json.loads(raw)
            ids = {n["id"] for n in g["nodes"]}
            added = 0
            existing = {(e["source"], e["target"]) for e in g["edges"]}
            for e in data.get("edges", []):
                a, b = f"skill:{e.get('source')}", f"skill:{e.get('target')}"
                if a in ids and b in ids and (a, b) not in existing and (b, a) not in existing:
                    g["edges"].append({"source": a, "target": b, "kind": "hermes"})
                    added += 1
            g["stats"]["hermes_edges"] = added
        except Exception as e:  # CLI missing or non-JSON: keep our own graph
            g["stats"]["hermes_error"] = str(e)[:200]
    return g
