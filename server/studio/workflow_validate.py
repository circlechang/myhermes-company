"""Workflow graph validation (docs/API.md, docs/parity/workflows.md).

節點 kind：hermes（別名 agent）/ coding-agent / gate / condition / loop / delivery。
邊：`on` = always|success|failure；`sourceHandle` 依節點種類：
  - 一般節點：output（預設）
  - condition：true / false（也接受 output＝不分支）
  - loop：body（迴圈本體）/ exit（結束後）
  - targetHandle 只能是 input。
迴圈（受控回邊）定義：`loop_back: true` 的邊，其 target 必須是 loop 節點，
且 source 必須在該 loop 節點的 body 可達範圍內。拿掉所有 loop_back 邊之後，
整張圖必須是 DAG；沒有 loop_back 的環一律拒絕。
"""
from __future__ import annotations

from collections import defaultdict, deque
from typing import Any

VALID_KINDS = {"agent", "hermes", "coding-agent", "gate", "condition", "loop", "delivery"}
VALID_ON = {"always", "success", "failure"}
SOURCE_HANDLES = {
    "condition": {"output", "true", "false"},
    "loop": {"output", "body", "exit"},
}
VALID_CODING_TOOLS = {"claude-code", "codex", "pi"}
# docs 模組：節點可以改成「傳文件」而不是「傳文字」（io_mode: text|doc，預設 text＝向後相容）
VALID_IO_MODES = {"text", "doc"}
VALID_DOC_OPS = {"transform", "fanout", "select", "merge"}
VALID_SELECT_BY = {"human", "ai"}
VALID_DELIVERY = {"line", "webhook", "file"}
VALID_CONDITION_OPS = {"contains", "not_contains", "regex", "json_path", "min_length", "max_length", "equals"}


class WorkflowValidationError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def node_kind(n: dict) -> str:
    k = n.get("kind", "hermes")
    return "hermes" if k == "agent" else k


def _check_rule(rule: Any, where: str, errors: list[str]) -> None:
    if not isinstance(rule, dict):
        errors.append(f"{where} 缺少條件規則")
        return
    op = rule.get("op")
    if op not in VALID_CONDITION_OPS:
        errors.append(f"{where} 條件運算子不合法: {op}")
        return
    if op in ("min_length", "max_length"):
        try:
            int(rule.get("value"))
        except (TypeError, ValueError):
            errors.append(f"{where} 長度條件的 value 必須是整數")
    elif op == "json_path":
        if not str(rule.get("path") or "").strip():
            errors.append(f"{where} json_path 條件必須有 path")
    elif not str(rule.get("value") or "").strip():
        errors.append(f"{where} 條件必須有 value")


def doc_op(n: dict) -> str:
    """節點的文件操作；不是 doc 模式回 ""。"""
    if str(n.get("io_mode") or "text") != "doc":
        return ""
    return str(n.get("doc_op") or "transform")


def _check_doc_mode(n: dict, nid: str) -> tuple[list[str], bool]:
    """驗 io_mode / doc_op 等欄位。回 (錯誤清單, 是否為「人選一份」的閘門節點)。"""
    errors: list[str] = []
    io = str(n.get("io_mode") or "text")
    if io not in VALID_IO_MODES:
        return [f"節點 {nid} io_mode 必須是 text 或 doc"], False
    if io != "doc":
        return errors, False
    op = str(n.get("doc_op") or "transform")
    if op not in VALID_DOC_OPS:
        return [f"doc 節點 {nid} doc_op 必須是 {'/'.join(sorted(VALID_DOC_OPS))}"], False
    if op == "fanout":
        try:
            cnt = int(n.get("fanout_count", 3))
        except (TypeError, ValueError):
            cnt = 0
        if cnt < 2 or cnt > 20:
            errors.append(f"doc 節點 {nid} fanout_count 必須介於 2–20")
    human_select = False
    if op == "select":
        by = str(n.get("select_by") or "ai")
        if by not in VALID_SELECT_BY:
            errors.append(f"doc 節點 {nid} select_by 必須是 human 或 ai")
        human_select = by == "human"
    for key in ("doc_path", "doc_path_pattern", "doc_glob"):
        v = n.get(key)
        if v is not None and not isinstance(v, str):
            errors.append(f"doc 節點 {nid} {key} 必須是字串")
    if op == "fanout" and n.get("doc_path_pattern") and "{i}" not in str(n["doc_path_pattern"]):
        errors.append(f"doc 節點 {nid} doc_path_pattern 必須含有 {{i}}")
    return errors, human_select


