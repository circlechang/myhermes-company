"""WS /ws/chat — bridges gateway /v1/runs SSE to WebSocket and persists messages.

Context strategy (see docs/API.md): each Studio session owns a stable
`hermes_session_id` passed as `session_id` to POST /v1/runs, and every run also
sends `conversation_history` rebuilt from SQLite (user/assistant turns). The
gateway's `previous_response_id` only resolves ids minted by /v1/responses, so
run ids cannot be chained that way; explicit history is the reliable path.

Chat-module additions:
- `run` accepts `attachments` (uploaded files: their local paths are appended to
  the input so Hermes can read them; images are also sent as `image_url` content
  parts when the gateway accepts them, falling back to path-only on 400),
  `reply_to` (quoted message id), `model`/`provider` (one-off override).
- `regenerate` re-runs the last user turn (drops the trailing assistant/tool
  messages first); `edit` rewrites the last user message and re-runs.
- run.completed usage is accumulated on the session (token badge) and stored on
  the assistant message; `reasoning.available` text is stored on the message.
- session.run_status tracks running/completed/failed/cancelled for the sidebar.

Doc mode (docs module):
- when `sessions.doc_id` is set, the current document is appended to the run's
  `instructions` and the model is asked to emit the **full new version** inside a
  ```doc fence (or a unified diff inside ```doc-patch). On run.completed the fence
  is parsed out of the reply, applied as a new `doc_versions` row (and written back
  to the workspace `.md`), and `doc.updated` is pushed to the client. A patch that
  cannot be applied triggers one automatic follow-up run asking for the full text.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session, select

from ..auth import Principal, principal_from_ws
from ..errors import ApiError
from ..hermes.gateway import GatewayClient, GatewayError
from ..models import Agent, ChatSession, Message, now
from ..modules import inbox as inbox_svc
from ..modules.coding_agents import staff
from ..modules.coding_agents.models import CodingRun
from ..modules.coding_agents.router import PROCESSES
from ..modules.docs import chat_link as doc_link
from .sessions import get_owned_session

log = logging.getLogger("studio.ws")
router = APIRouter()

HISTORY_LIMIT = 40
MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024


def _history(db: Session, session_id: str) -> list[dict[str, str]]:
    rows = db.exec(select(Message).where(Message.session_id == session_id, Message.role.in_(["user", "assistant"]))
                   .order_by(Message.created_at, Message.id)).all()
    hist = [{"role": m.role, "content": m.content} for m in rows if m.content]
    return hist[-HISTORY_LIMIT:]


def _clean_attachments(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for a in raw[:20]:
        if not isinstance(a, dict) or not a.get("path"):
            continue
        out.append({"name": str(a.get("name") or Path(str(a["path"])).name), "path": str(a["path"]),
                    "mime": str(a.get("mime") or mimetypes.guess_type(str(a["path"]))[0] or ""),
                    "size": int(a.get("size") or 0)})
    return out


def compose_input(text: str, attachments: list[dict[str, Any]], quote: Optional[str]) -> str:
    """Text actually sent to Hermes: quote block + user text + attachment paths."""
    parts: list[str] = []
    if quote:
        q = "\n".join("> " + ln for ln in quote.strip().splitlines()[:20])
        parts.append(f"[引用先前訊息]\n{q}\n")
    parts.append(text)
    if attachments:
        lines = "\n".join(f"- {a['name']}: {a['path']}" for a in attachments)
        parts.append(f"\n[附件檔案，已存在本機，可直接讀取]\n{lines}")
    return "\n".join(parts).strip()


def image_parts(attachments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for a in attachments:
        mime = a.get("mime") or ""
        if not mime.startswith("image/"):
            continue
        try:
            p = Path(a["path"])
            if p.stat().st_size > MAX_INLINE_IMAGE_BYTES:
                continue
            b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        except OSError:
            continue
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
    return parts


# 開著的對話 WS（收件匣決定危險指令後要推 approval.responded 回來）
_BRIDGES: "set[ChatBridge]" = set()


async def notify_approval_decided(run_id: str, approval_id: str, decision: str) -> int:
    """給 inbox 模組呼叫：把決定推給所有持有這個 run 的對話 WS。回推送數。"""
    n = 0
    for b in list(_BRIDGES):
        info = b.runs.get(run_id)
        if info is None:
            continue
        try:
            await b.send({"type": "approval.responded", "session_id": info["session_id"], "run_id": run_id,
                          "approval_id": approval_id, "decision": decision, "via": "inbox"})
            n += 1
        except Exception:
            pass
    return n


class ChatBridge:
    def __init__(self, ws: WebSocket, principal: Principal):
        self.ws = ws
        self.p = principal
        self.app = ws.app
        self.gateway: GatewayClient = ws.app.state.gateway
        self.engine = ws.app.state.engine
        self.runs: dict[str, dict[str, Any]] = {}  # run_id -> {session_id, profile, task, doc}
        self.coding_runs: dict[str, dict[str, Any]] = {}  # coding 員工的 run_id -> {session_id, task}
        self._send_lock = asyncio.Lock()

    @property
    def docs_workspace(self) -> Path:
        ws = getattr(self.app.state, "docs_workspace", None)
        return Path(ws) if ws else Path(self.app.state.settings.db_path).parent / "workspace"

    async def send(self, payload: dict[str, Any]) -> None:
        async with self._send_lock:
            await self.ws.send_text(json.dumps(payload, ensure_ascii=False, default=str))

    async def error(self, message: str, code: str = "error", **extra) -> None:
        await self.send({"type": "error", "code": code, "message": message, **extra})

    # -- inbound -----------------------------------------------------------
    async def handle(self, msg: dict[str, Any]) -> None:
        t = msg.get("type")
        if t == "run":
            await self.start_run(msg)
        elif t == "regenerate":
            await self.regenerate(msg)
        elif t == "edit":
            await self.edit(msg)
        elif t in ("approval", "stop", "steer"):
            await self.control(t, msg)
        elif t == "ping":
            await self.send({"type": "pong"})
        else:
            await self.error(f"unknown message type: {t}", "bad_message")

    async def regenerate(self, msg: dict[str, Any]) -> None:
        """Drop everything after the last user message and run it again."""
        session_id = str(msg.get("session_id") or "")
        with Session(self.engine) as db:
            try:
                s = get_owned_session(db, self.p, session_id)
            except ApiError as e:
                await self.error(e.message, e.code, session_id=session_id)
                return
            rows = db.exec(select(Message).where(Message.session_id == s.id).order_by(Message.created_at, Message.id)).all()
            last_user = next((m for m in reversed(rows) if m.role == "user"), None)
            if last_user is None:
                await self.error("沒有可重新生成的使用者訊息", "bad_message", session_id=session_id)
                return
            removed = [m.id for m in rows if (m.created_at, m.id) > (last_user.created_at, last_user.id)]
            for m in rows:
                if m.id in removed or m.id == last_user.id:
                    db.delete(m)
            db.commit()
            text, atts, reply_to = last_user.content, json.loads(last_user.attachments or "[]"), last_user.reply_to
        await self.send({"type": "messages.removed", "session_id": session_id, "ids": removed + [last_user.id]})
        await self.start_run({"session_id": session_id, "input": text, "attachments": atts, "reply_to": reply_to,
                              "model": msg.get("model"), "provider": msg.get("provider")})

    async def edit(self, msg: dict[str, Any]) -> None:
        """Rewrite the given (or last) user message, drop what followed, re-run."""
        session_id = str(msg.get("session_id") or "")
        text = str(msg.get("input") or "").strip()
        if not text:
            await self.error("edit 需要 input", "bad_message", session_id=session_id)
            return
        with Session(self.engine) as db:
            try:
                s = get_owned_session(db, self.p, session_id)
            except ApiError as e:
                await self.error(e.message, e.code, session_id=session_id)
                return
            rows = db.exec(select(Message).where(Message.session_id == s.id).order_by(Message.created_at, Message.id)).all()
            target_id = msg.get("message_id")
            target = next((m for m in reversed(rows) if m.role == "user" and (not target_id or m.id == target_id)), None)
            if target is None:
                await self.error("找不到要編輯的訊息", "not_found", session_id=session_id)
                return
            removed = [m.id for m in rows if (m.created_at, m.id) >= (target.created_at, target.id)]
            for m in rows:
                if m.id in removed:
                    db.delete(m)
            db.commit()
            atts = json.loads(target.attachments or "[]") if msg.get("attachments") is None else msg.get("attachments")
            reply_to = target.reply_to
        await self.send({"type": "messages.removed", "session_id": session_id, "ids": removed})
        await self.start_run({"session_id": session_id, "input": text, "attachments": atts, "reply_to": reply_to,
                              "model": msg.get("model"), "provider": msg.get("provider")})

    async def start_run(self, msg: dict[str, Any]) -> None:
        session_id = str(msg.get("session_id") or "")
        text = str(msg.get("input") or "").strip()
        attachments = _clean_attachments(msg.get("attachments"))
        if not session_id or (not text and not attachments):
            await self.error("run 需要 session_id 與 input", "bad_message")
            return
        if not text:
            text = "（請看附件）"
        reply_to = str(msg.get("reply_to") or "") or None
        with Session(self.engine) as db:
            try:
                s = get_owned_session(db, self.p, session_id)
            except ApiError as e:
                await self.error(e.message, e.code, session_id=session_id)
                return
            if s.run_status == "running" and s.last_run_id in self.runs:
                await self.error("這個對話還在回覆中", "busy", session_id=session_id)
                return
            agent = db.get(Agent, s.agent_id)
            if agent is None:
                await self.error("agent not found", "not_found", session_id=session_id)
                return
            if staff.is_coding(staff.runtime_of(agent)):
                # AI 員工「就是」一個 coding agent：走 CLI，不打 gateway；事件型別一模一樣
                await self.start_coding_run(db, s, agent, msg, text, attachments, reply_to)
                return
            profile = agent.profile
            model = str(msg.get("model") or "").strip() or s.model or agent.model or None
            provider = str(msg.get("provider") or "").strip() or s.provider or None
            hermes_session_id = s.hermes_session_id
            history = _history(db, s.id)
            quote = None
            if reply_to:
                q = db.get(Message, reply_to)
                if q is not None and q.session_id == s.id:
                    quote = q.content[:2000]
                else:
                    reply_to = None
            m = Message(session_id=s.id, role="user", content=text, reply_to=reply_to,
                        attachments=json.dumps(attachments, ensure_ascii=False) if attachments else None)
            db.add(m)
            s.last_message_at = now()
            s.updated_at = now()
            db.add(s)
            db.commit()
            user_msg_id = m.id
        sent_text = compose_input(text, attachments, quote)
        imgs = image_parts(attachments)
        # 文件模式：把「目前文件全文」與圍欄規則附進 instructions（見 modules/docs/chat_link.py）
        doc_ctx = None
        try:
            doc_ctx = doc_link.context_for(self.engine, self.docs_workspace, session_id)
        except Exception as e:  # pragma: no cover - 文件壞了不擋對話
            log.warning("doc context failed for %s: %s", session_id, e)
        instructions = doc_ctx["instructions"] if doc_ctx else None
        run_id: Optional[str] = None
        err: Optional[str] = None
        try:
            if imgs:
                try:
                    run_id = await self._start_multimodal(profile, sent_text, imgs, hermes_session_id, history, model, provider,
                                                          instructions)
                except GatewayError as e:
                    if e.status != 400:
                        raise
                    log.info("gateway rejected image parts (%s); falling back to path-only", e.message)
            if run_id is None:
                run_id = await self._post_run(profile, self._run_body(sent_text, hermes_session_id, history, model, provider,
                                                                      instructions))
        except GatewayError as e:
            err = e.message
        except Exception as e:
            err = f"gateway unreachable: {e}"
        if err is not None or run_id is None:
            self._set_status(session_id, "failed")
            await self.send({"type": "run.failed", "session_id": session_id, "error": err or "no run id"})
            return
        with Session(self.engine) as db:
            s = db.get(ChatSession, session_id)
            if s:
                s.last_run_id = run_id
                s.run_status = "running"
                db.add(s)
                db.commit()
        task = asyncio.create_task(self._pump(run_id, session_id, profile))
        self.runs[run_id] = {"session_id": session_id, "profile": profile, "task": task, "doc": doc_ctx,
                             "doc_retry": bool(msg.get("_doc_retry"))}
        await self.send({"type": "run.started", "session_id": session_id, "run_id": run_id, "message_id": user_msg_id,
                         "attachments": attachments, "reply_to": reply_to, "model": model or "",
                         "doc_id": (doc_ctx or {}).get("doc_id", "")})

    # -- coding 員工（runtime = claude-code / codex / pi）--------------------
    async def start_coding_run(self, db: Session, s: ChatSession, agent: Agent, msg: dict[str, Any], text: str,
                               attachments: list[dict[str, Any]], reply_to: Optional[str]) -> None:
        session_id = s.id
        meta = staff.get_or_create_meta(db, session_id, agent)
        if meta.status == "running":
            await self.error("這個對話還在回覆中", "busy", session_id=session_id)
            return
        quote = None
        if reply_to:
            q = db.get(Message, reply_to)
            quote = q.content[:2000] if (q is not None and q.session_id == session_id) else None
        prompt = compose_input(text, attachments, quote)
        images = [a["path"] for a in attachments if str(a.get("mime") or "").startswith("image/")]
        try:
            spec = staff.build_spec(self.app, agent, prompt, workspace=meta.workspace or agent.workspace,
                                    resume_id=(meta.external_session_id if bool(msg.get("resume", True)) else ""),
                                    images=images, db=db)
        except ApiError as e:
            self._set_status(session_id, "failed")
            await self.send({"type": "run.failed", "session_id": session_id, "run_id": "", "error": e.message, "code": e.code})
            return
        run = CodingRun(session_id=session_id, agent=spec.agent, prompt=text)
        db.add(run)
        db.flush()
        run_id = run.id
        user_msg = Message(session_id=session_id, role="user", content=text, reply_to=reply_to,
                           attachments=json.dumps(attachments, ensure_ascii=False) if attachments else None,
                           run_id=run_id)
        db.add(user_msg)
        db.flush()
        user_msg_id = user_msg.id
        meta.status = "running"
        s.last_run_id = run_id
        s.run_status = "running"
        s.last_message_at = now()
        s.updated_at = now()
        db.add(meta)
        db.add(s)
        db.commit()

        async def _go() -> None:
            try:
                await staff.run_chat_turn(engine=self.engine, session_id=session_id, run_id=run_id, spec=spec,
                                          send=self.send, registry=PROCESSES)
            finally:
                self.coding_runs.pop(run_id, None)

        task = asyncio.create_task(_go())
        self.coding_runs[run_id] = {"session_id": session_id, "task": task}
        await self.send({"type": "run.started", "session_id": session_id, "run_id": run_id, "message_id": user_msg_id,
                         "attachments": attachments, "reply_to": reply_to, "model": spec.model or "",
                         "runtime": agent.runtime, "workspace": spec.workspace, "doc_id": ""})

    @staticmethod
    def _run_body(input_: Any, hermes_session_id: str, history: list, model: Optional[str], provider: Optional[str],
                  instructions: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {"input": input_}
        if hermes_session_id:
            body["session_id"] = hermes_session_id
        if history:
            body["conversation_history"] = history
        if model:
            body["model"] = model
        if provider:
            body["provider"] = provider
        if instructions:
            body["instructions"] = instructions
        return body

    async def _start_multimodal(self, profile, text, imgs, hermes_session_id, history, model, provider,
                                instructions: Optional[str] = None) -> str:
        """POST /v1/runs with `input` as a message list whose last user content has image parts."""
        body = self._run_body([{"role": "user", "content": [{"type": "text", "text": text}, *imgs]}],
                              hermes_session_id, history, model, provider, instructions)
        return await self._post_run(profile, body)

    async def _post_run(self, profile: Optional[str], body: dict[str, Any]) -> str:
        async with self.gateway._client() as c:  # reuse auth/base-url; gateway.py is owned by another module
            r = await c.post(f"{self.gateway._prefix(profile)}/v1/runs", json=body)
            self.gateway._raise(r)
            data = r.json()
            run_id = data.get("run_id") or data.get("id")
            if not run_id:
                raise GatewayError(502, "gateway returned no run_id")
            return run_id

    async def control(self, kind: str, msg: dict[str, Any]) -> None:
        run_id = str(msg.get("run_id") or "")
        if run_id in self.coding_runs:
            if kind != "stop":
                await self.error("coding 員工只支援停止（不支援插話／核准）", "unsupported", run_id=run_id)
                return
            ap = PROCESSES.get(run_id)
            if ap is not None:
                await ap.stop()
            await self.send({"type": "stop.ack", "session_id": self.coding_runs[run_id]["session_id"], "run_id": run_id})
            return
        info = self.runs.get(run_id)
        if info is None:
            await self.error(f"unknown run_id: {run_id}", "unknown_run", run_id=run_id)
            return
        profile = info["profile"]
        try:
            if kind == "approval":
                decision = str(msg.get("decision") or msg.get("choice") or "deny")
                approval_id = str(msg.get("approval_id") or run_id)
                prior = inbox_svc.lookup(run_id, approval_id, engine=self.engine)
                if prior and prior.get("status") == "resolved":
                    # 收件匣（或另一個分頁）已決定並 forward 過，不再送第二次
                    await self.send({"type": "approval.ack", "session_id": info["session_id"], "run_id": run_id,
                                     "approval_id": approval_id, "already_decided": True, "decision": prior.get("decision")})
                    return
                await self.gateway.approve(profile, run_id, decision)
                inbox_svc.mark_decided(run_id=run_id, approval_id=approval_id, decision=decision, member_id=self.p.member.id,
                                       forwarded=True, engine=self.engine)
            elif kind == "stop":
                await self.gateway.stop(profile, run_id)
            elif kind == "steer":
                await self.gateway.steer(profile, run_id, str(msg.get("input") or ""))
            await self.send({"type": f"{kind}.ack", "session_id": info["session_id"], "run_id": run_id})
        except GatewayError as e:
            await self.error(e.message, "gateway_error", run_id=run_id)
        except Exception as e:
            await self.error(str(e), "gateway_unreachable", run_id=run_id)

    # -- SSE pump ----------------------------------------------------------
    async def _pump(self, run_id: str, session_id: str, profile: Optional[str]) -> None:
        assistant_text: list[str] = []
        reasoning: list[str] = []
        tools: dict[str, dict[str, Any]] = {}  # tool name -> pending tool message
        terminal = False
        doc_events: list[dict[str, Any]] = []
        doc_sent: list[dict[str, Any]] = []
        try:
            async for ev in self.gateway.run_events(profile, run_id):
                name = ev.get("event") or ev.get("type") or ""
                out = {k: v for k, v in ev.items() if k != "event"}
                out.update({"type": name, "session_id": session_id, "run_id": run_id})
                if name == "message.delta":
                    assistant_text.append(str(ev.get("delta") or ""))
                elif name == "reasoning.available":
                    r = ev.get("reasoning") or ev.get("text") or ev.get("content") or ""
                    if isinstance(r, str) and r:
                        reasoning.append(r)
                elif name == "tool.started":
                    tool_name = ev.get("tool") or ev.get("name") or "tool"
                    out.setdefault("name", tool_name)
                    out.setdefault("args", ev.get("preview") or ev.get("args"))
                    tools[tool_name] = {"name": tool_name, "args": out["args"]}
                elif name == "tool.completed":
                    tool_name = ev.get("tool") or ev.get("name") or "tool"
                    out.setdefault("name", tool_name)
                    result = {k: ev.get(k) for k in ("result", "preview", "duration", "error") if k in ev}
                    out.setdefault("result", result)
                    pending = tools.pop(tool_name, {"name": tool_name, "args": None})
                    self._save_tool(session_id, run_id, tool_name, pending.get("args"), result)
                elif name == "subagent.complete":
                    # 背景委派結果（gateway 0.20.5 只送 start/complete 生命週期，不送子代理的工具細節）
                    result = {k: ev.get(k) for k in ("status", "summary", "output_tail", "duration_seconds", "input_tokens", "output_tokens",
                                                     "tool_count", "cost_usd", "files_written", "child_session_id") if ev.get(k) is not None}
                    self._save_tool(session_id, run_id, "subagent", {"goal": ev.get("goal"), "subagent_id": ev.get("subagent_id"),
                                                                     "model": ev.get("model")}, result)
                elif name == "approval.request":
                    out.setdefault("approval_id", ev.get("approval_id") or ev.get("id") or run_id)
                    out.setdefault("command", ev.get("command"))
                    out.setdefault("context", {k: ev.get(k) for k in ("tool", "description", "choices", "reason") if k in ev})
                    # 同步進收件匣（直接 import，不走 HTTP）
                    pid = inbox_svc.record(company_id=self.p.company_id, member_id=self.p.member.id, session_id=session_id,
                                           run_id=run_id, approval_id=str(out["approval_id"]), agent=profile or "",
                                           command=str(out.get("command") or ""), context=out.get("context") or {}, engine=self.engine)
                    if pid:
                        out["pending_id"] = pid
                elif name in ("run.completed", "run.failed", "run.cancelled"):
                    terminal = True
                    final = ev.get("output") if name == "run.completed" else None
                    content = final if isinstance(final, str) and final else "".join(assistant_text)
                    usage = ev.get("usage") if isinstance(ev.get("usage"), dict) else None
                    if name == "run.completed":
                        content, doc_events = self._handle_doc_output(run_id, session_id, content)
                        doc_sent = doc_events
                        out["output"] = content
                    msg_id = self._save_assistant(session_id, run_id, content, status=name, usage=usage,
                                                  reasoning="\n".join(reasoning) or None)
                    if msg_id:
                        out["message_id"] = msg_id
                    if usage:
                        out["session_usage"] = self._session_usage(session_id)
                for ev2 in doc_events:  # doc.updated / doc.patch_failed 先送，run.completed 才是收尾
                    await self.send(ev2)
                doc_events = []
                await self.send(out)
                if terminal:
                    await self._maybe_doc_retry(run_id, session_id, doc_sent)
                    break
            if not terminal:
                # stream closed without terminal event; ask status once
                try:
                    st = await self.gateway.run_status(profile, run_id)
                except Exception:
                    st = {}
                status = st.get("status", "unknown")
                content = st.get("output") or "".join(assistant_text)
                usage = st.get("usage") if isinstance(st.get("usage"), dict) else None
                if status == "completed":
                    content, doc_events = self._handle_doc_output(run_id, session_id, content)
                    self._save_assistant(session_id, run_id, content, status="run.completed", usage=usage)
                    for ev2 in doc_events:
                        await self.send(ev2)
                    await self.send({"type": "run.completed", "session_id": session_id, "run_id": run_id, "output": content,
                                     "usage": usage, "session_usage": self._session_usage(session_id)})
                    await self._maybe_doc_retry(run_id, session_id, doc_events)
                else:
                    self._save_assistant(session_id, run_id, content, status="run.failed")
                    await self.send({"type": "run.failed", "session_id": session_id, "run_id": run_id, "error": st.get("error") or f"stream closed (status={status})"})
        except asyncio.CancelledError:
            self._set_status(session_id, "cancelled")
            raise
        except Exception as e:
            log.exception("run pump failed for %s", run_id)
            self._set_status(session_id, "failed")
            try:
                await self.send({"type": "run.failed", "session_id": session_id, "run_id": run_id, "error": str(e)})
            except Exception:
                pass
        finally:
            self.runs.pop(run_id, None)

    # -- doc mode ----------------------------------------------------------
    def _handle_doc_output(self, run_id: str, session_id: str, content: str) -> tuple[str, list[dict[str, Any]]]:
        """文件模式：抽掉 ```doc 圍欄、建立新版本。回 (訊息本文, 要推給前端的事件)。"""
        info = self.runs.get(run_id) or {}
        doc_ctx = info.get("doc")
        if not doc_ctx:
            return content, []
        try:
            res = doc_link.apply_output(self.engine, self.docs_workspace, doc_ctx["doc_id"], content,
                                        session_id=session_id, run_id=run_id, author_id=info.get("profile") or "")
        except Exception as e:  # pragma: no cover - 文件層壞了不影響對話
            log.warning("doc apply failed for %s: %s", doc_ctx.get("doc_id"), e)
            return content, []
        events: list[dict[str, Any]] = []
        if res.get("updated"):
            events.append({"type": "doc.updated", "session_id": session_id, "run_id": run_id, **res["updated"]})
        if res.get("patch_error"):
            events.append({"type": "doc.patch_failed", "session_id": session_id, "run_id": run_id,
                           "doc_id": doc_ctx["doc_id"], "reason": res["patch_error"]})
        return res.get("body", content), events

    async def _maybe_doc_retry(self, run_id: str, session_id: str, events: list[dict[str, Any]]) -> None:
        """```doc-patch 套不上 → 自動再跑一輪，請模型重出全文（只重試一次）。"""
        info = self.runs.get(run_id) or {}
        failed = next((e for e in events if e["type"] == "doc.patch_failed"), None)
        if failed is None or info.get("doc_retry"):
            return
        await self.start_run({"session_id": session_id, "input": doc_link.RETRY_PROMPT.format(reason=failed["reason"]),
                              "_doc_retry": True})

    def _set_status(self, session_id: str, status: str) -> None:
        with Session(self.engine) as db:
            s = db.get(ChatSession, session_id)
            if s:
                s.run_status = status
                db.add(s)
                db.commit()

    def _session_usage(self, session_id: str) -> dict[str, int]:
        with Session(self.engine) as db:
            s = db.get(ChatSession, session_id)
            if not s:
                return {}
            return {"input_tokens": s.input_tokens, "output_tokens": s.output_tokens, "total_tokens": s.total_tokens,
                    "context_tokens": s.context_tokens}

    def _save_assistant(self, session_id: str, run_id: str, content: str, status: str,
                        usage: Optional[dict[str, Any]] = None, reasoning: Optional[str] = None) -> Optional[str]:
        msg_id: Optional[str] = None
        with Session(self.engine) as db:
            s = db.get(ChatSession, session_id)
            if content or status == "run.completed":
                m = Message(session_id=session_id, role="assistant", content=content, run_id=run_id,
                            usage=json.dumps(usage, ensure_ascii=False, default=str) if usage else None,
                            reasoning=reasoning)
                db.add(m)
                db.flush()
                msg_id = m.id
                if s:
                    s.last_message_at = now()
            if s:
                s.updated_at = now()
                s.run_status = {"run.completed": "completed", "run.failed": "failed", "run.cancelled": "cancelled"}.get(status, "")
                if usage:
                    i = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
                    o = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
                    t = int(usage.get("total_tokens") or (i + o))
                    s.input_tokens = (s.input_tokens or 0) + i
                    s.output_tokens = (s.output_tokens or 0) + o
                    s.total_tokens = (s.total_tokens or 0) + t
                    s.context_tokens = i + o
                db.add(s)
            db.commit()
        return msg_id

    def _save_tool(self, session_id: str, run_id: str, name: str, args: Any, result: Any) -> None:
        with Session(self.engine) as db:
            db.add(Message(session_id=session_id, role="tool", content="", tool_name=name, run_id=run_id,
                           tool_args=json.dumps(args, ensure_ascii=False, default=str) if args is not None else None,
                           tool_result=json.dumps(result, ensure_ascii=False, default=str) if result is not None else None))
            db.commit()

    async def close(self) -> None:
        for info in list(self.runs.values()):
            info["task"].cancel()
        # coding 員工的子程序不砍：讓它跑完並落庫，重連後從歷史看得到結果


@router.websocket("/ws/chat")
async def ws_chat(ws: WebSocket):
    with Session(ws.app.state.engine) as db:
        try:
            principal = principal_from_ws(ws, db)
        except ApiError as e:
            await ws.close(code=4401, reason=e.message)
            return
        db.refresh(principal.member)
        db.expunge(principal.member)
    await ws.accept()
    bridge = ChatBridge(ws, principal)
    _BRIDGES.add(bridge)
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
        _BRIDGES.discard(bridge)
        await bridge.close()
