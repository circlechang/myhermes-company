"""REST + WebSocket：/coding/*、/ws/coding。"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, current_principal, get_db, principal_from_ws
from ...errors import ApiError, bad_request, forbidden, not_found
from ...models import ChatSession, Message, new_id, now
from . import detect
from .models import CodingAgentSetting, CodingRun, CodingSessionMeta
from .proxy import get_or_create_proxy_token, proxy_info, rotate_proxy_token
from .runner import AgentProcess, RunSpec, git_snapshot, is_git_repo, run_agent

log = logging.getLogger("studio.coding")
router = APIRouter(prefix="/coding", tags=["coding"])

INSTALL_JOBS: dict[str, dict[str, Any]] = {}
PROCESSES: dict[str, AgentProcess] = {}
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _agent_or_404(agent: str) -> None:
    if agent not in detect.AGENTS:
        raise not_found("agent")


def _bin_for(request_app, agent: str) -> Optional[str]:
    override = getattr(request_app.state, "coding_bins", None) or {}
    return override.get(agent) or detect.find_bin(detect.AGENTS[agent]["bin"])


def _public_base(app) -> str:
    s = app.state.settings
    host = s.host if s.host not in ("0.0.0.0", "::", "") else "127.0.0.1"
    return f"http://{host}:{s.port}"


# ---------------------------------------------------------------- agents / install
@router.get("/agents")
async def list_agents(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    infos = await detect.detect_all()
    override = getattr(request.app.state, "coding_bins", None) or {}
    for info in infos:
        if info["id"] in override:
            info.update(installed=True, path=override[info["id"]], version=info["version"] or "test")
        row = db.exec(select(CodingAgentSetting).where(CodingAgentSetting.company_id == p.company_id,
                                                       CodingAgentSetting.agent == info["id"])).first()
        info["settings"] = row.to_dict() if row else _default_setting(info["id"]).to_dict()
        info["running"] = sum(1 for _ in PROCESSES.values())  # 目前全域執行中數量
    return infos


@router.post("/agents/{agent}/install", status_code=202)
async def install_agent(agent: str, p: Principal = Depends(current_principal)):
    _agent_or_404(agent)
    if p.role != "owner":
        raise forbidden("只有 owner 可以安裝 CLI")
    npm = detect.find_npm()
    if not npm:
        raise bad_request("找不到 npm；請先安裝 Node.js（nvm 或 Homebrew）", "npm_missing")
    job_id = new_id("inst")
    job = {"id": job_id, "agent": agent, "status": "running", "log": "", "started_at": time.time(), "finished_at": None,
           "command": f"{npm} i -g {detect.AGENTS[agent]['package']}"}
    INSTALL_JOBS[job_id] = job

    async def _run():
        try:
            proc = await asyncio.create_subprocess_exec(
                npm, "i", "-g", detect.AGENTS[agent]["package"],
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                env={**os.environ, "PATH": detect.search_path()},
            )
            assert proc.stdout
            async for raw in proc.stdout:
                job["log"] += raw.decode("utf-8", "replace")
                job["log"] = job["log"][-20000:]
            await asyncio.wait_for(proc.wait(), timeout=600)
            job["status"] = "completed" if proc.returncode == 0 else "failed"
            job["exit_code"] = proc.returncode
        except Exception as e:
            job["status"] = "failed"
            job["log"] += f"\n{e}"
        job["finished_at"] = time.time()

    asyncio.create_task(_run())
    return {"job_id": job_id, "command": job["command"]}


@router.get("/install/{job_id}")
def install_status(job_id: str, p: Principal = Depends(current_principal)):
    job = INSTALL_JOBS.get(job_id)
    if not job:
        raise not_found("install job")
    return job


# ---------------------------------------------------------------- settings
def _default_setting(agent: str) -> CodingAgentSetting:
    extra = {"permission_mode": "acceptEdits"} if agent == "claude" else {"sandbox": "workspace-write"} if agent == "codex" else {}
    return CodingAgentSetting(company_id="", agent=agent, workspace=str(Path.home()), extra_json=json.dumps(extra))


def _get_setting(db: Session, company_id: str, agent: str) -> CodingAgentSetting:
    row = db.exec(select(CodingAgentSetting).where(CodingAgentSetting.company_id == company_id,
                                                   CodingAgentSetting.agent == agent)).first()
    if row is None:
        row = _default_setting(agent)
        row.company_id = company_id
    return row


class SettingUpdate(BaseModel):
    workspace: Optional[str] = None
    model: Optional[str] = None
    api_mode: Optional[str] = None
    hermes_profile: Optional[str] = None
    extra: Optional[dict[str, Any]] = None


@router.get("/settings/{agent}")
def get_setting(agent: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _agent_or_404(agent)
    return _get_setting(db, p.company_id, agent).to_dict()


@router.put("/settings/{agent}")
def put_setting(agent: str, body: SettingUpdate, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _agent_or_404(agent)
    p.require_admin()
    row = _get_setting(db, p.company_id, agent)
    if body.workspace is not None:
        ws = str(Path(body.workspace).expanduser()) if body.workspace else ""
        if ws and not Path(ws).is_dir():
            raise bad_request(f"工作區不存在：{ws}", "workspace_missing")
        row.workspace = ws
    if body.model is not None:
        row.model = body.model.strip()
    if body.api_mode is not None:
        if body.api_mode not in ("direct", "hermes"):
            raise bad_request("api_mode 只能是 direct 或 hermes")
        row.api_mode = body.api_mode
    if body.hermes_profile is not None:
        row.hermes_profile = body.hermes_profile.strip()
    if body.extra is not None:
        cur = json.loads(row.extra_json or "{}")
        cur.update(body.extra)
        row.extra_json = json.dumps({k: v for k, v in cur.items() if v not in (None, "")}, ensure_ascii=False)
    row.updated_at = now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.to_dict()


@router.get("/proxy-info")
def get_proxy_info(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    return proxy_info(_public_base(request.app), get_or_create_proxy_token(db, p.company_id))


@router.post("/proxy-info/rotate")
def rotate_proxy(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    if p.role != "owner":
        raise forbidden("只有 owner 可以重設 proxy token")
    return proxy_info(_public_base(request.app), rotate_proxy_token(db, p.company_id))


# ---------------------------------------------------------------- workspace browser
@router.get("/fs")
async def browse_fs(path: str = "", p: Principal = Depends(current_principal)):
    base = Path(path).expanduser() if path else Path.home()
    if not base.is_dir():
        raise not_found("directory")
    base = base.resolve()
    dirs = []
    try:
        for child in sorted(base.iterdir(), key=lambda c: c.name.lower()):
            if child.is_dir() and not child.name.startswith("."):
                dirs.append({"name": child.name, "path": str(child), "is_git": (child / ".git").exists()})
    except PermissionError:
        raise forbidden("沒有讀取權限")
    return {"path": str(base), "parent": str(base.parent) if base.parent != base else None,
            "is_git": await is_git_repo(str(base)), "dirs": dirs[:500]}


# ---------------------------------------------------------------- sessions
def _session_public(s: ChatSession, meta: Optional[CodingSessionMeta]) -> dict[str, Any]:
    return {
        "id": s.id, "title": s.title, "source": s.source, "agent": meta.agent if meta else s.source.split(":")[-1],
        "workspace": meta.workspace if meta else "", "model": meta.model if meta else "",
        "external_session_id": meta.external_session_id if meta else "", "status": meta.status if meta else "idle",
        "created_at": s.created_at, "updated_at": s.updated_at, "last_message_at": s.last_message_at,
        "last_run_id": s.last_run_id,
    }


def _owned(db: Session, p: Principal, session_id: str) -> tuple[ChatSession, CodingSessionMeta]:
    s = db.get(ChatSession, session_id)
    if s is None or s.company_id != p.company_id or not s.source.startswith("coding:"):
        raise not_found("session")
    if s.member_id != p.member.id and p.role not in ("owner", "admin"):
        raise not_found("session")
    meta = db.get(CodingSessionMeta, session_id)
    if meta is None:
        meta = CodingSessionMeta(session_id=session_id, agent=s.source.split(":")[-1])
    return s, meta


class SessionCreate(BaseModel):
    agent: str
    workspace: Optional[str] = None
    model: Optional[str] = None
    title: Optional[str] = None


@router.get("/sessions")
def list_sessions(agent: Optional[str] = None, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    q = select(ChatSession).where(ChatSession.company_id == p.company_id, ChatSession.member_id == p.member.id,
                                  ChatSession.source.like("coding:%"))
    if agent:
        q = q.where(ChatSession.source == f"coding:{agent}")
    rows = db.exec(q.order_by(ChatSession.updated_at.desc())).all()
    metas = {m.session_id: m for m in db.exec(select(CodingSessionMeta).where(
        CodingSessionMeta.session_id.in_([r.id for r in rows]))).all()} if rows else {}
    return [_session_public(s, metas.get(s.id)) for s in rows]


@router.post("/sessions", status_code=201)
def create_session(body: SessionCreate, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    _agent_or_404(body.agent)
    setting = _get_setting(db, p.company_id, body.agent)
    ws = str(Path(body.workspace).expanduser()) if body.workspace else setting.workspace
    if ws and not Path(ws).is_dir():
        raise bad_request(f"工作區不存在：{ws}", "workspace_missing")
    s = ChatSession(company_id=p.company_id, member_id=p.member.id, agent_id="", source=f"coding:{body.agent}",
                    title=body.title or f"{detect.AGENTS[body.agent]['name']} · {Path(ws).name if ws else '未指定工作區'}",
                    hermes_session_id="")
    db.add(s)
    db.flush()
    meta = CodingSessionMeta(session_id=s.id, agent=body.agent, workspace=ws,
                             model=(body.model if body.model is not None else setting.model) or "")
    db.add(meta)
    db.commit()
    db.refresh(s)
    db.refresh(meta)
    return _session_public(s, meta)


@router.get("/sessions/{session_id}")
def get_session(session_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s, meta = _owned(db, p, session_id)
    return _session_public(s, meta)


class SessionPatch(BaseModel):
    title: Optional[str] = None
    model: Optional[str] = None
    workspace: Optional[str] = None


@router.patch("/sessions/{session_id}")
def patch_session(session_id: str, body: SessionPatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s, meta = _owned(db, p, session_id)
    if body.title is not None:
        s.title = body.title
    if body.model is not None:
        meta.model = body.model
    if body.workspace is not None:
        ws = str(Path(body.workspace).expanduser())
        if not Path(ws).is_dir():
            raise bad_request(f"工作區不存在：{ws}", "workspace_missing")
        meta.workspace = ws
    s.updated_at = now()
    db.add(s)
    db.add(meta)
    db.commit()
    return _session_public(s, meta)


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s, meta = _owned(db, p, session_id)
    for m in db.exec(select(Message).where(Message.session_id == s.id)).all():
        db.delete(m)
    for r in db.exec(select(CodingRun).where(CodingRun.session_id == s.id)).all():
        db.delete(r)
    if db.get(CodingSessionMeta, s.id):
        db.delete(meta)
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.get("/sessions/{session_id}/messages")
def list_messages(session_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s, _ = _owned(db, p, session_id)
    rows = db.exec(select(Message).where(Message.session_id == s.id).order_by(Message.created_at, Message.id)).all()
    out = []
    for m in rows:
        d: dict[str, Any] = {"id": m.id, "role": m.role, "content": m.content, "run_id": m.run_id, "created_at": m.created_at}
        if m.role == "tool":
            d["tool_name"] = m.tool_name
            d["tool_args"] = _loads(m.tool_args)
            d["tool_result"] = _loads(m.tool_result)
        out.append(d)
    return out


@router.get("/sessions/{session_id}/runs")
def list_runs(session_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s, _ = _owned(db, p, session_id)
    rows = db.exec(select(CodingRun).where(CodingRun.session_id == s.id).order_by(CodingRun.started_at)).all()
    return [r.to_dict() for r in rows]


class ImageUpload(BaseModel):
    filename: str
    data_base64: str


@router.post("/sessions/{session_id}/images", status_code=201)
def upload_image(session_id: str, body: ImageUpload, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s, meta = _owned(db, p, session_id)
    if not meta.workspace:
        raise bad_request("此 session 沒有工作區，無法存放圖片", "workspace_missing")
    try:
        raw = base64.b64decode(body.data_base64.split(",", 1)[-1], validate=False)
    except Exception:
        raise bad_request("data_base64 無法解碼")
    if len(raw) > 20 * 1024 * 1024:
        raise bad_request("圖片超過 20MB")
    name = _SAFE_NAME.sub("_", Path(body.filename).name) or "image.png"
    d = Path(meta.workspace) / ".studio-uploads"
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{int(time.time())}_{uuid.uuid4().hex[:6]}_{name}"
    path.write_bytes(raw)
    return {"path": str(path), "size": len(raw)}


def _loads(t: Optional[str]):
    if not t:
        return None
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        return t


# ---------------------------------------------------------------- WebSocket
class CodingBridge:
    def __init__(self, ws: WebSocket, principal: Principal):
        self.ws = ws
        self.p = principal
        self.app = ws.app
        self.engine = ws.app.state.engine
        self.tasks: dict[str, asyncio.Task] = {}
        self._lock = asyncio.Lock()

    async def send(self, payload: dict[str, Any]) -> None:
        async with self._lock:
            await self.ws.send_text(json.dumps(payload, ensure_ascii=False, default=str))

    async def error(self, message: str, code: str = "error", **extra) -> None:
        await self.send({"type": "error", "code": code, "message": message, **extra})

    async def handle(self, msg: dict[str, Any]) -> None:
        t = msg.get("type")
        if t == "run":
            await self.start(msg)
        elif t == "stop":
            await self.stop(str(msg.get("run_id") or ""))
        elif t == "ping":
            await self.send({"type": "pong"})
        else:
            await self.error(f"unknown message type: {t}", "bad_message")

    async def start(self, msg: dict[str, Any]) -> None:
        session_id = str(msg.get("session_id") or "")
        text = str(msg.get("input") or "").strip()
        images = [str(x) for x in (msg.get("images") or []) if x]
        if not session_id or not (text or images):
            await self.error("run 需要 session_id 與 input", "bad_message")
            return
        with Session(self.engine) as db:
            try:
                s, meta = _owned(db, self.p, session_id)
            except ApiError as e:
                await self.error(e.message, e.code, session_id=session_id)
                return
            if meta.status == "running":
                await self.error("此 session 已有執行中的任務", "busy", session_id=session_id)
                return
            setting = _get_setting(db, self.p.company_id, meta.agent)
            bin_path = _bin_for(self.app, meta.agent)
            if not bin_path:
                await self.send({"type": "run.failed", "session_id": session_id, "run_id": "",
                                 "error": f"{detect.AGENTS[meta.agent]['name']} 尚未安裝：{detect.AGENTS[meta.agent]['install_cmd']}"})
                return
            proxy = None
            if setting.api_mode == "hermes":
                proxy = {"base": _public_base(self.app), "token": get_or_create_proxy_token(db, self.p.company_id)}
            resume_id = meta.external_session_id if (bool(msg.get("resume", True)) and meta.external_session_id) else ""
            spec = RunSpec(agent=meta.agent, prompt=text or "請看附件圖片。", workspace=meta.workspace, bin_path=bin_path,
                           model=meta.model or setting.model, resume_id=resume_id, images=images,
                           extra=json.loads(setting.extra_json or "{}"), proxy=proxy)
            run = CodingRun(session_id=s.id, agent=meta.agent, prompt=text)
            db.add(run)
            db.add(Message(session_id=s.id, role="user", content=text + ("\n" + "\n".join(f"[圖片] {i}" for i in images) if images else ""), run_id=run.id))
            meta.status = "running"
            s.last_run_id = run.id
            s.last_message_at = now()
            s.updated_at = now()
            db.add(meta)
            db.add(s)
            db.commit()
            run_id = run.id
        self.tasks[run_id] = asyncio.create_task(self._execute(run_id, session_id, spec))

    async def _execute(self, run_id: str, session_id: str, spec: RunSpec) -> None:
        before = await git_snapshot(spec.workspace)
        pending_tools: dict[str, dict[str, Any]] = {}
        text_parts: list[str] = []

        async def on_event(ev: dict[str, Any]) -> None:
            out = dict(ev)
            out.update({"session_id": session_id, "run_id": run_id})
            t = ev["type"]
            if t == "message.delta":
                text_parts.append(str(ev.get("delta") or ""))
            elif t == "tool.started":
                pending_tools[ev.get("call_id") or ev.get("name") or ""] = {"name": ev.get("name"), "args": ev.get("args")}
            elif t == "tool.completed":
                key = ev.get("call_id") or ev.get("name") or ""
                pend = pending_tools.pop(key, {"name": ev.get("name"), "args": None})
                self._save_tool(session_id, run_id, pend.get("name") or ev.get("name") or "tool", pend.get("args"),
                                {"result": ev.get("result"), "error": ev.get("error")})
            elif t == "session.init":
                if ev.get("external_session_id"):
                    with Session(self.engine) as db:
                        meta = db.get(CodingSessionMeta, session_id)
                        if meta and not meta.external_session_id:
                            meta.external_session_id = ev["external_session_id"]
                            db.add(meta)
                            db.commit()
            if t in ("run.completed", "run.failed"):
                return  # 最終事件由下面補 diff 後再送
            try:
                await self.send(out)
            except Exception:
                pass

        try:
            result = await run_agent(spec, run_id, on_event, registry=PROCESSES)
        except Exception as e:
            log.exception("coding run failed")
            result = {"status": "failed", "exit_code": None, "external_session_id": "", "output": "", "usage": {}, "error": str(e)}
        after = await git_snapshot(spec.workspace)
        output = result.get("output") or "".join(text_parts)
        with Session(self.engine) as db:
            run = db.get(CodingRun, run_id)
            if run:
                run.status = result["status"]
                run.exit_code = result.get("exit_code")
                run.diff_before = before["diff"]
                run.diff_after = after["diff"]
                run.files_json = json.dumps(after["files"], ensure_ascii=False)
                run.usage_json = json.dumps(result.get("usage") or {}, ensure_ascii=False, default=str)
                run.error = result.get("error") or ""
                run.finished_at = now()
                db.add(run)
            meta = db.get(CodingSessionMeta, session_id)
            if meta:
                meta.status = "idle" if result["status"] != "failed" else "failed"
                if result.get("external_session_id"):
                    meta.external_session_id = result["external_session_id"]
                db.add(meta)
            s = db.get(ChatSession, session_id)
            if output or result["status"] == "completed":
                db.add(Message(session_id=session_id, role="assistant", content=output, run_id=run_id))
            if s:
                s.last_message_at = now()
                s.updated_at = now()
                db.add(s)
            db.commit()
        diff = {"before": before["diff"], "after": after["diff"], "files": after["files"], "is_git": after["is_git"]}
        self.tasks.pop(run_id, None)
        base = {"session_id": session_id, "run_id": run_id, "diff": diff, "exit_code": result.get("exit_code"),
                "external_session_id": result.get("external_session_id") or ""}
        try:
            if result["status"] == "completed":
                await self.send({"type": "run.completed", "output": output, "usage": result.get("usage") or {}, **base})
            elif result["status"] == "cancelled":
                await self.send({"type": "run.cancelled", "output": output, **base})
            else:
                await self.send({"type": "run.failed", "error": result.get("error") or "failed", "output": output, **base})
        except Exception:
            pass

    def _save_tool(self, session_id: str, run_id: str, name: str, args: Any, result: Any) -> None:
        with Session(self.engine) as db:
            db.add(Message(session_id=session_id, role="tool", content="", tool_name=name, run_id=run_id,
                           tool_args=json.dumps(args, ensure_ascii=False, default=str) if args is not None else None,
                           tool_result=json.dumps(result, ensure_ascii=False, default=str) if result is not None else None))
            db.commit()

    async def stop(self, run_id: str) -> None:
        ap = PROCESSES.get(run_id)
        if ap is None:
            await self.error(f"unknown run_id: {run_id}", "unknown_run", run_id=run_id)
            return
        await ap.stop()
        await self.send({"type": "stop.ack", "run_id": run_id})

    async def close(self) -> None:
        # 連線斷了不殺子程序：讓它跑完並落庫，前端重連後可從歷史看結果
        pass


@router.websocket("/ws")  # 實際路徑 /coding/ws；另外在 __init__ 也掛 /ws/coding
async def ws_coding(ws: WebSocket):
    await _ws_main(ws)


async def _ws_main(ws: WebSocket) -> None:
    with Session(ws.app.state.engine) as db:
        try:
            principal = principal_from_ws(ws, db)
        except ApiError as e:
            await ws.close(code=4401, reason=e.message)
            return
        db.refresh(principal.member)
        db.expunge(principal.member)
    await ws.accept()
    bridge = CodingBridge(ws, principal)
    await bridge.send({"type": "ready", "member_id": principal.member.id})
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await bridge.error("invalid JSON", "bad_message")
                continue
            if not isinstance(msg, dict):
                await bridge.error("message must be an object", "bad_message")
                continue
            await bridge.handle(msg)
    except WebSocketDisconnect:
        pass
    finally:
        await bridge.close()


ws_router = APIRouter()


@ws_router.websocket("/ws/coding")
async def ws_coding_alias(ws: WebSocket):
    await _ws_main(ws)


async def shutdown() -> None:
    for ap in list(PROCESSES.values()):
        try:
            await ap.stop()
        except Exception:
            pass