def validate_workflow(nodes: Any, edges: Any) -> None:
    errors: list[str] = []
    if not isinstance(nodes, list) or not nodes:
        raise WorkflowValidationError(["工作流至少要有 1 個節點"])
    if not isinstance(edges, list):
        raise WorkflowValidationError(["edges 必須是陣列"])

    ids: list[str] = []
    kinds: dict[str, str] = {}
    for i, n in enumerate(nodes):
        if not isinstance(n, dict) or not n.get("id"):
            errors.append(f"nodes[{i}] 缺少 id")
            continue
        nid = str(n["id"])
        if nid in ids:
            errors.append(f"節點 id 重複: {nid}")
        ids.append(nid)
        raw_kind = n.get("kind", "hermes")
        if raw_kind not in VALID_KINDS:
            errors.append(f"節點 {nid} kind 不合法: {raw_kind}")
            continue
        kind = node_kind(n)
        kinds[nid] = kind
        if kind == "hermes":
            doc_errs, human_select = _check_doc_mode(n, nid)
            errors.extend(doc_errs)
            if not (n.get("agent_id") or n.get("agent")) and not human_select:
                errors.append(f"agent 節點 {nid} 必須指定 agent_id")
            if not str(n.get("prompt") or "").strip() and not human_select:
                errors.append(f"agent 節點 {nid} 必須有 prompt")
        elif kind == "coding-agent":
            if n.get("tool") not in VALID_CODING_TOOLS:
                errors.append(f"coding-agent 節點 {nid} tool 必須是 claude-code/codex/pi")
            if not str(n.get("prompt") or n.get("command") or "").strip():
                errors.append(f"coding-agent 節點 {nid} 必須有指令")
        elif kind == "condition":
            mode = n.get("mode", "rule")
            if mode == "ai":
                if not (n.get("agent_id") or n.get("agent")):
                    errors.append(f"condition 節點 {nid}（AI 判斷）必須指定 agent_id")
                if not str(n.get("prompt") or "").strip():
                    errors.append(f"condition 節點 {nid}（AI 判斷）必須有判斷提示")
            elif mode == "rule":
                _check_rule(n.get("rule"), f"condition 節點 {nid}", errors)
            else:
                errors.append(f"condition 節點 {nid} mode 必須是 rule 或 ai")
        elif kind == "loop":
            try:
                mx = int(n.get("max_iterations", 0))
            except (TypeError, ValueError):
                mx = 0
            if mx < 1 or mx > 100:
                errors.append(f"loop 節點 {nid} max_iterations 必須介於 1–100")
            if n.get("until") is not None:
                _check_rule(n.get("until"), f"loop 節點 {nid} until", errors)
        elif kind == "delivery":
            ch = n.get("channel")
            if ch not in VALID_DELIVERY:
                errors.append(f"delivery 節點 {nid} channel 必須是 line/webhook/file")
            elif ch == "line" and not str(n.get("to") or "").strip():
                errors.append(f"delivery 節點 {nid}（LINE）必須填 userId/groupId")
            elif ch == "webhook" and not str(n.get("url") or "").startswith(("http://", "https://")):
                errors.append(f"delivery 節點 {nid}（webhook）url 必須是 http(s)")
            elif ch == "file" and not str(n.get("path") or "").strip():
                errors.append(f"delivery 節點 {nid}（file）必須填 path")
    id_set = set(ids)

    adj: dict[str, list[str]] = defaultdict(list)  # 不含 loop_back
    full_adj: dict[str, list[str]] = defaultdict(list)
    undirected: dict[str, set[str]] = defaultdict(set)
    seen_edges: set[tuple[str, str, str]] = set()
    loop_backs: list[tuple[int, str, str]] = []
    for i, e in enumerate(edges):
        if not isinstance(e, dict):
            errors.append(f"edges[{i}] 格式錯誤")
            continue
        s, t = str(e.get("source") or ""), str(e.get("target") or "")
        src_handle = e.get("sourceHandle") or e.get("source_handle") or "output"
        tgt_handle = e.get("targetHandle") or e.get("target_handle") or "input"
        if tgt_handle != "input":
            errors.append(f"edges[{i}] 必須接到 input（得到 {tgt_handle}）")
        if s not in id_set or t not in id_set:
            errors.append(f"edges[{i}] 指到不存在的節點: {s} -> {t}")
            continue
        allowed = SOURCE_HANDLES.get(kinds.get(s, ""), {"output"})
        if src_handle not in allowed:
            errors.append(f"edges[{i}] 必須從 {'/'.join(sorted(allowed))} 出發（得到 {src_handle}）")
        if s == t:
            errors.append(f"edges[{i}] 不可自迴圈: {s}")
            continue
        key = (s, t, src_handle)
        if key in seen_edges:
            errors.append(f"edges[{i}] 重複的邊: {s} -> {t}")
            continue
        if e.get("on", "always") not in VALID_ON:
            errors.append(f"edges[{i}] on 不合法: {e.get('on')}")
        seen_edges.add(key)
        full_adj[s].append(t)
        undirected[s].add(t)
        undirected[t].add(s)
        if e.get("loop_back"):
            if kinds.get(t) != "loop":
                errors.append(f"edges[{i}] loop_back 邊的 target 必須是 loop 節點: {s} -> {t}")
            loop_backs.append((i, s, t))
        else:
            adj[s].append(t)

    if errors:
        raise WorkflowValidationError(errors)

    # acyclic (Kahn) on graph without loop_back edges
    indeg = {n: 0 for n in ids}
    for s, ts in adj.items():
        for t in ts:
            indeg[t] += 1
    q = deque(n for n in ids if indeg[n] == 0)
    visited = 0
    while q:
        n = q.popleft()
        visited += 1
        for t in adj[n]:
            indeg[t] -= 1
            if indeg[t] == 0:
                q.append(t)
    if visited != len(ids):
        errors.append("工作流有環（cycle）；迴圈請用 loop 節點並把回邊標記 loop_back")

    # loop_back source must be reachable from the loop node's body branch (without loop_back edges)
    body_targets: dict[str, set[str]] = defaultdict(set)
    for e in edges:
        if e.get("loop_back"):
            continue
        s, t = str(e.get("source")), str(e.get("target"))
        if kinds.get(s) == "loop" and (e.get("sourceHandle") or e.get("source_handle") or "output") in ("body", "output"):
            body_targets[s].add(t)
    for i, s, t in loop_backs:
        reach = set()
        stack = list(body_targets.get(t, ()))
        while stack:
            n = stack.pop()
            if n in reach:
                continue
            reach.add(n)
            stack.extend(adj[n])
        if s not in reach:
            errors.append(f"edges[{i}] loop_back 的 source {s} 不在 loop 節點 {t} 的 body 範圍內")

    # single connected component
    if len(ids) > 1:
        start = ids[0]
        seen = {start}
        stack = [start]
        while stack:
            n = stack.pop()
            for m in undirected[n]:
                if m not in seen:
                    seen.add(m)
                    stack.append(m)
        if len(seen) != len(ids):
            errors.append("工作流必須是單一連通圖（有孤立節點或子圖）")

    if errors:
        raise WorkflowValidationError(errors)


