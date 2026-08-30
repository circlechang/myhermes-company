"""Side-effecting node runners: coding-agent subprocesses and deliveries.
Kept separate from the engine so tests can swap them (engine.coding_runner / engine.deliverer)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

import httpx

log = logging.getLogger("studio.workflows.runners")

CODING_BINS = {"claude-code": "claude", "codex": "codex", "pi": "pi"}


def coding_tool_available(tool: str) -> Optional[str]:
    b = CODING_BINS.get(tool)
    return shutil.which(b) if b else None


def coding_tools_status() -> dict[str, dict[str, Any]]:
    return {t: {"bin": b, "path": coding_tool_available(t), "installed": bool(coding_tool_available(t))} for t, b in CODING_BINS.items()}


OnDelta = Callable[[str], Awaitable[None]]


async def run_coding_agent(tool: str, prompt: str, cwd: str, *, on_delta: Optional[OnDelta] = None,
                           timeout: float = 1800.0) -> dict[str, Any]:
    """Run claude / codex / pi as a subprocess; returns {output, exit_code, usage?}.
    claude: `claude -p <prompt> --output-format stream-json --verbose` (JSONL events)
    codex : `codex exec --json <prompt>` (JSONL events) — falls back to plain text
    pi    : `pi -p <prompt>` (plain text)"""
    exe = coding_tool_available(tool)
    if not exe:
        raise FileNotFoundError(f"{tool} 未安裝")
    if tool == "claude-code":
        cmd = [exe, "-p", prompt, "--output-format", "stream-json", "--verbose"]
    elif tool == "codex":
        cmd = [exe, "exec", "--json", "--skip-git-repo-check", prompt]
    else:
        cmd = [exe, "-p", prompt]
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)  # allow nested launch from inside a Claude Code session
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=cwd or None, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL, env=env)
    chunks: list[str] = []
    final: Optional[str] = None
    usage: dict[str, Any] = {}

    async def read_stdout():
        nonlocal final, usage
        assert proc.stdout
        async for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if not line:
                continue
            ev: Any = None
            if line.startswith("{"):
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    ev = None
            if ev is None:
                chunks.append(line + "\n")
                if on_delta:
                    await on_delta(line + "\n")
                continue
            text = _extract_text(tool, ev)
            if text:
                chunks.append(text)
                if on_delta:
                    await on_delta(text)
            if ev.get("type") == "result":  # claude final
                if isinstance(ev.get("result"), str):
                    final = ev["result"]
                u = ev.get("usage") or {}
                if u:
                    usage = {"input_tokens": u.get("input_tokens", 0), "output_tokens": u.get("output_tokens", 0),
                             "total_tokens": u.get("input_tokens", 0) + u.get("output_tokens", 0),
                             "cost_usd": ev.get("total_cost_usd")}
            if ev.get("type") == "turn.completed":  # codex
                u = ev.get("usage") or {}
                if u:
                    usage = {"input_tokens": u.get("input_tokens", 0), "output_tokens": u.get("output_tokens", 0),
                             "total_tokens": u.get("input_tokens", 0) + u.get("output_tokens", 0)}

    try:
        await asyncio.wait_for(read_stdout(), timeout=timeout)
        stderr = (await proc.stderr.read()).decode("utf-8", "replace") if proc.stderr else ""
        code = await proc.wait()
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"{tool} 執行超過 {timeout:.0f} 秒")
    except asyncio.CancelledError:
        proc.kill()
        raise
    output = final if final is not None else "".join(chunks).strip()
    if code != 0 and not output:
        output = stderr.strip()[-2000:]
    return {"output": output, "exit_code": code, "usage": usage, "stderr": stderr[-2000:]}


def _extract_text(tool: str, ev: dict[str, Any]) -> str:
    t = ev.get("type")
    if tool == "claude-code":
        if t == "assistant":
            msg = ev.get("message") or {}
            parts = msg.get("content") or []
            return "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
        if t == "stream_event":
            e = ev.get("event") or {}
            if e.get("type") == "content_block_delta":
                return (e.get("delta") or {}).get("text", "")
        return ""
    if tool == "codex":
        if t == "item.completed":
            item = ev.get("item") or {}
            if item.get("type") == "agent_message":
                return str(item.get("text") or "")
        return ""
    return str(ev.get("text") or "")


# -- deliveries -----------------------------------------------------------

def line_token(hermes_home: Path) -> str:
    from ...config import _read_env_file
    return _read_env_file(hermes_home / ".env").get("LINE_CHANNEL_ACCESS_TOKEN", "")


async def deliver(node: dict[str, Any], text: str, *, hermes_home: Path, workspace: Path, run_id: str,
                  http: Optional[httpx.AsyncClient] = None) -> dict[str, Any]:
    ch = node.get("channel")
    if ch == "line":
        token = line_token(hermes_home)
        if not token:
            raise RuntimeError("LINE 未設定：~/.hermes/.env 缺 LINE_CHANNEL_ACCESS_TOKEN")
        body = {"to": node["to"], "messages": [{"type": "text", "text": text[:5000] or "(空)"}]}
        async with (http or httpx.AsyncClient(timeout=20.0)) as c:
            r = await c.post("https://api.line.me/v2/bot/message/push", json=body,
                             headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            if r.status_code >= 400:
                raise RuntimeError(f"LINE push 失敗 {r.status_code}: {r.text[:300]}")
        return {"channel": "line", "to": node["to"], "status": r.status_code}
    if ch == "webhook":
        payload = {"run_id": run_id, "node_id": node.get("id"), "title": node.get("title"), "text": text}
        async with (http or httpx.AsyncClient(timeout=20.0)) as c:
            r = await c.post(node["url"], json=payload, headers={"Content-Type": "application/json"})
            if r.status_code >= 400:
                raise RuntimeError(f"webhook 回 {r.status_code}: {r.text[:300]}")
        return {"channel": "webhook", "url": node["url"], "status": r.status_code}
    if ch == "file":
        rel = str(node.get("path") or "").replace("{run_id}", run_id)
        target = (workspace / rel).resolve()
        if not str(target).startswith(str(workspace.resolve())):
            raise RuntimeError("path 必須在工作區內")
        target.parent.mkdir(parents=True, exist_ok=True)
        mode = "a" if node.get("append") else "w"
        with open(target, mode, encoding="utf-8") as f:
            f.write(text)
            if node.get("append"):
                f.write("\n")
        return {"channel": "file", "path": str(target), "bytes": len(text.encode("utf-8"))}
    raise RuntimeError(f"未知投遞管道 {ch}")
