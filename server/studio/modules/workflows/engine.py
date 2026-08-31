"""Workflow executor (asyncio, in-process).

Scheduling model
- Every node starts `pending`. A node is dispatched when all incoming (non loop_back) edges are
  *resolved* (source finished) and at least one is *taken*. If all are resolved and none taken the node
  is `skipped` (which propagates). Roots are dispatched immediately. Independent ready nodes run in
  parallel as asyncio tasks.
- Edge decision (after source finishes): on=always → taken; success → taken iff source succeeded;
  failure → taken iff source failed. condition nodes add branch handle true/false; loop nodes body/exit.
- loop_back edge taken → reset the loop body (see workflow_validate.loop_body) and re-enter the loop node.
- gate → pending approval; approve continues with upstream text; reject re-runs the direct upstream
  nodes with the comment appended as [退回意見].
- Budget (max_tokens / max_cost_usd) and deadline_seconds stop the run (status budget_exceeded / timeout).
- Every state change is persisted (WorkflowRun.node_states_json + workflow_run_nodes rows + events_json)
  and broadcast on the hub; the run row is the frozen snapshot used for replay.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from sqlmodel import Session, select

from ...hermes.gateway import GatewayClient, GatewayError
from ...models import (Agent, ChatSession, Message, Workflow, WorkflowApproval, WorkflowRun, WorkflowRunNode, new_id, now)
from ...workflow_validate import loop_body, node_kind
from . import doc_nodes, runners
from .conditions import evaluate_rule, parse_yes_no
from .hub import WorkflowHub

log = logging.getLogger("studio.workflows.engine")

DONE = {"completed", "failed", "skipped", "reused", "stopped", "outcome_unknown"}
TERMINAL_RUN = {"completed", "failed", "stopped", "timeout", "budget_exceeded", "needs_attention"}
SYSTEM_PROMPT = ("你在執行工作流「{wf}」的節點「{node}」。只做本節點任務，不要重做上游已完成的工作；"
                 "直接輸出可交給下游使用的結果，不要寒暄。")

# --- spill：節點輸出超過門檻就整份寫工作區，下游與快照只帶 head/tail + 路徑 ---
SPILL_LIMIT = int(os.environ.get("STUDIO_WF_SPILL_BYTES") or 32 * 1024)
SPILL_HEAD = 4 * 1024
SPILL_TAIL = 2 * 1024

# --- done_check：節點結構化自檢 ---
DONE_CHECK_SUFFIX = ("\n\n[自檢]\n完成本節點任務後，最後一定要附一段 JSON 程式碼區塊回報狀態（只能是這三種之一）：\n"
                     "```json\n{\"status\": \"complete|continue|blocked\", \"evidence\": \"你憑什麼判斷（引用你的輸出）\", "
                     "\"next\": \"還沒做完時下一步要做什麼；blocked 時寫卡在哪、需要人給什麼\"}\n```\n"
                     "complete＝任務已達成；continue＝還有明確可做的下一步；blocked＝缺資訊或需要人決定。")
DONE_CHECK_DEFAULT_ROUNDS = 3
DONE_STATUSES = {"complete", "continue", "blocked"}
_JSON_BLOCK = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```\s*$", re.S)
CACHEABLE_KINDS = {"hermes", "coding-agent", "condition"}
CACHE_FIELDS = ("kind", "prompt", "agent_id", "agent", "profile", "model", "skills", "system", "attachments", "tool_approval",
                "tool", "cwd", "command", "mode", "rule", "done_check", "done_check_max_rounds",
                "io_mode", "doc_op", "fanout_count", "select_by", "criteria", "doc_path", "doc_path_pattern", "doc_glob",
                "doc_new", "doc_status", "doc_stage")


def _bytes_slice(text: str, n: int, *, tail: bool = False) -> str:
    b = text.encode("utf-8")
    part = b[-n:] if tail else b[:n]
    return part.decode("utf-8", "ignore")


def parse_done_check(output: str) -> tuple[str, Optional[dict[str, Any]], str]:
    """回 (去掉自檢區塊的輸出, 解析結果或 None, warning)。找不到／解析失敗 → (原輸出, None, 原因)。"""
    m = _JSON_BLOCK.search(output.rstrip())
    if not m:
        return output, None, "找不到自檢 JSON 區塊"
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        return output, None, f"自檢 JSON 解析失敗: {e}"
    if not isinstance(data, dict) or str(data.get("status", "")).lower() not in DONE_STATUSES:
        return output, None, f"自檢 status 不合法: {data.get('status') if isinstance(data, dict) else data!r}"
    body = output.rstrip()[: m.start()].rstrip()
    return body, {"status": str(data["status"]).lower(), "evidence": str(data.get("evidence") or ""), "next": str(data.get("next") or "")}, ""


def effect_hash(node: dict[str, Any], upstream: list[tuple[str, str]]) -> str:
    """節點設定 + 上游輸出的雜湊；rerun 時相同就沿用上次輸出。"""
    h = hashlib.sha256()
    h.update(json.dumps({k: node.get(k) for k in CACHE_FIELDS}, sort_keys=True, ensure_ascii=False, default=str).encode())
    for src, out in sorted(upstream):
        h.update(b"\0" + src.encode() + b"\0" + hashlib.sha256((out or "").encode()).digest())
    return h.hexdigest()


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


class RunContext:
    def __init__(self, run: WorkflowRun, snapshot: dict[str, Any]):
        self.run_id = run.id
        self.company_id = run.company_id
        self.member_id = run.created_by
        self.workflow_id = run.workflow_id
        self.workflow_name = run.workflow_name
        self.snapshot = snapshot
        self.nodes: dict[str, dict[str, Any]] = {str(n["id"]): n for n in snapshot["nodes"]}
        self.edges: list[dict[str, Any]] = snapshot["edges"]
        self.budget: dict[str, Any] = snapshot.get("budget") or {}
        self.input: dict[str, Any] = json.loads(run.input_json or "{}")
        self.states: dict[str, dict[str, Any]] = json.loads(run.node_states_json or "{}")
        self.events: list[dict[str, Any]] = json.loads(run.events_json or "[]")
        self.decisions: dict[str, bool] = {}
        self.loop_counts: dict[str, int] = {}
        self.loop_reentry: set[str] = set()
        self.loop_inputs: dict[str, str] = {}  # loop_id -> output of the back-edge source (current iteration)
        self.feedback: dict[str, str] = {}
        self.usage: dict[str, float] = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0}
        self.status = run.status
        self.error = ""
        self.tasks: dict[str, asyncio.Task] = {}
        self.gateway_runs: dict[str, tuple[Optional[str], str]] = {}  # node_id -> (profile, gateway run id)
        self.approval_events: dict[str, asyncio.Event] = {}
        self.approval_results: dict[str, tuple[str, str]] = {}
        self.approval_choices: dict[str, str] = {}  # node_id -> 人在 doc_select 閘門選的 doc_id
        self.stop_reason: Optional[str] = None
        self.lock = asyncio.Lock()
        self.deadline_task: Optional[asyncio.Task] = None
        self.started_at: Optional[datetime] = None
        self.resume_gate: dict[str, str] = {}  # node_id -> pending approval id（重啟後從 workflow_approvals 恢復）
        self.cache: dict[str, dict[str, Any]] = {}  # node_id -> 父 run 的節點狀態（效果快取來源）
        self.human_notes: dict[str, str] = {}  # node_id -> 自檢 blocked 後人給的指示
        for nid in self.nodes:
            self.states.setdefault(nid, {"status": "pending", "attempt": 0})

    def restore_decisions(self) -> None:
        """從 events 重建邊決策與迴圈計數（重啟修復用；events 是持久化的真相）。"""
        self.decisions = {}
        for ev in self.events:
            t = ev.get("type")
            if t == "edge.decision":
                self.decisions[ev["edge"]] = bool(ev.get("taken"))
            elif t == "loop.iteration":
                lid = str(ev.get("node_id"))
                self.loop_counts[lid] = max(self.loop_counts.get(lid, 0), int(ev.get("iteration") or 0))
                if lid in self.nodes:
                    for nid in loop_body(self.snapshot["nodes"], self.edges, lid) | {lid}:
                        for e in self.outgoing(nid):
                            self.decisions.pop(self.edge_key(e), None)

    # helpers
    def edge_key(self, e: dict[str, Any]) -> str:
        return e.get("id") or f"{e['source']}->{e['target']}:{e.get('sourceHandle') or 'output'}"

    def incoming(self, nid: str, *, include_loop_back: bool = False) -> list[dict[str, Any]]:
        return [e for e in self.edges if str(e["target"]) == nid and (include_loop_back or not e.get("loop_back"))]

    def outgoing(self, nid: str) -> list[dict[str, Any]]:
        return [e for e in self.edges if str(e["source"]) == nid]


class WorkflowEngine:
    def __init__(self, engine, gateway: GatewayClient, hub: WorkflowHub, *, hermes_home: Path, workspace: Path):
        self.db_engine = engine
        self.gateway = gateway
        self.hub = hub
        self.hermes_home = hermes_home
        self.workspace = workspace
        self.runs: dict[str, RunContext] = {}
        self.coding_runner: Callable[..., Awaitable[dict[str, Any]]] = runners.run_coding_agent
        self.coding_available: Callable[[str], Optional[str]] = runners.coding_tool_available
        self.deliverer: Callable[..., Awaitable[dict[str, Any]]] = runners.deliver
        self.default_cost_per_1k: float = 0.0  # gateway 沒回成本時的估算單價（USD / 1k tokens）
        self.spill_limit: int = SPILL_LIMIT  # 節點輸出溢出門檻（bytes）
        self.spill_head: int = SPILL_HEAD
        self.spill_tail: int = SPILL_TAIL

    # ------------------------------------------------------------------ public
    async def start(self, wf: Workflow, *, member_id: str, trigger: str = "manual", input: Optional[dict[str, Any]] = None,
                    parent: Optional[WorkflowRun] = None, from_node: Optional[str] = None, force: bool = False) -> WorkflowRun:
        snapshot = {"workflow_id": wf.id, "name": wf.name, "profile": wf.profile, "version": wf.version,
                    "nodes": json.loads(wf.nodes_json), "edges": json.loads(wf.edges_json),
                    "viewport": json.loads(wf.viewport_json or "{}"), "budget": json.loads(wf.budget_json or "{}")}
        if parent is not None:  # rerun keeps the parent's frozen graph
            psnap = json.loads(parent.snapshot_json)
            snapshot.update({k: psnap[k] for k in ("nodes", "edges", "viewport", "budget", "version") if k in psnap})
        run = WorkflowRun(company_id=wf.company_id, workflow_id=wf.id, workflow_name=wf.name, status="running", trigger=trigger,
                          snapshot_json=json.dumps(snapshot, ensure_ascii=False), input_json=json.dumps(input or {}, ensure_ascii=False),
                          created_by=member_id, parent_run_id=parent.id if parent else "", started_at=now())
        with Session(self.db_engine) as db:
            db.add(run)
            db.commit()
            db.refresh(run)
            db.expunge(run)
        ctx = RunContext(run, snapshot)
        ctx.started_at = run.started_at
        if parent is not None and from_node:
            self._seed_from_parent(ctx, parent, from_node)
        if parent is not None and not force:  # 效果快取：設定與上游輸出都沒變的節點直接沿用（指定重跑的節點本身除外）
            ctx.cache = {k: v for k, v in json.loads(parent.node_states_json or "{}").items()
                         if v.get("status") in ("completed", "reused") and v.get("effect_hash") and k != from_node}
        self.runs[run.id] = ctx
        self._event(ctx, {"type": "run.status", "status": "running", "trigger": trigger})
        self._persist(ctx)
        await self._broadcast(ctx, {"type": "run.status", "status": "running", "trigger": trigger})
        dl = ctx.budget.get("deadline_seconds")
        if dl:
            ctx.deadline_task = asyncio.create_task(self._deadline(ctx, float(dl)))
        asyncio.create_task(self._dispatch(ctx))
        return run

    async def stop(self, run_id: str, *, reason: str = "stopped") -> bool:
        ctx = self.runs.get(run_id)
        if ctx is None or ctx.status in TERMINAL_RUN:
            return False
        ctx.stop_reason = reason
        for nid, (profile, grun) in list(ctx.gateway_runs.items()):
            try:
                await self.gateway.stop(profile, grun)
            except Exception:
                pass
        for nid, t in list(ctx.tasks.items()):
            t.cancel()
        for ev in ctx.approval_events.values():
            ev.set()
        await asyncio.sleep(0)  # let cancellations land
        async with ctx.lock:
            for nid, st in ctx.states.items():
                if st["status"] in ("running", "waiting_approval"):
                    self._set_state(ctx, nid, "stopped", finished=True)
                elif st["status"] == "pending":
                    self._set_state(ctx, nid, "skipped", reason="run stopped")
            self._cancel_pending_approvals(ctx)
            await self._finish(ctx, reason)
        return True

    async def park(self) -> None:
        """關機前把記憶體裡的 run 放下：停掉 gateway 端的執行、取消本地 task，但不改 DB 狀態。
        等閘門的 run 下次啟動會從 workflow_approvals 恢復；執行中的節點會被標 outcome_unknown 進收件匣。"""
        for rid, ctx in list(self.runs.items()):
            for nid, (profile, grun) in list(ctx.gateway_runs.items()):
                try:
                    await self.gateway.stop(profile, grun)
                except Exception:
                    pass
            ctx.stop_reason = "parked"
            for t in list(ctx.tasks.values()):
                t.cancel()
            if ctx.deadline_task and not ctx.deadline_task.done():
                ctx.deadline_task.cancel()
            self.runs.pop(rid, None)
        await asyncio.sleep(0)

    async def decide_approval(self, approval: WorkflowApproval, decision: str, comment: str, member_id: str,
                              choice: str = "") -> None:
        ctx = self.runs.get(approval.run_id)
        if ctx is None:
            raise RuntimeError("run 已不在執行中（未被啟動時的修復程序接手，請從節點重跑）")
        ctx.approval_results[approval.node_id] = (decision, comment)
        if choice:
            ctx.approval_choices[approval.node_id] = choice
        ev = ctx.approval_events.get(approval.node_id)
        if ev is None:
            raise RuntimeError("此閘門不在等待狀態")
        with Session(self.db_engine) as db:
            a = db.get(WorkflowApproval, approval.id)
            if a:
                a.status = "approved" if decision == "approve" else "rejected"
                a.comment = comment
                if choice:
                    a.choice = choice
                a.decided_by = member_id
                a.decided_at = now()
                db.add(a)
                db.commit()
        ev.set()

    def snapshot_of(self, run_id: str) -> Optional[dict[str, Any]]:
        ctx = self.runs.get(run_id)
        return None if ctx is None else self._run_dict(ctx)

    # ------------------------------------------------------------------ scheduling
    async def _dispatch(self, ctx: RunContext) -> None:
        async with ctx.lock:
            await self._dispatch_locked(ctx)

    async def _dispatch_locked(self, ctx: RunContext) -> None:
        if ctx.status in TERMINAL_RUN:
            return
        progressed = True
        while progressed:
            progressed = False
            for nid in list(ctx.nodes):
                st = ctx.states[nid]["status"]
                if st != "pending":
                    continue
                if nid in ctx.loop_reentry:
                    self._launch(ctx, nid)
                    progressed = True
                    continue
                inc = ctx.incoming(nid)
                if not inc:
                    self._launch(ctx, nid)
                    progressed = True
                    continue
                resolved = all(ctx.edge_key(e) in ctx.decisions for e in inc)
                if not resolved:
                    continue
                taken = [e for e in inc if ctx.decisions.get(ctx.edge_key(e))]
                if taken:
                    self._launch(ctx, nid)
                else:
                    self._set_state(ctx, nid, "skipped", reason="上游未走到此節點")
                    self._resolve_edges(ctx, nid, success=False, skipped=True)
                progressed = True
        self._persist(ctx)
        await self._maybe_finish(ctx)

    def _launch(self, ctx: RunContext, nid: str) -> None:
        st = ctx.states[nid]
        node = ctx.nodes[nid]
        if node_kind(node) in CACHEABLE_KINDS and nid not in ctx.loop_reentry:
            ups = [(str(e["source"]), ctx.states[str(e["source"])].get("output") or "") for e in ctx.incoming(nid) if ctx.decisions.get(ctx.edge_key(e))]
            if not ups and not ctx.incoming(nid, include_loop_back=True):
                ups = [("__input__", json.dumps(ctx.input, sort_keys=True, ensure_ascii=False, default=str))]
            st["effect_hash"] = effect_hash(node, ups)
            cached = ctx.cache.get(nid)
            if cached and cached.get("effect_hash") == st["effect_hash"] and nid not in ctx.feedback:
                ctx.states[nid] = dict(cached, status="reused", reason="效果快取：設定與上游輸出未變")
                ctx.states[nid]["effect_hash"] = st["effect_hash"]
                self._event(ctx, {"type": "node.status", "node_id": nid, "status": "reused", "attempt": cached.get("attempt", 0), "reason": "效果快取"})
                branch = None
                if node_kind(node) == "condition":
                    branch = "true" if cached.get("decision") else "false"
                self._resolve_edges(ctx, nid, success=True, branch=branch)
                asyncio.create_task(self._broadcast(ctx, {"type": "node.status", "node_id": nid, "status": "reused", "reason": "效果快取",
                                                          "output": (cached.get("output") or "")[:4000], "branch": branch}))
                return
        st["attempt"] = int(st.get("attempt", 0)) + 1
        self._set_state(ctx, nid, "running", started=True)
        ctx.tasks[nid] = asyncio.create_task(self._run_node(ctx, nid))

    async def _maybe_finish(self, ctx: RunContext) -> None:
        if ctx.status in TERMINAL_RUN:
            return
        active = [n for n, s in ctx.states.items() if s["status"] in ("running", "waiting_approval")]
        if active:
            new_status = "waiting_approval" if all(ctx.states[n]["status"] == "waiting_approval" for n in active) else "running"
            if new_status != ctx.status:
                ctx.status = new_status
                self._event(ctx, {"type": "run.status", "status": new_status})
                self._persist(ctx)
                await self._broadcast(ctx, {"type": "run.status", "status": new_status})
            return
        for nid, s in ctx.states.items():
            if s["status"] == "pending":
                self._set_state(ctx, nid, "skipped", reason="不可達")
        failed = [n for n, s in ctx.states.items() if s["status"] == "failed"
                  and not any(ctx.decisions.get(ctx.edge_key(e)) for e in ctx.outgoing(n))]
        await self._finish(ctx, "failed" if failed else "completed", error="; ".join(f"{n}: {ctx.states[n].get('error','')}" for n in failed))

    async def _finish(self, ctx: RunContext, status: str, error: str = "") -> None:
        if ctx.status in TERMINAL_RUN:
            return
        ctx.status = status
        ctx.error = error or ctx.error
        if ctx.deadline_task and not ctx.deadline_task.done():
            ctx.deadline_task.cancel()
        self._event(ctx, {"type": "run.status", "status": status, "error": ctx.error})
        self._persist(ctx, finished=True)
        await self._broadcast(ctx, {"type": "run.status", "status": status, "error": ctx.error, "usage": ctx.usage})
        self.runs.pop(ctx.run_id, None)

    async def _deadline(self, ctx: RunContext, seconds: float) -> None:
        try:
            await asyncio.sleep(seconds)
        except asyncio.CancelledError:
            return
        if ctx.status not in TERMINAL_RUN:
            ctx.error = f"超過期限 {seconds:.0f} 秒"
            await self.stop(ctx.run_id, reason="timeout")

    # ------------------------------------------------------------------ edges
    def _resolve_edges(self, ctx: RunContext, nid: str, *, success: bool, skipped: bool = False,
                       branch: Optional[str] = None) -> list[dict[str, Any]]:
        """Decide every outgoing edge of `nid`; returns taken loop_back edges."""
        taken_backs: list[dict[str, Any]] = []
        for e in ctx.outgoing(nid):
            on = e.get("on", "always")
            handle = e.get("sourceHandle") or e.get("source_handle") or "output"
            if branch == "body" and handle == "exit":
                continue  # 迴圈還在跑：exit 邊留待迴圈結束再決定，下游不會被提早 skip
            if skipped:
                taken = False
            else:
                taken = on == "always" or (on == "success" and success) or (on == "failure" and not success)
                if branch is not None and handle != "output":
                    taken = taken and handle == branch
            ctx.decisions[ctx.edge_key(e)] = taken
            self._event(ctx, {"type": "edge.decision", "edge": ctx.edge_key(e), "source": str(e["source"]), "target": str(e["target"]),
                              "on": on, "handle": handle, "taken": taken, "loop_back": bool(e.get("loop_back"))})
            if taken and e.get("loop_back"):
                taken_backs.append(e)
        return taken_backs

    def _reenter_loop(self, ctx: RunContext, loop_id: str, back_output: str) -> None:
        body = loop_body(ctx.snapshot["nodes"], ctx.edges, loop_id)
        ctx.loop_inputs[loop_id] = back_output
        for nid in body | {loop_id}:
            for e in ctx.outgoing(nid):
                ctx.decisions.pop(ctx.edge_key(e), None)
            st = ctx.states[nid]
            st.update({"status": "pending", "output": "", "error": "", "started_at": None, "finished_at": None})
        ctx.loop_reentry.add(loop_id)
        self._event(ctx, {"type": "loop.iteration", "node_id": loop_id, "iteration": ctx.loop_counts.get(loop_id, 0)})

    # ------------------------------------------------------------------ node execution
    async def _run_node(self, ctx: RunContext, nid: str) -> None:
        node = ctx.nodes[nid]
        kind = node_kind(node)
        await self._broadcast(ctx, {"type": "node.status", "node_id": nid, "status": "running", "attempt": ctx.states[nid]["attempt"]})
        success = True
        branch: Optional[str] = None
        try:
            if kind == "hermes":
                output = await self._run_hermes(ctx, nid, node)
            elif kind == "coding-agent":
                output = await self._run_coding(ctx, nid, node)
            elif kind == "gate":
                output = await self._run_gate(ctx, nid, node)
                if output is None:  # rejected → upstream re-run scheduled
                    return
            elif kind == "condition":
                output, branch = await self._run_condition(ctx, nid, node)
            elif kind == "loop":
                output, branch = self._run_loop(ctx, nid, node)
            elif kind == "delivery":
                output = await self._run_delivery(ctx, nid, node)
            else:
                raise RuntimeError(f"未知節點型別 {kind}")
        except asyncio.CancelledError:
            return
        except Exception as e:
            log.info("node %s/%s failed: %s", ctx.run_id, nid, e)
            success = False
            output = ""
            ctx.states[nid]["error"] = str(e)[:2000]
        finally:
            ctx.tasks.pop(nid, None)
            ctx.gateway_runs.pop(nid, None)
        async with ctx.lock:
            if ctx.status in TERMINAL_RUN:
                return
            ctx.states[nid]["output"] = self._spill(ctx, nid, output)
            output = ctx.states[nid]["output"]
            self._set_state(ctx, nid, "completed" if success else "failed", finished=True)
            backs = self._resolve_edges(ctx, nid, success=success, branch=branch)
            for e in backs:
                self._reenter_loop(ctx, str(e["target"]), output)
            self._persist(ctx)
            await self._broadcast(ctx, {"type": "node.status", "node_id": nid, "status": ctx.states[nid]["status"],
                                        "output": output[:4000], "error": ctx.states[nid].get("error", ""),
                                        "usage": ctx.states[nid].get("usage"), "branch": branch})
            if self._budget_exceeded(ctx):
                asyncio.create_task(self.stop(ctx.run_id, reason="budget_exceeded"))
                return
            await self._dispatch_locked(ctx)

    def _upstream_text(self, ctx: RunContext, nid: str) -> str:
        parts: list[str] = []
        if nid in ctx.loop_reentry:
            return f"### 上一輪結果\n{ctx.loop_inputs.get(nid, '')}".strip()
        for e in ctx.incoming(nid):
            if not ctx.decisions.get(ctx.edge_key(e)):
                continue
            src = str(e["source"])
            out = ctx.states[src].get("output") or ""
            parts.append(f"### {ctx.nodes[src].get('title') or src}\n{out}".strip())
        if not parts and not ctx.incoming(nid, include_loop_back=True):
            payload = ctx.input.get("payload") if isinstance(ctx.input, dict) else None
            text = ctx.input.get("text") if isinstance(ctx.input, dict) else None
            if text:
                parts.append(f"### 外部輸入\n{text}")
            elif payload is not None:
                parts.append("### 外部輸入\n" + json.dumps(payload, ensure_ascii=False, indent=2))
        return "\n\n".join(parts)

    def _compose(self, ctx: RunContext, nid: str, node: dict[str, Any], task: str) -> str:
        up = self._upstream_text(ctx, nid)
        msg = ""
        if up:
            msg += f"[上游結果]\n{up}\n\n"
        fb = ctx.feedback.pop(nid, None)
        if fb:
            msg += f"[退回意見]\n{fb}\n\n"
        msg += f"[本節點任務]\n{task}"
        att = node.get("attachments") or []
        if att:
            msg += "\n\n[附件]\n" + "\n".join(f"- {a}" for a in att)
        return msg

    def _agent_for(self, node: dict[str, Any]) -> tuple[Optional[str], Optional[str], Optional[Agent]]:
        with Session(self.db_engine) as db:
            ag = db.get(Agent, str(node.get("agent_id") or "")) if node.get("agent_id") else None
            if ag is None and node.get("agent"):
                ag = db.exec(select(Agent).where(Agent.profile == str(node["agent"]))).first()
            if ag:
                db.expunge(ag)
        profile = (node.get("profile") or (ag.profile if ag else node.get("agent")) or None)
        # 只在節點明確指定時才送 model；員工預設模型由 gateway profile 自己決定
        # （同步進來的 agent.model 可能是 provider 不接受的別名，例如 Codex 帳號拒絕 stealth/*）
        model = node.get("model") or None
        return profile, model, ag

    async def _hermes_call(self, ctx: RunContext, nid: str, node: dict[str, Any], text: str, instructions: str) -> str:
        profile, model, ag = self._agent_for(node)
        if ag is None and not profile:
            raise RuntimeError("找不到 AI 員工（agent_id）")
        hermes_sid = f"wf-{ctx.run_id}-{nid}-{ctx.states[nid]['attempt']}"
        with Session(self.db_engine) as db:
            s = ChatSession(company_id=ctx.company_id, member_id=ctx.member_id, agent_id=ag.id if ag else "",
                            title=f"{ctx.workflow_name} / {node.get('title') or nid}", source="workflow", hermes_session_id=hermes_sid)
            db.add(s)
            db.commit()
            db.refresh(s)
            session_id = s.id
            db.add(Message(session_id=session_id, role="user", content=text))
            db.commit()
        ctx.states[nid]["session_id"] = session_id
        ctx.states[nid]["hermes_session_id"] = hermes_sid
        ctx.states[nid]["profile"] = profile
        run_id = await self.gateway.start_run(profile, text, session_id=hermes_sid, instructions=instructions, model=model)
        ctx.gateway_runs[nid] = (profile, run_id)
        with Session(self.db_engine) as db:
            s = db.get(ChatSession, session_id)
            if s:
                s.last_run_id = run_id
                db.add(s)
                db.commit()
        chunks: list[str] = []
        final: Optional[str] = None
        usage: dict[str, Any] = {}
        error: Optional[str] = None
        tools: dict[str, Any] = {}
        approval_policy = node.get("tool_approval", "deny")
        async for ev in self.gateway.run_events(profile, run_id):
            name = ev.get("event") or ev.get("type") or ""
            if name == "message.delta":
                d = str(ev.get("delta") or "")
                chunks.append(d)
                await self._broadcast(ctx, {"type": "node.delta", "node_id": nid, "delta": d})
            elif name == "tool.started":
                tools[ev.get("tool") or "tool"] = ev.get("preview") or ev.get("args")
                await self._broadcast(ctx, {"type": "node.tool", "node_id": nid, "name": ev.get("tool"), "status": "started"})
            elif name == "tool.completed":
                tname = ev.get("tool") or "tool"
                self._save_tool(session_id, run_id, tname, tools.pop(tname, None), {k: ev.get(k) for k in ("result", "preview", "duration", "error") if k in ev})
                await self._broadcast(ctx, {"type": "node.tool", "node_id": nid, "name": tname, "status": "completed"})
            elif name == "approval.request":
                choice = "once" if approval_policy == "allow" else "deny"
                self._event(ctx, {"type": "tool.approval", "node_id": nid, "command": ev.get("command"), "choice": choice})
                try:
                    await self.gateway.approve(profile, run_id, choice)
                except Exception as e:
                    log.warning("auto approval failed: %s", e)
            elif name == "run.completed":
                final = ev.get("output") if isinstance(ev.get("output"), str) else None
                usage = ev.get("usage") or {}
                break
            elif name in ("run.failed", "run.cancelled"):
                error = str(ev.get("error") or name)
                break
        if final is None and error is None and not chunks:
            try:
                st = await self.gateway.run_status(profile, run_id)
                if st.get("status") == "completed":
                    final = st.get("output") or ""
                    usage = st.get("usage") or usage
                else:
                    error = st.get("error") or f"stream closed (status={st.get('status')})"
            except Exception as e:
                error = str(e)
        content = final if final else "".join(chunks)
        with Session(self.db_engine) as db:
            db.add(Message(session_id=session_id, role="assistant", content=content or (error or ""), run_id=run_id))
            s = db.get(ChatSession, session_id)
            if s:
                s.last_message_at = now()
                db.add(s)
            db.commit()
        self._add_usage(ctx, nid, usage)
        if error:
            raise RuntimeError(error)
        return content

    async def _run_hermes(self, ctx: RunContext, nid: str, node: dict[str, Any]) -> str:
        instr = SYSTEM_PROMPT.format(wf=ctx.workflow_name, node=node.get("title") or nid)
        if node.get("system"):
            instr += "\n" + str(node["system"])
        if node.get("skills"):
            instr += "\n請優先使用這些 skills：" + ", ".join(map(str, node["skills"]))
        if nid in ctx.resume_gate:  # 重啟前卡在自檢 blocked：先等人決定，再重跑本節點
            decision, comment = await self._wait_human(ctx, nid, ctx.resume_gate.pop(nid), payload=None)
            if decision != "approve":
                raise RuntimeError(f"自檢 blocked，人退回：{comment or '無說明'}")
            ctx.human_notes[nid] = comment
        if str(node.get("io_mode") or "text") == "doc":  # 文件模式：transform / fanout / select / merge
            return await doc_nodes.run(self, ctx, nid, node, instr)
        if not node.get("done_check"):
            return await self._hermes_call(ctx, nid, node, self._compose(ctx, nid, node, str(node.get("prompt") or "")), instr)
        max_rounds = max(1, int(node.get("done_check_max_rounds") or DONE_CHECK_DEFAULT_ROUNDS))
        base = self._compose(ctx, nid, node, str(node.get("prompt") or "") + DONE_CHECK_SUFFIX)
        rounds: list[dict[str, Any]] = ctx.states[nid].setdefault("done_rounds", [])
        prev_output = ""
        prev_next = ""
        while True:
            text = base
            if ctx.human_notes.get(nid):
                text += f"\n\n[人的指示]\n{ctx.human_notes.pop(nid)}"
            if rounds:
                text += f"\n\n[上一輪輸出]\n{prev_output}\n\n[上一輪自檢]\n下一步：{prev_next or '（未說明）'}\n請接續完成，輸出完整結果（不要只給差異）。"
            raw = await self._hermes_call(ctx, nid, node, text, instr)
            body, chk, warn = parse_done_check(raw)
            rec = {"round": len(rounds) + 1, "status": chk["status"] if chk else "complete", "evidence": chk["evidence"] if chk else "",
                   "next": chk["next"] if chk else "", "warning": warn, "output_chars": len(body), "session_id": ctx.states[nid].get("session_id")}
            rounds.append(rec)
            self._event(ctx, {"type": "node.done_check", "node_id": nid, **{k: rec[k] for k in ("round", "status", "evidence", "next", "warning")}})
            await self._broadcast(ctx, {"type": "node.done_check", "node_id": nid, "round": rec["round"], "status": rec["status"], "evidence": rec["evidence"]})
            if warn:
                self._event(ctx, {"type": "node.note", "node_id": nid, "note": f"自檢解析失敗，視為 complete：{warn}"})
                return raw
            if rec["status"] == "complete":
                return body
            if rec["status"] == "continue":
                if len(rounds) >= max_rounds:
                    self._event(ctx, {"type": "node.note", "node_id": nid, "note": f"自檢 continue 已達上限 {max_rounds} 輪，以最後一輪輸出為結果"})
                    return body
                prev_output, prev_next = body, rec["next"]
                continue
            # blocked → 閘門式等待：workflow_approvals 一列（收件匣自動列出），人「繼續」(approve) 或「退回」(reject)
            payload = f"[自檢 blocked] 第 {rec['round']} 輪\n\n[證據]\n{rec['evidence']}\n\n[卡在哪]\n{rec['next']}\n\n[目前輸出]\n{body[:3000]}"
            with Session(self.db_engine) as db:
                a = WorkflowApproval(company_id=ctx.company_id, run_id=ctx.run_id, workflow_id=ctx.workflow_id, workflow_name=ctx.workflow_name,
                                     node_id=nid, node_title=f"{node.get('title') or nid}（自檢 blocked）", payload=payload)
                db.add(a)
                db.commit()
                db.refresh(a)
                approval_id = a.id
            decision, comment = await self._wait_human(ctx, nid, approval_id, payload=payload)
            if decision != "approve":
                raise RuntimeError(f"自檢 blocked，人退回：{comment or '無說明'}")
            if len(rounds) >= max_rounds:
                self._event(ctx, {"type": "node.note", "node_id": nid, "note": f"自檢已達上限 {max_rounds} 輪，人選擇繼續，以最後一輪輸出為結果"})
                return body
            ctx.human_notes[nid] = comment or "請繼續"
            prev_output, prev_next = body, rec["next"]

    async def _wait_human(self, ctx: RunContext, nid: str, approval_id: str, *, payload: Optional[str],
                          kind: str = "done_check") -> tuple[str, str]:
        """把節點掛成 waiting_approval，等 decide_approval 喚醒；回 (decision, comment)。"""
        ev = asyncio.Event()
        ctx.approval_events[nid] = ev
        ctx.approval_results.pop(nid, None)
        ctx.states[nid]["approval_id"] = approval_id
        async with ctx.lock:
            self._set_state(ctx, nid, "waiting_approval")
            if payload is not None:
                self._event(ctx, {"type": "approval.request", "node_id": nid, "approval_id": approval_id, "kind": kind})
            self._persist(ctx)
        if payload is not None:
            await self._broadcast(ctx, {"type": "approval.request", "node_id": nid, "approval_id": approval_id, "payload": payload[:4000], "kind": kind})
        await self._maybe_finish(ctx)
        await ev.wait()
        ctx.approval_events.pop(nid, None)
        if ctx.stop_reason:
            raise asyncio.CancelledError()
        decision, comment = ctx.approval_results.get(nid, ("reject", "run stopped"))
        self._event(ctx, {"type": "approval.decided", "node_id": nid, "approval_id": approval_id, "decision": decision, "comment": comment, "kind": kind})
        await self._broadcast(ctx, {"type": "approval.decided", "node_id": nid, "approval_id": approval_id, "decision": decision, "comment": comment})
        self._set_state(ctx, nid, "running")
        return decision, comment

    async def _run_coding(self, ctx: RunContext, nid: str, node: dict[str, Any]) -> str:
        tool = str(node.get("tool"))
        if not self.coding_available(tool):
            ctx.states[nid]["skipped_reason"] = f"{tool} 未安裝"
            self._event(ctx, {"type": "node.note", "node_id": nid, "note": f"{tool} 未安裝，略過"})
            return ""
        prompt = self._compose(ctx, nid, node, str(node.get("prompt") or node.get("command") or ""))
        cwd = str(node.get("cwd") or self.workspace)
        Path(cwd).mkdir(parents=True, exist_ok=True)

        async def on_delta(d: str):
            await self._broadcast(ctx, {"type": "node.delta", "node_id": nid, "delta": d})

        res = await self.coding_runner(tool, prompt, cwd, on_delta=on_delta, timeout=float(node.get("timeout_seconds") or 1800))
        self._add_usage(ctx, nid, res.get("usage") or {})
        ctx.states[nid]["exit_code"] = res.get("exit_code")
        if res.get("exit_code"):
            raise RuntimeError(f"{tool} 結束碼 {res['exit_code']}: {res.get('output', '')[-500:]}")
        return str(res.get("output") or "")

    async def _run_gate(self, ctx: RunContext, nid: str, node: dict[str, Any]) -> Optional[str]:
        ev = asyncio.Event()
        ctx.approval_events[nid] = ev
        ctx.approval_results.pop(nid, None)
        resumed = ctx.resume_gate.pop(nid, None)
        if resumed:  # 重啟修復：workflow_approvals 的 pending 列是真相，沿用它的 id 與 payload
            with Session(self.db_engine) as db:
                a = db.get(WorkflowApproval, resumed)
                payload = a.payload if a else self._upstream_text(ctx, nid)
            approval_id = resumed
        else:
            payload = self._upstream_text(ctx, nid)
            with Session(self.db_engine) as db:
                a = WorkflowApproval(company_id=ctx.company_id, run_id=ctx.run_id, workflow_id=ctx.workflow_id, workflow_name=ctx.workflow_name,
                                     node_id=nid, node_title=str(node.get("title") or nid), payload=payload)
                db.add(a)
                db.commit()
                db.refresh(a)
                approval_id = a.id
        ctx.states[nid]["approval_id"] = approval_id
        async with ctx.lock:
            self._set_state(ctx, nid, "waiting_approval")
            if not resumed:
                self._event(ctx, {"type": "approval.request", "node_id": nid, "approval_id": approval_id})
            self._persist(ctx)
        await self._broadcast(ctx, {"type": "approval.request", "node_id": nid, "approval_id": approval_id, "payload": payload[:4000]})
        await self._maybe_finish(ctx)
        await ev.wait()
        ctx.approval_events.pop(nid, None)
        if ctx.stop_reason:
            raise asyncio.CancelledError()
        decision, comment = ctx.approval_results.get(nid, ("reject", "run stopped"))
        self._event(ctx, {"type": "approval.decided", "node_id": nid, "approval_id": approval_id, "decision": decision, "comment": comment})
        await self._broadcast(ctx, {"type": "approval.decided", "node_id": nid, "approval_id": approval_id, "decision": decision, "comment": comment})
        if decision == "approve":
            self._set_state(ctx, nid, "running")
            return payload + (f"\n\n[審批意見]\n{comment}" if comment else "")
        # rejected: re-run direct upstream nodes with the comment
        async with ctx.lock:
            ctx.states[nid].update({"status": "pending", "output": "", "error": ""})
            preds = [str(e["source"]) for e in ctx.incoming(nid) if ctx.decisions.get(ctx.edge_key(e))]
            for p in preds:
                ctx.feedback[p] = comment or "審批退回，請修正後重送"
                for e in ctx.outgoing(p):
                    ctx.decisions.pop(ctx.edge_key(e), None)
                ctx.states[p].update({"status": "pending", "output": "", "error": "", "finished_at": None})
                self._event(ctx, {"type": "node.status", "node_id": p, "status": "pending", "reason": "閘門退回"})
            ctx.tasks.pop(nid, None)
            self._persist(ctx)
            for p in preds:
                await self._broadcast(ctx, {"type": "node.status", "node_id": p, "status": "pending", "reason": "閘門退回"})
            await self._broadcast(ctx, {"type": "node.status", "node_id": nid, "status": "pending", "reason": "閘門退回"})
            await self._dispatch_locked(ctx)
        return None

    async def _run_condition(self, ctx: RunContext, nid: str, node: dict[str, Any]) -> tuple[str, str]:
        up = self._upstream_text(ctx, nid)
        if node.get("mode", "rule") == "ai":
            prompt = self._compose(ctx, nid, node, str(node.get("prompt") or "") + "\n\n只回答 YES 或 NO（第一行），第二行簡短說明理由。")
            instr = SYSTEM_PROMPT.format(wf=ctx.workflow_name, node=node.get("title") or nid) + "\n你是判斷器，只輸出 YES 或 NO。"
            answer = await self._hermes_call(ctx, nid, node, prompt, instr)
            res = parse_yes_no(answer)
            if res is None:
                raise RuntimeError(f"AI 判斷結果無法解析: {answer[:100]!r}")
            ctx.states[nid]["decision"] = res
            return answer, "true" if res else "false"
        # rule: evaluate against raw upstream outputs joined (without headers) so contains/regex hit real content
        raw = "\n\n".join((ctx.states[str(e["source"])].get("output") or "") for e in ctx.incoming(nid) if ctx.decisions.get(ctx.edge_key(e)))
        res, why = evaluate_rule(node.get("rule") or {}, raw or up)
        ctx.states[nid]["decision"] = res
        return why, "true" if res else "false"

    def _run_loop(self, ctx: RunContext, nid: str, node: dict[str, Any]) -> tuple[str, str]:
        count = ctx.loop_counts.get(nid, 0)
        reentry = nid in ctx.loop_reentry
        ctx.loop_reentry.discard(nid)
        if reentry:
            raw = ctx.loop_inputs.get(nid, "")
        else:
            raw = "\n\n".join((ctx.states[str(e["source"])].get("output") or "") for e in ctx.incoming(nid) if ctx.decisions.get(ctx.edge_key(e)))
        mx = int(node.get("max_iterations") or 1)
        until = node.get("until")
        if until and count > 0:
            ok, why = evaluate_rule(until, raw)
            if ok:
                ctx.states[nid]["iterations"] = count
                return f"迴圈結束（條件成立：{why}，共 {count} 次）\n\n{raw}", "exit"
        if count >= mx:
            ctx.states[nid]["iterations"] = count
            return f"迴圈結束（達上限 {mx} 次）\n\n{raw}", "exit"
        ctx.loop_counts[nid] = count + 1
        ctx.states[nid]["iterations"] = count + 1
        return raw if raw else f"第 {count + 1} 次迭代", "body"

    async def _run_delivery(self, ctx: RunContext, nid: str, node: dict[str, Any]) -> str:
        text = self._upstream_text(ctx, nid)
        if node.get("template"):
            text = str(node["template"]).replace("{{text}}", text).replace("{{workflow}}", ctx.workflow_name)
        res = await self.deliverer(node, text, hermes_home=self.hermes_home, workspace=self.workspace, run_id=ctx.run_id)
        ctx.states[nid]["delivery"] = res
        return text

    # ------------------------------------------------------------------ spill
    def _spill(self, ctx: RunContext, nid: str, output: str) -> str:
        """輸出超過門檻：完整內容寫 runs/<run_id>/<node_id>.output.md，回傳 head+tail+路徑的縮短版。"""
        st = ctx.states[nid]
        st.pop("spill", None)
        if not output or len(output.encode("utf-8")) <= self.spill_limit:
            return output
        rel = Path("runs") / ctx.run_id / f"{nid}.output.md"
        full = self.workspace / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(output, encoding="utf-8")
        size = len(output.encode("utf-8"))
        st["spill"] = {"path": str(rel), "bytes": size, "head_bytes": self.spill_head, "tail_bytes": self.spill_tail}
        self._event(ctx, {"type": "node.spill", "node_id": nid, "bytes": size, "path": str(rel)})
        head = _bytes_slice(output, self.spill_head)
        tail = _bytes_slice(output, self.spill_tail, tail=True)
        return (f"{head}\n\n…（輸出共 {size} bytes，已溢出；中段省略。完整內容：{full}）…\n\n{tail}")

    def spill_path(self, run_id: str, node_id: str) -> Path:
        return self.workspace / "runs" / run_id / f"{node_id}.output.md"

    # ------------------------------------------------------------------ crash repair
    async def recover(self) -> list[dict[str, Any]]:
        """伺服器啟動時修復未結束的 run。
        - 等閘門（waiting_approval）且 workflow_approvals 還有 pending 列 → 從表恢復等待，核准後續跑。
        - 節點 running 被中斷 → 標 outcome_unknown，run → needs_attention，收件匣一筆；可從該節點重跑。
        - 沒有活動節點但 run 仍 running → 直接續派（pending 節點照 events 重建的邊決策繼續）。"""
        report: list[dict[str, Any]] = []
        with Session(self.db_engine) as db:
            runs = db.exec(select(WorkflowRun).where(WorkflowRun.status.in_(["running", "waiting_approval", "pending"]))).all()
            for r in runs:
                db.expunge(r)
            pend = {}
            for a in db.exec(select(WorkflowApproval).where(WorkflowApproval.status == "pending")).all():
                pend.setdefault(a.run_id, {})[a.node_id] = a.id
        for r in runs:
            try:
                snapshot = json.loads(r.snapshot_json or "{}")
                ctx = RunContext(r, snapshot)
                ctx.started_at = r.started_at or r.created_at
                ctx.usage.update({k: float(v) for k, v in json.loads(r.usage_json or "{}").items()})
                ctx.restore_decisions()
                for nid, st in ctx.states.items():
                    if node_kind(ctx.nodes[nid]) == "loop" and st.get("iterations"):
                        ctx.loop_counts[nid] = max(ctx.loop_counts.get(nid, 0), int(st["iterations"]))
                interrupted = [nid for nid, st in ctx.states.items() if st.get("status") == "running"]
                waiting = [nid for nid, st in ctx.states.items() if st.get("status") == "waiting_approval"]
                gates = pend.get(r.id, {})
                lost_gates = [nid for nid in waiting if nid not in gates]
                if interrupted or lost_gates:
                    self._mark_needs_attention(ctx, interrupted + lost_gates, gates)
                    report.append({"run_id": r.id, "action": "needs_attention", "nodes": interrupted + lost_gates})
                    continue
                self.runs[r.id] = ctx
                for nid in waiting:
                    ctx.resume_gate[nid] = gates[nid]
                    ctx.tasks[nid] = asyncio.create_task(self._run_node(ctx, nid))
                self._event(ctx, {"type": "run.recovered", "resumed_gates": waiting})
                self._persist(ctx)
                if not waiting:
                    asyncio.create_task(self._dispatch(ctx))
                dl = ctx.budget.get("deadline_seconds")
                if dl:
                    elapsed = (now() - ctx.started_at).total_seconds() if ctx.started_at else 0
                    ctx.deadline_task = asyncio.create_task(self._deadline(ctx, max(1.0, float(dl) - elapsed)))
                report.append({"run_id": r.id, "action": "resumed", "nodes": waiting})
            except Exception as e:  # 修不了就照舊標 stopped，不讓啟動炸掉
                log.warning("recover %s failed: %s", r.id, e, exc_info=True)
                with Session(self.db_engine) as db:
                    row = db.get(WorkflowRun, r.id)
                    if row:
                        row.status, row.error, row.finished_at = "stopped", f"重啟修復失敗：{e}", now()
                        db.add(row)
                        db.commit()
                report.append({"run_id": r.id, "action": "stopped", "error": str(e)})
        return report

    def _mark_needs_attention(self, ctx: RunContext, nodes: list[str], gates: dict[str, str]) -> None:
        for nid in nodes:
            st = ctx.states[nid]
            st["status"] = "outcome_unknown"
            st["finished_at"] = _iso(now())
            st["error"] = st.get("error") or "伺服器重啟時此節點執行中，結果未知（外部副作用可能已發生）"
            self._event(ctx, {"type": "node.status", "node_id": nid, "status": "outcome_unknown", "attempt": st.get("attempt", 0), "reason": "重啟中斷"})
        for nid, st in ctx.states.items():
            if st.get("status") in ("pending", "waiting_approval"):
                st["status"] = "skipped"
                st["reason"] = "run 進入 needs_attention"
        ctx.status = "needs_attention"
        ctx.error = "伺服器重啟，節點 " + ", ".join(nodes) + " 結果未知；請確認外部狀態後從該節點重跑"
        self._event(ctx, {"type": "run.status", "status": "needs_attention", "error": ctx.error, "unknown": nodes})
        with Session(self.db_engine) as db:
            for nid in ctx.states:
                aid = gates.get(nid)
                if aid:
                    a = db.get(WorkflowApproval, aid)
                    if a:
                        a.status = "cancelled"
                        db.add(a)
            db.commit()
        self._persist(ctx, finished=True)
        titles = "、".join(str(ctx.nodes[n].get("title") or n) for n in nodes)
        try:
            from ..inbox import add_item
            add_item(ctx.company_id, "workflow_attention", f"工作流「{ctx.workflow_name}」重啟後結果未知：{titles}",
                     f"run {ctx.run_id} 在伺服器重啟時有節點執行中，結果未知。請確認外部副作用（投遞／寫檔／訊息）後，從節點 {', '.join(nodes)} 重跑或忽略。",
                     ref=ctx.run_id, link=f"/workflows/runs/{ctx.run_id}")
        except Exception as e:
            log.debug("inbox item skipped: %s", e)
        try:
            from ..events import record
            record("workflow.needs_attention", "workflow", ctx.run_id, {"workflow_id": ctx.workflow_id, "nodes": nodes, "error": ctx.error},
                   company_id=ctx.company_id, member_id=ctx.member_id)
        except Exception as e:
            log.debug("event record skipped: %s", e)

    # ------------------------------------------------------------------ state / persistence
    def _set_state(self, ctx: RunContext, nid: str, status: str, *, started: bool = False, finished: bool = False, reason: str = "") -> None:
        st = ctx.states[nid]
        st["status"] = status
        if started:
            st["started_at"] = _iso(now())
            st["finished_at"] = None
            st["error"] = ""
        if finished:
            st["finished_at"] = _iso(now())
        if reason:
            st["reason"] = reason
        self._event(ctx, {"type": "node.status", "node_id": nid, "status": status, "attempt": st.get("attempt", 0), **({"reason": reason} if reason else {})})

    def _event(self, ctx: RunContext, ev: dict[str, Any]) -> None:
        ctx.events.append({"ts": _iso(now()), "seq": len(ctx.events), **ev})

    def _add_usage(self, ctx: RunContext, nid: str, usage: dict[str, Any]) -> None:
        if not usage:
            return
        u = {k: float(usage.get(k) or 0) for k in ("input_tokens", "output_tokens", "total_tokens")}
        if not u["total_tokens"]:
            u["total_tokens"] = u["input_tokens"] + u["output_tokens"]
        cost = usage.get("cost_usd") or usage.get("cost")
        u["cost_usd"] = float(cost) if cost is not None else u["total_tokens"] / 1000 * self.default_cost_per_1k
        ctx.states[nid]["usage"] = u
        for k, v in u.items():
            ctx.usage[k] = ctx.usage.get(k, 0) + v

    def _budget_exceeded(self, ctx: RunContext) -> bool:
        mt = ctx.budget.get("max_tokens")
        mc = ctx.budget.get("max_cost_usd")
        if mt and ctx.usage["total_tokens"] > float(mt):
            ctx.error = f"超過 token 預算 {int(ctx.usage['total_tokens'])}/{mt}"
            return True
        if mc and ctx.usage["cost_usd"] > float(mc):
            ctx.error = f"超過成本預算 {ctx.usage['cost_usd']:.4f}/{mc} USD"
            return True
        return False

    def _cancel_pending_approvals(self, ctx: RunContext) -> None:
        with Session(self.db_engine) as db:
            for a in db.exec(select(WorkflowApproval).where(WorkflowApproval.run_id == ctx.run_id, WorkflowApproval.status == "pending")).all():
                a.status = "cancelled"
                db.add(a)
            db.commit()

    def _run_dict(self, ctx: RunContext) -> dict[str, Any]:
        return {"id": ctx.run_id, "status": ctx.status, "node_states": ctx.states, "events": ctx.events, "usage": ctx.usage,
                "decisions": ctx.decisions, "error": ctx.error}

    def _persist(self, ctx: RunContext, *, finished: bool = False) -> None:
        with Session(self.db_engine) as db:
            r = db.get(WorkflowRun, ctx.run_id)
            if r is None:
                return
            r.status = ctx.status
            r.node_states_json = json.dumps(ctx.states, ensure_ascii=False, default=str)
            r.events_json = json.dumps(ctx.events, ensure_ascii=False, default=str)
            r.usage_json = json.dumps(ctx.usage)
            r.error = ctx.error
            if finished:
                r.finished_at = now()
            db.add(r)
            existing = {n.node_id: n for n in db.exec(select(WorkflowRunNode).where(WorkflowRunNode.run_id == ctx.run_id)).all()}
            for nid, st in ctx.states.items():
                row = existing.get(nid) or WorkflowRunNode(run_id=ctx.run_id, node_id=nid, kind=node_kind(ctx.nodes[nid]))
                row.status = st.get("status", "pending")
                row.attempt = int(st.get("attempt", 0))
                row.session_id = st.get("session_id") or ""
                row.hermes_session_id = st.get("hermes_session_id") or ""
                row.output = st.get("output") or ""
                row.error = st.get("error") or ""
                row.usage_json = json.dumps(st.get("usage") or {})
                row.started_at = datetime.fromisoformat(st["started_at"]) if st.get("started_at") else None
                row.finished_at = datetime.fromisoformat(st["finished_at"]) if st.get("finished_at") else None
                db.add(row)
            db.commit()

    def _save_tool(self, session_id: str, run_id: str, name: str, args: Any, result: Any) -> None:
        with Session(self.db_engine) as db:
            db.add(Message(session_id=session_id, role="tool", content="", tool_name=name, run_id=run_id,
                           tool_args=json.dumps(args, ensure_ascii=False, default=str) if args is not None else None,
                           tool_result=json.dumps(result, ensure_ascii=False, default=str) if result is not None else None))
            db.commit()

    async def _broadcast(self, ctx: RunContext, ev: dict[str, Any]) -> None:
        try:
            await self.hub.broadcast(ctx.company_id, {"run_id": ctx.run_id, "workflow_id": ctx.workflow_id, "ts": _iso(now()), **ev})
        except Exception:
            log.debug("broadcast failed", exc_info=True)

    def _seed_from_parent(self, ctx: RunContext, parent: WorkflowRun, from_node: str) -> None:
        """Rerun from a node: reuse parent outputs for everything not downstream of `from_node`."""
        pstates = json.loads(parent.node_states_json or "{}")
        pevents = json.loads(parent.events_json or "[]")
        pdecisions: dict[str, bool] = {}
        for ev in pevents:
            if ev.get("type") == "edge.decision":
                pdecisions[ev["edge"]] = bool(ev.get("taken"))
        downstream = {from_node}
        changed = True
        while changed:
            changed = False
            for e in ctx.edges:
                if e.get("loop_back"):
                    continue
                if str(e["source"]) in downstream and str(e["target"]) not in downstream:
                    downstream.add(str(e["target"]))
                    changed = True
        for nid in ctx.nodes:
            if nid in downstream:
                continue
            ps = pstates.get(nid)
            if ps and ps.get("status") in ("completed", "reused"):
                ctx.states[nid] = dict(ps, status="reused")
                for e in ctx.outgoing(nid):
                    k = ctx.edge_key(e)
                    if k in pdecisions:
                        ctx.decisions[k] = pdecisions[k]
        self._event(ctx, {"type": "run.rerun", "from_node": from_node, "parent_run_id": parent.id,
                          "reused": [n for n, s in ctx.states.items() if s.get("status") == "reused"]})


def approval_open(engine: WorkflowEngine, run_id: str) -> bool:
    return run_id in engine.runs
