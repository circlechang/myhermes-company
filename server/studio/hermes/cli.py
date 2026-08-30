"""Subprocess wrapper for the `hermes` CLI (kanban / profile) and profile files."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any, Optional

import yaml

log = logging.getLogger("studio.cli")


class CliError(Exception):
    pass


class HermesCli:
    def __init__(self, hermes_bin: str, hermes_home: Path):
        self.bin = hermes_bin
        self.home = Path(hermes_home).expanduser()

    async def _run(self, *args: str, timeout: float = 30.0) -> str:
        try:
            proc = await asyncio.create_subprocess_exec(
                self.bin, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except FileNotFoundError:
            raise CliError(f"hermes CLI not found: {self.bin}")
        except asyncio.TimeoutError:
            raise CliError(f"hermes {' '.join(args)} timed out")
        if proc.returncode != 0:
            raise CliError((err or out).decode("utf-8", "replace").strip()[:500] or f"exit {proc.returncode}")
        return out.decode("utf-8", "replace")

    # -- kanban ------------------------------------------------------------
    async def kanban_list(self, status: Optional[str] = None) -> list[dict[str, Any]]:
        args = ["kanban", "list", "--json"]
        if status:
            args += ["--status", status]
        raw = await self._run(*args)
        try:
            data = json.loads(raw or "[]")
        except json.JSONDecodeError:
            raise CliError("kanban list returned non-JSON output")
        if isinstance(data, dict):
            data = data.get("tasks") or data.get("data") or []
        return data

    async def kanban_create(self, title: str, body: str = "", assignee: str = "", priority: Optional[int] = None) -> dict[str, Any]:
        args = ["kanban", "create", title, "--json"]
        if body:
            args += ["--body", body]
        if assignee:
            args += ["--assignee", assignee]
        if priority is not None:
            args += ["--priority", str(priority)]
        return _parse_json_or_text(await self._run(*args))

    async def kanban_set_status(self, task_id: str, status: str) -> dict[str, Any]:
        # hermes kanban exposes verbs per status; map the common ones.
        verb = {
            "done": "complete", "complete": "complete", "completed": "complete",
            "blocked": "block", "block": "block",
            "scheduled": "schedule",
            "ready": "unblock", "todo": "unblock", "unblock": "unblock",
            "review": "request-review",
            "archived": "archive", "archive": "archive",
            "promote": "promote",
        }.get(status)
        if verb is None:
            raise CliError(f"unsupported status: {status}")
        return _parse_json_or_text(await self._run("kanban", verb, task_id))

    async def kanban_comment(self, task_id: str, text: str) -> dict[str, Any]:
        return _parse_json_or_text(await self._run("kanban", "comment", task_id, text))

    # -- profiles ----------------------------------------------------------
    def profiles_dir(self) -> Path:
        return self.home / "profiles"

    def profile_dir(self, profile: str) -> Path:
        return self.home if profile == "default" else self.profiles_dir() / profile

    def list_profiles_fs(self) -> list[str]:
        names = ["default"]
        d = self.profiles_dir()
        if d.is_dir():
            for p in sorted(d.iterdir()):
                if p.is_dir() and not p.name.startswith(".") and p.name != "default":
                    names.append(p.name)
        return names

    async def list_profiles(self) -> list[dict[str, Any]]:
        """`hermes profile list` (table output) parsed; falls back to the filesystem."""
        infos: dict[str, dict[str, Any]] = {n: {"name": n, "model": "", "gateway": ""} for n in self.list_profiles_fs()}
        try:
            raw = await self._run("profile", "list")
        except CliError as e:
            log.warning("hermes profile list failed, using filesystem only: %s", e)
            raw = ""
        for line in raw.splitlines():
            m = re.match(r"^\s*[◆*>]?\s*([A-Za-z0-9_.-]+)\s+(\S+)\s+(\S+)", line)
            if not m or m.group(1).lower() == "profile":
                continue
            name, model, gw = m.group(1), m.group(2), m.group(3)
            infos.setdefault(name, {"name": name})
            infos[name].update({"model": model, "gateway": gw})
        for name, info in infos.items():
            if not info.get("model"):
                info["model"] = self.profile_model(name)
        return list(infos.values())

    def profile_model(self, profile: str) -> str:
        cfg = self.profile_dir(profile) / "config.yaml"
        try:
            data = yaml.safe_load(cfg.read_text(encoding="utf-8")) or {}
            model = data.get("model")
            if isinstance(model, dict):
                return str(model.get("default") or "")
            return str(model or "")
        except Exception:
            return ""

    def read_soul(self, profile: str) -> str:
        p = self.profile_dir(profile) / "SOUL.md"
        return p.read_text(encoding="utf-8") if p.exists() else ""

    def write_soul(self, profile: str, content: str) -> None:
        d = self.profile_dir(profile)
        d.mkdir(parents=True, exist_ok=True)
        (d / "SOUL.md").write_text(content, encoding="utf-8")


def _parse_json_or_text(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {"result": data}
    except json.JSONDecodeError:
        m = re.search(r"\b(t_[0-9a-f]{6,})\b", raw)
        return {"ok": True, "id": m.group(1) if m else None, "raw": raw}
