"""把三家 CLI 的 JSONL 串流轉成統一事件（純函式，方便測試）。

統一事件（dict，都有 type）：
- session.init   {external_session_id, model?}
- message.delta  {delta}
- tool.started   {name, args, call_id}
- tool.completed {name, result, call_id, error?}
- run.completed  {output, usage, external_session_id?}
- run.failed     {error}
- log            {text}   （非結構化／不認得的行，前端當日誌顯示）
"""
from __future__ import annotations

import json
from typing import Any, Callable


class ParserState:
    """跨行狀態：claude 的 tool_use id→name、已輸出的文字（避免重複）。"""

    def __init__(self) -> None:
        self.tool_names: dict[str, str] = {}
        self.text_parts: list[str] = []
        self.external_session_id: str = ""
        self.done: bool = False


def _j(obj: Any) -> str:
    if isinstance(obj, str):
        return obj
    try:
        return json.dumps(obj, ensure_ascii=False)
    except Exception:
        return str(obj)


# ---------------------------------------------------------------- claude
def parse_claude(line: str, st: ParserState) -> list[dict[str, Any]]:
    line = line.strip()
    if not line:
        return []
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        return [{"type": "log", "text": line}]
    if not isinstance(ev, dict):
        return [{"type": "log", "text": line}]
    t = ev.get("type")
    out: list[dict[str, Any]] = []
    sid = ev.get("session_id")
    if sid and not st.external_session_id:
        st.external_session_id = sid
    if t == "system":
        if ev.get("subtype") == "init":
            out.append({"type": "session.init", "external_session_id": sid or "", "model": ev.get("model", "")})
        return out
    if t == "rate_limit_event":
        return out
    if t == "assistant":
        for block in (ev.get("message") or {}).get("content") or []:
            bt = block.get("type")
            if bt == "text" and block.get("text"):
                st.text_parts.append(block["text"])
                out.append({"type": "message.delta", "delta": block["text"]})
            elif bt == "tool_use":
                cid = block.get("id") or ""
                st.tool_names[cid] = block.get("name") or "tool"
                out.append({"type": "tool.started", "name": st.tool_names[cid], "args": block.get("input"), "call_id": cid})
        return out
    if t == "user":
        for block in (ev.get("message") or {}).get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                cid = block.get("tool_use_id") or ""
                content = block.get("content")
                if isinstance(content, list):
                    content = "\n".join(_j(c.get("text", c)) if isinstance(c, dict) else _j(c) for c in content)
                out.append({"type": "tool.completed", "name": st.tool_names.get(cid, "tool"), "call_id": cid,
                            "result": content, "error": bool(block.get("is_error"))})
        return out
    if t == "stream_event":  # --include-partial-messages
        inner = ev.get("event") or {}
        if inner.get("type") == "content_block_delta" and (inner.get("delta") or {}).get("type") == "text_delta":
            out.append({"type": "message.delta", "delta": inner["delta"].get("text", "")})
        return out
    if t == "result":
        st.done = True
        if ev.get("is_error") or ev.get("subtype") not in (None, "success"):
            err = ev.get("result") or ev.get("error") or ev.get("subtype") or "failed"
            out.append({"type": "run.failed", "error": _j(err), "usage": ev.get("usage") or {},
                        "external_session_id": sid or st.external_session_id})
        else:
            usage = dict(ev.get("usage") or {})
            if ev.get("total_cost_usd") is not None:
                usage["cost_usd"] = ev.get("total_cost_usd")
            usage["num_turns"] = ev.get("num_turns")
            out.append({"type": "run.completed", "output": ev.get("result") or "".join(st.text_parts), "usage": usage,
                        "external_session_id": sid or st.external_session_id})
        return out
    return [{"type": "log", "text": line[:2000]}]


