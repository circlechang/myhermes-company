"""以 subprocess 執行 coding agent CLI，把 JSONL 輸出轉成統一事件；含 git diff 快照。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shlex
import signal
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from .detect import search_path
from .parsers import PARSERS, ParserState

log = logging.getLogger("studio.coding")

PROXY_ENV_KEY = "MHC_PROXY_KEY"


@dataclass
class RunSpec:
    agent: str
    prompt: str
    workspace: str
    bin_path: str
    model: str = ""
    resume_id: str = ""
    images: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)
    # api_mode=hermes 時給的 proxy 資訊：{"base": "http://127.0.0.1:8700", "token": "..."}
    proxy: Optional[dict[str, str]] = None


def build_command(spec: RunSpec) -> tuple[list[str], dict[str, str]]:
    """回傳 (argv, env)。純函式，測試直接檢查。"""
    env = {k: v for k, v in os.environ.items()}
    env["PATH"] = search_path()
    env.pop("CLAUDECODE", None)  # 允許在 Claude Code 內再開一個 claude
    ex = spec.extra or {}
    prompt = spec.prompt
    argv: list[str]

    if spec.agent == "claude":
        if spec.images:
            prompt += "\n\n[附件圖片] 請先用 Read 工具讀取以下檔案：\n" + "\n".join(spec.images)
        argv = [spec.bin_path, "-p", prompt, "--output-format", "stream-json", "--verbose"]
        if spec.model:
            argv += ["--model", spec.model]
        if spec.resume_id:
            argv += ["--resume", spec.resume_id]
        pm = ex.get("permission_mode") or "acceptEdits"
        if pm == "bypassPermissions" or ex.get("dangerously_skip_permissions"):
            argv += ["--dangerously-skip-permissions"]
        else:
            argv += ["--permission-mode", pm]
        if ex.get("max_turns"):
            argv += ["--max-turns", str(int(ex["max_turns"]))]
        if ex.get("max_budget_usd") and not spec.proxy:
            # 走 Hermes proxy 時 Claude Code 用 Anthropic 牌價算成本會誤判超支（實測 error_max_budget_usd），不帶
            argv += ["--max-budget-usd", str(ex["max_budget_usd"])]
        if ex.get("allowed_tools"):
            argv += ["--allowedTools", str(ex["allowed_tools"])]
        if spec.proxy:
            env["ANTHROPIC_BASE_URL"] = spec.proxy["base"].rstrip("/") + "/coding/proxy/anthropic"
            env["ANTHROPIC_AUTH_TOKEN"] = spec.proxy["token"]
            env.pop("ANTHROPIC_API_KEY", None)
            env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    elif spec.agent == "codex":
        argv = [spec.bin_path, "exec", "--json", "--skip-git-repo-check"]
        if spec.workspace:
            argv += ["-C", spec.workspace]
        model = spec.model
        if spec.proxy:
            base = spec.proxy["base"].rstrip("/") + "/coding/proxy/openai/v1"
            argv += ["-c", "model_provider=myhermescompany",
                     "-c", 'model_providers.myhermescompany.name="MyHermesCompany"',
                     "-c", f'model_providers.myhermescompany.base_url="{base}"',
                     "-c", 'model_providers.myhermescompany.wire_api="responses"',
                     "-c", f'model_providers.myhermescompany.env_key="{PROXY_ENV_KEY}"']
            env[PROXY_ENV_KEY] = spec.proxy["token"]
            model = model or "hermes-agent"
        if model:
            argv += ["-m", model]
        sandbox = ex.get("sandbox") or "workspace-write"
        if sandbox == "danger-full-access" and ex.get("dangerously_skip_permissions"):
            argv += ["--dangerously-bypass-approvals-and-sandbox"]
        else:
            argv += ["-s", sandbox]
        for img in spec.images:
            argv += ["-i", img]
        if spec.resume_id:
            argv += ["resume", spec.resume_id, prompt]
        else:
            argv += [prompt]
    elif spec.agent == "pi":
        argv = [spec.bin_path, "-p", "--mode", "json"]
        if spec.model:
            argv += ["--model", spec.model]
        if spec.resume_id:
            argv += ["--session", spec.resume_id]
        argv += [prompt]
    else:
        raise ValueError(f"unknown agent: {spec.agent}")
    return argv, env


def redacted_command(argv: list[str]) -> str:
    """顯示給前端的指令列：提示詞截短。"""
    parts = []
    for a in argv:
        if len(a) > 80:
            a = a[:77] + "…"
        parts.append(shlex.quote(a))
    return " ".join(parts)


# ---------------------------------------------------------------- git
async def _git(workspace: str, *args: str, timeout: float = 20.0) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args, cwd=workspace, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, out.decode("utf-8", "replace")
    except Exception as e:  # git 不存在／逾時
        return 1, str(e)


async def is_git_repo(workspace: str) -> bool:
    if not workspace or not Path(workspace).is_dir():
        return False
    code, out = await _git(workspace, "rev-parse", "--is-inside-work-tree")
    return code == 0 and out.strip() == "true"


async def git_snapshot(workspace: str) -> dict[str, Any]:
    """{diff, files}：diff = `git diff HEAD`（無 commit 時退回 `git diff`），files = porcelain。"""
    if not await is_git_repo(workspace):
        return {"diff": "", "files": [], "is_git": False}
    code, diff = await _git(workspace, "diff", "HEAD", "--no-color")
    if code != 0:
        _, diff = await _git(workspace, "diff", "--no-color")
    _, status = await _git(workspace, "status", "--porcelain", "--untracked-files=all")
    files = []
    for line in status.splitlines():
        if len(line) >= 4:
            files.append({"status": line[:2].strip() or "??", "path": line[3:]})
    # 新增（未追蹤）檔案 git diff 看不到，補上內容當新增 diff（限 200KB）
    extra = []
    for f in files:
        if f["status"] == "??":
            p = Path(workspace) / f["path"]
            try:
                if p.is_file() and p.stat().st_size < 200_000:
                    text = p.read_text(encoding="utf-8")
                    body = "".join(f"+{l}\n" for l in text.splitlines())
                    extra.append(f"diff --git a/{f['path']} b/{f['path']}\nnew file mode 100644\n--- /dev/null\n+++ b/{f['path']}\n@@ -0,0 +1,{len(text.splitlines())} @@\n{body}")
            except Exception:
                pass
    return {"diff": diff[:2_000_000] + "".join(extra), "files": files, "is_git": True}


# ---------------------------------------------------------------- process
class AgentProcess:
    def __init__(self, run_id: str, proc: asyncio.subprocess.Process):
        self.run_id = run_id
        self.proc = proc
        self.cancelled = False

    async def stop(self) -> None:
        self.cancelled = True
        if self.proc.returncode is None:
            # 整個 process group 一起殺：CLI 會再開 node／shell 子程序，只殺父程序 stdout 不會關
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass


EventCb = Callable[[dict[str, Any]], Awaitable[None]]


async def run_agent(spec: RunSpec, run_id: str, on_event: EventCb, *, registry: dict[str, AgentProcess],
                    timeout: float = 3600.0) -> dict[str, Any]:
    """啟動 CLI、逐行解析、回呼事件。回傳 {status, exit_code, external_session_id, output, usage, error}。"""
    argv, env = build_command(spec)
    parser = PARSERS[spec.agent]
    st = ParserState()
    cwd = spec.workspace if spec.workspace and Path(spec.workspace).is_dir() else None
    result: dict[str, Any] = {"status": "failed", "exit_code": None, "external_session_id": "", "output": "",
                              "usage": {}, "error": ""}
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=cwd, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
        )
    except FileNotFoundError:
        result["error"] = f"CLI not found: {argv[0]}"
        await on_event({"type": "run.failed", "error": result["error"]})
        return result
    ap = AgentProcess(run_id, proc)
    registry[run_id] = ap
    await on_event({"type": "run.started", "command": redacted_command(argv)})
    stderr_tail: list[str] = []

    async def pump_stderr():
        assert proc.stderr
        async for raw in proc.stderr:
            text = raw.decode("utf-8", "replace").rstrip()
            if text:
                stderr_tail.append(text)
                del stderr_tail[:-50]
                await on_event({"type": "log", "text": text, "stream": "stderr"})

    terminal_seen = False

    async def pump_stdout():
        nonlocal terminal_seen
        assert proc.stdout
        while True:
            try:
                raw = await proc.stdout.readline()
            except (ValueError, asyncio.LimitOverrunError):  # 超長行
                await on_event({"type": "log", "text": "[line too long, skipped]"})
                continue
            if not raw:
                break
            for ev in parser(raw.decode("utf-8", "replace"), st):
                if ev["type"] in ("run.completed", "run.failed"):
                    terminal_seen = True
                    result["status"] = "completed" if ev["type"] == "run.completed" else "failed"
                    result["output"] = ev.get("output") or "".join(st.text_parts)
                    result["usage"] = ev.get("usage") or {}
                    result["error"] = ev.get("error") or ""
                if ev.get("external_session_id"):
                    result["external_session_id"] = ev["external_session_id"]
                await on_event(ev)

    try:
        await asyncio.wait_for(asyncio.gather(pump_stdout(), pump_stderr()), timeout=timeout)
        await proc.wait()
    except asyncio.TimeoutError:
        await ap.stop()
        result.update(status="failed", error=f"timed out after {timeout}s")
    finally:
        registry.pop(run_id, None)
    result["exit_code"] = proc.returncode
    if not result["external_session_id"]:
        result["external_session_id"] = st.external_session_id
    if ap.cancelled:
        result["status"] = "cancelled"
        result["output"] = result["output"] or "".join(st.text_parts)
    elif not terminal_seen:
        if proc.returncode == 0:
            result.update(status="completed", output="".join(st.text_parts))
        else:
            result.update(status="failed", error=result["error"] or ("\n".join(stderr_tail[-5:]) or f"exit {proc.returncode}"))
    elif proc.returncode not in (0, None) and result["status"] == "completed" and not result["output"]:
        result.update(status="failed", error="\n".join(stderr_tail[-5:]) or f"exit {proc.returncode}")
    return result


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)
