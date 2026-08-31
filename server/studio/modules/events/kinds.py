"""事件 kind 白名單與 seq 配號（deepseek-harness 研究第 5 項）。

- `KNOWN_KINDS`：明確列出的 kind；`KNOWN_PREFIXES`：允許的前綴族（入口型事件各自定義 kind 時用）。
- `normalize_kind(kind)`：不在白名單 → 改成 `other.<原 kind>` 並記 warning（不靜默寫入、也不丟例外）。
- `next_seq(db)`：全域單調遞增序號（每 company 自然也是單調的）；同一個 SQLite 寫入者不會撞號。
"""
from __future__ import annotations

import logging

from sqlalchemy import text
from sqlmodel import Session

log = logging.getLogger("studio.events.kinds")

KNOWN_KINDS: frozenset[str] = frozenset({
    # 對話
    "chat.run", "chat.message",
    # 工作流（因果鏈：run.started ← node.completed ← run）
    "workflow.run.started", "workflow.node.completed", "workflow.run",
    # 工作流 harness（重啟修復／自檢）
    "workflow.needs_attention", "workflow.recovered", "node.done_check",
    # 審批（approval.requested ← approval.decided；chat 危險指令用 approval.request）
    "approval.requested", "approval.request", "approval.decided",
    # 群聊／看板
    "groupchat.message", "kanban.status",
    # 文件（docs 模組；一份 .md 從 A 站傳到 B 站的因果鏈）
    "doc.created", "doc.updated", "doc.selected", "doc.split", "doc.merged",
    # Studio 內部
    "soul.write", "soul.rollback", "limit.exceeded", "limit.reset",
    "search.token.created", "search.token.revoked", "search.skill.installed",
    # 相容性（契約測試／升級預檢）
    "compat.check", "compat.precheck",
})
# 前綴族：入口型事件（line./webhook./form./cron./api.）、行業套件（pack.*，套件自訂事件也走這族）、其他
KNOWN_PREFIXES: tuple[str, ...] = ("line.", "webhook.", "form.", "cron.", "api.", "pack.", "custom.", "other.")


def is_known(kind: str) -> bool:
    return kind in KNOWN_KINDS or kind.startswith(KNOWN_PREFIXES)


def normalize_kind(kind: str) -> str:
    k = (kind or "").strip()
    if not k:
        return "other.unknown"
    if is_known(k):
        return k
    log.warning("events: unknown kind %r → other.%s（加進 events/kinds.py 的 KNOWN_KINDS 才會原樣存）", k, k)
    return f"other.{k}"


def next_seq(db: Session) -> int:
    row = db.exec(text("SELECT COALESCE(MAX(seq), 0) FROM events")).one()
    return int(row[0] or 0) + 1


def backfill_seq(engine) -> int:
    """既有資料補 seq：seq=0 的列依 ts、id 排序配號，接在目前最大 seq 之後。回傳補了幾筆。"""
    with engine.begin() as conn:
        base = int(conn.execute(text("SELECT COALESCE(MAX(seq), 0) FROM events")).scalar() or 0)
        rows = conn.execute(text("SELECT id FROM events WHERE seq IS NULL OR seq = 0 ORDER BY ts, id")).fetchall()
        for i, (eid,) in enumerate(rows, start=1):
            conn.execute(text("UPDATE events SET seq = :s WHERE id = :i"), {"s": base + i, "i": eid})
        conn.execute(text("UPDATE events SET causes_json = '[]' WHERE causes_json IS NULL"))
    if rows:
        log.info("events: backfilled seq for %d rows", len(rows))
    return len(rows)
