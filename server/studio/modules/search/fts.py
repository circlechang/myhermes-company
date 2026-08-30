"""SQLite FTS5 全站索引（deepseek-harness 研究第 4 項）。

一張 FTS5 虛擬表 `search_index` 涵蓋四個來源（scope）：
- chat      messages.content（user/assistant）
- group     room_messages.content
- workflow  workflow_run_nodes.output
- events    events.subject + payload 的文字值

中文怎麼搜：FTS5 的 unicode61 不切 CJK（整句是一個 token），trigram 又搜不到兩個字的詞（「文案」）。
所以索引欄 `text` 存的是 `tokenize()` 後的字串——每個 CJK 字前後補空白，讓每個字成為一個 token；
查詢時把中文片段轉成 phrase `"文 案"`（相鄰 token），拉丁字用 `"word"*` 前綴比對。原文放在 UNINDEXED 的 `body`，片段在 Python 端切。

同步：來源表上的 trigger 只把 (scope, ref, op) 丟進 `search_dirty`（純 SQL，不依賴 Python 自訂函式，
別的程式直接開這顆 DB 寫入也不會炸）；`drain()` 在每次搜尋前、背景每 N 秒、啟動時把待辦吃掉。索引空的時候做全量重建。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any, Iterable, Optional

from sqlalchemy import inspect, text

log = logging.getLogger("studio.search.fts")

SCOPES = ("chat", "group", "workflow", "events")

_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]")
_CJK_RUN = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]+")


def tokenize(s: str) -> str:
    """CJK 每字一 token；其他照舊。"""
    if not s:
        return ""
    out = _CJK.sub(lambda m: f" {m.group(0)} ", s)
    return re.sub(r"\s+", " ", out).strip()


def build_match(q: str) -> str:
    """使用者查詢 → FTS5 MATCH 表達式（全部加引號，防 FTS 語法注入）。空字串代表沒有可搜的字。"""
    parts: list[str] = []
    for term in (q or "").split():
        pos = 0
        for m in _CJK_RUN.finditer(term):
            if m.start() > pos:
                parts.append(_latin(term[pos:m.start()]))
            parts.append('"' + " ".join(m.group(0)) + '"')
            pos = m.end()
        if pos < len(term):
            parts.append(_latin(term[pos:]))
    return " ".join(p for p in parts if p)


def _latin(s: str) -> str:
    s = s.replace('"', "").strip()
    return f'"{s}"*' if s else ""


def terms_of(q: str) -> list[str]:
    """片段標示用：原查詢拆成的字串（中文片段與拉丁字）。"""
    out: list[str] = []
    for term in (q or "").split():
        pos = 0
        for m in _CJK_RUN.finditer(term):
            if m.start() > pos:
                out.append(term[pos:m.start()])
            out.append(m.group(0))
            pos = m.end()
        if pos < len(term):
            out.append(term[pos:])
    return [t.replace('"', "") for t in out if t.replace('"', "")]


def snippet(body: str, terms: list[str], width: int = 70) -> str:
    body = (body or "").replace("\n", " ")
    low = body.lower()
    idx = -1
    for t in terms:
        i = low.find(t.lower())
        if i >= 0 and (idx < 0 or i < idx):
            idx = i
    if idx < 0:
        return body[: width * 2] + ("…" if len(body) > width * 2 else "")
    start = max(0, idx - width)
    end = min(len(body), idx + width)
    return ("…" if start > 0 else "") + body[start:end] + ("…" if end < len(body) else "")


# ---------------------------------------------------------------- schema

_DDL = [
    """CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        scope UNINDEXED, ref UNINDEXED, company_id UNINDEXED, agent UNINDEXED, member_id UNINDEXED,
        ts UNINDEXED, title UNINDEXED, body UNINDEXED, meta UNINDEXED, text,
        tokenize='unicode61 remove_diacritics 2')""",
    "CREATE TABLE IF NOT EXISTS search_dirty(id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, ref TEXT NOT NULL, op TEXT NOT NULL DEFAULT 'upsert')",
]

# (table, scope, 觸發欄位)
_SOURCES = [
    ("messages", "chat", "content"),
    ("room_messages", "group", "content"),
    ("workflow_run_nodes", "workflow", "output"),
    ("events", "events", "payload_json"),
]


def _trigger_sql(table: str, scope: str, col: str) -> list[str]:
    return [
        f"CREATE TRIGGER IF NOT EXISTS search_{table}_ai AFTER INSERT ON {table} BEGIN "
        f"INSERT INTO search_dirty(scope, ref, op) VALUES('{scope}', new.id, 'upsert'); END",
        f"CREATE TRIGGER IF NOT EXISTS search_{table}_au AFTER UPDATE OF {col} ON {table} BEGIN "
        f"INSERT INTO search_dirty(scope, ref, op) VALUES('{scope}', new.id, 'upsert'); END",
        f"CREATE TRIGGER IF NOT EXISTS search_{table}_ad AFTER DELETE ON {table} BEGIN "
        f"INSERT INTO search_dirty(scope, ref, op) VALUES('{scope}', old.id, 'delete'); END",
    ]


def ensure_schema(engine) -> None:
    tables = set(inspect(engine).get_table_names())
    with engine.begin() as conn:
        for ddl in _DDL:
            conn.execute(text(ddl))
        for table, scope, col in _SOURCES:
            if table in tables:
                for sql in _trigger_sql(table, scope, col):
                    conn.execute(text(sql))


def index_empty(engine) -> bool:
    with engine.connect() as conn:
        return int(conn.execute(text("SELECT COUNT(*) FROM search_index")).scalar() or 0) == 0


# ---------------------------------------------------------------- 來源 → 文件

def _iso(v: Any) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v or "")


def _payload_text(payload_json: str) -> str:
    try:
        v = json.loads(payload_json or "{}")
    except ValueError:
        return payload_json or ""
    out: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, str):
            out.append(x)
        elif isinstance(x, dict):
            for k, y in x.items():
                if isinstance(y, (str, dict, list)):
                    walk(y)
                elif y is not None and not isinstance(y, bool):
                    out.append(f"{k}={y}")
        elif isinstance(x, list):
            for y in x:
                walk(y)

    walk(v)
    return " ".join(out)


_FETCH = {
    "chat": """SELECT m.id AS ref, m.content AS body, m.created_at AS ts, s.company_id, s.member_id, COALESCE(a.profile,'') AS agent,
                      s.title AS title, m.session_id AS session_id, m.role AS role
               FROM messages m JOIN sessions s ON s.id = m.session_id LEFT JOIN agents a ON a.id = s.agent_id
               WHERE m.role IN ('user','assistant') {where}""",
    "group": """SELECT rm.id AS ref, rm.content AS body, rm.created_at AS ts, r.company_id, COALESCE(mem.member_id,'') AS member_id,
                       CASE WHEN mem.kind='ai' THEN COALESCE(mem.profile,'') ELSE '' END AS agent,
                       r.name AS title, rm.room_id AS room_id, rm.sender_name AS sender, rm.sender_kind AS sender_kind
                FROM room_messages rm JOIN rooms r ON r.id = rm.room_id LEFT JOIN room_members mem ON mem.id = rm.sender_id
                WHERE 1=1 {where}""",
    "workflow": """SELECT n.id AS ref, n.output AS body, COALESCE(n.finished_at, n.started_at) AS ts, r.company_id, r.created_by AS member_id,
                          '' AS agent, r.workflow_name AS title, n.run_id AS run_id, n.node_id AS node_id, n.status AS status
                   FROM workflow_run_nodes n JOIN workflow_runs r ON r.id = n.run_id WHERE n.output <> '' {where}""",
    "events": """SELECT e.id AS ref, e.subject AS subject, e.payload_json AS payload_json, e.ts AS ts, e.company_id, e.member_id, e.agent,
                        e.kind AS title
                 FROM events e WHERE 1=1 {where}""",
}
_REF_COL = {"chat": "m.id", "group": "rm.id", "workflow": "n.id", "events": "e.id"}


def _doc(scope: str, row: dict[str, Any]) -> dict[str, Any]:
    if scope == "events":
        body = f"{row.get('subject') or ''} {_payload_text(row.get('payload_json') or '')}".strip()
        meta = {"kind": row.get("title"), "subject": row.get("subject")}
    elif scope == "chat":
        body = row.get("body") or ""
        meta = {"session_id": row.get("session_id"), "role": row.get("role")}
    elif scope == "group":
        body = row.get("body") or ""
        meta = {"room_id": row.get("room_id"), "sender": row.get("sender"), "sender_kind": row.get("sender_kind")}
    else:
        body = row.get("body") or ""
        meta = {"run_id": row.get("run_id"), "node_id": row.get("node_id"), "status": row.get("status")}
    title = str(row.get("title") or "")
    return {"scope": scope, "ref": str(row["ref"]), "company_id": row.get("company_id") or "", "agent": row.get("agent") or "",
            "member_id": row.get("member_id") or "", "ts": _iso(row.get("ts")), "title": title, "body": body,
            "meta": json.dumps(meta, ensure_ascii=False), "text": tokenize(f"{title}\n{body}")}


def _fetch(conn, scope: str, refs: Optional[Iterable[str]] = None) -> list[dict[str, Any]]:
    if scope not in _FETCH:
        return []
    if refs is None:
        rows = conn.execute(text(_FETCH[scope].format(where="")))
        return [dict(r._mapping) for r in rows]
    out: list[dict[str, Any]] = []
    for ref in refs:
        rows = conn.execute(text(_FETCH[scope].format(where=f"AND {_REF_COL[scope]} = :ref")), {"ref": ref})
        out.extend(dict(r._mapping) for r in rows)
    return out


_INSERT = text("""INSERT INTO search_index(scope, ref, company_id, agent, member_id, ts, title, body, meta, text)
                  VALUES(:scope, :ref, :company_id, :agent, :member_id, :ts, :title, :body, :meta, :text)""")
_DELETE = text("DELETE FROM search_index WHERE scope = :scope AND ref = :ref")


def reindex_all(engine) -> int:
    tables = set(inspect(engine).get_table_names())
    n = 0
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM search_index"))
        conn.execute(text("DELETE FROM search_dirty"))
        for table, scope, _ in _SOURCES:
            if table not in tables:
                continue
            for row in _fetch(conn, scope):
                conn.execute(_INSERT, _doc(scope, row))
                n += 1
    log.info("search: reindexed %d documents", n)
    return n


def drain(engine, max_rows: int = 5000) -> int:
    """把 search_dirty 吃掉：upsert＝刪舊插新；delete＝刪。回傳處理筆數。"""
    with engine.begin() as conn:
        rows = conn.execute(text("SELECT id, scope, ref, op FROM search_dirty ORDER BY id LIMIT :n"), {"n": max_rows}).fetchall()
        if not rows:
            return 0
        latest: dict[tuple[str, str], str] = {}
        for _id, scope, ref, op in rows:
            latest[(scope, str(ref))] = op
        for (scope, ref), op in latest.items():
            conn.execute(_DELETE, {"scope": scope, "ref": ref})
            if op == "upsert":
                for row in _fetch(conn, scope, [ref]):
                    conn.execute(_INSERT, _doc(scope, row))
        conn.execute(text("DELETE FROM search_dirty WHERE id <= :m"), {"m": rows[-1][0]})
    return len(rows)


# ---------------------------------------------------------------- 查詢

def query(engine, q: str, *, company_id: str, scopes: Optional[list[str]] = None, since: Optional[str] = None,
          until: Optional[str] = None, agent: Optional[str] = None, member_id: Optional[str] = None,
          allowed_agents: Optional[list[str]] = None, limit: int = 20, offset: int = 0) -> tuple[list[dict[str, Any]], int]:
    match = build_match(q)
    if not match:
        return [], 0
    where = ["search_index MATCH :m", "company_id IN (:cid, '')"]
    params: dict[str, Any] = {"m": match, "cid": company_id}
    if scopes:
        names = [f":s{i}" for i in range(len(scopes))]
        where.append(f"scope IN ({', '.join(names)})")
        params.update({f"s{i}": s for i, s in enumerate(scopes)})
    if since:
        where.append("ts >= :since")
        params["since"] = since
    if until:
        where.append("ts <= :until")
        params["until"] = until
    if agent:
        where.append("agent = :agent")
        params["agent"] = agent
    if allowed_agents is not None:
        names = [f":a{i}" for i in range(len(allowed_agents))]
        where.append(f"(agent = '' OR agent IN ({', '.join(names) or "''"}))")
        params.update({f"a{i}": a for i, a in enumerate(allowed_agents)})
    if member_id:  # 非管理者：私人對話只看自己的
        where.append("(scope <> 'chat' OR member_id = :mid)")
        params["mid"] = member_id
    sql = f"SELECT scope, ref, company_id, agent, member_id, ts, title, body, meta, bm25(search_index) AS score FROM search_index WHERE {' AND '.join(where)}"
    with engine.connect() as conn:
        total = int(conn.execute(text(f"SELECT COUNT(*) FROM ({sql})"), params).scalar() or 0)
        rows = conn.execute(text(sql + " ORDER BY score, ts DESC LIMIT :lim OFFSET :off"), {**params, "lim": limit, "off": offset}).fetchall()
    terms = terms_of(q)
    items = []
    for r in rows:
        d = dict(r._mapping)
        try:
            meta = json.loads(d.pop("meta") or "{}")
        except ValueError:
            meta = {}
        d["meta"] = meta
        d["snippet"] = snippet(d.pop("body") or "", terms)
        d["score"] = round(-float(d["score"] or 0), 4)  # bm25 越負越相關 → 轉成越大越好
        d["link"] = link_for(d["scope"], d["ref"], meta)
        items.append(d)
    return items, total


def link_for(scope: str, ref: str, meta: dict[str, Any]) -> str:
    from urllib.parse import quote
    if scope == "chat":
        return f"/?session={quote(str(meta.get('session_id') or ''))}&message={quote(ref)}"
    if scope == "group":
        return f"/groupchat?room={quote(str(meta.get('room_id') or ''))}&message={quote(ref)}"
    if scope == "workflow":
        return f"/workflows/runs/{quote(str(meta.get('run_id') or ''))}?node={quote(str(meta.get('node_id') or ''))}"
    return f"/events?subject={quote(str(meta.get('subject') or ''))}&event={quote(ref)}"
