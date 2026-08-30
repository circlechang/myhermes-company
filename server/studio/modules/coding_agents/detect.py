"""偵測 claude / codex / pi CLI 是否安裝、版本、安裝指令。"""
from __future__ import annotations

import asyncio
import glob
import os
import re
import shutil
from pathlib import Path
from typing import Any, Optional

AGENTS: dict[str, dict[str, Any]] = {
    "claude": {
        "name": "Claude Code",
        "bin": "claude",
        "package": "@anthropic-ai/claude-code",
        "install_cmd": "npm i -g @anthropic-ai/claude-code",
        "docs": "https://docs.anthropic.com/en/docs/claude-code",
        "supports": {"resume": True, "images": True, "proxy": "anthropic"},
    },
    "codex": {
        "name": "Codex CLI",
        "bin": "codex",
        "package": "@openai/codex",
        "install_cmd": "npm i -g @openai/codex",
        "docs": "https://github.com/openai/codex",
        "supports": {"resume": True, "images": True, "proxy": "openai"},
    },
    "pi": {
        "name": "Pi",
        "bin": "pi",
        "package": "@mariozechner/pi-coding-agent",
        "install_cmd": "npm i -g @mariozechner/pi-coding-agent",
        "docs": "https://github.com/badlogic/pi-mono",
        "supports": {"resume": True, "images": False, "proxy": "openai"},
    },
}


def candidate_dirs() -> list[str]:
    home = Path.home()
    dirs: list[str] = []
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if d and d not in dirs:
            dirs.append(d)
    extra = [str(home / ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", str(home / ".npm-global/bin"),
             str(home / ".bun/bin"), str(home / ".volta/bin")]
    extra += sorted(glob.glob(str(home / ".nvm/versions/node/*/bin")), reverse=True)
    for d in extra:
        if d not in dirs:
            dirs.append(d)
    return dirs


def search_path() -> str:
    """給子程序用的 PATH：把常見安裝位置補進去，讓 node shim 也找得到。"""
    return os.pathsep.join(candidate_dirs())


def find_bin(name: str) -> Optional[str]:
    for d in candidate_dirs():
        p = Path(d) / name
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return shutil.which(name)


def find_npm() -> Optional[str]:
    return find_bin("npm")


_VER_RE = re.compile(r"(\d+\.\d+\.\d+[\w.-]*)")


async def cli_version(path: str, timeout: float = 15.0) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            path, "--version", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "PATH": search_path()},
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except Exception:
        return ""
    text = out.decode("utf-8", "replace").strip()
    m = _VER_RE.search(text)
    return m.group(1) if m else text.splitlines()[0][:40] if text else ""


async def detect_agent(agent_id: str) -> dict[str, Any]:
    spec = AGENTS[agent_id]
    path = find_bin(spec["bin"])
    version = await cli_version(path) if path else ""
    return {
        "id": agent_id, "name": spec["name"], "installed": bool(path), "path": path or "", "version": version,
        "install_cmd": spec["install_cmd"], "package": spec["package"], "docs": spec["docs"],
        "supports": spec["supports"], "npm_available": bool(find_npm()),
    }


async def detect_all() -> list[dict[str, Any]]:
    return list(await asyncio.gather(*(detect_agent(a) for a in AGENTS)))
