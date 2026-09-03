from __future__ import annotations

import json
from typing import Optional

import re

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, or_, select

from ..auth import Principal, current_principal, get_db
from ..errors import bad_request, not_found
from ..models import Agent, ChatSession, Message, SessionCategory, new_id, now
from ..modules.coding_agents import staff

router = APIRouter(tags=["sessions"])


PREVIEW_CHARS = 80
TITLE_CHARS = 30
RESULT_CHARS = 60
# 預設標題「與 {agent} 的對話」；只有這種標題才允許被自動改名，人改過的一律不動
DEFAULT_TITLE_RE = re.compile(r"^與 .+ 的對話$")
_MD_LEAD_RE = re.compile(r"^[\s#*\-+>`~|]+")
_MD_INLINE_RE = re.compile(r"[`*_~]+")


def _snippet(text: Optional[str], limit: int = PREVIEW_CHARS) -> str:
    """把訊息壓成單行摘要。換行與連續空白收成一個空格，超長截斷加省略號。"""
    t = " ".join((text or "").split())
    return t if len(t) <= limit else t[: limit - 1] + "\u2026"


def _first_line(text: Optional[str]) -> str:
    """第一個非空白行（去掉行首 markdown 記號）。CJK 沒有詞界，全部以字元計。"""
    for raw in (text or "").splitlines():
        line = _MD_LEAD_RE.sub("", raw).strip()
        if line:
            return line
    return ""


def auto_title(text: str) -> str:
    """把第一則使用者訊息變成側欄標題：第一行、去 markdown／斜線指令、收空白、30 字截斷。

    純函式，方便單測；回空字串代表「沒東西可當標題」，呼叫端應保留原標題。
    """
    line = _first_line(text)
    if line.startswith("/"):
        # 「/model gpt-5 幫我看」→「gpt-5 幫我看」；整行只有指令就留指令名
        m = re.match(r"^/\S*\s*(.*)$", line)
        rest = (m.group(1) if m else "").strip()
        line = rest or line.lstrip("/")
    line = " ".join(_MD_INLINE_RE.sub("", line).split())
    return _snippet(line, TITLE_CHARS)


def is_default_title(title: Optional[str], agent_name: str = "") -> bool:
    t = (title or "").strip()
    return not t or t == f"與 {agent_name} 的對話" or bool(DEFAULT_TITLE_RE.match(t))


def apply_auto_title(s: ChatSession, agent_name: str, text: str) -> bool:
    """標題還是預設值時，用第一則使用者訊息改名（只會成功一次；工作流對話不動）。回 True 表示改了。"""
    if (s.source or "") == "workflow" or not is_default_title(s.title, agent_name):
        return False
    t = auto_title(text)
    if not t:
        return False
    s.title = t
    return True


def _result_line(text: Optional[str]) -> str:
    """回覆的第一個非空行，去掉 markdown 記號，60 字。"""
    return _snippet(_MD_INLINE_RE.sub("", _first_line(text)), RESULT_CHARS)


def result_of(s: ChatSession, last_assistant: Optional[tuple[str, Optional[str]]], doc_version: Optional[int]) -> tuple[str, str]:
    """側欄「一行結果」→ (kind, text)。kind ∈ failed | doc | ok | ""。優先序：失敗 > 文件更新 > 最後一則回覆 > 空。

    失敗時只引用「這一次 run」留下的片段（partial output），不拿上一輪成功的回覆冒充錯誤訊息。
    kind 由後端給，前端不用靠字串前綴猜圖示。
    """
    content, run_id = last_assistant or ("", None)
    if (s.run_status or "") == "failed":
        frag = _result_line(content) if (run_id and run_id == (s.last_run_id or "")) else ""
        return "failed", (f"失敗：{frag}" if frag else "失敗")
    if (getattr(s, "doc_id", "") or "") and doc_version:
        return "doc", f"文件已更新到 v{doc_version}"
    text = _result_line(content) if content else ""
    return ("ok" if text else ""), text


def result_for(s: ChatSession, last_assistant: Optional[tuple[str, Optional[str]]], doc_version: Optional[int]) -> str:
    return result_of(s, last_assistant, doc_version)[1]


