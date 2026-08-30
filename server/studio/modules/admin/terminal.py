"""O. Web 終端 — WebSocket ↔ pty（ptyprocess）。僅 owner/admin。

WS `/ws/terminal?token=&cwd=<profile name | root id>&cols=&rows=`
- client→server：純文字＝鍵盤輸入；JSON `{"type":"resize","cols":..,"rows":..}`
- server→client：純文字＝終端輸出；JSON `{"type":"ready"|"exit"|"error", ...}`
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from ...auth import Principal, principal_from_ws
from ...errors import ApiError
from ...hermes.cli import HermesCli

log = logging.getLogger("studio.terminal")
router = APIRouter()


def cwd_choices(cli: HermesCli, db_path: Path) -> list[dict]:
    out = [{"id": "workspace", "label": "Hermes workspace", "path": str(cli.home / "workspace")}]
    for prof in cli.list_profiles_fs():
        out.append({"id": f"profile:{prof}", "label": f"profile {prof}", "path": str(cli.profile_dir(prof))})
    out.append({"id": "home", "label": "home (~)", "path": str(Path.home())})
    return out


def resolve_cwd(cli: HermesCli, db_path: Path, cwd_id: str) -> Path:
    for c in cwd_choices(cli, db_path):
        if c["id"] == cwd_id:
            p = Path(c["path"])
            if p.is_dir():
                return p
            raise ApiError(404, "not_found", f"目錄不存在: {p}")
    raise ApiError(400, "bad_request", f"unknown cwd: {cwd_id}")


def default_shell() -> str:
    sh = os.environ.get("SHELL") or "/bin/zsh"
    if not shutil.which(sh) and not Path(sh).exists():
        sh = "/bin/bash" if Path("/bin/bash").exists() else "/bin/sh"
    return sh


@router.websocket("/ws/terminal")
async def ws_terminal(ws: WebSocket):
    await ws.accept()
    with Session(ws.app.state.engine) as db:
        try:
            principal: Principal = principal_from_ws(ws, db)
            principal.require_admin()
        except ApiError as e:
            await ws.send_text(json.dumps({"type": "error", "code": e.code, "message": e.message}))
            await ws.close(code=4403)
            return
    try:
        import ptyprocess
    except ImportError:
        await ws.send_text(json.dumps({"type": "error", "code": "pty_unavailable", "message": "ptyprocess 未安裝"}))
        await ws.close(code=4500)
        return
    cli: HermesCli = ws.app.state.cli
    try:
        cwd = resolve_cwd(cli, ws.app.state.settings.db_path, ws.query_params.get("cwd") or "workspace")
    except ApiError as e:
        await ws.send_text(json.dumps({"type": "error", "code": e.code, "message": e.message}))
        await ws.close(code=4404)
        return
    cols = int(ws.query_params.get("cols") or 100)
    rows = int(ws.query_params.get("rows") or 30)
    env = dict(os.environ)
    env.update({"TERM": "xterm-256color", "HERMES_HOME": str(cli.home), "STUDIO_TERMINAL": "1", "LANG": env.get("LANG") or "zh_TW.UTF-8"})
    cmd = [default_shell(), "-l"]
    if os.environ.get("STUDIO_TERMINAL_CMD"):
        cmd = os.environ["STUDIO_TERMINAL_CMD"].split()
    try:
        proc = ptyprocess.PtyProcessUnicode.spawn(cmd, cwd=str(cwd), env=env, dimensions=(rows, cols))
    except Exception as e:
        await ws.send_text(json.dumps({"type": "error", "code": "spawn_failed", "message": str(e)}))
        await ws.close(code=4500)
        return
    await ws.send_text(json.dumps({"type": "ready", "cwd": str(cwd), "shell": cmd[0], "pid": proc.pid}))
    loop = asyncio.get_running_loop()

    async def pump_output():
        try:
            while proc.isalive():
                try:
                    data = await loop.run_in_executor(None, proc.read, 4096)
                except EOFError:
                    break
                if data:
                    await ws.send_text(data)
        except Exception as e:  # socket closed
            log.debug("terminal pump ended: %s", e)
        finally:
            try:
                await ws.send_text(json.dumps({"type": "exit", "code": proc.exitstatus}))
            except Exception:
                pass

    task = asyncio.create_task(pump_output())
    try:
        while True:
            msg = await ws.receive_text()
            if msg.startswith("{"):
                try:
                    obj = json.loads(msg)
                except json.JSONDecodeError:
                    obj = None
                if isinstance(obj, dict) and obj.get("type") == "resize":
                    try:
                        proc.setwinsize(int(obj.get("rows") or rows), int(obj.get("cols") or cols))
                    except Exception:
                        pass
                    continue
                if isinstance(obj, dict) and obj.get("type") == "input":
                    proc.write(str(obj.get("data") or ""))
                    continue
            proc.write(msg)
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()
        try:
            proc.terminate(force=True)
        except Exception:
            pass
