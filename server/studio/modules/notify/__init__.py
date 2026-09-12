"""notify 模組：有事找老闆 → 推一則 LINE。

問題：閘門等人看、流程失敗、對話要跑危險指令，這些都只躺在收件匣，老闆不開站台就不知道。
做法：公司層級一組偏好（notify_prefs），別的模組在事件發生處呼叫 `emit(kind, company_id, payload)`，
這裡決定要不要推、組訊息、推到 LINE（token 跟「送到 LINE」投遞節點一樣讀 ~/.hermes/.env）。

原則：
- `emit` 永遠不 raise 到呼叫端（流程／對話不能因為推播壞掉而壞掉）；推播本身丟到執行緒做（fire-and-forget）。
- 同一件事（kind, ref）10 分鐘內只推一次（閘門退回重跑、失敗重試都不會洗版）。
- token 只在記憶體裡經手，不 log、不回傳。
"""
from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, current_principal, get_db
from ...errors import bad_request
from ...models import Agent, new_id, now

log = logging.getLogger("studio.notify")
router = APIRouter(prefix="/notify", tags=["notify"])

LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"
DEDUPE_SECONDS = 600  # 同一 (kind, ref) 10 分鐘內只推一次
KINDS = ("gate", "failed", "chat")
TEST_TEXT = "MyHermesCompany 測試訊息"

_engine = None
_hermes_home: Optional[Path] = None
_recent: dict[tuple[str, str, str], float] = {}  # (company_id, kind, ref) -> monotonic 時間
_recent_lock = threading.Lock()
_clock = time.monotonic  # 測試可換掉，模擬窗口過期


class NotifyPrefs(SQLModel, table=True):
    """一家公司一列：要不要推、推給誰、連結用哪個網址、哪些事要推、安靜時段。"""
    __tablename__ = "notify_prefs"
    id: str = Field(default_factory=lambda: new_id("np"), primary_key=True)
    company_id: str = Field(index=True, unique=True)
    enabled: bool = False
    line_to: str = ""  # LINE userId 或 groupId（跟「送到 LINE」節點的 to 一樣）
    public_url: str = ""  # 站台對外網址，用來組訊息裡的連結；空＝不附連結
    on_waiting: bool = True  # 閘門等你看
    on_failed: bool = True  # 流程失敗／超預算／需要注意
    on_chat_approval: bool = True  # 對話裡的危險指令
    quiet_hours: str = ""  # "23-07"：這段時間內不推（本機時間）；空＝不限
    updated_at: datetime = Field(default_factory=now)

    def to_dict(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "line_to": self.line_to, "public_url": self.public_url, "on_waiting": self.on_waiting,
                "on_failed": self.on_failed, "on_chat_approval": self.on_chat_approval, "quiet_hours": self.quiet_hours,
                "updated_at": self.updated_at}


def _defaults(company_id: str) -> NotifyPrefs:
    return NotifyPrefs(company_id=company_id)


def get_prefs(db: Session, company_id: str) -> NotifyPrefs:
    """沒設定過就回預設值（不落庫，PUT 時才建）。"""
    return db.exec(select(NotifyPrefs).where(NotifyPrefs.company_id == company_id)).first() or _defaults(company_id)


# -- LINE 推播 -----------------------------------------------------------------
def line_token() -> str:
    """跟 workflows.runners.line_token 同一來源：~/.hermes/.env 的 LINE_CHANNEL_ACCESS_TOKEN。"""
    from ...config import _read_env_file
    home = _hermes_home or Path("~/.hermes").expanduser()
    return _read_env_file(home / ".env").get("LINE_CHANNEL_ACCESS_TOKEN", "")


def line_configured() -> bool:
    return bool(line_token())


