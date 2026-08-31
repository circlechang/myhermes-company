"""群聊核心：@mention 解析、路由決策、上下文組裝、壓縮、AI 回覆編排（含深度上限）。

純函式（parse_mentions / decide_targets / estimate_tokens / build_context）不碰 IO，方便測試；
Orchestrator 負責呼叫 gateway 與廣播。
"""
from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from sqlmodel import Session, select

from ...hermes.gateway import GatewayClient, GatewayError
from ...models import Agent, new_id, now
from ..coding_agents import staff
from ..coding_agents.router import PROCESSES
from .models import Room, RoomMember, RoomMessage, RoomSummary

log = logging.getLogger("studio.groupchat")

# @ 後面接：中英數、底線、連字號、點（profile 名常見）；名稱比對時以「最長優先」避免 @researcher 吃掉 @researcher-2
_MENTION_RE = re.compile(r"@([\w一-鿿぀-ヿ.-]+)")


def parse_mentions(text: str, members: list[RoomMember]) -> list[RoomMember]:
    """回傳被 @ 到的成員（依出現順序、去重）。名稱比對不分大小寫，
    允許「@名稱」後接標點（例：@小明，你好）。"""
    if "@" not in text:
        return []
    by_name = sorted(members, key=lambda m: -len(m.display_name))
    found: list[RoomMember] = []
    for m in _MENTION_RE.finditer(text):
        token = m.group(1)
        low = token.lower()
        for mem in by_name:
            name = mem.display_name.lower()
            # 允許 token 以名稱開頭（中文 @小明你好 沒有分隔），或名稱相等
            if low == name or (low.startswith(name) and len(name) >= 2) or (mem.profile and low == mem.profile.lower()):
                if mem not in found:
                    found.append(mem)
                break
    return found


def decide_targets(room: Room, members: list[RoomMember], text: str, sender: Optional[RoomMember],
                   depth: int) -> tuple[list[RoomMember], int]:
    """決定哪些 AI 要回覆。回傳 (targets, new_rr_cursor)。
    - 有 @：被 @ 的 AI（排除自己）
    - 無 @ 且人類發言：依 room.no_mention_policy（round_robin / host / none）
    - AI 發言無 @：不觸發（避免 AI 自言自語）
    - depth 已達 room.max_ai_depth：AI 發言不再觸發任何人
    """
    ais = [m for m in members if m.kind == "ai"]
    if not ais:
        return [], room.rr_cursor
    is_ai = sender is not None and sender.kind == "ai"
    if is_ai and depth >= room.max_ai_depth:
        return [], room.rr_cursor
    mentioned = [m for m in parse_mentions(text, members) if m.kind == "ai" and (sender is None or m.id != sender.id)]
    if mentioned:
        return mentioned, room.rr_cursor
    if is_ai:
        return [], room.rr_cursor
    policy = room.no_mention_policy
    if policy == "round_robin":
        idx = room.rr_cursor % len(ais)
        return [ais[idx]], idx + 1
    if policy == "host":
        host = next((m for m in ais if m.id == room.host_member_id), None) or ais[0]
        return [host], room.rr_cursor
    return [], room.rr_cursor


def estimate_tokens(text: str) -> int:
    """粗估：CJK 每字 1 token、其他每 4 字元 1 token。只用來決定何時壓縮，不求精準。"""
    cjk = sum(1 for ch in text if "぀" <= ch <= "鿿")
    other = len(text) - cjk
    return cjk + (other + 3) // 4


@dataclass
class Context:
    instructions: str
    history: list[dict[str, str]]
    input_text: str


def build_context(room: Room, members: list[RoomMember], target: RoomMember, messages: list[RoomMessage],
                  summary: Optional[RoomSummary], trigger: RoomMessage) -> Context:
    """把房間狀態組成送 gateway 的 instructions + conversation_history + input。
    messages：摘要之後的訊息（已排序、不含 trigger）；history 只取最近 room.history_n 則。"""
    roster = "、".join(f"{m.display_name}（{'AI' if m.kind == 'ai' else '人類'}）" for m in members)
    others_ai = [m.display_name for m in members if m.kind == "ai" and m.id != target.id]
    parts = [
        f"你是群聊「{room.name}」裡的成員「{target.display_name}」。房間成員：{roster}。",
        "訊息格式為「[發言者]: 內容」。請以你的身分直接回覆，不要加上自己的名字前綴，保持簡潔。",
    ]
    if others_ai:
        parts.append(f"若需要其他 AI 成員接手，可在回覆中用 @名稱 點名（可點名：{'、'.join(others_ai)}）；不需要就不要 @，避免來回打轉。")
    if target.system_prompt.strip():
        parts.append("你的角色設定：\n" + target.system_prompt.strip())
    if summary and summary.content.strip():
        parts.append("先前對話摘要：\n" + summary.content.strip())
    history: list[dict[str, str]] = []
    for m in messages[-room.history_n:]:
        if not m.content:
            continue
        if m.sender_id == target.id:
            history.append({"role": "assistant", "content": m.content})
        else:
            history.append({"role": "user", "content": f"[{m.sender_name}]: {m.content}"})
    input_text = f"[{trigger.sender_name}]: {trigger.content}"
    return Context(instructions="\n\n".join(parts), history=history, input_text=input_text)


