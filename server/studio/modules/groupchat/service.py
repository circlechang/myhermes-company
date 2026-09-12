"""群聊核心：@mention 解析、路由決策、上下文組裝、壓縮、AI 回覆編排（含深度上限）。

純函式（parse_mentions / decide_targets / estimate_tokens / build_context）不碰 IO，方便測試；
Orchestrator 負責呼叫 gateway 與廣播。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from sqlmodel import Session, select

from ...hermes.gateway import GatewayClient, GatewayError
from ...models import Agent, new_id, now
from ..coding_agents import staff
from ..coding_agents.router import PROCESSES
from .models import Room, RoomDoc, RoomMember, RoomMessage, RoomSummary

log = logging.getLogger("studio.groupchat")

# @ 後面接：中英數、底線、連字號、點（profile 名常見）；名稱比對時以「最長優先」避免 @researcher 吃掉 @researcher-2
_MENTION_RE = re.compile(r"@([\w一-鿿぀-ヿ.-]+)")
# @everyone：群組裡所有 Bot 都要看（少用，給群組層級的公告）
_EVERYONE_RE = re.compile(r"@(everyone|all|所有人|大家)(?![\w一-鿿])", re.IGNORECASE)


def _doc_gist(body: str, content: str, title: str) -> str:
    """文件卡的一句摘要：Bot 圍欄外那句說明；沒有就取文件內第一行正文（跳過標題）。"""
    b = " ".join((body or "").split())
    if b:
        return b[:120]
    for line in (content or "").splitlines():
        t = line.strip().lstrip("#>-*0123456789. ").strip()
        if t and t != title.strip():
            return _clip(t, 120)
    return title


def model_or_none(model: Optional[str]) -> Optional[str]:
    """`hermes profile list` 沒設模型時顯示「—」，同步進 agents.model 後不能當模型 id 送出；空值／佔位字一律改用 profile 預設。"""
    m = (model or "").strip()
    return None if not m or m in ("—", "–", "-", "default", "(default)") else m


def mentions_everyone(text: str) -> bool:
    return bool(_EVERYONE_RE.search(text or ""))


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
    if not is_ai and mentions_everyone(text):
        return ais, room.rr_cursor
    mentioned = [m for m in parse_mentions(text, members) if m.kind == "ai" and (sender is None or m.id != sender.id)]
    if mentioned:
        return mentioned, room.rr_cursor
    if is_ai:
        return [], room.rr_cursor
    policy = room.no_mention_policy
    if len(ais) == 1 and policy in ("auto", "host"):
        # 私訊或只有一個 Bot 的群組：不 @ 也是它接
        return [ais[0]], room.rr_cursor
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


# Bot 產出文件的規則（沒有焦點文件時；有焦點文件時改用 docs.service.doc_context 的更新規則）
NEW_DOC_RULES = (
    "[文件規則]\n"
    "需要交付一份文件（報告、企劃、清單、報價單、會議紀錄、草稿…）時，把**完整內容**用 Markdown 放在回覆最後的 ```doc 圍欄裡，"
    "圍欄第一行寫「# 標題」。圍欄之外只寫一兩句說明，不要把內容再貼一次。這一輪不需要交付文件就不要輸出圍欄。"
    "文件會變成群組裡的一張文件卡，其他成員可以接著改。"
)


def _clip(text: str, n: int = 160) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def build_context(room: Room, members: list[RoomMember], target: RoomMember, messages: list[RoomMessage],
                  summary: Optional[RoomSummary], trigger: RoomMessage, *, reply_to: Optional[RoomMessage] = None,
                  doc_context: str = "", skill: str = "") -> Context:
    """把房間狀態組成送 gateway 的 instructions + conversation_history + input。
    messages：摘要之後的訊息（已排序、不含 trigger）；history 只取最近 room.history_n 則。
    trigger 在討論串裡時，history 只放同一串（根訊息＋回覆），主對話不混進來。"""
    roster = "、".join(f"{m.display_name}（{'AI' if m.kind == 'ai' else '人類'}）" for m in members)
    others_ai = [m.display_name for m in members if m.kind == "ai" and m.id != target.id]
    if room.kind == "dm":
        parts = [f"你是「{target.display_name}」，正在跟使用者一對一私訊。請以你的身分直接回覆，保持簡潔。"]
    else:
        parts = [
            f"你是群組「{room.name}」裡的成員「{target.display_name}」。群組成員：{roster}。",
            "訊息格式為「[發言者]: 內容」。請以你的身分直接回覆，不要加上自己的名字前綴，保持簡潔。",
        ]
        if others_ai:
            parts.append(f"若需要其他 AI 成員接手（例如請專家審稿、交給負責的人），在回覆中用 @名稱 點名並說清楚要他做什麼"
                         f"（可點名：{'、'.join(others_ai)}）；不需要就不要 @，避免來回打轉。")
    if target.system_prompt.strip():
        parts.append("你的角色設定：\n" + target.system_prompt.strip())
    if summary and summary.content.strip():
        parts.append("先前對話摘要：\n" + summary.content.strip())
    if skill:
        parts.append(f"使用者指定這一輪要用技能「{skill}」：請先載入這個技能，照它的步驟做。")
    parts.append(doc_context or NEW_DOC_RULES)
    if trigger.thread_root_id:
        scoped = [m for m in messages if m.id == trigger.thread_root_id or m.thread_root_id == trigger.thread_root_id]
        parts.append("這是一個討論串，只針對串裡的主題回覆。")
    else:
        scoped = [m for m in messages if not m.thread_root_id]
    history: list[dict[str, str]] = []
    for m in scoped[-room.history_n:]:
        if not m.content:
            continue
        if m.sender_id == target.id:
            history.append({"role": "assistant", "content": m.content})
        else:
            history.append({"role": "user", "content": f"[{m.sender_name}]: {m.content}"})
    quote = f"（回覆 {reply_to.sender_name} 的「{_clip(reply_to.content)}」）" if reply_to is not None else ""
    input_text = f"[{trigger.sender_name}]: {quote}{trigger.content}"
    return Context(instructions="\n\n".join(parts), history=history, input_text=input_text)


# ---------------------------------------------------------------------------
# 自動分派（policy=auto）：不 @ 時由 Bot 自己判斷誰接
# ---------------------------------------------------------------------------
ROUTE_PROMPT = (
    "你是群組的分派員。根據使用者這則訊息，判斷群組裡哪一位（或哪幾位）成員最該回應。"
    "只輸出 JSON，格式：{\"names\": [\"成員名稱\"]}；最多 2 位；一般閒聊或不確定就選最適合的 1 位。不要輸出其他文字。"
)


def route_input(members: list[RoomMember], text: str) -> str:
    lines = []
    for m in members:
        if m.kind != "ai":
            continue
        role = _clip(m.system_prompt, 120) if m.system_prompt.strip() else ""
        lines.append(f"- {m.display_name}{'：' + role if role else ''}")
    return "群組成員：\n" + "\n".join(lines) + f"\n\n使用者訊息：{text}"


def parse_route(output: str, members: list[RoomMember]) -> list[RoomMember]:
    ais = [m for m in members if m.kind == "ai"]
    names: list[str] = []
    m = re.search(r"\{.*\}", output or "", re.S)
    if m:
        try:
            v = json.loads(m.group(0))
            names = [str(x) for x in (v.get("names") or [])] if isinstance(v, dict) else []
        except (TypeError, ValueError):
            names = []
    out: list[RoomMember] = []
    for n in names:
        hit = next((a for a in ais if a.display_name.lower() == n.strip().lstrip("@").lower()), None)
        if hit and hit not in out:
            out.append(hit)
    return out[:2]


def heuristic_route(members: list[RoomMember], text: str) -> list[RoomMember]:
    """分派員失敗時的退路：訊息裡出現誰的名字或角色關鍵字就給誰；都沒有給第一位。"""
    ais = [m for m in members if m.kind == "ai"]
    if not ais:
        return []
    low = (text or "").lower()
    best, score = ais[0], 0
    for a in ais:
        s = 3 if a.display_name.lower() in low else 0
        for kw in re.findall(r"[\w一-鿿]{2,}", a.system_prompt or ""):
            if kw.lower() in low:
                s += 1
        if s > score:
            best, score = a, s
    return [best]


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
        # room_id -> {run_id: (profile, room_member_id)}：「停止」要知道房間裡誰正在跑
        self.active: dict[str, dict[str, tuple[str, str]]] = {}
        self.stopped_runs: set[str] = set()
        self.busy: dict[str, set[str]] = {}  # room_id -> 正在回覆的 room_member id

    def _lock(self, room_id: str) -> asyncio.Lock:
        return self._room_locks.setdefault(room_id, asyncio.Lock())

    # -- persistence helpers ------------------------------------------------
    def _next_seq(self, db: Session, room_id: str) -> int:
        last = db.exec(select(RoomMessage.seq).where(RoomMessage.room_id == room_id).order_by(RoomMessage.seq.desc())).first()
        return (last or 0) + 1

    def save_message(self, room_id: str, sender: Optional[RoomMember], content: str, *, kind: Optional[str] = None,
                     depth: int = 0, run_id: Optional[str] = None, status: str = "done", reply_to_id: str = "",
                     thread_root_id: str = "", doc_id: str = "",
                     attachments: Optional[list[dict[str, Any]]] = None) -> RoomMessage:
        with Session(self.engine) as db:
            msg = RoomMessage(
                room_id=room_id, seq=self._next_seq(db, room_id), sender_id=sender.id if sender else None,
                sender_name=sender.display_name if sender else "系統", sender_kind=kind or (sender.kind if sender else "system"),
                content=content, depth=depth, run_id=run_id, status=status, reply_to_id=reply_to_id or "",
                thread_root_id=thread_root_id or "", doc_id=doc_id or "",
            )
            msg.set_attachments(attachments or [])
            db.add(msg)
            room = db.get(Room, room_id)
            if room:
                room.updated_at = now()
                db.add(room)
            db.commit()
            db.refresh(msg)
            db.expunge(msg)
            return msg

    def update_attachments(self, message_id: str, fn: Callable[[list[dict[str, Any]]], list[dict[str, Any]]]) -> Optional[RoomMessage]:
        with Session(self.engine) as db:
            m = db.get(RoomMessage, message_id)
            if m is None:
                return None
            m.set_attachments(fn(m.attachments()))
            db.add(m)
            db.commit()
            db.refresh(m)
            db.expunge(m)
            return m

    def public(self, m: RoomMessage) -> dict[str, Any]:
        """廣播／回傳用：訊息本體＋引用預覽（前端送出當下就畫得出引用框）。"""
        d = m.to_dict()
        q = self._get_message(m.reply_to_id) if m.reply_to_id else None
        d["reply_to"] = ({"id": q.id, "sender_name": q.sender_name, "content": (q.content or "")[:200],
                          "has_doc": any(a.get("type") == "doc" for a in q.attachments())} if q else None)
        return d

    async def system_event(self, room_id: str, text: str) -> RoomMessage:
        """置中灰字的系統事件（改名、加減成員）；不觸發任何 Bot。"""
        m = self.save_message(room_id, None, text, kind="system")
        await self.broadcast(room_id, {"type": "message.new", "message": m.to_dict()})
        return m

    def _get_message(self, message_id: str) -> Optional[RoomMessage]:
        if not message_id:
            return None
        with Session(self.engine) as db:
            m = db.get(RoomMessage, message_id)
            if m is not None:
                db.expunge(m)
            return m

    def _load(self, room_id: str) -> tuple[Optional[Room], list[RoomMember]]:
        """房間＋成員。AI 成員沒有個別角色設定時，帶入 Bot 本身的職稱與描述（長期規則）。"""
        with Session(self.engine) as db:
            room = db.get(Room, room_id)
            members = db.exec(select(RoomMember).where(RoomMember.room_id == room_id).order_by(RoomMember.joined_at)).all()
            for m in members:
                db.expunge(m)
                if m.kind == "ai" and not (m.system_prompt or "").strip() and m.agent_id:
                    a = db.get(Agent, m.agent_id)
                    if a is not None:
                        parts = [f"職稱：{a.title}" if a.title else "", a.description or ""]
                        if getattr(a, "gh_dir", ""):
                            from .github_link import persona_line
                            parts.append(persona_line(a.gh_dir, getattr(a, "gh_account", "")))
                        m.system_prompt = "\n".join(x for x in parts if x)
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

    def _implicit_doc(self, room_id: str, thread_root_id: str = "", window: int = 6) -> str:
        """人類沒指定文件、也沒引用時：最近幾則裡剛流過一份文件，就當作在談它（「@B 幫我潤稿」不用再點卡片）。"""
        with Session(self.engine) as db:
            q = select(RoomMessage).where(RoomMessage.room_id == room_id, RoomMessage.thread_root_id == (thread_root_id or ""))
            for m in db.exec(q.order_by(RoomMessage.seq.desc()).limit(window)).all():
                if m.doc_id:
                    return m.doc_id
        return ""

    # -- entry point ----------------------------------------------------------
    async def post(self, room_id: str, sender: Optional[RoomMember], content: str, *, depth: int = 0,
                   run_id: Optional[str] = None, reply_to_id: str = "", thread_root_id: str = "", doc_id: str = "",
                   attachments: Optional[list[dict[str, Any]]] = None) -> RoomMessage:
        """存訊息、廣播、決定要回覆的 AI 並在背景執行。"""
        if sender is not None and sender.kind == "human" and not doc_id:
            quoted = self._get_message(reply_to_id)
            doc_id = (quoted.doc_id if quoted else "") or self._implicit_doc(room_id, thread_root_id)
        msg = self.save_message(room_id, sender, content, depth=depth, run_id=run_id, reply_to_id=reply_to_id,
                                thread_root_id=thread_root_id, doc_id=doc_id, attachments=attachments)
        await self.broadcast(room_id, {"type": "message.new", "message": self.public(msg)})
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
        if targets and sender is not None and sender.kind == "ai":
            # Bot 點名別的 Bot＝交棒：在這則訊息上標出交給誰（前端畫「傳訊息給 ⚫⚫ 2 位」）
            handoff = {"type": "handoff", "to": [{"id": t.id, "name": t.display_name, "agent_id": t.agent_id} for t in targets]}
            upd = self.update_attachments(msg.id, lambda a: [x for x in a if x.get("type") != "handoff"] + [handoff])
            if upd is not None:
                msg = upd
                await self.broadcast(room_id, {"type": "message.updated", "message": self.public(msg)})
        # 壓縮檢查在觸發 AI 之前做，讓這次回覆就能用到摘要
        await self.maybe_compress(room, members)
        auto = (not targets and sender is not None and sender.kind == "human" and room.no_mention_policy == "auto"
                and not parse_mentions(content, members) and any(m.kind == "ai" for m in members))
        if auto:
            self._spawn(self._route_then_reply(room, members, msg, depth + 1))
        for target in targets:
            self._spawn(self.reply(room_id, target.id, msg, depth + 1))
        return msg

    async def _route_then_reply(self, room: Room, members: list[RoomMember], msg: RoomMessage, depth: int) -> None:
        await self.broadcast(room.id, {"type": "route.started", "trigger_id": msg.id})
        targets = await self.auto_route(room, members, msg.content)
        await self.broadcast(room.id, {"type": "route.done", "trigger_id": msg.id,
                                       "targets": [{"id": t.id, "name": t.display_name} for t in targets]})
        for t in targets:
            self._spawn(self.reply(room.id, t.id, msg, depth))

    async def auto_route(self, room: Room, members: list[RoomMember], text: str) -> list[RoomMember]:
        """不 @ 的訊息交給分派員判斷誰接；失敗或逾時就用關鍵字退路。"""
        ais = [m for m in members if m.kind == "ai"]
        if len(ais) <= 1:
            return ais
        router = next((m for m in ais if m.id == room.host_member_id), None) or ais[0]
        try:
            async def _ask() -> str:
                run_id, rp = await self.start_run_for(router.profile or None, route_input(members, text),
                                                      instructions=ROUTE_PROMPT, model=model_or_none(router.model))
                parts: list[str] = []
                async for ev in self.gateway.run_events(rp, run_id):
                    name = ev.get("event") or ev.get("type") or ""
                    if name == "message.delta":
                        parts.append(str(ev.get("delta") or ""))
                    elif name == "run.completed":
                        o = ev.get("output")
                        return o if isinstance(o, str) and o else "".join(parts)
                    elif name in ("run.failed", "run.cancelled"):
                        return ""
                return "".join(parts)
            out = await asyncio.wait_for(_ask(), timeout=45.0)
            picked = parse_route(out, members)
            if picked:
                return picked
        except Exception as e:  # gateway 掛了、逾時：退關鍵字
            log.info("groupchat auto route fallback: %s", e)
        return heuristic_route(members, text)

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

    async def start_run_for(self, profile: Optional[str], input_text: str, **kw) -> tuple[str, Optional[str]]:
        """開一個 run；回 (run_id, 實際用的 profile)。
        剛建的 Bot：Hermes gateway 的 multiplex 允許名單只在啟動時讀，新 profile 要等 gateway 重啟才服務（404
        Unknown or unconfigured profile）。新 Bot 是從 default clone 的，先借 default 的通道跑（角色設定在 instructions、
        對話串用自己的 session_id），gateway 重啟後就自動改回自己的 profile。"""
        try:
            return await self.gateway.start_run(profile, input_text, **kw), profile
        except GatewayError as e:
            if profile and e.status == 404 and "unconfigured profile" in (e.message or "").lower():
                log.info("profile %s 尚未被 gateway 服務，這一輪改用 default", profile)
                return await self.gateway.start_run(None, input_text, **kw), None
            raise

    # -- 停止 / 核准 ------------------------------------------------------------
    async def stop_room(self, room_id: str) -> int:
        """停掉這個房間正在跑的所有 Bot（已經做完的動作不會復原）。"""
        runs = dict(self.active.get(room_id, {}))
        for run_id, (profile, _rm) in runs.items():
            self.stopped_runs.add(run_id)
            try:
                await self.gateway.stop(profile or None, run_id)
            except Exception as e:
                log.info("groupchat stop %s: %s", run_id, e)
        await self.broadcast(room_id, {"type": "room.stopped", "runs": list(runs)})
        return len(runs)

    async def respond_approval(self, room_id: str, message_id: str, choice: str, decided_by: str) -> RoomMessage:
        """核准卡按鈕：once（允許一次）／always（一律允許）／deny（拒絕）。"""
        m = self._get_message(message_id)
        if m is None or m.room_id != room_id:
            raise GatewayError(404, "找不到這張核准卡")
        card = next((a for a in m.attachments() if a.get("type") == "approval"), None)
        if card is None:
            raise GatewayError(400, "這則訊息不是核准卡")
        if card.get("status") != "pending":
            return m
        await self.gateway.approve(card.get("profile") or None, str(card.get("run_id") or ""), choice)

        def _decide(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
            for a in items:
                if a.get("type") == "approval":
                    a["status"] = choice
                    a["decided_by"] = decided_by
                    a["decided_at"] = now().isoformat()
            return items
        upd = self.update_attachments(message_id, _decide) or m
        await self.broadcast(room_id, {"type": "message.updated", "message": upd.to_dict()})
        return upd

    # -- 文件：圍欄 → 文件卡 ----------------------------------------------------
    def _workspace(self):
        from pathlib import Path
        from ..docs import service as dsvc
        _eng, ws = dsvc.bound()
        if ws is not None:
            return ws
        eng = getattr(getattr(self.app, "state", None), "workflow_engine", None)
        if eng is not None:
            return Path(eng.workspace)
        return Path(self.app.state.settings.db_path).parent / "workspace"

    def apply_docs(self, room: Room, target: RoomMember, trigger: RoomMessage, output: str,
                   run_id: str = "") -> tuple[str, list[dict[str, Any]], str]:
        """解析回覆裡的 ```doc／```doc-patch：有焦點文件就存成它的新版本，否則建新文件。
        回（抽掉圍欄的本文, 文件卡清單, 這則訊息的焦點文件 id）。"""
        from ..docs import service as dsvc
        from ..docs.chat_link import summarize
        from ..docs.models import Doc
        body, docs, patches = dsvc.extract_docs(output or "")
        if not docs and not patches:
            return (output or "").strip(), [], ""
        ws = self._workspace()
        cards: list[dict[str, Any]] = []
        author = target.profile or target.display_name
        with Session(self.engine) as db:
            focus = db.get(Doc, trigger.doc_id) if trigger.doc_id else None
            if focus is not None and focus.company_id != room.company_id:
                focus = None
            try:
                if focus is not None:
                    last = dsvc.latest(db, focus.id)
                    base = last.content if last else ""
                    content = docs[-1] if docs else dsvc.apply_patch(base, patches[-1])
                    v, created = dsvc.add_version(db, ws, focus, content, author_kind="agent", author_id=author,
                                                  summary=summarize(body, "更新文件"), run_id=run_id)
                    db.flush()
                    cards.append(self._doc_card(focus, v, target, "updated" if created else "same"))
                else:
                    for content in docs[:3]:
                        title = dsvc.first_heading(content) or f"{target.display_name} 的文件"
                        gist = _doc_gist(body, content, title)
                        doc, v = dsvc.create_doc(db, ws, company_id=room.company_id, title=title, content=content,
                                                 origin="chat", meta={"room_id": room.id, "room_name": room.name},
                                                 created_by=target.agent_id or "", owner_agent_id=target.agent_id or "",
                                                 author_kind="agent", author_id=author, summary=gist,
                                                 run_id=run_id, fmt="md")
                        db.flush()
                        cards.append(self._doc_card(doc, v, target, "created"))
                db.commit()
            except dsvc.DocError as e:
                db.rollback()
                note = f"（文件沒存成功：{e.message}）"
                return (body + "\n\n" + note).strip(), [], trigger.doc_id
        return body, cards, (cards[-1]["doc_id"] if cards else trigger.doc_id)

    @staticmethod
    def _doc_card(doc, v, author: Optional[RoomMember], action: str) -> dict[str, Any]:
        return {"type": "doc", "doc_id": doc.id, "title": doc.title, "version": v.version if v else 0,
                "summary": v.summary if v else "", "action": action,
                "author": author.display_name if author else "", "author_rm_id": author.id if author else "",
                "diff_stat": {"added": v.added, "removed": v.removed} if v else {"added": 0, "removed": 0}}

    def track_docs(self, room_id: str, message_id: str, cards: list[dict[str, Any]]) -> None:
        if not cards:
            return
        with Session(self.engine) as db:
            for c in cards:
                row = db.exec(select(RoomDoc).where(RoomDoc.room_id == room_id, RoomDoc.doc_id == c["doc_id"])).first()
                if row is None:
                    row = RoomDoc(room_id=room_id, doc_id=c["doc_id"], first_message_id=message_id)
                row.last_message_id = message_id
                row.updated_at = now()
                db.add(row)
            db.commit()

    # -- AI reply ---------------------------------------------------------------
    async def reply(self, room_id: str, target_id: str, trigger: RoomMessage, depth: int) -> None:
        room, members = self._load(room_id)
        target = next((m for m in members if m.id == target_id), None)
        if room is None or target is None:
            return
        self.busy.setdefault(room_id, set()).add(target.id)
        try:
            await self._reply(room, members, target, trigger, depth)
        finally:
            self.busy.get(room_id, set()).discard(target.id)

    async def _reply(self, room: Room, members: list[RoomMember], target: RoomMember, trigger: RoomMessage, depth: int) -> None:
        room_id = room.id
        tid = trigger.id
        await self.broadcast(room_id, {"type": "ai.typing", "member_id": target.id, "name": target.display_name,
                                       "trigger_id": tid, "thread_root_id": trigger.thread_root_id})
        messages, summary = self._messages_after_summary(room_id, exclude_id=trigger.id)
        reply_to = self._get_message(trigger.reply_to_id)
        doc_ctx = ""
        if trigger.doc_id:
            doc_ctx = self._doc_context(trigger.doc_id)
        skill = ""
        sm = re.match(r"^/([\w.-]+)", trigger.content or "")
        if sm and trigger.sender_kind == "human":
            skill = sm.group(1)
        ctx = build_context(room, members, target, messages, summary, trigger, reply_to=reply_to,
                            doc_context=doc_ctx, skill=skill)
        coding_agent = self._coding_agent_for(target)
        if coding_agent is not None:
            await self._reply_coding(room_id, target, trigger, depth, ctx, coding_agent)
            return
        text_parts: list[str] = []
        tools: list[dict[str, Any]] = []
        run_id: Optional[str] = None
        run_profile: Optional[str] = target.profile or None
        stopped = False
        try:
            run_id, run_profile = await self.start_run_for(
                target.profile or None, ctx.input_text, session_id=f"studio_room_{room_id}_{target.id}",
                conversation_history=ctx.history or None, instructions=ctx.instructions, model=model_or_none(target.model),
            )
            self.active.setdefault(room_id, {})[run_id] = (run_profile or "", target.id)
            await self.broadcast(room_id, {"type": "ai.started", "member_id": target.id, "trigger_id": tid, "run_id": run_id,
                                           "thread_root_id": trigger.thread_root_id})
            final: Optional[str] = None
            failed: Optional[str] = None
            async for ev in self.gateway.run_events(run_profile, run_id):
                name = ev.get("event") or ev.get("type") or ""
                if name == "message.delta":
                    d = str(ev.get("delta") or "")
                    text_parts.append(d)
                    await self.broadcast(room_id, {"type": "ai.delta", "member_id": target.id, "trigger_id": tid, "run_id": run_id, "delta": d})
                elif name == "tool.started":
                    item = {"tool": str(ev.get("tool") or ev.get("name") or "tool"), "preview": _clip(str(ev.get("preview") or ""), 200),
                            "status": "running"}
                    tools.append(item)
                    await self.broadcast(room_id, {"type": "ai.tool", "member_id": target.id, "trigger_id": tid, "run_id": run_id, **item})
                elif name == "tool.completed":
                    tool_name = str(ev.get("tool") or ev.get("name") or "")
                    for it in reversed(tools):
                        if it["status"] == "running" and (not tool_name or it["tool"] == tool_name):
                            it["status"] = "error" if ev.get("error") else "done"
                            if ev.get("duration") is not None:
                                it["duration"] = ev.get("duration")
                            break
                    await self.broadcast(room_id, {"type": "ai.tool_done", "member_id": target.id, "trigger_id": tid, "run_id": run_id,
                                                   "tool": tool_name, "error": bool(ev.get("error"))})
                elif name == "approval.request":
                    await self._approval_card(room_id, target, run_id, ev, trigger, run_profile)
                elif name == "run.completed":
                    out = ev.get("output")
                    final = out if isinstance(out, str) and out else "".join(text_parts)
                    break
                elif name in ("run.failed", "run.cancelled"):
                    if name == "run.cancelled" or run_id in self.stopped_runs:
                        stopped = True
                    failed = str(ev.get("error") or name)
                    break
            if final is None and failed is None:
                try:
                    st = await self.gateway.run_status(run_profile, run_id)
                except Exception:
                    st = {}
                if st.get("status") == "completed":
                    final = st.get("output") or "".join(text_parts)
                else:
                    failed = st.get("error") or "stream closed"
                    stopped = stopped or run_id in self.stopped_runs or st.get("status") in ("cancelled", "stopped")
        except GatewayError as e:
            failed = e.message
        except Exception as e:  # gateway unreachable etc.
            log.exception("groupchat reply failed")
            failed = str(e)
        finally:
            if run_id:
                self.active.get(room_id, {}).pop(run_id, None)
        tool_att = [{"type": "tools", "items": tools}] if tools else []
        if failed is not None:
            if stopped or (run_id and run_id in self.stopped_runs):
                # 停止：已經寫出來的字留著（標「已停止」一次）；什麼都還沒寫就不留空泡泡
                partial = "".join(text_parts).strip()
                m = None
                if partial or tool_att:
                    m = self.save_message(room_id, target, partial, depth=depth, run_id=run_id, status="stopped",
                                          thread_root_id=trigger.thread_root_id, attachments=tool_att)
                await self.broadcast(room_id, {"type": "ai.stopped", "member_id": target.id, "trigger_id": tid, "run_id": run_id,
                                               "message": m.to_dict() if m else None})
                return
            m = self.save_message(room_id, target, f"（回覆失敗：{failed}）", depth=depth, run_id=run_id, status="failed",
                                  thread_root_id=trigger.thread_root_id, attachments=tool_att)
            await self.broadcast(room_id, {"type": "ai.failed", "member_id": target.id, "trigger_id": tid, "run_id": run_id,
                                           "error": failed, "message": m.to_dict()})
            return
        content = (final or "").strip()
        # 模型偶爾會自己加「[名字]: 」前綴，去掉
        prefix = f"[{target.display_name}]:"
        if content.startswith(prefix):
            content = content[len(prefix):].strip()
        body, cards, focus_doc = self.apply_docs(room, target, trigger, content, run_id or "")
        await self.broadcast(room_id, {"type": "ai.done", "member_id": target.id, "trigger_id": tid, "run_id": run_id})
        # 透過 post 走同一條路：存檔、廣播 message.new、再看有沒有 @ 別的 AI（深度 +1）
        msg = await self.post(room_id, target, body, depth=depth, run_id=run_id, thread_root_id=trigger.thread_root_id,
                              doc_id=focus_doc or trigger.doc_id, attachments=tool_att + cards)
        self.track_docs(room_id, msg.id, cards)
        if cards:
            await self.broadcast(room_id, {"type": "docs.changed", "doc_ids": [c["doc_id"] for c in cards]})

    def _doc_context(self, doc_id: str) -> str:
        from ..docs import service as dsvc
        from ..docs.models import Doc
        with Session(self.engine) as db:
            doc = db.get(Doc, doc_id)
            if doc is None:
                return ""
            last = dsvc.latest(db, doc.id)
            # 群組裡流動的文件一律照 Markdown 規則（HTML 文件也給全文，但不強迫輸出整頁 HTML）
            return dsvc.doc_context(doc.title, doc.path, last.version if last else None, last.content if last else "", doc.fmt())

    async def _approval_card(self, room_id: str, target: RoomMember, run_id: str, ev: dict[str, Any], trigger: RoomMessage,
                             run_profile: Optional[str] = None) -> None:
        card = {"type": "approval", "run_id": run_id, "profile": run_profile or "",
                "approval_id": str(ev.get("approval_id") or ev.get("id") or run_id),
                "command": str(ev.get("command") or ""), "description": str(ev.get("description") or ev.get("reason") or ""),
                "tool": str(ev.get("tool") or ""), "choices": ev.get("choices") or ["once", "always", "deny"], "status": "pending"}
        m = self.save_message(room_id, target, "", depth=trigger.depth, run_id=run_id, thread_root_id=trigger.thread_root_id,
                              attachments=[card])
        await self.broadcast(room_id, {"type": "message.new", "message": m.to_dict()})

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
        tid = trigger.id
        history = "\n".join(f"{h['role']}: {h['content']}" for h in ctx.history[-8:])
        prompt = f"{ctx.instructions}\n\n[近期對話]\n{history}\n\n[現在這則]\n{ctx.input_text}"
        run_id = new_id("crun")
        failed: Optional[str] = None
        output = ""
        try:
            with Session(self.engine) as db:
                spec = staff.build_spec(self.app, agent, prompt, workspace=agent.workspace, db=db)
            await self.broadcast(room_id, {"type": "ai.started", "member_id": target.id, "trigger_id": tid, "run_id": run_id})

            async def on_event(ev: dict[str, Any]) -> None:
                if ev.get("type") == "message.delta":
                    await self.broadcast(room_id, {"type": "ai.delta", "member_id": target.id, "trigger_id": tid, "run_id": run_id,
                                                   "delta": str(ev.get("delta") or "")})
                elif ev.get("type") == "tool.started":
                    await self.broadcast(room_id, {"type": "ai.tool", "member_id": target.id, "trigger_id": tid, "run_id": run_id,
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
            await self.broadcast(room_id, {"type": "ai.failed", "member_id": target.id, "trigger_id": tid, "run_id": run_id,
                                           "error": failed, "message": m.to_dict()})
            return
        await self.broadcast(room_id, {"type": "ai.done", "member_id": target.id, "trigger_id": tid, "run_id": run_id})
        await self.post(room_id, target, output.strip() or "（沒有輸出）", depth=depth, run_id=run_id,
                        thread_root_id=trigger.thread_root_id)

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
                run_id, sp = await self.start_run_for(summarizer.profile or None, prompt,
                                                      instructions="你是會議記錄員，只輸出摘要。", model=model_or_none(summarizer.model))
                out_parts: list[str] = []
                final = ""
                async for ev in self.gateway.run_events(sp, run_id):
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