def push_line_detail(to: str, text: str) -> tuple[bool, str]:
    """同步推一則文字到 LINE；回 (ok, error)。error 只含狀態碼與 LINE 回的前 300 字，絕不含 token。"""
    to = (to or "").strip()
    if not to:
        return False, "沒有收件對象（line_to 空白）"
    token = line_token()
    if not token:
        return False, "LINE 未設定：~/.hermes/.env 缺 LINE_CHANNEL_ACCESS_TOKEN"
    body = {"to": to, "messages": [{"type": "text", "text": (text or "")[:5000] or "(空)"}]}
    try:
        with httpx.Client(timeout=20.0) as c:
            r = c.post(LINE_PUSH_URL, json=body, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    except Exception as e:  # 網路層錯誤：訊息不帶 header，安全
        return False, f"LINE 連線失敗：{type(e).__name__}"
    if r.status_code >= 400:
        return False, f"LINE push 失敗 {r.status_code}: {r.text[:300]}"
    return True, ""


def push_line(to: str, text: str) -> bool:
    """給其他模組用的最小介面（測試會 monkeypatch 這個名字）。"""
    ok, err = push_line_detail(to, text)
    if not ok:
        log.warning("LINE push failed: %s", err)
    return ok


# -- 訊息組裝 -------------------------------------------------------------------
def _first_line(s: Any, limit: int = 80) -> str:
    for line in str(s or "").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):  # 跳過 markdown 標題（上游結果開頭是「### 節點a」，老闆要看的是內容）
            return line if len(line) <= limit else line[: limit - 1] + "…"
    return ""


def _link(prefs: NotifyPrefs, path: str) -> str:
    base = (prefs.public_url or "").strip().rstrip("/")
    return f"{base}{path}" if base else ""


def build_text(kind: str, prefs: NotifyPrefs, p: dict[str, Any]) -> str:
    """三種訊息的固定格式；public_url 空就不附連結那行。"""
    lines: list[str] = []
    if kind == "gate":
        lines.append(f"⏸ 第 {p.get('n') or '?'} 步等你看｜{p.get('workflow_name') or ''}")
        first = _first_line(p.get("text"))
        if first:
            lines.append(first)
        link = _link(prefs, f"/workflows/{p.get('wf_id') or ''}")
    elif kind == "failed":
        lines.append(f"⚠ 流程失敗｜{p.get('workflow_name') or ''}")
        err = _first_line(p.get("error")) or "（沒有錯誤說明）"
        lines.append(f"第 {p['n']} 步：{err}" if p.get("n") else err)
        link = _link(prefs, f"/workflows/{p.get('wf_id') or ''}")
    elif kind == "chat":
        lines.append(f"⚠ {p.get('agent') or 'AI 員工'} 想執行：{_first_line(p.get('command')) or '(未知指令)'}")
        link = _link(prefs, "/today")
        if link:
            link = f"到收件匣決定：{link}"
    else:
        raise ValueError(f"unknown notify kind {kind}")
    if link:
        lines.append(link)
    return "\n".join(lines)


def in_quiet_hours(spec: str, hour: Optional[int] = None) -> bool:
    """"23-07" → 23:00 到隔天 07:00 之間不推；格式壞掉就當沒設。"""
    m = re.fullmatch(r"\s*(\d{1,2})\s*-\s*(\d{1,2})\s*", spec or "")
    if not m:
        return False
    start, end = int(m.group(1)) % 24, int(m.group(2)) % 24
    h = datetime.now().hour if hour is None else hour
    if start == end:
        return False
    return start <= h < end if start < end else (h >= start or h < end)


def _dedupe(company_id: str, kind: str, ref: str) -> bool:
    """回 True＝10 分鐘內推過，該略過。"""
    key = (company_id, kind, ref)
    t = _clock()
    with _recent_lock:
        for k, ts in list(_recent.items()):  # 順手清掉過期的
            if t - ts > DEDUPE_SECONDS:
                _recent.pop(k, None)
        if key in _recent:
            return True
        _recent[key] = t
    return False


def reset_dedupe() -> None:
    with _recent_lock:
        _recent.clear()


def _send(to: str, text: str) -> bool:
    """有 event loop 就丟到執行緒（不擋流程）；沒有（同步測試碼）就直接推。"""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is None:
        return push_line(to, text)
    fut = loop.run_in_executor(None, push_line, to, text)
    fut.add_done_callback(lambda f: f.exception() and log.warning("LINE push crashed: %s", f.exception()))
    return True


