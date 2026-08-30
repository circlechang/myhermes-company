"""`hermes kanban` CLI 包裝：有 --json 的用 --json，沒有的解析文字。

runner：`async (*args, timeout=...) -> str`，正式環境是 studio.hermes.cli.HermesCli._run，
測試時換成假的（不會真的開子程序）。
"""
from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable, Optional

from ...hermes.cli import CliError

Runner = Callable[..., Awaitable[str]]

STATUSES = ("triage", "todo", "ready", "running", "review", "blocked", "scheduled", "done", "archived")

# Studio 看板欄位 → hermes 狀態；移動時用的 CLI 動詞
MOVE_VERBS: dict[str, list[str]] = {
    "done": ["complete"],
    "blocked": ["block"],
    "scheduled": ["schedule"],
    "todo": ["unblock"],
    "ready": ["promote"],
    "review": ["request-review"],
    "archived": ["archive"],
}

# UI 優先權 ↔ hermes 整數
PRIORITY_TO_INT = {"low": 10, "medium": 50, "high": 80, "urgent": 100}


def priority_label(v: Any) -> str:
    try:
        n = int(v or 0)
    except (TypeError, ValueError):
        return "medium"
    if n >= 100:
        return "urgent"
    if n >= 80:
        return "high"
    if n >= 50:
        return "medium"
    return "low"


