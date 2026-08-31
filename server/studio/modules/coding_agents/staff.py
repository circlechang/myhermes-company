"""AI 員工＝Coding Agent（runtime 分派的共用零件）。

`agents.runtime` 是 `hermes` 時走既有 gateway；是 `claude-code` / `codex` / `pi` 時，
聊天、工作流、群聊三處都改用本模組把同一支 CLI 跑起來，事件正規化成跟 Hermes 一樣的那一組
（run.started / message.delta / tool.started / tool.completed / run.completed / run.failed），
前端不需要知道差別。

安全：coding 員工會在使用者機器上跑指令、改檔案，所以**工作目錄必須落在檔案模組的根白名單內**
（`STUDIO_FILE_ROOTS`、Hermes workspace、profile 目錄、Studio uploads）。預設不允許任意路徑。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from sqlmodel import Session

from ...errors import ApiError, bad_request
from ...models import Agent
from . import detect
from .models import CodingSessionMeta
from .proxy import get_or_create_proxy_token
from .runner import RunSpec, git_snapshot, run_agent

log = logging.getLogger("studio.coding.staff")

# agents.runtime -> coding_agents 的 agent id（detect.AGENTS 的 key）
RUNTIMES: dict[str, str] = {"claude-code": "claude", "codex": "codex", "pi": "pi"}
HERMES = "hermes"
VALID_RUNTIMES = {HERMES, *RUNTIMES}


def is_coding(runtime: str) -> bool:
    return (runtime or HERMES) in RUNTIMES


def cli_id(runtime: str) -> str:
    """runtime -> CLI id（claude-code -> claude）。不是 coding runtime 就丟 ValueError。"""
    try:
        return RUNTIMES[runtime]
    except KeyError:
        raise ValueError(f"not a coding runtime: {runtime}")


def runtime_of(agent: Optional[Agent]) -> str:
    return (getattr(agent, "runtime", "") or HERMES) if agent is not None else HERMES


def bin_for(app, runtime: str) -> Optional[str]:
    """找 CLI 執行檔；測試可用 app.state.coding_bins 覆寫。"""
    aid = cli_id(runtime)
    override = getattr(app.state, "coding_bins", None) or {}
    return override.get(aid) or detect.find_bin(detect.AGENTS[aid]["bin"])


def installed(app, runtime: str) -> bool:
    return bool(bin_for(app, runtime))


async def runtime_catalog(app) -> list[dict[str, Any]]:
    """建立員工的下拉選單資料：Hermes ＋ 三個 coding runtime（含未安裝與安裝指令）。"""
    override = getattr(app.state, "coding_bins", None) or {}
    out: list[dict[str, Any]] = [{"id": HERMES, "name": "Hermes", "installed": True, "install_cmd": "", "kind": "hermes"}]
    for runtime, aid in RUNTIMES.items():
        info = await detect.detect_agent(aid)
        if aid in override:
            info.update(installed=True, path=override[aid], version=info.get("version") or "test")
        out.append({"id": runtime, "name": info["name"], "installed": bool(info["installed"]),
                    "version": info.get("version", ""), "path": info.get("path", ""),
                    "install_cmd": info["install_cmd"], "docs": info.get("docs", ""), "kind": "coding"})
    return out


# ---------------------------------------------------------------- 工作目錄白名單
def allowed_roots(app) -> list[Path]:
    from ..files.paths import list_roots
    roots = list_roots(app.state.cli, Path(app.state.settings.db_path))
    return [r.path for r in roots]


def roots_public(app) -> list[dict[str, str]]:
    from ..files.paths import list_roots
    return [{"id": r.id, "label": r.label, "path": str(r.path)}
            for r in list_roots(app.state.cli, Path(app.state.settings.db_path))]


def virtual_workspace(app, workspace: str) -> str:
    """把絕對工作目錄換成檔案瀏覽器看得懂的虛擬路徑（`<root_id>/<rel>`）；不在任何根底下就回空字串。"""
    from ..files.paths import list_roots, to_virtual
    if not workspace:
        return ""
    try:
        target = Path(workspace).expanduser().resolve()
    except OSError:
        return ""
    for r in list_roots(app.state.cli, Path(app.state.settings.db_path)):
        try:
            root = r.path.resolve()
        except OSError:
            continue
        if target == root or root in target.parents:
            return to_virtual(r, target)
    return ""


def check_workspace(app, workspace: str) -> str:
    """回正規化後的絕對路徑；不在白名單內或不存在就丟 400。空字串一律拒絕（coding 員工必須有工作目錄）。"""
    raw = (workspace or "").strip()
    if not raw:
        raise bad_request("coding 員工必須指定工作目錄", "workspace_required")
    p = Path(raw).expanduser()
    try:
        p = p.resolve()
    except OSError as e:
        raise bad_request(f"工作目錄無法解析：{e}", "workspace_missing")
    if not p.is_dir():
        raise bad_request(f"工作目錄不存在：{p}", "workspace_missing")
    for root in allowed_roots(app):
        try:
            root_r = root.resolve()
        except OSError:
            continue
        if p == root_r or root_r in p.parents:
            return str(p)
    raise ApiError(400, "workspace_not_allowed",
                   "工作目錄不在允許清單內；請把它加進 STUDIO_FILE_ROOTS（例：STUDIO_FILE_ROOTS=\"code=/Users/me/code\"）")


# ---------------------------------------------------------------- 設定
def config_of(agent: Agent) -> dict[str, Any]:
    try:
        c = json.loads(getattr(agent, "coding_config_json", None) or "{}")
    except (TypeError, ValueError):
        c = {}
    return c if isinstance(c, dict) else {}


def config_public(agent: Agent) -> dict[str, Any]:
    c = config_of(agent)
    return {"model": str(c.get("model") or agent.model or ""), "api_mode": str(c.get("api_mode") or "direct"),
            "hermes_profile": str(c.get("hermes_profile") or ""), "extra": c.get("extra") if isinstance(c.get("extra"), dict) else {}}


def default_config(runtime: str) -> dict[str, Any]:
    extra = {"permission_mode": "acceptEdits"} if runtime == "claude-code" else {"sandbox": "workspace-write"} if runtime == "codex" else {}
    return {"model": "", "api_mode": "direct", "hermes_profile": "", "extra": extra}


def public_base(app) -> str:
    s = app.state.settings
    host = s.host if s.host not in ("0.0.0.0", "::", "") else "127.0.0.1"
    return f"http://{host}:{s.port}"


def build_spec(app, agent: Agent, prompt: str, *, workspace: str = "", resume_id: str = "",
               images: Optional[list[str]] = None, db: Optional[Session] = None) -> RunSpec:
    cfg = config_public(agent)
    ws = workspace or agent.workspace or ""
    bin_path = bin_for(app, agent.runtime)
    if not bin_path:
        aid = cli_id(agent.runtime)
        raise ApiError(400, "agent_not_installed",
                       f"{detect.AGENTS[aid]['name']} 尚未安裝：{detect.AGENTS[aid]['install_cmd']}")
    proxy = None
    if cfg["api_mode"] == "hermes" and db is not None:
        proxy = {"base": public_base(app), "token": get_or_create_proxy_token(db, agent.company_id)}
    return RunSpec(agent=cli_id(agent.runtime), prompt=prompt, workspace=ws, bin_path=bin_path,
                   model=cfg["model"], resume_id=resume_id, images=list(images or []), extra=dict(cfg["extra"]),
                   proxy=proxy)


# ---------------------------------------------------------------- 執行
EventCb = Callable[[dict[str, Any]], Awaitable[None]]


async def execute(spec: RunSpec, run_id: str, on_event: EventCb, *, registry: dict[str, Any],
                  timeout: float = 3600.0, diff: bool = True) -> dict[str, Any]:
    """跑一次 CLI，回 run_agent 的結果 ＋ `diff`（before/after/files）。事件已是正規化過的那一組。"""
    before = await git_snapshot(spec.workspace) if diff else {"diff": "", "files": [], "is_git": False}
    result = await run_agent(spec, run_id, on_event, registry=registry, timeout=timeout)
    after = await git_snapshot(spec.workspace) if diff else {"diff": "", "files": [], "is_git": False}
    result["diff"] = {"before": before["diff"], "after": after["diff"], "files": after["files"], "is_git": after["is_git"]}
    result["before_paths"] = [f["path"] for f in before["files"]]
    return result


def get_or_create_meta(db: Session, session_id: str, agent: Agent, workspace: str = "") -> CodingSessionMeta:
    meta = db.get(CodingSessionMeta, session_id)
    if meta is None:
        meta = CodingSessionMeta(session_id=session_id, agent=cli_id(agent.runtime),
                                 workspace=workspace or agent.workspace or "",
                                 model=config_public(agent)["model"])
        db.add(meta)
    return meta


def diff_stat(diff_text: str) -> list[dict[str, Any]]:
    """從 unified diff 算出「檔案 → 加幾行／刪幾行」（給 skill 回摘要用，不必再開 git）。"""
    files: list[dict[str, Any]] = []
    cur: Optional[dict[str, Any]] = None
    for line in (diff_text or "").splitlines():
        if line.startswith("diff --git "):
            parts = line.split(" b/", 1)
            path = parts[1] if len(parts) == 2 else line[len("diff --git "):]
            cur = {"path": path, "added": 0, "removed": 0}
            files.append(cur)
        elif cur is None:
            continue
        elif line.startswith("+++") or line.startswith("---") or line.startswith("@@"):
            continue
        elif line.startswith("+"):
            cur["added"] += 1
        elif line.startswith("-"):
            cur["removed"] += 1
    return files


# ---------------------------------------------------------------- 對話回合（工作臺／群聊共用）
async def run_chat_turn(*, engine, session_id: str, run_id: str, spec: RunSpec, send: EventCb,
                        registry: dict[str, Any], timeout: float = 3600.0) -> dict[str, Any]:
    """跑一回合並落庫（tool 訊息、assistant 訊息、CodingRun 的 diff）。

    事件透過 `send` 往外送，型別跟 Hermes 對話完全一樣，前端不必分辨。
    回傳 run_agent 的結果（多一個 `diff`）。"""
    from ...models import ChatSession, Message, now as _now
    from .models import CodingRun

    before = await git_snapshot(spec.workspace)
    pending: dict[str, dict[str, Any]] = {}
    text_parts: list[str] = []

    def _save_tool(name: str, args: Any, result: Any) -> None:
        with Session(engine) as db:
            db.add(Message(session_id=session_id, role="tool", content="", tool_name=name, run_id=run_id,
                           tool_args=json.dumps(args, ensure_ascii=False, default=str) if args is not None else None,
                           tool_result=json.dumps(result, ensure_ascii=False, default=str) if result is not None else None))
            db.commit()

    async def on_event(ev: dict[str, Any]) -> None:
        t = ev.get("type")
        if t == "message.delta":
            text_parts.append(str(ev.get("delta") or ""))
        elif t == "tool.started":
            pending[str(ev.get("call_id") or ev.get("name") or "")] = {"name": ev.get("name"), "args": ev.get("args")}
        elif t == "tool.completed":
            key = str(ev.get("call_id") or ev.get("name") or "")
            pend = pending.pop(key, {"name": ev.get("name"), "args": None})
            _save_tool(str(pend.get("name") or ev.get("name") or "tool"), pend.get("args"),
                       {"result": ev.get("result"), "error": ev.get("error")})
        elif t == "session.init" and ev.get("external_session_id"):
            with Session(engine) as db:
                m = db.get(CodingSessionMeta, session_id)
                if m and not m.external_session_id:
                    m.external_session_id = str(ev["external_session_id"])
                    db.add(m)
                    db.commit()
        if t in ("run.completed", "run.failed"):
            return  # 收尾事件等 diff 算完再送
        if t == "run.started":
            # 呼叫端已經先送過一次 run.started（帶 message_id）；runner 這一次只是要告訴前端實際指令列
            await send({"type": "log", "text": str(ev.get("command") or ""), "stream": "command",
                        "session_id": session_id, "run_id": run_id})
            return
        out = dict(ev)
        out.update({"session_id": session_id, "run_id": run_id})
        try:
            await send(out)
        except Exception:  # pragma: no cover - 連線斷了不影響落庫
            pass

    try:
        result = await run_agent(spec, run_id, on_event, registry=registry, timeout=timeout)
    except Exception as e:  # pragma: no cover
        log.exception("coding chat turn failed")
        result = {"status": "failed", "exit_code": None, "external_session_id": "", "output": "", "usage": {}, "error": str(e)}
    after = await git_snapshot(spec.workspace)
    output = result.get("output") or "".join(text_parts)
    status = result.get("status") or "failed"
    diff = {"before": before["diff"], "after": after["diff"], "files": after["files"], "is_git": after["is_git"]}
    result["diff"] = diff
    result["output"] = output
    msg_id = ""
    with Session(engine) as db:
        run = db.get(CodingRun, run_id)
        if run:
            run.status = status
            run.exit_code = result.get("exit_code")
            run.diff_before = before["diff"]
            run.diff_after = after["diff"]
            run.files_json = json.dumps(after["files"], ensure_ascii=False)
            run.usage_json = json.dumps(result.get("usage") or {}, ensure_ascii=False, default=str)
            run.error = result.get("error") or ""
            run.finished_at = _now()
            db.add(run)
        meta = db.get(CodingSessionMeta, session_id)
        if meta:
            meta.status = "failed" if status == "failed" else "idle"
            if result.get("external_session_id"):
                meta.external_session_id = result["external_session_id"]
            db.add(meta)
        s = db.get(ChatSession, session_id)
        if output or status == "completed":
            m = Message(session_id=session_id, role="assistant", content=output, run_id=run_id)
            db.add(m)
            db.flush()
            msg_id = m.id
            if s:
                s.last_message_at = _now()
        if s:
            s.updated_at = _now()
            s.run_status = {"completed": "completed", "cancelled": "cancelled"}.get(status, "failed")
            db.add(s)
        db.commit()
    base = {"session_id": session_id, "run_id": run_id, "diff": diff, "exit_code": result.get("exit_code"),
            "external_session_id": result.get("external_session_id") or "", "message_id": msg_id}
    try:
        if status == "completed":
            await send({"type": "run.completed", "output": output, "usage": result.get("usage") or {}, **base})
        elif status == "cancelled":
            await send({"type": "run.cancelled", "output": output, **base})
        else:
            await send({"type": "run.failed", "error": result.get("error") or "failed", "output": output, **base})
    except Exception:  # pragma: no cover
        pass
    return result