def _agent_name(company_id: str, profile: str) -> str:
    if not profile or _engine is None:
        return profile or ""
    try:
        with Session(_engine) as db:
            a = db.exec(select(Agent).where(Agent.company_id == company_id, Agent.profile == profile)).first()
            return (a.name if a and a.name else profile)
    except Exception:
        return profile


def _emit(kind: str, company_id: str, payload: dict[str, Any]) -> bool:
    if kind not in KINDS:
        raise ValueError(f"unknown notify kind {kind}")
    if _engine is None:
        return False
    with Session(_engine) as db:
        prefs = get_prefs(db, company_id)
    if not prefs.enabled or not prefs.line_to.strip():
        return False
    flag = {"gate": prefs.on_waiting, "failed": prefs.on_failed, "chat": prefs.on_chat_approval}[kind]
    if not flag:
        return False
    if in_quiet_hours(prefs.quiet_hours):
        return False
    ref = str(payload.get("ref") or payload.get("approval_id") or payload.get("run_id") or "")
    if not ref:  # 沒有對象的事件推出去也只是一句「第 ? 步」，不推
        return False
    if _dedupe(company_id, kind, ref):
        return False
    p = dict(payload)
    if kind == "chat" and not p.get("agent"):
        p["agent"] = _agent_name(company_id, str(p.get("profile") or ""))
    return _send(prefs.line_to.strip(), build_text(kind, prefs, p))


def emit(kind: str, company_id: str, payload: dict[str, Any]) -> bool:
    """其他模組的唯一入口。永遠不 raise；回 True＝已排入推送（不代表 LINE 收到）。

    payload 依 kind：
    - gate:   {ref, n, workflow_name, wf_id, text}
    - failed: {ref, n, workflow_name, wf_id, error}
    - chat:   {ref, profile|agent, command}
    """
    try:
        return _emit(kind, company_id, payload or {})
    except Exception as e:
        log.warning("notify.emit(%s) skipped: %s", kind, e)
        return False


# -- API ------------------------------------------------------------------------
class PrefsBody(BaseModel):
    enabled: Optional[bool] = None
    line_to: Optional[str] = None
    public_url: Optional[str] = None
    on_waiting: Optional[bool] = None
    on_failed: Optional[bool] = None
    on_chat_approval: Optional[bool] = None
    quiet_hours: Optional[str] = None


class TestBody(BaseModel):
    line_to: Optional[str] = None  # 沒存之前也能先試


@router.get("/prefs")
def read_prefs(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    return get_prefs(db, p.company_id).to_dict()


@router.put("/prefs")
def write_prefs(body: PrefsBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    row = db.exec(select(NotifyPrefs).where(NotifyPrefs.company_id == p.company_id)).first() or _defaults(p.company_id)
    if body.public_url is not None:
        url = body.public_url.strip().rstrip("/")
        if url and not re.match(r"^https?://", url):
            raise bad_request("站台網址要以 http:// 或 https:// 開頭")
        row.public_url = url
    if body.quiet_hours is not None:
        q = body.quiet_hours.strip()
        if q and not re.fullmatch(r"\d{1,2}-\d{1,2}", q):
            raise bad_request("安靜時段格式是 HH-HH，例如 23-07")
        row.quiet_hours = q
    if body.line_to is not None:
        row.line_to = body.line_to.strip()
    for k in ("enabled", "on_waiting", "on_failed", "on_chat_approval"):
        v = getattr(body, k)
        if v is not None:
            setattr(row, k, bool(v))
    if row.enabled and not row.line_to:
        raise bad_request("要啟用得先填 LINE 收件對象")
    row.updated_at = now()
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.to_dict()


@router.post("/test")
def send_test(body: Optional[TestBody] = None, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    to = (body.line_to if body and body.line_to is not None else get_prefs(db, p.company_id).line_to).strip()
    ok, err = push_line_detail(to, TEST_TEXT)
    return {"ok": ok, "error": err}


@router.get("/status")
def status(p: Principal = Depends(current_principal)):
    return {"line_configured": line_configured()}


async def on_startup(app) -> None:
    global _engine, _hermes_home
    _engine = app.state.engine
    _hermes_home = Path(app.state.settings.hermes_home)
    reset_dedupe()