def summaries_for(db: Session, session_ids: list[str]) -> dict[str, dict]:
    """每個對話一次取齊：最早的 user 訊息（preview）、最新的 assistant 訊息（result）、這個對話寫出的最高文件版本。

    用最早的 user 訊息而不是最新：標題重複時要回答的是「這個對話在講什麼」，開場白最能識別，
    而且不會隨著對話變長而跳動。三個聚合查詢各打一次 DB，不管幾百列都不會 N+1，也不把整批訊息撈進記憶體。
    """
    if not session_ids:
        return {}
    out: dict[str, dict] = {sid: {"preview": "", "last_assistant": None, "doc_version": None} for sid in session_ids}

    def _edge(role: str, agg):
        sub = (select(Message.session_id.label("sid"), agg(Message.created_at).label("t"))
               .where(Message.session_id.in_(session_ids), Message.role == role)
               .group_by(Message.session_id).subquery())
        return db.exec(
            select(Message.session_id, Message.content, Message.run_id)
            .join(sub, (Message.session_id == sub.c.sid) & (Message.created_at == sub.c.t))
            .where(Message.role == role)
            .order_by(Message.session_id, Message.id)
        ).all()

    seen: set[str] = set()
    for sid, content, _ in _edge("user", func.min):
        if sid not in seen:  # 同一毫秒兩則就取 id 最小的那則
            seen.add(sid)
            out[sid]["preview"] = _snippet(content)
    for sid, content, run_id in _edge("assistant", func.max):
        out[sid]["last_assistant"] = (content or "", run_id)
    from ..modules.docs.models import DocVersion
    for sid, ver in db.exec(
        select(DocVersion.session_id, func.max(DocVersion.version))
        .where(DocVersion.session_id.in_(session_ids)).group_by(DocVersion.session_id)
    ).all():
        out[sid]["doc_version"] = int(ver or 0) or None
    return out


def previews_for(db: Session, session_ids: list[str]) -> dict[str, str]:
    """舊介面：只要 preview。"""
    return {sid: v["preview"] for sid, v in summaries_for(db, session_ids).items()}


def session_public(s: ChatSession, preview: str = "", result: str = "", result_kind: str = "") -> dict:
    return {
        "preview": preview,
        "result": result,
        "result_kind": result_kind,
        "id": s.id, "agent_id": s.agent_id, "member_id": s.member_id, "title": s.title, "source": s.source,
        "created_at": s.created_at, "updated_at": s.updated_at, "last_message_at": s.last_message_at,
        "archived": bool(s.archived), "category_id": s.category_id, "model": s.model or "", "provider": s.provider or "",
        "running": s.run_status == "running", "run_status": s.run_status or "", "last_run_id": s.last_run_id or "",
        "usage": {"input_tokens": s.input_tokens or 0, "output_tokens": s.output_tokens or 0,
                  "total_tokens": s.total_tokens or 0, "context_tokens": s.context_tokens or 0},
        "imported_from": s.imported_from or "",
        "doc_id": getattr(s, "doc_id", "") or "",
    }


def message_public(m: Message) -> dict:
    d = {"id": m.id, "role": m.role, "content": m.content, "run_id": m.run_id, "created_at": m.created_at,
         "reply_to": m.reply_to, "attachments": _loads(m.attachments) or [], "reasoning": m.reasoning or None,
         "usage": _loads(m.usage)}
    if m.role == "tool":
        d["tool_name"] = m.tool_name
        d["tool_args"] = _loads(m.tool_args)
        d["tool_result"] = _loads(m.tool_result)
    return d


def _loads(t: Optional[str]):
    if not t:
        return None
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        return t


def get_owned_session(db: Session, p: Principal, session_id: str) -> ChatSession:
    s = db.get(ChatSession, session_id)
    if s is None or s.company_id != p.company_id:
        raise not_found("session")
    if s.member_id != p.member.id and p.role not in ("owner", "admin"):
        raise not_found("session")
    return s


def _sort_key(s: ChatSession):
    # running first, then most recent activity
    ts = s.last_message_at or s.updated_at or s.created_at
    return (0 if s.run_status == "running" else 1, -(ts.timestamp() if ts else 0))


