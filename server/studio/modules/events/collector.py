"""定期把其他模組落庫的新資料補記成 events（沒有 hook 可攔，所以用掃描；簡單可靠）。

來源與水位：
- chat：messages(role=assistant, run_id 非空) → kind=chat.run，subject=message:<id>，agent=session 的 profile，payload 含 usage / 字數
- workflow：workflow_runs 已開始（started_at）→ workflow.run.started；workflow_run_nodes 已結束 → workflow.node.completed（causes=該 run.started）；
  workflow_runs 已結束（finished_at 非空）→ kind=workflow.run，subject=run:<id>（causes=run.started＋各節點）
- approval：workflow_approvals 建立 → approval.requested（causes=run.started）；已決定 → approval.decided（causes=approval.requested）
- groupchat：room_messages → kind=groupchat.message，subject=room_message:<id>（AI 回覆 depth>0 時 causes=同房前一則）
- chat：causes=同 session 前一筆 chat.run
- kanban：`hermes kanban list --json` 的 status 與上次快照比對 → kind=kanban.status，subject=task:<id>

每個來源的水位存在 event_cursors；另外用 (kind, subject) 查重，重啟或水位重算都不會重複。
`collect_sync(engine, cli=None)` 給測試直接呼叫。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Optional

from sqlmodel import Session, select

from ...models import Agent, ChatSession, Member, Message, WorkflowApproval, WorkflowRun, WorkflowRunNode, now
from .kinds import next_seq, normalize_kind
from .models import Event, EventCursor

log = logging.getLogger("studio.events.collector")


def _cursor(db: Session, source: str) -> EventCursor:
    c = db.get(EventCursor, source)
    if c is None:
        c = EventCursor(source=source)
        db.add(c)
    return c


def _exists(db: Session, kind: str, subject: str) -> bool:
    return db.exec(select(Event.id).where(Event.kind == kind, Event.subject == subject)).first() is not None


def _find_id(db: Session, kind: str, subject: str) -> Optional[str]:
    return db.exec(select(Event.id).where(Event.kind == kind, Event.subject == subject)).first()


def _add(db: Session, **kw) -> bool:
    """寫一筆（同 kind+subject 已有就跳過）。`causes` 是上游事件 id 清單（None 會濾掉）。"""
    kw["kind"] = normalize_kind(kw["kind"])
    if _exists(db, kw["kind"], kw["subject"]):
        return False
    payload = kw.pop("payload", {})
    causes = [c for c in (kw.pop("causes", None) or []) if c]
    ev = Event(payload_json=json.dumps(payload, ensure_ascii=False, default=str), causes_json=json.dumps(causes), seq=next_seq(db), **kw)
    db.add(ev)
    db.flush()
    return True


def _loads(s: Optional[str]) -> Any:
    try:
        return json.loads(s) if s else None
    except ValueError:
        return None


def collect_chat(db: Session) -> int:
    cur = _cursor(db, "chat")
    q = select(Message).where(Message.role == "assistant", Message.run_id.isnot(None))
    if cur.last_ts:
        q = q.where(Message.created_at >= cur.last_ts)
    n = 0
    last = cur.last_ts
    for m in db.exec(q.order_by(Message.created_at)).all():
        sess = db.get(ChatSession, m.session_id)
        agent = db.get(Agent, sess.agent_id) if sess and sess.agent_id else None
        source = "chat" if not sess else ("workflow" if sess.source == "workflow" else ("coding" if sess.source.startswith("coding") else "chat"))
        prev = db.exec(select(Message.id).where(Message.session_id == m.session_id, Message.role == "assistant",
                                                Message.run_id.isnot(None), Message.created_at < m.created_at)
                       .order_by(Message.created_at.desc())).first()
        if _add(db, ts=m.created_at, kind="chat.run", source=source, subject=f"message:{m.id}",
                agent=(agent.profile if agent else ""), member_id=(sess.member_id if sess else ""),
                company_id=(sess.company_id if sess else ""),
                causes=[_find_id(db, "chat.run", f"message:{prev}")] if prev else [],
                payload={"session_id": m.session_id, "run_id": m.run_id, "chars": len(m.content or ""),
                         "usage": _loads(m.usage), "excerpt": (m.content or "")[:200]}):
            n += 1
        last = m.created_at if (last is None or m.created_at > last) else last
    cur.last_ts = last
    cur.updated_at = now()
    db.add(cur)
    return n


def _run_started_id(db: Session, run_id: str) -> Optional[str]:
    return _find_id(db, "workflow.run.started", f"run:{run_id}")


def collect_workflows(db: Session) -> int:
    n = 0
    # 1) run 開始（因果鏈的根）
    cur0 = _cursor(db, "workflow_started")
    q0 = select(WorkflowRun).where(WorkflowRun.started_at.isnot(None))
    if cur0.last_ts:
        q0 = q0.where(WorkflowRun.started_at >= cur0.last_ts)
    last0 = cur0.last_ts
    for r in db.exec(q0.order_by(WorkflowRun.started_at)).all():
        parent = _find_id(db, "workflow.run", f"run:{r.parent_run_id}") if r.parent_run_id else None
        if _add(db, ts=r.started_at or r.created_at, kind="workflow.run.started", source="workflow", subject=f"run:{r.id}",
                member_id=r.created_by or "", company_id=r.company_id, causes=[parent] if parent else [],
                payload={"workflow_id": r.workflow_id, "workflow_name": r.workflow_name, "trigger": r.trigger,
                         "parent_run_id": r.parent_run_id}):
            n += 1
        if r.started_at and (last0 is None or r.started_at > last0):
            last0 = r.started_at
    cur0.last_ts = last0
    cur0.updated_at = now()
    db.add(cur0)
    # 2) 節點完成（causes = 該 run.started）
    cur1 = _cursor(db, "workflow_node")
    q1 = select(WorkflowRunNode).where(WorkflowRunNode.finished_at.isnot(None))
    if cur1.last_ts:
        q1 = q1.where(WorkflowRunNode.finished_at >= cur1.last_ts)
    last1 = cur1.last_ts
    for nd in db.exec(q1.order_by(WorkflowRunNode.finished_at)).all():
        run = db.get(WorkflowRun, nd.run_id)
        if _add(db, ts=nd.finished_at or nd.started_at or now(), kind="workflow.node.completed", source="workflow",
                subject=f"run_node:{nd.run_id}:{nd.node_id}:{nd.attempt}",
                member_id=(run.created_by if run else "") or "", company_id=(run.company_id if run else ""),
                causes=[_run_started_id(db, nd.run_id)],
                payload={"run_id": nd.run_id, "node_id": nd.node_id, "node_kind": nd.kind, "status": nd.status, "attempt": nd.attempt,
                         "workflow_name": run.workflow_name if run else "", "error": nd.error, "usage": _loads(nd.usage_json),
                         "excerpt": (nd.output or "")[:200]}):
            n += 1
        if nd.finished_at and (last1 is None or nd.finished_at > last1):
            last1 = nd.finished_at
    cur1.last_ts = last1
    cur1.updated_at = now()
    db.add(cur1)
    # 3) 審批建立（causes = run.started）
    cur3 = _cursor(db, "approval_requested")
    q3 = select(WorkflowApproval)
    if cur3.last_ts:
        q3 = q3.where(WorkflowApproval.created_at >= cur3.last_ts)
    last3 = cur3.last_ts
    for a in db.exec(q3.order_by(WorkflowApproval.created_at)).all():
        if _add(db, ts=a.created_at, kind="approval.requested", source="workflow", subject=f"approval:{a.id}",
                company_id=a.company_id, causes=[_run_started_id(db, a.run_id)],
                payload={"run_id": a.run_id, "workflow_name": a.workflow_name, "node_id": a.node_id, "node_title": a.node_title}):
            n += 1
        if a.created_at and (last3 is None or a.created_at > last3):
            last3 = a.created_at
    cur3.last_ts = last3
    cur3.updated_at = now()
    db.add(cur3)
    # 4) run 結束（causes = run.started + 該 run 的節點完成）
    cur = _cursor(db, "workflow")
    q = select(WorkflowRun).where(WorkflowRun.finished_at.isnot(None))
    if cur.last_ts:
        q = q.where(WorkflowRun.finished_at >= cur.last_ts)
    last = cur.last_ts
    for r in db.exec(q.order_by(WorkflowRun.finished_at)).all():
        node_ids = db.exec(select(Event.id).where(Event.kind == "workflow.node.completed",
                                                   Event.subject.like(f"run_node:{r.id}:%")).order_by(Event.seq)).all()
        if _add(db, ts=r.finished_at or r.created_at, kind="workflow.run", source="workflow", subject=f"run:{r.id}",
                member_id=r.created_by or "", company_id=r.company_id,
                causes=[_run_started_id(db, r.id), *node_ids],
                payload={"workflow_id": r.workflow_id, "workflow_name": r.workflow_name, "status": r.status,
                         "trigger": r.trigger, "usage": _loads(r.usage_json), "error": r.error}):
            n += 1
        if r.finished_at and (last is None or r.finished_at > last):
            last = r.finished_at
    cur.last_ts = last
    cur.updated_at = now()
    db.add(cur)
    # 5) 審批決定（causes = approval.requested）
    cur2 = _cursor(db, "approval")
    q2 = select(WorkflowApproval).where(WorkflowApproval.decided_at.isnot(None))
    if cur2.last_ts:
        q2 = q2.where(WorkflowApproval.decided_at >= cur2.last_ts)
    last2 = cur2.last_ts
    for a in db.exec(q2.order_by(WorkflowApproval.decided_at)).all():
        if _add(db, ts=a.decided_at or a.created_at, kind="approval.decided", source="workflow", subject=f"approval:{a.id}",
                member_id=a.decided_by or "", company_id=a.company_id, decision=a.status,
                causes=[_find_id(db, "approval.requested", f"approval:{a.id}")],
                payload={"run_id": a.run_id, "workflow_name": a.workflow_name, "node_title": a.node_title, "comment": a.comment}):
            n += 1
        if a.decided_at and (last2 is None or a.decided_at > last2):
            last2 = a.decided_at
    cur2.last_ts = last2
    cur2.updated_at = now()
    db.add(cur2)
    return n


def collect_groupchat(db: Session) -> int:
    try:
        from ..groupchat.models import Room, RoomMember, RoomMessage
    except Exception:
        return 0
    cur = _cursor(db, "groupchat")
    q = select(RoomMessage)
    if cur.last_ts:
        q = q.where(RoomMessage.created_at >= cur.last_ts)
    n = 0
    last = cur.last_ts
    for m in db.exec(q.order_by(RoomMessage.created_at)).all():
        room = db.get(Room, m.room_id)
        rm = db.get(RoomMember, m.sender_id) if m.sender_id else None
        causes: list[Optional[str]] = []
        if m.depth > 0 or m.sender_kind == "ai":
            prev = db.exec(select(RoomMessage.id).where(RoomMessage.room_id == m.room_id, RoomMessage.seq < m.seq)
                           .order_by(RoomMessage.seq.desc())).first()
            if prev:
                causes = [_find_id(db, "groupchat.message", f"room_message:{prev}")]
        if _add(db, ts=m.created_at, kind="groupchat.message", source="groupchat", subject=f"room_message:{m.id}", causes=causes,
                agent=(rm.profile if rm and rm.kind == "ai" else ""), member_id=(rm.member_id if rm and rm.kind == "human" else "") or "",
                company_id=(room.company_id if room else ""),
                payload={"room_id": m.room_id, "room": room.name if room else "", "sender": m.sender_name, "sender_kind": m.sender_kind,
                         "excerpt": (m.content or "")[:200], "depth": m.depth, "status": m.status}):
            n += 1
        last = m.created_at if (last is None or m.created_at > last) else last
    cur.last_ts = last
    cur.updated_at = now()
    db.add(cur)
    return n


def collect_kanban(db: Session, tasks: list[dict[str, Any]]) -> int:
    """比對看板卡的 status 與上次快照；第一次執行只建快照（避免把整個歷史灌成事件）。"""
    cur = _cursor(db, "kanban")
    prev: dict[str, str] = _loads(cur.state_json) or {}
    first = not prev and cur.last_ts is None
    n = 0
    seen: dict[str, str] = {}
    ts = now()
    for t in tasks:
        tid = str(t.get("id") or "")
        st = str(t.get("status") or "")
        if not tid:
            continue
        seen[tid] = st
        if first:
            continue
        old = prev.get(tid)
        if old == st:
            continue
        stamp = ts.strftime("%Y%m%d%H%M%S")
        if _add(db, ts=ts, kind="kanban.status", source="kanban", subject=f"task:{tid}:{st}:{stamp}",
                agent=str(t.get("assignee") or ""),
                payload={"task_id": tid, "title": t.get("title"), "from": old, "to": st, "priority": t.get("priority")}):
            n += 1
    cur.state_json = json.dumps(seen, ensure_ascii=False)
    cur.last_ts = ts
    cur.updated_at = ts
    db.add(cur)
    return n


def collect_sync(engine, kanban_tasks: Optional[list[dict[str, Any]]] = None) -> int:
    n = 0
    with Session(engine) as db:
        for fn in (collect_chat, collect_workflows, collect_groupchat):
            try:
                n += fn(db)
            except Exception as e:
                log.warning("collector %s failed: %s", fn.__name__, e)
                db.rollback()
        if kanban_tasks is not None:
            try:
                n += collect_kanban(db, kanban_tasks)
            except Exception as e:
                log.warning("collector kanban failed: %s", e)
                db.rollback()
        db.commit()
    return n


async def collect(app) -> int:
    tasks = None
    cli = getattr(app.state, "cli", None)
    if cli is not None:
        try:
            tasks = await cli.kanban_list()
        except Exception as e:
            log.debug("kanban list unavailable for collector: %s", e)
    return collect_sync(app.state.engine, tasks)