SUMMARY_PROMPT = (
    "請把下面這段群聊對話濃縮成摘要，保留：已決定的事、待辦、各成員立場、關鍵數字與名稱。"
    "用條列，繁體中文，不超過 400 字。只輸出摘要本文。\n\n"
)


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
Broadcast = Callable[[str, dict[str, Any]], Awaitable[None]]


class Orchestrator:
    """一個 app 一個實例，掛在 app.state.groupchat。"""

    def __init__(self, engine, gateway: GatewayClient, broadcast: Broadcast, app=None):
        self.engine = engine
        self.gateway = gateway
        self.broadcast = broadcast
        self.app = app
        self.tasks: set[asyncio.Task] = set()
        self._room_locks: dict[str, asyncio.Lock] = {}

    def _lock(self, room_id: str) -> asyncio.Lock:
        return self._room_locks.setdefault(room_id, asyncio.Lock())

    # -- persistence helpers ------------------------------------------------
    def _next_seq(self, db: Session, room_id: str) -> int:
        last = db.exec(select(RoomMessage.seq).where(RoomMessage.room_id == room_id).order_by(RoomMessage.seq.desc())).first()
        return (last or 0) + 1

    def save_message(self, room_id: str, sender: Optional[RoomMember], content: str, *, kind: Optional[str] = None,
                     depth: int = 0, run_id: Optional[str] = None, status: str = "done") -> RoomMessage:
        with Session(self.engine) as db:
            msg = RoomMessage(
                room_id=room_id, seq=self._next_seq(db, room_id), sender_id=sender.id if sender else None,
                sender_name=sender.display_name if sender else "系統", sender_kind=kind or (sender.kind if sender else "system"),
                content=content, depth=depth, run_id=run_id, status=status,
            )
            db.add(msg)
            room = db.get(Room, room_id)
            if room:
                room.updated_at = now()
                db.add(room)
            db.commit()
            db.refresh(msg)
            db.expunge(msg)
            return msg

    def _load(self, room_id: str) -> tuple[Optional[Room], list[RoomMember]]:
        with Session(self.engine) as db:
            room = db.get(Room, room_id)
            members = db.exec(select(RoomMember).where(RoomMember.room_id == room_id).order_by(RoomMember.joined_at)).all()
            for m in members:
                db.expunge(m)
            if room:
                db.expunge(room)
            return room, list(members)

    def _messages_after_summary(self, room_id: str, exclude_id: Optional[str] = None) -> tuple[list[RoomMessage], Optional[RoomSummary]]:
        with Session(self.engine) as db:
            summary = db.exec(select(RoomSummary).where(RoomSummary.room_id == room_id).order_by(RoomSummary.covers_until_seq.desc())).first()
            q = select(RoomMessage).where(RoomMessage.room_id == room_id, RoomMessage.status == "done")
            if summary:
                q = q.where(RoomMessage.seq > summary.covers_until_seq)
            rows = [m for m in db.exec(q.order_by(RoomMessage.seq)).all() if m.id != exclude_id]
            for m in rows:
                db.expunge(m)
            if summary:
                db.expunge(summary)
            return rows, summary

    # -- entry point ----------------------------------------------------------
    async def post(self, room_id: str, sender: Optional[RoomMember], content: str, *, depth: int = 0,
                   run_id: Optional[str] = None) -> RoomMessage:
        """存訊息、廣播、決定要回覆的 AI 並在背景執行。"""
        msg = self.save_message(room_id, sender, content, depth=depth, run_id=run_id)
        await self.broadcast(room_id, {"type": "message.new", "message": msg.to_dict()})
        room, members = self._load(room_id)
        if room is None:
            return msg
        targets, cursor = decide_targets(room, members, content, sender, depth)
        if cursor != room.rr_cursor:
            with Session(self.engine) as db:
                r = db.get(Room, room_id)
                if r:
                    r.rr_cursor = cursor
                    db.add(r)
                    db.commit()
        # 壓縮檢查在觸發 AI 之前做，讓這次回覆就能用到摘要
        await self.maybe_compress(room, members)
        for target in targets:
            self._spawn(self.reply(room_id, target.id, msg, depth + 1))
        return msg

    def _spawn(self, coro) -> asyncio.Task:
        t = asyncio.create_task(coro)
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)
        return t

    async def wait_idle(self, timeout: float = 10.0) -> None:
        """測試用：等所有背景 AI 回覆結束（包含連鎖觸發）。"""
        deadline = asyncio.get_event_loop().time() + timeout
        while self.tasks and asyncio.get_event_loop().time() < deadline:
            await asyncio.wait(list(self.tasks), timeout=0.2)

    # -- AI reply ---------------------------------------------------------------
    async def reply(self, room_id: str, target_id: str, trigger: RoomMessage, depth: int) -> None:
        room, members = self._load(room_id)
        target = next((m for m in members if m.id == target_id), None)
        if room is None or target is None:
            return
        await self.broadcast(room_id, {"type": "ai.typing", "member_id": target.id, "name": target.display_name,
                                       "trigger_id": trigger.id})
        messages, summary = self._messages_after_summary(room_id, exclude_id=trigger.id)
        ctx = build_context(room, members, target, messages, summary, trigger)
        coding_agent = self._coding_agent_for(target)
        if coding_agent is not None:
            await self._reply_coding(room_id, target, trigger, depth, ctx, coding_agent)
            return
        text_parts: list[str] = []
        run_id: Optional[str] = None
        try:
            run_id = await self.gateway.start_run(
                target.profile or None, ctx.input_text, session_id=f"studio_room_{room_id}_{target.id}",
                conversation_history=ctx.history or None, instructions=ctx.instructions, model=target.model or None,
            )
            await self.broadcast(room_id, {"type": "ai.started", "member_id": target.id, "run_id": run_id})
            final: Optional[str] = None
            failed: Optional[str] = None
            async for ev in self.gateway.run_events(target.profile or None, run_id):
                name = ev.get("event") or ev.get("type") or ""
                if name == "message.delta":
                    d = str(ev.get("delta") or "")
                    text_parts.append(d)
                    await self.broadcast(room_id, {"type": "ai.delta", "member_id": target.id, "run_id": run_id, "delta": d})
                elif name == "tool.started":
                    await self.broadcast(room_id, {"type": "ai.tool", "member_id": target.id, "run_id": run_id,
                                                   "tool": ev.get("tool") or ev.get("name")})
                elif name == "run.completed":
                    out = ev.get("output")
                    final = out if isinstance(out, str) and out else "".join(text_parts)
                    break
                elif name in ("run.failed", "run.cancelled"):
                    failed = str(ev.get("error") or name)
                    break
            if final is None and failed is None:
                try:
                    st = await self.gateway.run_status(target.profile or None, run_id)
                except Exception:
                    st = {}
                if st.get("status") == "completed":
                    final = st.get("output") or "".join(text_parts)
                else:
                    failed = st.get("error") or "stream closed"
        except GatewayError as e:
            failed = e.message
        except Exception as e:  # gateway unreachable etc.
            log.exception("groupchat reply failed")
            failed = str(e)
        if failed is not None:
            m = self.save_message(room_id, target, f"（回覆失敗：{failed}）", depth=depth, run_id=run_id, status="failed")
            await self.broadcast(room_id, {"type": "ai.failed", "member_id": target.id, "run_id": run_id,
                                           "error": failed, "message": m.to_dict()})
            return
        content = (final or "").strip()
        # 模型偶爾會自己加「[名字]: 」前綴，去掉
        prefix = f"[{target.display_name}]:"
        if content.startswith(prefix):
            content = content[len(prefix):].strip()
        await self.broadcast(room_id, {"type": "ai.done", "member_id": target.id, "run_id": run_id})
        # 透過 post 走同一條路：存檔、廣播 message.new、再看有沒有 @ 別的 AI（深度 +1）
        await self.post(room_id, target, content, depth=depth, run_id=run_id)

    # -- coding 員工（runtime = claude-code / codex / pi）---------------------
    def _coding_agent_for(self, target: RoomMember) -> Optional[Agent]:
        """這位群聊 AI 成員背後的 AI 員工如果是 coding runtime，回那筆 Agent；否則 None。"""
        if target.kind != "ai" or not target.agent_id or self.app is None:
            return None
        with Session(self.engine) as db:
            a = db.get(Agent, target.agent_id)
            if a is None or not staff.is_coding(staff.runtime_of(a)):
                return None
            db.expunge(a)
            return a

    async def _reply_coding(self, room_id: str, target: RoomMember, trigger: RoomMessage, depth: int,
                            ctx: "Context", agent: Agent) -> None:
        """coding 員工在群聊裡回話：跑一次 CLI，把輸出當成一則群聊訊息（走同一條 post）。"""
        history = "\n".join(f"{h['role']}: {h['content']}" for h in ctx.history[-8:])
        prompt = f"{ctx.instructions}\n\n[近期對話]\n{history}\n\n[現在這則]\n{ctx.input_text}"
        run_id = new_id("crun")
        failed: Optional[str] = None
        output = ""
        try:
            with Session(self.engine) as db:
                spec = staff.build_spec(self.app, agent, prompt, workspace=agent.workspace, db=db)
            await self.broadcast(room_id, {"type": "ai.started", "member_id": target.id, "run_id": run_id})

            async def on_event(ev: dict[str, Any]) -> None:
                if ev.get("type") == "message.delta":
                    await self.broadcast(room_id, {"type": "ai.delta", "member_id": target.id, "run_id": run_id,
                                                   "delta": str(ev.get("delta") or "")})
                elif ev.get("type") == "tool.started":
                    await self.broadcast(room_id, {"type": "ai.tool", "member_id": target.id, "run_id": run_id,
                                                   "tool": ev.get("name")})

            result = await staff.execute(spec, run_id, on_event, registry=PROCESSES, timeout=1800.0)
            output = str(result.get("output") or "")
            if result.get("status") != "completed":
                failed = str(result.get("error") or result.get("status") or "failed")
        except Exception as e:
            log.exception("groupchat coding reply failed")
            failed = str(getattr(e, "message", None) or e)
        if failed is not None:
            m = self.save_message(room_id, target, f"（回覆失敗：{failed}）", depth=depth, run_id=run_id, status="failed")
            await self.broadcast(room_id, {"type": "ai.failed", "member_id": target.id, "run_id": run_id,
                                           "error": failed, "message": m.to_dict()})
            return
        await self.broadcast(room_id, {"type": "ai.done", "member_id": target.id, "run_id": run_id})
        await self.post(room_id, target, output.strip() or "（沒有輸出）", depth=depth, run_id=run_id)

    # -- compression --------------------------------------------------------------
    async def maybe_compress(self, room: Room, members: list[RoomMember], *, force: bool = False) -> Optional[RoomSummary]:
        ais = [m for m in members if m.kind == "ai"]
        if not ais:
            return None
        async with self._lock(room.id):
            messages, summary = self._messages_after_summary(room.id)
            # 至少留 history_n 則不壓，超過門檻的部分才摘要
            if len(messages) <= room.history_n and not force:
                return None
            total = sum(estimate_tokens(m.content) for m in messages)
            if total < room.compress_threshold_tokens and not force:
                return None
            keep = room.history_n if not force else 0
            to_fold = messages[: len(messages) - keep] if keep else messages
            if not to_fold:
                return None
            summarizer = next((m for m in ais if m.id == room.summarizer_member_id), ais[0])
            transcript = "\n".join(f"[{m.sender_name}]: {m.content}" for m in to_fold)
            prompt = SUMMARY_PROMPT
            if summary:
                prompt += "先前摘要：\n" + summary.content + "\n\n新的對話：\n"
            prompt += transcript
            await self.broadcast(room.id, {"type": "summary.started", "member_id": summarizer.id})
            try:
                run_id = await self.gateway.start_run(summarizer.profile or None, prompt,
                                                      instructions="你是會議記錄員，只輸出摘要。", model=summarizer.model or None)
                out_parts: list[str] = []
                final = ""
                async for ev in self.gateway.run_events(summarizer.profile or None, run_id):
                    name = ev.get("event") or ev.get("type") or ""
                    if name == "message.delta":
                        out_parts.append(str(ev.get("delta") or ""))
                    elif name == "run.completed":
                        o = ev.get("output")
                        final = o if isinstance(o, str) and o else "".join(out_parts)
                        break
                    elif name in ("run.failed", "run.cancelled"):
                        raise GatewayError(502, str(ev.get("error") or name))
                if not final:
                    final = "".join(out_parts)
            except Exception as e:
                log.warning("groupchat compress failed: %s", e)
                await self.broadcast(room.id, {"type": "summary.failed", "error": str(e)})
                return None
            with Session(self.engine) as db:
                s = RoomSummary(room_id=room.id, content=final.strip(), covers_until_seq=to_fold[-1].seq,
                                made_by=summarizer.display_name)
                db.add(s)
                db.commit()
                db.refresh(s)
                db.expunge(s)
            await self.broadcast(room.id, {"type": "summary.updated", "summary": s.to_dict()})
            return s

    async def shutdown(self) -> None:
        for t in list(self.tasks):
            t.cancel()