# ---------------------------------------------------------------- codex
def parse_codex(line: str, st: ParserState) -> list[dict[str, Any]]:
    line = line.strip()
    if not line:
        return []
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        return [{"type": "log", "text": line}]
    if not isinstance(ev, dict):
        return [{"type": "log", "text": line}]
    t = ev.get("type")
    out: list[dict[str, Any]] = []
    if t == "thread.started":
        st.external_session_id = ev.get("thread_id") or ""
        out.append({"type": "session.init", "external_session_id": st.external_session_id})
    elif t in ("item.started", "item.updated", "item.completed"):
        item = ev.get("item") or {}
        it = item.get("type")
        iid = item.get("id") or ""
        if it == "agent_message":
            if t == "item.completed" and item.get("text"):
                st.text_parts.append(item["text"])
                out.append({"type": "message.delta", "delta": item["text"]})
        elif it in ("command_execution", "file_change", "mcp_tool_call", "web_search", "patch_apply"):
            name = it
            args: Any = item.get("command") or item.get("changes") or item.get("query") or {k: v for k, v in item.items() if k not in ("id", "type", "status", "aggregated_output", "exit_code")}
            if t == "item.started":
                st.tool_names[iid] = name
                out.append({"type": "tool.started", "name": name, "args": args, "call_id": iid})
            elif t == "item.completed":
                if iid not in st.tool_names:
                    out.append({"type": "tool.started", "name": name, "args": args, "call_id": iid})
                result: Any = item.get("aggregated_output") or item.get("output") or item.get("result")
                if result is None:
                    result = {k: v for k, v in item.items() if k not in ("id", "type")}
                err = item.get("status") in ("failed", "error") or (item.get("exit_code") not in (None, 0))
                out.append({"type": "tool.completed", "name": name, "result": result, "call_id": iid, "error": bool(err)})
        elif it == "reasoning":
            pass
        elif it == "error":
            out.append({"type": "log", "text": str(item.get("message") or "")})
        else:
            out.append({"type": "log", "text": line[:2000]})
    elif t == "turn.completed":
        st.done = True
        out.append({"type": "run.completed", "output": "".join(st.text_parts), "usage": ev.get("usage") or {},
                    "external_session_id": st.external_session_id})
    elif t == "turn.failed" or t == "error":
        st.done = True
        err = ev.get("error") or ev.get("message") or "failed"
        if isinstance(err, dict):
            err = err.get("message") or _j(err)
        out.append({"type": "run.failed", "error": str(err), "external_session_id": st.external_session_id})
    elif t == "turn.started":
        pass
    else:
        out.append({"type": "log", "text": line[:2000]})
    return out


# ---------------------------------------------------------------- pi
def parse_pi(line: str, st: ParserState) -> list[dict[str, Any]]:
    """pi --mode json：AgentEvent JSONL（agent_start / message_update / tool_execution_* / agent_end）。
    未在本機實測（pi 未安裝），欄位依 pi-agent-core 公開型別，另外容錯常見別名。"""
    line = line.strip()
    if not line:
        return []
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        return [{"type": "log", "text": line}]
    if not isinstance(ev, dict):
        return [{"type": "log", "text": line}]
    t = ev.get("type")
    out: list[dict[str, Any]] = []
    sid = ev.get("sessionId") or ev.get("session_id") or ev.get("sessionFile")
    if sid and not st.external_session_id:
        st.external_session_id = str(sid)
        out.append({"type": "session.init", "external_session_id": st.external_session_id})
    if t == "message_update":
        ame = ev.get("assistantMessageEvent") or ev.get("event") or {}
        if ame.get("type") == "text_delta" and ame.get("delta"):
            st.text_parts.append(ame["delta"])
            out.append({"type": "message.delta", "delta": ame["delta"]})
    elif t == "message_end":
        msg = ev.get("message") or {}
        if msg.get("role") == "assistant" and not st.text_parts:
            for block in msg.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                    st.text_parts.append(block["text"])
                    out.append({"type": "message.delta", "delta": block["text"]})
    elif t == "tool_execution_start":
        cid = ev.get("toolCallId") or ""
        name = ev.get("toolName") or "tool"
        st.tool_names[cid] = name
        out.append({"type": "tool.started", "name": name, "args": ev.get("args"), "call_id": cid})
    elif t == "tool_execution_end":
        cid = ev.get("toolCallId") or ""
        out.append({"type": "tool.completed", "name": ev.get("toolName") or st.tool_names.get(cid, "tool"),
                    "result": ev.get("result"), "call_id": cid, "error": bool(ev.get("isError"))})
    elif t == "agent_end":
        st.done = True
        out.append({"type": "run.completed", "output": "".join(st.text_parts), "usage": ev.get("usage") or {},
                    "external_session_id": st.external_session_id})
    elif t == "error":
        st.done = True
        out.append({"type": "run.failed", "error": str(ev.get("error") or ev.get("message") or "failed")})
    elif t in ("agent_start", "turn_start", "turn_end", "message_start"):
        pass
    else:
        out.append({"type": "log", "text": line[:2000]})
    return out


PARSERS: dict[str, Callable[[str, ParserState], list[dict[str, Any]]]] = {
    "claude": parse_claude, "codex": parse_codex, "pi": parse_pi,
}