@router.get("/sessions")
def list_sessions(agent_id: Optional[str] = None, include_archived: bool = False, category_id: Optional[str] = None,
                  p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    q = select(ChatSession).where(ChatSession.company_id == p.company_id, ChatSession.member_id == p.member.id)
    if agent_id:
        q = q.where(ChatSession.agent_id == agent_id)
    if not include_archived:
        q = q.where(ChatSession.archived == False)  # noqa: E712
    if category_id:
        q = q.where(ChatSession.category_id == category_id)
    rows = db.exec(q).all()
    rows.sort(key=_sort_key)
    summ = summaries_for(db, [s.id for s in rows])
    out = []
    for s in rows:
        v = summ.get(s.id) or {"preview": "", "last_assistant": None, "doc_version": None}
        kind, text = result_of(s, v["last_assistant"], v["doc_version"])
        out.append(session_public(s, v["preview"], text, kind))
    return out


class SessionCreate(BaseModel):
    agent_id: str
    title: Optional[str] = None
    source: str = "workbench"
    model: Optional[str] = None
    category_id: Optional[str] = None
    doc_id: Optional[str] = None  # 綁一份文件（文件模式）


@router.post("/sessions", status_code=201)
def create_session(body: SessionCreate, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    a = db.get(Agent, body.agent_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("agent")
    runtime = staff.runtime_of(a)
    coding = staff.is_coding(runtime)
    # coding 員工的對話照樣落在 sessions（source=coding:<cli>），續談靠 coding_session_meta 記外部 session id
    source = f"coding:{staff.cli_id(runtime)}" if coding and (body.source or "workbench") == "workbench" else (body.source or "workbench")
    s = ChatSession(company_id=p.company_id, member_id=p.member.id, agent_id=a.id,
                    title=body.title or f"與 {a.name} 的對話", source=source,
                    hermes_session_id="" if coding else new_id("studio"), model=body.model or "",
                    category_id=body.category_id, doc_id=(body.doc_id or ""))
    db.add(s)
    db.flush()
    if coding:
        staff.get_or_create_meta(db, s.id, a)
    db.commit()
    db.refresh(s)
    return session_public(s)


@router.get("/sessions/search")
def search_sessions(q: str = "", limit: int = 30, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """Ctrl+K 全文搜尋：標題 + 訊息內容（LIKE，大小寫不敏感）。"""
    term = (q or "").strip()
    if not term:
        return []
    like = f"%{term}%"
    base = select(ChatSession).where(ChatSession.company_id == p.company_id, ChatSession.member_id == p.member.id)
    hits: dict[str, dict] = {}
    for s in db.exec(base.where(ChatSession.title.ilike(like))).all():
        hits[s.id] = {"session": session_public(s), "match": "title", "snippet": s.title}
    msg_q = (select(Message, ChatSession).join(ChatSession, ChatSession.id == Message.session_id)
             .where(ChatSession.company_id == p.company_id, ChatSession.member_id == p.member.id,
                    Message.role.in_(["user", "assistant"]), Message.content.ilike(like))
             .order_by(Message.created_at.desc()).limit(limit * 3))
    for m, s in db.exec(msg_q).all():
        if s.id in hits:
            continue
        idx = m.content.lower().find(term.lower())
        start = max(0, idx - 40)
        snippet = m.content[start:start + 120].replace("\n", " ")
        hits[s.id] = {"session": session_public(s), "match": "message", "snippet": snippet, "message_id": m.id}
        if len(hits) >= limit:
            break
    out = list(hits.values())
    out.sort(key=lambda h: str(h["session"]["last_message_at"] or h["session"]["updated_at"] or ""), reverse=True)
    return out[:limit]


@router.get("/sessions/{session_id}")
def get_session(session_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return session_public(get_owned_session(db, p, session_id))


class SessionPatch(BaseModel):
    title: Optional[str] = None
    archived: Optional[bool] = None
    category_id: Optional[str] = None  # "" 清除分類
    model: Optional[str] = None
    provider: Optional[str] = None
    doc_id: Optional[str] = None  # "" 解除文件綁定


@router.patch("/sessions/{session_id}")
def patch_session(session_id: str, body: SessionPatch, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s = get_owned_session(db, p, session_id)
    if body.title is not None:
        t = body.title.strip()
        if not t:
            raise bad_request("title 不可為空")
        s.title = t[:200]
    if body.archived is not None:
        s.archived = bool(body.archived)
    if body.category_id is not None:
        if body.category_id == "":
            s.category_id = None
        else:
            c = db.get(SessionCategory, body.category_id)
            if c is None or c.company_id != p.company_id:
                raise not_found("category")
            s.category_id = c.id
    if body.model is not None:
        s.model = body.model.strip()
    if body.provider is not None:
        s.provider = body.provider.strip()
    if body.doc_id is not None:
        did = body.doc_id.strip()
        if did:
            from ..modules.docs.models import Doc
            d = db.get(Doc, did)
            if d is None or d.company_id != p.company_id:
                raise not_found("doc")
        s.doc_id = did
    s.updated_at = now()
    db.add(s)
    db.commit()
    db.refresh(s)
    return session_public(s)


class SessionModel(BaseModel):
    model: str = ""
    provider: str = ""


@router.post("/sessions/{session_id}/model")
def set_session_model(session_id: str, body: SessionModel, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """每 session 模型設定；空字串＝回到 agent / profile 預設。"""
    s = get_owned_session(db, p, session_id)
    s.model = body.model.strip()
    s.provider = body.provider.strip()
    s.updated_at = now()
    db.add(s)
    db.commit()
    db.refresh(s)
    return session_public(s)


@router.get("/sessions/{session_id}/messages")
def list_messages(session_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s = get_owned_session(db, p, session_id)
    rows = db.exec(select(Message).where(Message.session_id == s.id).order_by(Message.created_at, Message.id)).all()
    return [message_public(m) for m in rows]


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    s = get_owned_session(db, p, session_id)
    for m in db.exec(select(Message).where(Message.session_id == s.id)).all():
        db.delete(m)
    db.delete(s)
    db.commit()
    return {"ok": True}


def session_or_none(db: Session, p: Principal, session_id: str) -> Optional[ChatSession]:
    try:
        return get_owned_session(db, p, session_id)
    except Exception:
        return None


__all__ = ["router", "session_public", "previews_for", "summaries_for", "result_for", "result_of", "auto_title", "apply_auto_title", "message_public", "get_owned_session", "session_or_none", "or_"]