def topological_order(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Kahn order ignoring loop_back edges."""
    ids = [str(n["id"]) for n in nodes]
    adj: dict[str, list[str]] = defaultdict(list)
    indeg = {n: 0 for n in ids}
    for e in edges:
        if e.get("loop_back"):
            continue
        adj[str(e["source"])].append(str(e["target"]))
        indeg[str(e["target"])] += 1
    q = deque(n for n in ids if indeg[n] == 0)
    out: list[str] = []
    while q:
        n = q.popleft()
        out.append(n)
        for t in adj[n]:
            indeg[t] -= 1
            if indeg[t] == 0:
                q.append(t)
    return out


def loop_body(nodes: list[dict], edges: list[dict], loop_id: str) -> set[str]:
    """Nodes inside loop `loop_id`: reachable from its body branch (no loop_back) and able to reach a loop_back edge into it."""
    adj: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        if not e.get("loop_back"):
            adj[str(e["source"])].append(str(e["target"]))
    starts = [str(e["target"]) for e in edges if str(e["source"]) == loop_id and not e.get("loop_back")
              and (e.get("sourceHandle") or e.get("source_handle") or "output") in ("body", "output")]
    reach: set[str] = set()
    stack = list(starts)
    while stack:
        n = stack.pop()
        if n in reach:
            continue
        reach.add(n)
        stack.extend(adj[n])
    back_sources = {str(e["source"]) for e in edges if e.get("loop_back") and str(e["target"]) == loop_id}
    # keep only nodes that can reach a back source (forward closure ∩ backward closure)
    radj: dict[str, list[str]] = defaultdict(list)
    for s, ts in adj.items():
        for t in ts:
            radj[t].append(s)
    can_reach_back: set[str] = set()
    stack = list(back_sources)
    while stack:
        n = stack.pop()
        if n in can_reach_back:
            continue
        can_reach_back.add(n)
        stack.extend(radj[n])
    return reach & can_reach_back
