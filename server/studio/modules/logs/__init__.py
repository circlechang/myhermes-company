"""N. 日誌 — 列出 `~/.hermes/logs/*`、各 profile `logs/`、Studio 自己的 log；
依等級／檔案／關鍵字篩選；WebSocket 尾端追蹤；HTTP access log 結構化標記。

Studio log：`on_startup` 掛一個 RotatingFileHandler 到 `<db dir>/studio.log`（root logger）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import logging.handlers
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from ...auth import Principal, current_principal, principal_from_ws
from ...errors import ApiError
from ...hermes.cli import HermesCli

http_router = APIRouter(prefix="/logs", tags=["logs"])
ws_router = APIRouter()  # WebSocket 走 /ws/* 讓 vite proxy 與正式站同一條路
LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
LEVEL_ALIAS = {"WARN": "WARNING", "ERR": "ERROR", "FATAL": "CRITICAL"}
MAX_LINES = 5000

# 2026-08-29 13:04:52,933 INFO hermes_cli.plugins: message
STD_RE = re.compile(r"^(?P<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\s+(?:\[?(?P<level>[A-Z]+)\]?)\s+(?P<comp>[\w.\-]+)?:?\s*(?P<msg>.*)$")
# uvicorn access: INFO:     127.0.0.1:52345 - "GET /health HTTP/1.1" 200 OK
HTTP_RE = re.compile(r'"(?P<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?P<path>\S+)\s+HTTP/[\d.]+"\s+(?P<status>\d{3})')
LEVEL_ANY_RE = re.compile(r"\b(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\b")


def parse_line(line: str) -> dict[str, Any]:
    raw = line.rstrip("\n")
    out: dict[str, Any] = {"raw": raw, "ts": None, "level": None, "component": None, "msg": raw, "http": None}
    m = STD_RE.match(raw)
    if m:
        out["ts"] = m.group("ts")
        lvl = (m.group("level") or "").upper()
        out["level"] = LEVEL_ALIAS.get(lvl, lvl) if lvl in LEVELS or lvl in LEVEL_ALIAS else None
        out["component"] = m.group("comp")
        out["msg"] = m.group("msg")
    else:
        lm = LEVEL_ANY_RE.search(raw[:40])
        if lm:
            out["level"] = LEVEL_ALIAS.get(lm.group(1), lm.group(1))
    h = HTTP_RE.search(raw)
    if h:
        out["http"] = {"method": h.group("method"), "path": h.group("path"), "status": int(h.group("status"))}
    return out


def _level_ok(entry: dict[str, Any], min_level: Optional[str]) -> bool:
    if not min_level:
        return True
    if entry["level"] is None:
        return min_level == "DEBUG"
    return LEVELS.index(entry["level"]) >= LEVELS.index(min_level)


def studio_log_path(db_path: Path) -> Path:
    return Path(db_path).expanduser().parent / "studio.log"


def log_sources(cli: HermesCli, db_path: Path) -> list[dict[str, Any]]:
    """id 格式：hermes/<file> · profile:<name>/<file> · studio/studio.log"""
    out: list[dict[str, Any]] = []

    def add(group: str, base: Path) -> None:
        if not base.is_dir():
            return
        for f in sorted(base.iterdir()):
            if f.is_file() and (".log" in f.name):
                st = f.stat()
                out.append({"id": f"{group}/{f.name}", "group": group, "name": f.name, "size": st.st_size, "mtime": st.st_mtime})

    add("hermes", cli.home / "logs")
    for prof in cli.list_profiles_fs():
        if prof != "default":
            add(f"profile:{prof}", cli.profile_dir(prof) / "logs")
    sp = studio_log_path(db_path)
    if sp.exists():
        st = sp.stat()
        out.append({"id": "studio/studio.log", "group": "studio", "name": "studio.log", "size": st.st_size, "mtime": st.st_mtime})
    return out


def resolve_source(cli: HermesCli, db_path: Path, source_id: str) -> Path:
    group, _, name = (source_id or "").partition("/")
    if not name or "/" in name or name in (".", "..") or "\x00" in name:
        raise ApiError(400, "path_traversal", "invalid log id")
    if group == "hermes":
        base = cli.home / "logs"
    elif group.startswith("profile:"):
        prof = group[len("profile:"):]
        if prof not in cli.list_profiles_fs():
            raise ApiError(404, "not_found", "profile not found")
        base = cli.profile_dir(prof) / "logs"
    elif group == "studio":
        base = studio_log_path(db_path).parent
        name = "studio.log"
    else:
        raise ApiError(404, "not_found", "unknown log group")
    target = (base / name).resolve()
    if target.parent != base.resolve() or not target.is_file():
        raise ApiError(404, "not_found", "log file not found")
    return target


def tail_lines(path: Path, n: int) -> list[str]:
    n = max(1, min(n, MAX_LINES))
    with path.open("rb") as f:
        f.seek(0, 2)
        size = f.tell()
        block = 64 * 1024
        data = b""
        pos = size
        while pos > 0 and data.count(b"\n") <= n:
            step = min(block, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + data
    lines = data.decode("utf-8", "replace").splitlines()
    return lines[-n:]


@http_router.get("/files")
def files(request: Request, p: Principal = Depends(current_principal)):
    return log_sources(request.app.state.cli, request.app.state.settings.db_path)


@http_router.get("/read")
def read(request: Request, file: str, lines: int = 200, level: str = "", q: str = "", http_only: int = 0,
         p: Principal = Depends(current_principal)):
    path = resolve_source(request.app.state.cli, request.app.state.settings.db_path, file)
    level = level.upper().strip()
    if level and level not in LEVELS:
        raise ApiError(400, "bad_request", f"level must be one of {LEVELS}")
    # read more than asked so filters still return enough
    raw = tail_lines(path, min(MAX_LINES, lines * (5 if (level or q or http_only) else 1)))
    ql = q.lower()
    entries = []
    for ln in raw:
        e = parse_line(ln)
        if not _level_ok(e, level or None):
            continue
        if ql and ql not in ln.lower():
            continue
        if http_only and not e["http"]:
            continue
        entries.append(e)
    return {"file": file, "size": path.stat().st_size, "entries": entries[-lines:]}


@ws_router.websocket("/ws/logs")
async def ws_tail(ws: WebSocket):
    """`/ws/logs?token=&file=&level=&q=` — sends {type:'line', entry} as the file grows."""
    await ws.accept()
    with Session(ws.app.state.engine) as db:
        try:
            principal_from_ws(ws, db)
        except ApiError as e:
            await ws.send_text(json.dumps({"type": "error", "code": e.code, "message": e.message}))
            await ws.close(code=4401)
            return
    file_id = ws.query_params.get("file", "")
    level = (ws.query_params.get("level") or "").upper() or None
    q = (ws.query_params.get("q") or "").lower()
    try:
        path = resolve_source(ws.app.state.cli, ws.app.state.settings.db_path, file_id)
    except ApiError as e:
        await ws.send_text(json.dumps({"type": "error", "code": e.code, "message": e.message}))
        await ws.close(code=4404)
        return
    await ws.send_text(json.dumps({"type": "ready", "file": file_id}))
    pos = path.stat().st_size
    buf = b""

    async def reader():
        nonlocal pos, buf
        while True:
            try:
                size = path.stat().st_size
            except OSError:
                await asyncio.sleep(1.0)
                continue
            if size < pos:  # rotated / truncated
                pos = 0
                await ws.send_text(json.dumps({"type": "rotated"}))
            if size > pos:
                with path.open("rb") as f:
                    f.seek(pos)
                    chunk = f.read(min(size - pos, 512 * 1024))
                    pos = f.tell()
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for ln in lines:
                    text = ln.decode("utf-8", "replace")
                    e = parse_line(text)
                    if not _level_ok(e, level) or (q and q not in text.lower()):
                        continue
                    await ws.send_text(json.dumps({"type": "line", "entry": e}, ensure_ascii=False))
            await asyncio.sleep(0.5)

    task = asyncio.create_task(reader())
    try:
        while True:
            await ws.receive_text()  # client pings / ignored
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()


router = APIRouter()
router.include_router(http_router)
router.include_router(ws_router)

_handler: Optional[logging.Handler] = None


async def on_startup(app) -> None:
    global _handler
    if _handler is not None:
        return
    try:
        path = studio_log_path(app.state.settings.db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        h = logging.handlers.RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        h.setLevel(logging.INFO)
        logging.getLogger().addHandler(h)
        studio_logger = logging.getLogger("studio")
        if studio_logger.level == logging.NOTSET and logging.getLogger().level > logging.INFO:
            studio_logger.setLevel(logging.INFO)
        for name in ("uvicorn.access", "uvicorn.error", "studio"):
            logging.getLogger(name).addHandler(h)
        _handler = h
        logging.getLogger("studio.logs").info("studio log file: %s", path)
    except OSError as e:
        logging.getLogger("studio.logs").warning("cannot open studio log: %s", e)


async def on_shutdown(app) -> None:
    global _handler
    if _handler is not None:
        logging.getLogger().removeHandler(_handler)
        for name in ("uvicorn.access", "uvicorn.error", "studio"):
            logging.getLogger(name).removeHandler(_handler)
        _handler.close()
        _handler = None
