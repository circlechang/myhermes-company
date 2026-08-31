"""對話 ↔ 文件：把「一個對話串＝經營一份文件」接起來。

流程
1. session 綁了 doc（`sessions.doc_id`）→ 每一輪把「目前文件全文」附進 instructions，
   並要求模型在回覆最後用 ```doc 圍欄輸出**完整的新版文件**（很長時可用 ```doc-patch 的 unified diff）。
2. run 結束 → `apply_output()` 解析圍欄、套用、建立新版本，並把圍欄從訊息本文抽掉
   （對話裡只留「這一版改了什麼」的摘要）。
3. 呼叫端（chat_ws）把 `doc.updated` 推給前端；patch 套不上時推 `doc.patch_failed` 並請模型重出全文。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from sqlmodel import Session

from . import service as svc
from .models import Doc

log = logging.getLogger("studio.docs.chat")

RETRY_PROMPT = ("剛才的 ```doc-patch 套用失敗（{reason}）。請直接用 ```doc 圍欄輸出**完整的新版文件**，"
                "不要再給差異；圍欄之外只寫一句這一版改了什麼。")


def context_for(engine, workspace: Path, session_id: str) -> Optional[dict[str, Any]]:
    """回這個 session 綁的文件脈絡；沒綁或文件不見了回 None。"""
    with Session(engine) as db:
        from ...models import ChatSession
        s = db.get(ChatSession, session_id)
        doc_id = (getattr(s, "doc_id", "") or "") if s else ""
        if not doc_id:
            return None
        doc = db.get(Doc, doc_id)
        if doc is None:
            return None
        last = svc.latest(db, doc.id)
        content = last.content if last else ""
        return {"doc_id": doc.id, "title": doc.title, "path": doc.path,
                "version": last.version if last else None,
                "instructions": svc.doc_context(doc.title, doc.path, last.version if last else None, content)}


def summarize(body: str, fallback: str = "更新文件") -> str:
    text = (body or "").strip()
    if not text:
        return fallback
    for line in text.splitlines():
        s = line.strip().lstrip("-*# ").strip()
        if s:
            return s[:200]
    return fallback


def apply_output(engine, workspace: Path, doc_id: str, output: str, *, session_id: str = "", run_id: str = "",
                 author_id: str = "") -> dict[str, Any]:
    """解析並套用模型輸出裡的文件圍欄。

    回 `{body, updated|None, patch_error|None}`：
    - `body`：抽掉圍欄後的訊息本文（存進 messages、回給前端）
    - `updated`：`{doc_id, version, diff_stat, summary, same}`（有建新版本才有）
    - `patch_error`：doc-patch 套不上的原因（呼叫端據此請模型重出全文）
    """
    body, docs, patches = svc.extract_docs(output or "")
    if not docs and not patches:
        return {"body": (output or "").strip(), "updated": None, "patch_error": None}
    with Session(engine) as db:
        doc = db.get(Doc, doc_id)
        if doc is None:
            return {"body": body, "updated": None, "patch_error": "文件已不存在"}
        last = svc.latest(db, doc.id)
        base = last.content if last else ""
        content: Optional[str] = None
        if docs:
            content = docs[-1]
        elif patches:
            try:
                content = svc.apply_patch(base, patches[-1])
            except svc.DocError as e:
                return {"body": body, "updated": None, "patch_error": e.message}
        if content is None:
            return {"body": body, "updated": None, "patch_error": None}
        try:
            v, created = svc.add_version(db, workspace, doc, content, author_kind="agent", author_id=author_id,
                                         summary=summarize(body), session_id=session_id, run_id=run_id)
            db.commit()
            db.refresh(v)
        except svc.DocError as e:
            db.rollback()
            return {"body": body, "updated": None, "patch_error": e.message}
        payload = {"doc_id": doc.id, "title": doc.title, "version": v.version, "summary": v.summary,
                   "diff_stat": {"added": v.added, "removed": v.removed}, "same": not created}
        company_id = doc.company_id
    if created:
        try:
            from ..events import record
            record("doc.updated", "chat", f"doc:{doc_id}",
                   {**payload, "session_id": session_id, "run_id": run_id}, company_id=company_id)
        except Exception as e:  # pragma: no cover
            log.debug("doc event skipped: %s", e)
    return {"body": body, "updated": payload, "patch_error": None}
