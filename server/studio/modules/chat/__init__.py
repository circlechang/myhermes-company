"""聊天／工作臺模組（A. 聊天）。

提供：
- /chat/categories               對話分類 CRUD（每成員自有）
- /chat/uploads                  上傳檔案（multipart）→ ~/.myhermescompany/uploads/<company>/<session>/
- /chat/files?path=              下載／原始預覽（白名單：uploads、Hermes workspace、訊息中出現過的路徑）
- /chat/preview?path=            結構化預覽（docx/pptx/xlsx→HTML、csv→rows、md/code→text）
- /chat/models?profile=          模型清單（gateway /p/<profile>/api/model/options）
- /chat/hermes-history           Hermes state.db（default + 各 profile）唯讀 session 清單／訊息／匯入
啟動時把 chat 模組新增的欄位補進既有 SQLite 表（ALTER TABLE ADD COLUMN，只加不改）。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter
from sqlalchemy import text

from . import categories, files, hermes_history, models_api

log = logging.getLogger("studio.modules.chat")

router = APIRouter(prefix="/chat", tags=["chat"])
router.include_router(categories.router)
router.include_router(files.router)
router.include_router(models_api.router)
router.include_router(hermes_history.router)

# (table, column, DDL type/default) — additive only
_COLUMNS = [
    ("sessions", "archived", "BOOLEAN NOT NULL DEFAULT 0"),
    ("sessions", "category_id", "VARCHAR"),
    ("sessions", "model", "VARCHAR NOT NULL DEFAULT ''"),
    ("sessions", "provider", "VARCHAR NOT NULL DEFAULT ''"),
    ("sessions", "run_status", "VARCHAR NOT NULL DEFAULT ''"),
    ("sessions", "input_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ("sessions", "output_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ("sessions", "total_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ("sessions", "context_tokens", "INTEGER NOT NULL DEFAULT 0"),
    ("sessions", "imported_from", "VARCHAR NOT NULL DEFAULT ''"),
    ("messages", "reply_to", "VARCHAR"),
    ("messages", "attachments", "VARCHAR"),
    ("messages", "reasoning", "VARCHAR"),
    ("messages", "usage", "VARCHAR"),
]


def ensure_columns(engine) -> int:
    added = 0
    with engine.begin() as conn:
        for table, col, ddl in _COLUMNS:
            cols = {r[1] for r in conn.execute(text(f"PRAGMA table_info({table})")).fetchall()}
            if cols and col not in cols:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"))
                added += 1
        # reset stale "running" flags left by a crashed server
        conn.execute(text("UPDATE sessions SET run_status='' WHERE run_status='running'"))
    return added


async def on_startup(app) -> None:
    n = ensure_columns(app.state.engine)
    if n:
        log.info("chat module: added %d column(s) to existing tables", n)
    files.ensure_upload_root(app.state.settings)
