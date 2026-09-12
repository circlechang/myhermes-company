"""Bots 訊息介面：Bot（＝AI 員工＝Hermes profile）的建立／複製／刪除，以及私訊房間。

- 建 Bot：從 default（或指定來源）clone 一個 Hermes profile（帶設定、金鑰、技能，不帶記憶與對話），
  SOUL.md 改寫成這個 Bot 的角色，再建 Agent 與一間私訊房。
- 刪 Bot：刪 Agent、私訊房、把它移出群組；**Hermes profile 保留**（要真的刪 profile 走設定頁，屬高風險動作）。
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from ...auth import Principal, current_principal, get_db
from ...errors import ApiError, bad_request, not_found
from ...hermes import allowlist as AL
from ...hermes.cli import CliError, HermesCli
from ...hermes.gateway import GatewayError
from ...models import Agent
from . import github_link as GH
from .api import _add_ai, _room_view
from .models import Room, RoomDoc, RoomMember, RoomMessage, RoomPref, RoomReaction, RoomSummary

router = APIRouter(prefix="/groupchat", tags=["groupchat"])
log = logging.getLogger("studio.groupchat.bots")

# Hermes 的 clone 會把來源 skills/ 整包 copytree；skills 裡的 git repo 若開著 fsmonitor，
# 會有 .git/fsmonitor--daemon.ipc（socket），copytree 複製 socket 失敗 → 整條指令 exit 1、
# 後續步驟（描述、設定升級）沒跑，留下半成品。退路：用 Hermes 自己的 CLI 入口重跑，只是 copytree 跳過 socket。
_SOCKET_SAFE_CLI = (
    "import os, runpy, shutil, stat, sys\n"
    "_orig = shutil.copytree\n"
    "def _skip_sockets(d, names):\n"
    "    out = []\n"
    "    for n in names:\n"
    "        try:\n"
    "            if stat.S_ISSOCK(os.lstat(os.path.join(d, n)).st_mode): out.append(n)\n"
    "        except OSError: pass\n"
    "    return out\n"
    "def _ct(src, dst, symlinks=False, ignore=None, *a, **kw):\n"
    "    ig = lambda d, n: set(_skip_sockets(d, n)) | set(ignore(d, n) if ignore else ())\n"
    "    return _orig(src, dst, symlinks, ig, *a, **kw)\n"
    "shutil.copytree = _ct\n"
    "entry = sys.argv[1]\n"
    "sys.argv = ['hermes'] + sys.argv[2:]\n"
    "runpy.run_path(entry, run_name='__main__')\n"
)


def _hermes_entry(cli: HermesCli) -> Optional[tuple[str, str]]:
    """從 hermes 啟動腳本找出 (python, 入口腳本)；找不到回 None。"""
    try:
        bin_path = shutil.which(cli.bin) or cli.bin
        text = Path(bin_path).read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return None
    m = re.search(r'exec\s+"([^"]+python[^"]*)"\s+"([^"]+)"', text)
    return (m.group(1), m.group(2)) if m else None


async def _socket_safe_create(cli: HermesCli, args: list[str], timeout: float = 120.0) -> None:
    ent = _hermes_entry(cli)
    if ent is None:
        raise CliError("找不到 Hermes 的 Python 入口")
    proc = await asyncio.create_subprocess_exec(ent[0], "-c", _SOCKET_SAFE_CLI, ent[1], *args,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    if proc.returncode != 0:
        raise CliError((err or out).decode("utf-8", "replace").strip()[-500:] or f"exit {proc.returncode}")


def _cli(request: Request) -> HermesCli:
    return request.app.state.cli


def _hermes_home(request: Request) -> Path:
    return Path(request.app.state.settings.hermes_home)


def _config_path(request: Request) -> Path:
    return _hermes_home(request) / "config.yaml"


async def _served(request: Request, profile: str) -> bool:
    """Hermes **現在**認不認得這個設定檔（加進名單也要等 gateway 重啟才算）。直接問 gateway，結果快取 60 秒。"""
    if not profile:
        return True
    cache: dict[str, tuple[bool, float]] = request.app.state.__dict__.setdefault("bot_served_cache", {})
    hit = cache.get(profile)
    if hit and time.monotonic() - hit[1] < 60:
        return hit[0]
    ok = True
    try:
        await request.app.state.gateway.models(profile)
    except GatewayError as e:
        ok = not (e.status == 404 and "unconfigured profile" in (e.message or "").lower())
    except Exception:  # gateway 沒開：不要因此說 Bot 壞了
        ok = True
    cache[profile] = (ok, time.monotonic())
    return ok


def _gateway_cfg(request: Request) -> dict[str, Any]:
    try:
        import yaml
        data = yaml.safe_load(_config_path(request).read_text(encoding="utf-8")) or {}
    except Exception:  # 讀不到或格式壞掉：當成沒設定，不影響建 Bot
        return {}
    return data if isinstance(data, dict) else {}


# 加名單的結果 → 前端要顯示的一句話（None＝沒事，不用提示）
_ALLOW_HINT = {
    "added": "已把它加進 Hermes 的服務名單。重新啟動 Hermes（終端機打 hermes gateway restart）之後，它就會用自己的設定檔；"
             "在那之前先借 default 的通道回話，聊天不受影響。",
    "off": "Hermes 目前沒開多設定檔服務，這個 Bot 會一直借 default 的通道回話（設定、技能都跟 default 一樣）。",
    "missing": "沒能自動改 Hermes 的服務名單（設定檔格式不符預期）。它會先借 default 的通道回話。",
}


def _register_profile(request: Request, slug: str) -> dict[str, Any]:
    """把新 profile 加進 gateway 的服務名單（名單只在 gateway 啟動時讀，所以要重啟才生效）。"""
    status = AL.apply(_config_path(request), slug)
    return {"status": status, "needs_restart": status == "added", "hint": _ALLOW_HINT.get(status)}


def _slug(name: str, taken: set[str]) -> str:
    """profile 名只能小寫英數＋連字號；中文名字就用 bot-xxxx。"""
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:24]
    if len(base) < 2 or not base[0].isalpha():
        base = "bot"
    cand = base if base != "bot" else f"bot-{secrets.token_hex(2)}"
    while cand in taken or cand == "default":
        cand = f"{base}-{secrets.token_hex(2)}"
    return cand


def soul_for(name: str, title: str, description: str) -> str:
    parts = [f"# {name}"]
    if title.strip():
        parts.append(f"職稱：{title.strip()}")
    if description.strip():
        parts.append("## 長期規則\n" + description.strip())
    parts.append("你是使用者團隊裡的一個 Bot，會在私訊與群組裡跟使用者及其他 Bot 合作。回覆簡潔、直接，用繁體中文。")
    return "\n\n".join(parts) + "\n"


def bot_public(a: Agent, dm_room_id: str = "", served: Optional[bool] = None) -> dict[str, Any]:
    return {"id": a.id, "name": a.name, "title": a.title, "description": a.description, "avatar": a.avatar,
            "profile": a.profile, "model": a.model, "enabled": a.enabled, "runtime": a.runtime,
            "setup_state": a.setup_state, "setup_error": a.setup_error,
            "gh_dir": a.gh_dir, "gh_account": a.gh_account,
            "dm_room_id": dm_room_id, "created_at": a.created_at,
            # served=False：Hermes 還沒服務這個設定檔（要重啟），技能與例行會打不到，聊天走 default
            "served": True if served is None else served}


def _dm_room(db: Session, company_id: str, member_id: str, agent_id: str) -> Optional[Room]:
    for r in db.exec(select(Room).where(Room.company_id == company_id, Room.kind == "dm", Room.dm_agent_id == agent_id)).all():
        if r.created_by == member_id:
            return r
    return None


def ensure_dm(db: Session, p: Principal, agent: Agent) -> Room:
    room = _dm_room(db, p.company_id, p.member.id, agent.id)
    if room is not None:
        return room
    room = Room(company_id=p.company_id, name=agent.name, kind="dm", dm_agent_id=agent.id, no_mention_policy="host",
                created_by=p.member.id, max_ai_depth=0)
    db.add(room)
    db.flush()
    db.add(RoomMember(room_id=room.id, kind="human", member_id=p.member.id, display_name=p.member.username))
    ai = _add_ai(db, room, agent)
    room.host_member_id = ai.id
    db.add(room)
    db.commit()
    db.refresh(room)
    return room


@router.get("/bots")
async def list_bots(request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    agents = db.exec(select(Agent).where(Agent.company_id == p.company_id).order_by(Agent.created_at)).all()
    out = []
    for a in agents:
        r = _dm_room(db, p.company_id, p.member.id, a.id)
        served = False if a.setup_state == "preparing" or not a.profile else (
            True if a.runtime != "hermes" else await _served(request, a.profile))
        out.append(bot_public(a, r.id if r else "", served))
    return out


class DmIn(BaseModel):
    agent_id: str


@router.post("/dm")
def open_dm(body: DmIn, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """跟某個 Bot 的私訊房：有就回，沒有就建（Bot 也會順便啟用）。"""
    a = db.get(Agent, body.agent_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("bot")
    if not a.enabled:
        a.enabled = True
        db.add(a)
        db.commit()
    room = ensure_dm(db, p, a)
    return _room_view(db, room, p.member.id)


class BotIn(BaseModel):
    name: str
    title: str = ""
    description: str = ""
    avatar: str = ""
    clone_from: str = "default"


async def _make_profile(request: Request, name: str, clone_from: str, title: str) -> str:
    return await _make_profile_for(request.app, name, clone_from, title)


async def _make_profile_for(app, name: str, clone_from: str, title: str) -> str:
    """clone 一個 Hermes profile。失敗絕不留半成品（半成品裡有複製過去的 .env 金鑰）。"""
    cli: HermesCli = app.state.cli
    taken = set(cli.list_profiles_fs())
    if clone_from != "default" and clone_from not in taken:
        raise ApiError(400, "unknown_profile", f"來源 profile 不存在: {clone_from}")
    slug = _slug(name, taken)
    args = ["profile", "create", slug, "--no-alias", "--clone-from", clone_from]
    if title.strip():
        args += ["--description", title.strip()[:200]]
    pdir = cli.profile_dir(slug)

    def _cleanup() -> None:
        if pdir.is_dir() and pdir.parent.name == "profiles":
            shutil.rmtree(pdir, ignore_errors=True)

    # 這台機器的 skills 有 socket 檔時，官方指令每次都會失敗；第一次踩到就記住，之後直接走退路（省掉一次白做的複製）
    state = app.state
    skip_fast = bool(getattr(state, "hermes_clone_skip_fast", False))
    try:
        if skip_fast:
            raise CliError("上次就失敗過，直接用跳過 socket 的方式")
        await cli._run(*args, timeout=120.0)
    except CliError as first:
        if not skip_fast:
            log.warning("hermes profile create %s 失敗，改用跳過 socket 的方式重試：%s", slug, str(first)[:200])
            state.hermes_clone_skip_fast = True
        _cleanup()
        try:
            await _socket_safe_create(cli, args)
        except (CliError, OSError, asyncio.TimeoutError) as second:
            state.hermes_clone_skip_fast = False  # 退路也失敗：下次還是照正常流程走一次
            _cleanup()
            log.error("hermes profile create %s 重試仍失敗：%s", slug, str(second)[:300])
            raise ApiError(502, "hermes_cli_error", "Hermes 建立設定檔失敗，這次沒有留下任何半成品。請看伺服器 log 或稍後再試。")
    if slug not in set(cli.list_profiles_fs()):
        _cleanup()
        raise ApiError(502, "hermes_cli_error", "Hermes 回報成功但設定檔不存在")
    return slug


@router.post("/bots", status_code=201)
async def create_bot(body: BotIn, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """建立新 Bot：**先把 Bot 與私訊房建起來回傳**（立刻可以開始聊，走 default 通道），
    Hermes 設定檔（要複製設定、金鑰、技能，幾十秒）在背景做完再補上去。"""
    p.require_admin()
    name = body.name.strip() or "新 Bot"
    a = Agent(company_id=p.company_id, name=name[:80], profile="", title=body.title.strip()[:120],
              description=body.description.strip()[:4000], avatar=body.avatar.strip()[:64],
              enabled=True, setup_state="preparing")
    db.add(a)
    db.commit()
    db.refresh(a)
    room = ensure_dm(db, p, a)
    asyncio.create_task(_prepare_profile(request.app, a.id, name, body.clone_from or "default", body.title, body.description))
    gw = {"status": "preparing", "needs_restart": False,
          "hint": "已經可以開始跟它說話了。它專屬的 Hermes 設定檔正在背景複製（幾十秒），完成前先借 default 的通道回話。"}
    return {"bot": bot_public(a, room.id, False), "room": _room_view(db, room, p.member.id), "gateway": gw}


async def _prepare_profile(app, agent_id: str, name: str, clone_from: str, title: str, description: str,
                           display_name: str = "") -> None:
    """背景：clone profile → 寫 SOUL → 回填 agents.profile → 登記 gateway 名單。失敗就標記，不刪 Bot。"""
    from ...models import Agent as _Agent
    try:
        slug = await _make_profile_for(app, name, clone_from, title)
        cli: HermesCli = app.state.cli
        cli.write_soul(slug, soul_for(display_name or name, title, description))
        model = cli.profile_model(slug)
        status = AL.apply(Path(app.state.settings.hermes_home) / "config.yaml", slug)
        with Session(app.state.engine) as db:
            a = db.get(_Agent, agent_id)
            if a is None:  # 使用者在準備好之前就把它刪了 → 設定檔留著不動
                log.info("Bot %s 已被刪除，profile %s 留在磁碟上", agent_id, slug)
                return
            a.profile, a.model, a.setup_state, a.setup_error = slug, model or a.model, "", ""
            db.add(a)
            db.commit()
        log.info("Bot %s 的設定檔 %s 準備好了（名單：%s）", name, slug, status)
    except Exception as e:
        msg = str(getattr(e, "message", None) or e)[:300]
        log.error("Bot %s 的設定檔沒建成功：%s", name, msg)
        with Session(app.state.engine) as db:
            a = db.get(_Agent, agent_id)
            if a is not None:
                a.setup_state, a.setup_error = "failed", msg
                db.add(a)
                db.commit()


class BotPatch(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    avatar: Optional[str] = None


@router.patch("/bots/{agent_id}")
def patch_bot(agent_id: str, body: BotPatch, request: Request, p: Principal = Depends(current_principal),
              db: Session = Depends(get_db)):
    """改名字／職稱／描述／頭像；描述＝長期規則，同步寫回 SOUL.md。私訊房名稱跟著改。"""
    p.require_admin()
    a = db.get(Agent, agent_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("bot")
    changed_persona = False
    if body.name is not None:
        if not body.name.strip():
            raise bad_request("名字不可空白")
        a.name = body.name.strip()[:80]
        changed_persona = True
    if body.title is not None:
        a.title = body.title.strip()[:120]
        changed_persona = True
    if body.description is not None:
        a.description = body.description.strip()[:4000]
        changed_persona = True
    if body.avatar is not None:
        a.avatar = body.avatar.strip()[:64]
    db.add(a)
    for r in db.exec(select(Room).where(Room.company_id == p.company_id, Room.kind == "dm", Room.dm_agent_id == a.id)).all():
        r.name = a.name
        db.add(r)
    for m in db.exec(select(RoomMember).where(RoomMember.agent_id == a.id)).all():
        m.display_name = a.name
        db.add(m)
    db.commit()
    db.refresh(a)
    if changed_persona and a.runtime == "hermes" and a.profile:
        try:
            _cli(request).write_soul(a.profile, soul_for(a.name, a.title, a.description))
        except Exception:  # SOUL 寫不進去不擋改名（profile 可能已被手動刪）
            pass
    r = _dm_room(db, p.company_id, p.member.id, a.id)
    return bot_public(a, r.id if r else "", AL.is_served(_gateway_cfg(request), a.profile) if a.profile else True)


@router.post("/bots/{agent_id}/duplicate", status_code=201)
async def duplicate_bot(agent_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """複製 Bot：帶走設定、技能、角色、頭像；不帶對話與記憶。設定檔一樣在背景複製。"""
    p.require_admin()
    src = db.get(Agent, agent_id)
    if src is None or src.company_id != p.company_id:
        raise not_found("bot")
    if src.runtime != "hermes":
        raise bad_request("只有 Hermes Bot 可以複製")
    if not src.profile:
        raise bad_request("這個 Bot 的設定檔還在準備中，等它好了再複製")
    name = f"{src.name} 副本"
    a = Agent(company_id=p.company_id, name=name[:80], profile="", title=src.title, description=src.description,
              avatar=src.avatar, model=src.model, enabled=True, setup_state="preparing")
    db.add(a)
    db.commit()
    db.refresh(a)
    room = ensure_dm(db, p, a)
    asyncio.create_task(_prepare_profile(request.app, a.id, src.profile, src.profile, src.title, src.description, display_name=name))
    gw = {"status": "preparing", "needs_restart": False, "hint": "副本已經可以用了；它的設定檔正在背景複製。"}
    return {"bot": bot_public(a, room.id, False), "room": _room_view(db, room, p.member.id), "gateway": gw}


class RetryIn(BaseModel):
    clone_from: str = "default"


@router.post("/bots/{agent_id}/retry-setup")
async def retry_setup(agent_id: str, request: Request, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """設定檔沒建成功時重試一次（Bot 與對話都保留）。"""
    p.require_admin()
    a = db.get(Agent, agent_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("bot")
    if a.profile:
        return bot_public(a)
    a.setup_state, a.setup_error = "preparing", ""
    db.add(a)
    db.commit()
    db.refresh(a)
    asyncio.create_task(_prepare_profile(request.app, a.id, a.name, "default", a.title, a.description))
    return bot_public(a)


@router.delete("/bots/{agent_id}", status_code=204)
def delete_bot(agent_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """刪 Bot：私訊房整間刪、群組裡移除這位成員、刪 Agent。Hermes profile 保留在磁碟上。"""
    p.require_admin()
    a = db.get(Agent, agent_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("bot")
    for r in db.exec(select(Room).where(Room.company_id == p.company_id, Room.kind == "dm", Room.dm_agent_id == a.id)).all():
        for model in (RoomMessage, RoomSummary, RoomMember, RoomReaction, RoomPref, RoomDoc):
            for row in db.exec(select(model).where(model.room_id == r.id)).all():
                db.delete(row)
        db.delete(r)
    for m in db.exec(select(RoomMember).where(RoomMember.agent_id == a.id)).all():
        room = db.get(Room, m.room_id)
        if room is not None:
            if room.host_member_id == m.id:
                room.host_member_id = None
            if room.summarizer_member_id == m.id:
                room.summarizer_member_id = None
            db.add(room)
        db.delete(m)
    db.delete(a)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# GitHub 帳號：一個 Bot 一個 gh 設定目錄（Hermes 會剝除 GH_TOKEN，只能這樣分帳號）
# ---------------------------------------------------------------------------
def _bot(db: Session, p: Principal, agent_id: str) -> Agent:
    a = db.get(Agent, agent_id)
    if a is None or a.company_id != p.company_id:
        raise not_found("bot")
    return a


@router.get("/bots/{agent_id}/github")
async def github_status(agent_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """這個 Bot 現在用哪個 GitHub 帳號：own（專屬目錄）或 shared（跟系統共用）。"""
    a = _bot(db, p, agent_id)
    shared = await GH.status(None)
    if not a.gh_dir:
        return {"mode": "shared", "dir": "", "account": "", "ready": False, "shared_account": shared.get("account", ""),
                "message": "現在跟系統共用同一個 GitHub 登入。"}
    own = await GH.status(a.gh_dir)
    if own.get("account") and own["account"] != a.gh_account:  # 使用者換了帳號 → 跟著更新
        a.gh_account = own["account"]
        db.add(a)
        db.commit()
    return {"mode": "own", "dir": a.gh_dir, "bin": str(Path(a.gh_dir) / "bin"), "account": own.get("account", ""),
            "ready": bool(own.get("ready")), "shared_account": shared.get("account", ""),
            "login_cmd": f'GH_CONFIG_DIR="{a.gh_dir}" gh auth login', "message": own.get("message", "")}


@router.post("/bots/{agent_id}/github")
async def github_setup(agent_id: str, request: Request, p: Principal = Depends(current_principal),
                       db: Session = Depends(get_db)):
    """幫這個 Bot 開專屬的 gh 設定目錄與包裝指令，回一行要使用者自己貼去終端機的登入指令。"""
    p.require_admin()
    a = _bot(db, p, agent_id)
    info = GH.ensure_dir(GH.slug_of(a.profile, a.id))
    a.gh_dir = info["dir"]
    db.add(a)
    db.commit()
    st = await GH.status(a.gh_dir)
    return {"mode": "own", **info, "account": st.get("account", ""), "ready": bool(st.get("ready")),
            "message": st.get("message", "")}


@router.post("/bots/{agent_id}/github/check")
async def github_check(agent_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """使用者跑完 gh auth login 後按的「檢查」：把帳號名記下來。"""
    a = _bot(db, p, agent_id)
    if not a.gh_dir:
        raise bad_request("這個 Bot 還沒有專屬的 GitHub 目錄")
    st = await GH.status(a.gh_dir)
    if st.get("ready"):
        a.gh_account = st.get("account", "")
        db.add(a)
        db.commit()
    return {"ready": bool(st.get("ready")), "account": st.get("account", ""), "message": st.get("message", ""),
            "login_cmd": f'GH_CONFIG_DIR="{a.gh_dir}" gh auth login'}


@router.delete("/bots/{agent_id}/github", status_code=200)
def github_unlink(agent_id: str, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    """改回跟系統共用。**不刪目錄**（裡面是你的登入狀態），之後再按一次就會接回來。"""
    p.require_admin()
    a = _bot(db, p, agent_id)
    kept = a.gh_dir
    a.gh_dir, a.gh_account = "", ""
    db.add(a)
    db.commit()
    return {"mode": "shared", "kept_dir": kept}
