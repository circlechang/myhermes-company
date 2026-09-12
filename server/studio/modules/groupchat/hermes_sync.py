"""把 Bot 在 Hermes 那邊的對話（Telegram、終端機、桌面版…）同步進它的私訊房，變成同一條時間軸。

方向：
- **Bots 介面 → Hermes**：本來就有。我們送出的每一輪都是 gateway 的一個 run，Hermes 自己會記在
  `studio_room_<room>_<member>` 這個 session 裡。
- **Hermes → Bots 介面**：這支做的事。唯讀開啟 `$HERMES_HOME/state.db`（default）或
  `profiles/<p>/state.db`，把不是我們產生的 session（排除 `studio_room_%`）的使用者／助理訊息，
  依時間插進那個 Bot 的私訊房，標上來源。

原則：
- **唯讀**開 Hermes 的資料庫（`mode=ro`），絕不寫入。
- 排除自動排程（cron／storm）那種機器跑的 session，不然一個 default profile 就有四千多筆會灌爆對話。
- `ext_id` 去重，watermark 記在 `room_sync`，同一則不會進來兩次。
- 同步進來的訊息**不會觸發 Bot 回覆**（那是歷史，不是新交辦）。
- 第一次回補只抓最近 N 天，而且直接標成已讀，不要一開啟就跳幾百則未讀。
"""
from __future__ import annotations

import logging
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlmodel import Session, select

from .models import Room, RoomMember, RoomMessage, RoomSync

log = logging.getLogger("studio.groupchat.hermes_sync")

# 機器自己跑的不進對話（會有幾千筆）；要看那些去舊工作臺的「Hermes 歷史」
EXCLUDED_SOURCES = ("cron", "storm", "storm-search")
BACKFILL_DAYS = 14
MAX_PER_SYNC = 200
FIRST_SCAN_ROWS = 4000  # 第一次同步往回看幾筆（再用時間過濾）
# 我們自己的內部 run（分派員、摘要員）在舊版沒有帶 session id，Hermes 記成一般 api_server 對話。
# 這些不是使用者的對話，不能出現在時間軸上：用內容特徵整段 session 排除。
# 整段 session 都是機器內部的（分派員、摘要員、群聊代打）
INTERNAL_SESSION_MARKERS = (
    "你是群組的分派員",
    "請把下面這段群聊對話濃縮成摘要",
    "你是群聊「",
)
# 只有這一則是機器塞的（工作臺文件模式會把整份文件放進使用者訊息），同段其他對話要留
INTERNAL_MESSAGE_PREFIXES = ("[目前文件]", "[文件更新規則]", "[上游結果]", "[外部輸入]")
SOURCE_LABEL = {
    "telegram": "Telegram", "whatsapp": "WhatsApp", "line": "LINE", "discord": "Discord", "slack": "Slack",
    "signal": "Signal", "cli": "終端機", "desktop": "桌面版", "acp": "編輯器", "api_server": "工作臺",
    "email": "Email", "webhook": "Webhook",
}


def state_db(home: Path, profile: str) -> Path:
    return home / "state.db" if profile in ("", "default") else home / "profiles" / profile / "state.db"


def _open_ro(path: Path) -> Optional[sqlite3.Connection]:
    if not path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as e:
        log.info("開不了 %s：%s", path, e)
        return None


def read_new(home: Path, profile: str, since_id: int, since_ts: float, limit: int = MAX_PER_SYNC) -> list[dict[str, Any]]:
    """Hermes 那邊、不是我們產生的、比 since_id 新的使用者／助理訊息。

    **一定要用 messages.id 當進度標記**：`timestamp` 沒有索引，在真實資料（4GB）上
    `WHERE timestamp > ?` 要掃 11 秒；`id` 是主鍵，同樣的查詢 0.16 秒。
    第一次同步沒有標記，就從「最後 N 筆」往回抓再用時間過濾。
    """
    conn = _open_ro(state_db(home, profile))
    if conn is None:
        return []
    marks = ",".join("?" for _ in EXCLUDED_SOURCES)
    if since_id <= 0:  # 第一次：從最後 FIRST_SCAN_ROWS 筆開始看，不要整表掃
        row = conn.execute("SELECT MAX(id) FROM messages").fetchone()
        since_id = max(0, int(row[0] or 0) - FIRST_SCAN_ROWS)
    sql = (
        "SELECT m.id AS mid, m.session_id, m.role, m.content, m.timestamp, s.source, s.title "
        "FROM messages m JOIN sessions s ON s.id = m.session_id "
        "WHERE m.id > ? AND m.role IN ('user','assistant') "
        # 機器自己跑的 session 不進時間軸：私訊房自己的、分派員／摘要員、工作流節點、臨時 API 呼叫。
        # 工作臺的對話（studio_<亂碼>）要留，那是使用者跟同一個 Bot 講的話。
        "AND s.id NOT LIKE 'studio\\_room\\_%' ESCAPE '\\' "
        "AND s.id NOT LIKE 'studio\\_sys\\_%' ESCAPE '\\' "
        "AND s.id NOT LIKE 'wf-%' "
        "AND s.id NOT LIKE 'run\\_%' ESCAPE '\\' "
        f"AND (s.source IS NULL OR s.source NOT IN ({marks})) "
        "AND m.content IS NOT NULL AND TRIM(m.content) <> '' "
        "ORDER BY m.id LIMIT ?"
    )
    try:
        rows = conn.execute(sql, (since_id, *EXCLUDED_SOURCES, limit)).fetchall()
    except sqlite3.Error as e:
        log.info("讀 %s 失敗：%s", profile or "default", e)
        return []
    finally:
        conn.close()
    internal: set[str] = set()
    for r in rows:  # 先找出「整段都是內部指令」的 session，連回覆一起跳過
        if any(mark in (r["content"] or "") for mark in INTERNAL_SESSION_MARKERS):
            internal.add(r["session_id"])
    out = []
    for r in rows:
        if r["session_id"] in internal:
            continue
        if (r["content"] or "").lstrip().startswith(INTERNAL_MESSAGE_PREFIXES):
            continue
        try:
            ts = float(r["timestamp"])
        except (TypeError, ValueError):
            continue
        if ts < since_ts:  # 第一次回補只要最近這段時間
            continue
        out.append({"mid": int(r["mid"]), "ext_id": f"{r['session_id']}:{r['mid']}", "session_id": r["session_id"], "role": r["role"],
                    "content": (r["content"] or "").strip(), "ts": ts, "source": (r["source"] or "hermes")})
    return out