def _json(raw: str, what: str) -> Any:
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # 有些子命令會先印一行提示再印 JSON
        m = re.search(r"[\[{].*[\]}]", raw, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        raise CliError(f"kanban {what} returned non-JSON output")


def parse_text_result(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {"result": data}
    except json.JSONDecodeError:
        m = re.search(r"\b(t_[0-9a-f]{6,})\b", raw)
        return {"ok": True, "id": m.group(1) if m else None, "raw": raw}


class KanbanCli:
    def __init__(self, runner: Runner, board: Optional[str] = None):
        self.runner = runner
        self.board = board

    async def _run(self, *args: str, timeout: float = 30.0) -> str:
        base = ["kanban"]
        if self.board:
            base += ["--board", self.board]
        return await self.runner(*base, *args, timeout=timeout)

    # -- read ------------------------------------------------------------------
    async def list(self, *, status: Optional[str] = None, assignee: Optional[str] = None,
                   archived: bool = False, sort: Optional[str] = None) -> list[dict[str, Any]]:
        args = ["list", "--json"]
        if status:
            if status not in STATUSES:
                raise CliError(f"unsupported status: {status}")
            args += ["--status", status]
        if assignee:
            args += ["--assignee", assignee]
        if archived:
            args.append("--archived")
        if sort:
            args += ["--sort", sort]
        data = _json(await self._run(*args), "list") or []
        if isinstance(data, dict):
            data = data.get("tasks") or data.get("data") or []
        return data

    async def show(self, task_id: str) -> dict[str, Any]:
        data = _json(await self._run("show", task_id, "--json"), "show")
        if not isinstance(data, dict):
            raise CliError("kanban show returned unexpected output")
        return data

    async def diagnostics(self, severity: Optional[str] = None, task_id: Optional[str] = None) -> list[dict[str, Any]]:
        args = ["diagnostics", "--json"]
        if severity:
            args += ["--severity", severity]
        if task_id:
            args += ["--task", task_id]
        return _json(await self._run(*args), "diagnostics") or []

    async def stats(self) -> dict[str, Any]:
        raw = await self._run("stats")
        try:
            return _json(raw, "stats") or {}
        except CliError:
            return {"raw": raw.strip()}

    async def attachments(self, task_id: str) -> list[dict[str, Any]]:
        return _json(await self._run("attachments", task_id, "--json"), "attachments") or []

    # -- write ---------------------------------------------------------------------
    async def create(self, title: str, *, body: str = "", assignee: str = "", priority: Optional[int] = None,
                     skills: Optional[list[str]] = None, model: str = "", max_runtime: str = "",
                     parent: str = "", triage: bool = False) -> dict[str, Any]:
        args = ["create", title, "--json"]
        if body:
            args += ["--body", body]
        if assignee:
            args += ["--assignee", assignee]
        if priority is not None:
            args += ["--priority", str(int(priority))]
        for s in skills or []:
            args += ["--skill", s]
        if model:
            args += ["--model", model]
        if max_runtime:
            args += ["--max-runtime", max_runtime]
        if parent:
            args += ["--parent", parent]
        if triage:
            args.append("--triage")
        return parse_text_result(await self._run(*args))

    async def assign(self, task_id: str, profile: str) -> dict[str, Any]:
        return parse_text_result(await self._run("assign", task_id, profile or "none"))

    async def comment(self, task_id: str, text: str, author: str = "") -> dict[str, Any]:
        args = ["comment", task_id, text]
        if author:
            args += ["--author", author]
        return parse_text_result(await self._run(*args))

    async def attach(self, task_id: str, path: str, *, name: str = "", content_type: str = "", author: str = "") -> dict[str, Any]:
        args = ["attach", task_id, path]
        if name:
            args += ["--name", name]
        if content_type:
            args += ["--content-type", content_type]
        if author:
            args += ["--author", author]
        return parse_text_result(await self._run(*args))

    async def attach_rm(self, attachment_id: str) -> dict[str, Any]:
        return parse_text_result(await self._run("attach-rm", attachment_id))

    async def complete(self, task_id: str, result: str = "", summary: str = "") -> dict[str, Any]:
        args = ["complete", task_id]
        if result:
            args += ["--result", result]
        if summary:
            args += ["--summary", summary]
        return parse_text_result(await self._run(*args))

    async def block(self, task_id: str, reason: str = "", kind: str = "") -> dict[str, Any]:
        args = ["block", task_id]
        if kind:
            args += ["--kind", kind]
        if reason:
            args.append(reason)
        return parse_text_result(await self._run(*args))

    async def unblock(self, task_id: str) -> dict[str, Any]:
        return parse_text_result(await self._run("unblock", task_id))

    async def archive(self, task_id: str) -> dict[str, Any]:
        return parse_text_result(await self._run("archive", task_id))

    async def edit(self, task_id: str, result: str, summary: str = "") -> dict[str, Any]:
        args = ["edit", task_id, "--result", result]
        if summary:
            args += ["--summary", summary]
        return parse_text_result(await self._run(*args))

    async def move(self, task_id: str, status: str, *, reason: str = "", result: str = "") -> dict[str, Any]:
        """把卡片移到某個狀態；對應 CLI 動詞。todo/ready 從 blocked 出來用 unblock，從 todo 進 ready 用 promote。"""
        if status == "done":
            return await self.complete(task_id, result=result)
        if status == "blocked":
            return await self.block(task_id, reason=reason)
        if status == "review":
            return parse_text_result(await self._run("request-review", task_id))
        if status == "scheduled":
            return parse_text_result(await self._run("schedule", task_id))
        if status == "archived":
            return await self.archive(task_id)
        if status in ("todo", "ready"):
            # 先 unblock（blocked/scheduled → ready/todo）；再視需要 promote（todo → ready）
            try:
                out = await self.unblock(task_id)
            except CliError as e:
                out = {"ok": False, "raw": str(e)}
            if status == "ready":
                try:
                    out = parse_text_result(await self._run("promote", task_id))
                except CliError as e:
                    if not out.get("ok"):
                        raise e
            return out
        if status == "running":
            raise CliError("running 由 dispatcher 決定，請用「派工」而不是拖拉")
        raise CliError(f"unsupported status: {status}")

    async def dispatch(self, *, dry_run: bool = False, max_spawn: Optional[int] = None) -> dict[str, Any]:
        args = ["dispatch", "--json"]
        if dry_run:
            args.append("--dry-run")
        if max_spawn is not None:
            args += ["--max", str(int(max_spawn))]
        raw = await self._run(*args, timeout=120.0)
        try:
            data = _json(raw, "dispatch")
        except CliError:
            return {"raw": raw.strip()}
        return data if isinstance(data, dict) else {"result": data}
