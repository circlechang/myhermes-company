"""安裝／移除套件（冪等）。

安裝做四件事：
1. profiles：套件帶 SOUL.md 而 ~/.hermes/profiles/<p>/ 不存在 → 建目錄＋複製 SOUL.md（存在就不動）
2. agents：每個 profile 在 agents 表找同 company 的列；有就綁定（順便啟用），沒有就建
3. workflows：每個階段的 workflows/*.json 匯入（description 帶 `source=pack:<name>` 標記），節點 agent → agent_id；
   同名既有的更新 nodes/edges（version +1），不重複建
4. installed_packs 記一列（重裝＝更新）
移除：刪套件建立的 workflows（含 runs／排程／webhook），刪 installed_packs 列；agents 與 profile 保留（人工資產不動）。
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any, Optional

from sqlmodel import Session, select

from ...models import Agent, Workflow, WorkflowApproval, WorkflowRun, WorkflowRunNode, WorkflowSchedule, WorkflowWebhook, now
from ...workflow_validate import WorkflowValidationError, validate_workflow
from .loader import Pack, PackError
from .models import InstalledPack

log = logging.getLogger("studio.packs.install")


def source_tag(pack: Pack) -> str:
    return f"source=pack:{pack.name}"


def workflow_name(pack: Pack, stage_id: str, wf_name: str) -> str:
    return f"[{pack.name}] {wf_name or stage_id}"


def ensure_profiles(pack: Pack, hermes_home: Path) -> list[str]:
    """把套件的 SOUL.md 複製到 ~/.hermes/profiles/（只建不存在的）。回本次建立的 profile 名單。"""
    created: list[str] = []
    for prof in pack.profiles:
        dest = hermes_home / "profiles" / prof
        soul = pack.soul_path(prof)
        if dest.exists():
            continue
        if soul is None:
            log.warning("pack %s: profile %s 不存在也沒帶 SOUL.md，只綁定 agent 列", pack.name, prof)
            continue
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(soul, dest / "SOUL.md")
        cfg = pack.path / "profiles" / prof / "config.yaml"
        if cfg.is_file():
            shutil.copyfile(cfg, dest / "config.yaml")
        created.append(prof)
    # skills：只複製到「本次新建」的 profile 的 skills/<s>/；使用者既有的 profile 完全不動（round3 決定）
    for skill in pack.skills:
        src = pack.path / "skills" / skill
        for prof in created:
            dst = hermes_home / "profiles" / prof / "skills" / skill
            if not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(src, dst)
    return created


def ensure_agents(db: Session, pack: Pack, company_id: str) -> dict[str, str]:
    """profile → agent id；既有就綁定並啟用，沒有就建。"""
    out: dict[str, str] = {}
    meta = {a["profile"]: a for a in pack.agents}
    for prof in pack.profiles:
        ag = db.exec(select(Agent).where(Agent.company_id == company_id, Agent.profile == prof)).first()
        info = meta.get(prof, {})
        if ag is None:
            ag = Agent(company_id=company_id, name=info.get("name") or prof, profile=prof, title=info.get("title") or "",
                       description=info.get("description") or "", enabled=True)
            db.add(ag)
            db.flush()
        else:
            changed = False
            if not ag.enabled:
                ag.enabled = True
                changed = True
            if not ag.title and info.get("title"):
                ag.title = info["title"]
                changed = True
            if changed:
                ag.updated_at = now()
                db.add(ag)
        out[prof] = ag.id
    return out


def _bind_nodes(nodes: list[dict[str, Any]], agents: dict[str, str]) -> list[dict[str, Any]]:
    out = []
    for n in nodes:
        n = dict(n)
        prof = n.get("agent") or n.get("profile")
        if prof and prof in agents:
            n["agent_id"] = agents[prof]
        out.append(n)
    return out


def ensure_workflows(db: Session, pack: Pack, company_id: str, agents: dict[str, str], member_id: str) -> dict[str, str]:
    """每個階段一個工作流；回 stage id → workflow id。"""
    out: dict[str, str] = {}
    for st in pack.stages:
        data = pack.workflow_data(st.workflow)
        w = data.get("workflow") or data
        nodes = _bind_nodes(w.get("nodes") or [], agents)
        edges = w.get("edges") or []
        try:
            validate_workflow(nodes, edges)
        except WorkflowValidationError as e:
            raise PackError(f"階段 {st.id} 的工作流不合法：{'; '.join(e.errors)}")
        name = workflow_name(pack, st.id, str(w.get("name") or st.title))
        desc = f"{source_tag(pack)} stage={st.id}"
        wf = db.exec(select(Workflow).where(Workflow.company_id == company_id, Workflow.name == name)).first()
        if wf is None:
            wf = Workflow(company_id=company_id, name=name, description=desc, profile=str(w.get("profile") or ""),
                          nodes_json=json.dumps(nodes, ensure_ascii=False), edges_json=json.dumps(edges, ensure_ascii=False),
                          viewport_json=json.dumps(w.get("viewport") or {}, ensure_ascii=False),
                          budget_json=json.dumps(w.get("budget") or {}, ensure_ascii=False), created_by=member_id)
        else:
            nj, ej = json.dumps(nodes, ensure_ascii=False), json.dumps(edges, ensure_ascii=False)
            if wf.nodes_json != nj or wf.edges_json != ej:
                wf.nodes_json, wf.edges_json, wf.version, wf.updated_at = nj, ej, wf.version + 1, now()
            wf.description = desc
        db.add(wf)
        db.flush()
        out[st.id] = wf.id
    return out


def install(db: Session, pack: Pack, *, company_id: str, member_id: str, hermes_home: Path) -> InstalledPack:
    created = ensure_profiles(pack, hermes_home)
    agents = ensure_agents(db, pack, company_id)
    wfs = ensure_workflows(db, pack, company_id, agents, member_id)
    row = db.exec(select(InstalledPack).where(InstalledPack.company_id == company_id, InstalledPack.name == pack.name)).first()
    if row is None:
        row = InstalledPack(company_id=company_id, name=pack.name, installed_by=member_id)
    else:
        prev = set(json.loads(row.profiles_created_json or "[]"))
        created = sorted(prev | set(created))
    row.version = pack.version
    row.updated_at = now()
    row.agents_json = json.dumps(agents, ensure_ascii=False)
    row.workflows_json = json.dumps(wfs, ensure_ascii=False)
    row.profiles_created_json = json.dumps(created, ensure_ascii=False)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def uninstall(db: Session, row: InstalledPack) -> dict[str, Any]:
    removed = 0
    for wf_id in json.loads(row.workflows_json or "{}").values():
        wf = db.get(Workflow, wf_id)
        if wf is None or wf.company_id != row.company_id:
            continue
        for r in db.exec(select(WorkflowRun).where(WorkflowRun.workflow_id == wf.id)).all():
            for n in db.exec(select(WorkflowRunNode).where(WorkflowRunNode.run_id == r.id)).all():
                db.delete(n)
            db.delete(r)
        for a in db.exec(select(WorkflowApproval).where(WorkflowApproval.workflow_id == wf.id)).all():
            db.delete(a)
        for s in db.exec(select(WorkflowSchedule).where(WorkflowSchedule.workflow_id == wf.id)).all():
            db.delete(s)
        for w in db.exec(select(WorkflowWebhook).where(WorkflowWebhook.workflow_id == wf.id)).all():
            db.delete(w)
        db.delete(wf)
        removed += 1
    db.delete(row)
    db.commit()
    return {"ok": True, "workflows_removed": removed}


def installed(db: Session, company_id: str, name: str) -> Optional[InstalledPack]:
    return db.exec(select(InstalledPack).where(InstalledPack.company_id == company_id, InstalledPack.name == name)).first()