def label_of(source: str) -> str:
    return SOURCE_LABEL.get(source, source or "Hermes")


def _remember(engine, room_id: str, profile: str, last_id: int, last_ts: float, mtime: float) -> None:
    """沒有新訊息時也要記住看到哪裡，下一次才不用重掃。"""
    with Session(engine) as db:
        state = db.exec(select(RoomSync).where(RoomSync.room_id == room_id)).first()
        if state is None:
            state = RoomSync(room_id=room_id, profile=profile)
        state.last_id = max(last_id, state.last_id)
        state.last_ts = max(last_ts, state.last_ts)
        state.last_mtime = mtime
        state.profile = profile
        state.updated_at = datetime.utcnow()
        db.add(state)
        db.commit()


def sync_room(orch, home: Path, room: Room, profile: str) -> list[dict[str, Any]]:
    """把這個 Bot 在 Hermes 的新對話插進私訊房。回新加入的訊息（給呼叫端廣播）。"""
    engine = orch.engine
    db_path = state_db(home, profile)
    try:
        mtime = db_path.stat().st_mtime
    except OSError:
        return []
    with Session(engine) as db:
        state = db.exec(select(RoomSync).where(RoomSync.room_id == room.id)).first()
        first_time = state is None
        since_id = state.last_id if state else 0
        since_ts = state.last_ts if state else time.time() - BACKFILL_DAYS * 86400
        if state is not None and state.last_mtime and abs(state.last_mtime - mtime) < 0.001:
            return []  # Hermes 那邊沒有新東西
        members = db.exec(select(RoomMember).where(RoomMember.room_id == room.id)).all()
        human = next((m for m in members if m.kind == "human"), None)
        ai = next((m for m in members if m.kind == "ai"), None)
        owner_member_id = room.created_by
        if human is not None:
            db.expunge(human)
        if ai is not None:
            db.expunge(ai)
    if human is None or ai is None:
        return []
    rows = read_new(home, profile, since_id, since_ts)
    if not rows:
        _remember(engine, room.id, profile, since_id, since_ts, mtime)
        return []
    added: list[dict[str, Any]] = []
    seen: set[str] = set()
    with Session(engine) as db:  # 已經進來過的不再插一次
        have = set(db.exec(select(RoomMessage.ext_id).where(RoomMessage.room_id == room.id, RoomMessage.ext_id != "")).all())
    for r in rows:
        if r["ext_id"] in have or r["ext_id"] in seen:
            continue
        seen.add(r["ext_id"])
        sender = human if r["role"] == "user" else ai
        msg = orch.save_message(room.id, sender, r["content"], source=r["source"], ext_id=r["ext_id"],
                                created_at=datetime.fromtimestamp(r["ts"], tz=timezone.utc).replace(tzinfo=None))
        added.append(orch.public(msg))
    last_ts = max(r["ts"] for r in rows)
    last_id = max(r["mid"] for r in rows)
    with Session(engine) as db:
        state = db.exec(select(RoomSync).where(RoomSync.room_id == room.id)).first()
        if state is None:
            state = RoomSync(room_id=room.id, profile=profile)
        state.last_ts = max(last_ts, state.last_ts)
        state.last_id = max(last_id, state.last_id)
        state.last_mtime = mtime
        state.profile = profile
        state.updated_at = datetime.utcnow()
        db.add(state)
        # 第一次回補的是歷史，不要一開啟就幾百則未讀
        if first_time and added:
            from .models import RoomPref
            pref = db.exec(select(RoomPref).where(RoomPref.room_id == room.id, RoomPref.member_id == owner_member_id)).first()
            if pref is None:
                pref = RoomPref(room_id=room.id, member_id=owner_member_id)
            pref.last_read_seq = max(pref.last_read_seq, max(int(a["seq"]) for a in added))
            db.add(pref)
        db.commit()
    if added:
        log.info("房間 %s 從 Hermes 補進 %d 則（%s）", room.id, len(added), profile or "default")
    return added
