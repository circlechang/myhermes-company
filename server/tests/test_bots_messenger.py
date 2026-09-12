"""Bots 訊息介面：私訊、清單（未讀／釘選／隱藏）、@everyone、自動分派、文件卡流動、討論串、反應、核准、停止、建／複製／刪 Bot。"""
from __future__ import annotations

import shutil
import time
from pathlib import Path

from studio.modules.groupchat.models import RoomMember
from studio.modules.groupchat.service import heuristic_route, parse_route


def _agents(client, auth):
    return {a["profile"]: a["id"] for a in client.get("/agents", headers=auth).json()}


def _wait_idle(client, timeout=10.0):
    orch = client.app.state.groupchat
    deadline = time.time() + timeout
    while orch.tasks and time.time() < deadline:
        time.sleep(0.02)
    assert not orch.tasks, "AI 回覆未在時限內結束"


def _wait_setup(client, auth, agent_id, want="", timeout=10.0):
    """等背景準備設定檔結束（want=""：好了；want="failed"：失敗）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        b = next((x for x in client.get("/groupchat/bots", headers=auth).json() if x["id"] == agent_id), None)
        if b and b["setup_state"] == want:
            return b
        time.sleep(0.05)
    raise AssertionError(f"設定檔沒有在時限內變成 {want!r}")


def _msgs(client, auth, rid, **params):
    r = client.get(f"/groupchat/rooms/{rid}/messages", headers=auth, params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _group(client, auth, policy="auto"):
    ags = _agents(client, auth)
    r = client.post("/groupchat/rooms", json={"name": "專案群", "no_mention_policy": policy,
                                              "agent_ids": [ags["researcher"], ags["writer"]]}, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


def _say(client, auth, rid, text, **kw):
    r = client.post(f"/groupchat/rooms/{rid}/messages", json={"content": text, **kw}, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


# -- pure ----------------------------------------------------------------------
def _mem(name, prompt=""):
    return RoomMember(id=f"rm_{name}", room_id="r", kind="ai", display_name=name, profile=name, system_prompt=prompt)


def test_parse_route_and_heuristic():
    ms = [_mem("研究員", "負責市場研究、競品"), _mem("文案", "負責寫文案、標語")]
    assert [m.display_name for m in parse_route('好的 {"names": ["文案"]}', ms)] == ["文案"]
    assert parse_route("亂講一通", ms) == []
    assert heuristic_route(ms, "幫我想三個標語")[0].display_name == "文案"
    assert heuristic_route(ms, "今天天氣")[0].display_name == "研究員"


# -- DM ------------------------------------------------------------------------
def test_dm_get_or_create_and_reply_without_mention(client, auth):
    ags = _agents(client, auth)
    r1 = client.post("/groupchat/dm", json={"agent_id": ags["researcher"]}, headers=auth).json()
    r2 = client.post("/groupchat/dm", json={"agent_id": ags["researcher"]}, headers=auth).json()
    assert r1["id"] == r2["id"] and r1["kind"] == "dm" and r1["dm_agent_id"] == ags["researcher"]
    _say(client, auth, r1["id"], "你好")
    _wait_idle(client)
    ms = _msgs(client, auth, r1["id"])
    assert [m["sender_kind"] for m in ms] == ["human", "ai"]
    # 舊群聊頁不列私訊；messenger 清單有
    assert r1["id"] not in [x["id"] for x in client.get("/groupchat/rooms", headers=auth).json()]
    assert r1["id"] in [x["id"] for x in client.get("/groupchat/rooms?view=messenger", headers=auth).json()]
    bots = {b["profile"]: b for b in client.get("/groupchat/bots", headers=auth).json()}
    assert bots["researcher"]["dm_room_id"] == r1["id"] and bots["writer"]["dm_room_id"] == ""


def test_unread_read_pin_hide(client, auth):
    ags = _agents(client, auth)
    dm = client.post("/groupchat/dm", json={"agent_id": ags["writer"]}, headers=auth).json()
    _say(client, auth, dm["id"], "hi")
    _wait_idle(client)
    row = next(x for x in client.get("/groupchat/rooms?view=messenger", headers=auth).json() if x["id"] == dm["id"])
    assert row["unread"] == 1  # Bot 的回覆；自己的訊息不算
    assert row["last_message"]["sender_kind"] == "ai"
    client.post(f"/groupchat/rooms/{dm['id']}/read", json={}, headers=auth)
    row = client.get(f"/groupchat/rooms/{dm['id']}", headers=auth).json()
    assert row["unread"] == 0
    row = client.patch(f"/groupchat/rooms/{dm['id']}/prefs", json={"pinned": True}, headers=auth).json()
    assert row["pinned"] is True and row["hidden"] is False
    row = client.patch(f"/groupchat/rooms/{dm['id']}/prefs", json={"hidden": True}, headers=auth).json()
    assert row["hidden"] is True


# -- group routing ------------------------------------------------------------------
def test_everyone_triggers_all_bots(client, auth):
    room = _group(client, auth, policy="none")
    _say(client, auth, room["id"], "@everyone 早安")
    _wait_idle(client)
    senders = sorted(m["sender_name"] for m in _msgs(client, auth, room["id"]) if m["sender_kind"] == "ai")
    assert senders == ["researcher", "writer"]


def test_auto_route_uses_router_json(client, auth, gw_state):
    room = _group(client, auth, policy="auto")
    gw_state.scenario = "canned"
    gw_state.canned_text = '{"names": ["writer"]}'
    _say(client, auth, room["id"], "幫我寫一段開場")
    _wait_idle(client)
    ai = [m for m in _msgs(client, auth, room["id"]) if m["sender_kind"] == "ai"]
    assert [m["sender_name"] for m in ai] == ["writer"]


def test_auto_route_falls_back_to_heuristic(client, auth, gw_state):
    room = _group(client, auth, policy="auto")
    _say(client, auth, room["id"], "writer 你來回答")  # 分派員回的是 echo 不是 JSON → 名字比對
    _wait_idle(client)
    ai = [m for m in _msgs(client, auth, room["id"]) if m["sender_kind"] == "ai"]
    assert [m["sender_name"] for m in ai] == ["writer"]


def test_bot_handoff_is_marked(client, auth, gw_state):
    room = _group(client, auth, policy="none")
    gw_state.scenario = "canned"
    gw_state.canned_text = "我先看，@writer 請接手潤稿"
    _say(client, auth, room["id"], "@researcher 開始")
    _wait_idle(client)
    ms = _msgs(client, auth, room["id"])
    first_ai = next(m for m in ms if m["sender_name"] == "researcher")
    hand = [a for a in first_ai["attachments"] if a["type"] == "handoff"]
    assert hand and [t["name"] for t in hand[0]["to"]] == ["writer"]


# -- 文件魔術 ------------------------------------------------------------------------------
DOC_V1 = "好的，報價單在這：\n\n```doc\n# 報價單\n\n- 紙箱 100 個\n```\n"
DOC_V2 = "潤好了，把數量改成 200。\n\n```doc\n# 報價單\n\n- 紙箱 200 個\n- 運費另計\n```\n"


def test_doc_flows_between_bots(client, auth, gw_state):
    room = _group(client, auth, policy="none")
    rid = room["id"]
    gw_state.scenario = "canned"
    gw_state.canned_text = DOC_V1
    _say(client, auth, rid, "@researcher 做一份報價單")
    _wait_idle(client)
    ms = _msgs(client, auth, rid)
    made = next(m for m in ms if m["sender_name"] == "researcher")
    card = next(a for a in made["attachments"] if a["type"] == "doc")
    assert card["title"] == "報價單" and card["version"] == 1 and card["action"] == "created"
    assert "```doc" not in made["content"] and made["doc_id"] == card["doc_id"]
    docs = client.get(f"/groupchat/rooms/{rid}/docs", headers=auth).json()
    assert [d["title"] for d in docs] == ["報價單"]

    # 不點卡片、直接 @ 另一個 Bot：最近流過的文件自動帶上 → 產生 v2
    gw_state.canned_text = DOC_V2
    _say(client, auth, rid, "@writer 幫我潤稿")
    _wait_idle(client)
    run_inputs = [r["body"] for r in gw_state.runs.values() if r["profile"] == "writer"]
    assert "紙箱 100 個" in run_inputs[-1]["instructions"]  # writer 看得到文件全文
    ms = _msgs(client, auth, rid)
    edited = [m for m in ms if m["sender_name"] == "writer"][-1]
    card2 = next(a for a in edited["attachments"] if a["type"] == "doc")
    assert card2["doc_id"] == card["doc_id"] and card2["version"] == 2 and card2["author"] == "writer"
    assert card2["action"] == "updated"
    v = client.get(f"/docs/{card['doc_id']}/versions", headers=auth).json()
    assert [x["version"] for x in v][-1] == 2 or [x["version"] for x in v][0] == 2

    # 人在面板改：v3，貼一張 edited 卡，不觸發 Bot
    n_runs = len(gw_state.runs)
    r = client.post(f"/groupchat/rooms/{rid}/docs/{card['doc_id']}/versions",
                    json={"content": "# 報價單\n\n- 紙箱 300 個\n"}, headers=auth)
    assert r.status_code == 201, r.text
    assert r.json()["version"] == 3
    _wait_idle(client)
    assert len(gw_state.runs) == n_runs
    last = _msgs(client, auth, rid)[-1]
    assert last["attachments"][0]["action"] == "edited" and last["attachments"][0]["version"] == 3


def test_reply_to_doc_card_targets_that_doc(client, auth, gw_state):
    room = _group(client, auth, policy="none")
    rid = room["id"]
    gw_state.scenario = "canned"
    gw_state.canned_text = DOC_V1
    _say(client, auth, rid, "@researcher 做一份報價單")
    _wait_idle(client)
    made = next(m for m in _msgs(client, auth, rid) if m["sender_name"] == "researcher")
    gw_state.canned_text = "收到，這份我覺得 OK"
    for _ in range(4):  # 把文件擠出「最近幾則」視窗
        _say(client, auth, rid, "閒聊")
    _say(client, auth, rid, "@writer 看一下這份", reply_to_id=made["id"])
    _wait_idle(client)
    body = [r["body"] for r in gw_state.runs.values() if r["profile"] == "writer"][-1]
    assert "紙箱 100 個" in body["instructions"] and "回覆 researcher" in body["input"]
    q = [m for m in _msgs(client, auth, rid) if m["reply_to_id"] == made["id"]][0]
    assert q["reply_to"]["sender_name"] == "researcher" and q["reply_to"]["has_doc"] is True


# -- threads / reactions ----------------------------------------------------------------
def test_thread_scope_and_counts(client, auth):
    room = _group(client, auth, policy="none")
    rid = room["id"]
    root = _say(client, auth, rid, "主題 A")
    _say(client, auth, rid, "@researcher 串裡回答", thread_root_id=root["id"])
    _wait_idle(client)
    main = _msgs(client, auth, rid, scope="main")
    assert [m["content"] for m in main] == ["主題 A"]
    assert main[0]["reply_count"] == 2  # 人＋Bot
    thread = _msgs(client, auth, rid, scope="thread", thread=root["id"])
    assert [m["sender_kind"] for m in thread] == ["human", "human", "ai"]
    assert all(m["thread_root_id"] == root["id"] for m in thread[1:])
    # 串裡不能再開串
    r = client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "x", "thread_root_id": thread[1]["id"]}, headers=auth)
    assert r.status_code == 400


def test_reaction_toggle(client, auth):
    room = _group(client, auth, policy="none")
    m = _say(client, auth, room["id"], "按讚測試")
    url = f"/groupchat/rooms/{room['id']}/messages/{m['id']}/reactions"
    r = client.post(url, json={"emoji": "👍"}, headers=auth).json()
    assert r["reactions"] == [{"emoji": "👍", "count": 1, "mine": True, "names": ["admin"]}]
    assert _msgs(client, auth, room["id"])[0]["reactions"][0]["count"] == 1
    r = client.post(url, json={"emoji": "👍"}, headers=auth).json()
    assert r["reactions"] == []


# -- approval / stop / tools -------------------------------------------------------------------
def test_approval_card_allow_once(client, auth, gw_state):
    gw_state.scenario = "approval"
    ags = _agents(client, auth)
    dm = client.post("/groupchat/dm", json={"agent_id": ags["researcher"]}, headers=auth).json()
    _say(client, auth, dm["id"], "清掉暫存")
    card_msg = None
    for _ in range(200):
        card_msg = next((m for m in _msgs(client, auth, dm["id"]) if any(a["type"] == "approval" for a in m["attachments"])), None)
        if card_msg:
            break
        time.sleep(0.02)
    assert card_msg, "沒有出現核准卡"
    card = card_msg["attachments"][0]
    assert card["command"] == "rm -rf x" and card["status"] == "pending"
    r = client.post(f"/groupchat/rooms/{dm['id']}/messages/{card_msg['id']}/approval", json={"choice": "once"}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["attachments"][0]["status"] == "once"
    _wait_idle(client)
    assert gw_state.approvals and gw_state.approvals[0][1] == "once"
    final = _msgs(client, auth, dm["id"])[-1]
    tools = next(a for a in final["attachments"] if a["type"] == "tools")
    assert tools["items"][0]["tool"] == "terminal" and tools["items"][0]["status"] == "done"


def test_stop_room_stops_running_runs(client, auth, gw_state):
    gw_state.scenario = "approval"  # 會卡在等核准，方便在跑的時候按停止
    ags = _agents(client, auth)
    dm = client.post("/groupchat/dm", json={"agent_id": ags["writer"]}, headers=auth).json()
    _say(client, auth, dm["id"], "做很久的事")
    orch = client.app.state.groupchat
    for _ in range(200):
        if orch.active.get(dm["id"]):
            break
        time.sleep(0.02)
    r = client.post(f"/groupchat/rooms/{dm['id']}/stop", headers=auth)
    assert r.json()["stopped"] == 1
    assert gw_state.stopped
    _wait_idle(client)


# -- bots CRUD ---------------------------------------------------------------------------------
def _fake_profile_create(client, hermes_home):
    cli = client.app.state.cli

    async def _run(*args, timeout=30.0):
        assert args[:2] == ("profile", "create")
        name = args[2]
        src = args[args.index("--clone-from") + 1]
        d = hermes_home / "profiles" / name
        src_dir = hermes_home if src == "default" else hermes_home / "profiles" / src
        d.mkdir(parents=True)
        shutil.copy(src_dir / "config.yaml", d / "config.yaml")
        return ""
    cli._run = _run


def test_create_duplicate_delete_bot(client, auth, hermes_home):
    _fake_profile_create(client, hermes_home)
    r = client.post("/groupchat/bots", json={"name": "市場研究員", "title": "競品研究",
                                             "description": "只用公開來源\n每個重點附連結", "avatar": "blob:3|#8b5cf6"},
                    headers=auth)
    assert r.status_code == 201, r.text
    bot, room = r.json()["bot"], r.json()["room"]
    assert bot["enabled"] is True and room["kind"] == "dm"
    bot = _wait_setup(client, auth, bot["id"])
    assert bot["profile"].startswith("bot")
    soul = (hermes_home / "profiles" / bot["profile"] / "SOUL.md").read_text()
    assert "市場研究員" in soul and "只用公開來源" in soul
    # 改資料 → SOUL 與私訊房名同步
    r = client.patch(f"/groupchat/bots/{bot['id']}", json={"name": "研究員小美", "description": "只看台灣市場"}, headers=auth)
    assert r.json()["name"] == "研究員小美"
    assert client.get(f"/groupchat/rooms/{room['id']}", headers=auth).json()["name"] == "研究員小美"
    assert "只看台灣市場" in (hermes_home / "profiles" / bot["profile"] / "SOUL.md").read_text()
    _wait_setup(client, auth, bot["id"])
    # 私訊裡 Bot 帶著長期規則回話
    _say(client, auth, room["id"], "你好")
    _wait_idle(client)
    # 複製：新 profile、新私訊、不帶對話
    r = client.post(f"/groupchat/bots/{bot['id']}/duplicate", headers=auth)
    assert r.status_code == 201, r.text
    dup = r.json()
    assert dup["bot"]["name"] == "研究員小美 副本"
    assert _wait_setup(client, auth, dup["bot"]["id"])["profile"] not in ("", bot["profile"])
    assert _msgs(client, auth, dup["room"]["id"]) == []
    # 刪除：私訊房消失、profile 目錄還在
    assert client.delete(f"/groupchat/bots/{bot['id']}", headers=auth).status_code == 204
    assert client.get(f"/groupchat/rooms/{room['id']}", headers=auth).status_code == 404
    assert (hermes_home / "profiles" / bot["profile"]).is_dir()


def test_search_rooms_messages_docs(client, auth, gw_state):
    room = _group(client, auth, policy="none")
    gw_state.scenario = "canned"
    gw_state.canned_text = DOC_V1
    _say(client, auth, room["id"], "@researcher 報價單拜託")
    _wait_idle(client)
    res = client.get("/groupchat/search", params={"q": "報價"}, headers=auth).json()
    assert res["messages"] and res["docs"][0]["title"] == "報價單"
    res = client.get("/groupchat/search", params={"q": "專案"}, headers=auth).json()
    assert res["rooms"][0]["name"] == "專案群"


def test_profile_create_failure_retries_and_never_leaves_partial(client, auth, hermes_home, monkeypatch):
    """Hermes clone 在 skills 裡碰到 socket 會 exit 1 並留下半成品 → 清掉、改用跳過 socket 的方式重跑；再失敗也不留東西。"""
    from studio.hermes.cli import CliError
    from studio.modules.groupchat import bots_api
    cli = client.app.state.cli
    made: list[str] = []

    async def _half_then_fail(*args, timeout=30.0):
        d = hermes_home / "profiles" / args[2]
        (d / "skills").mkdir(parents=True)
        (d / ".env").write_text("SECRET=copied\n")
        made.append(args[2])
        raise CliError("shutil.Error: Operation not supported on socket")
    cli._run = _half_then_fail

    async def _safe_ok(c, args, timeout=120.0):
        d = hermes_home / "profiles" / args[2]
        assert not d.exists(), "重試前要先清掉半成品"
        d.mkdir(parents=True)
        (d / "config.yaml").write_text("model:\n  default: gpt-default\n")
    monkeypatch.setattr(bots_api, "_socket_safe_create", _safe_ok)
    r = client.post("/groupchat/bots", json={"name": "研究員"}, headers=auth)
    assert r.status_code == 201, r.text
    assert r.json()["bot"]["setup_state"] == "preparing" and r.json()["bot"]["profile"] == ""
    _wait_setup(client, auth, r.json()["bot"]["id"])
    assert made[0].startswith("bot-")

    # 踩過一次之後就直接走退路，不再浪費時間跑注定失敗的官方指令
    tried: list[str] = []

    async def _safe_fail(c, args, timeout=120.0):
        tried.append(args[2])
        (hermes_home / "profiles" / args[2]).mkdir(parents=True)
        raise CliError("still broken")
    monkeypatch.setattr(bots_api, "_socket_safe_create", _safe_fail)
    n_fast = len(made)
    r = client.post("/groupchat/bots", json={"name": "文案"}, headers=auth)
    assert r.status_code == 201  # Bot 先建起來，設定檔在背景失敗
    bot = _wait_setup(client, auth, r.json()["bot"]["id"], want="failed")
    assert "沒有留下任何半成品" in bot["setup_error"]
    assert len(made) == n_fast, "第二次不該再打官方指令"
    assert tried and not (hermes_home / "profiles" / tried[-1]).exists()


def test_system_events_on_rename_and_members(client, auth):
    ags = _agents(client, auth)
    room = _group(client, auth, policy="none")
    rid = room["id"]
    client.patch(f"/groupchat/rooms/{rid}", json={"name": "改名後"}, headers=auth)
    researcher_rm = next(m for m in room["members"] if m["display_name"] == "researcher")
    client.delete(f"/groupchat/rooms/{rid}/members/{researcher_rm['id']}", headers=auth)
    client.post(f"/groupchat/rooms/{rid}/members", json={"agent_id": ags["researcher"]}, headers=auth)
    sys_msgs = [m["content"] for m in _msgs(client, auth, rid) if m["sender_kind"] == "system"]
    assert sys_msgs == ["admin 把群組改名為「改名後」", "admin 把 researcher 移出群組", "admin 把 researcher 加進群組"]
    _wait_idle(client)
    assert not [m for m in _msgs(client, auth, rid) if m["sender_kind"] == "ai"], "系統事件不能觸發 Bot"


def test_post_returns_quote_preview_and_doc_gist(client, auth, gw_state):
    room = _group(client, auth, policy="none")
    rid = room["id"]
    gw_state.scenario = "canned"
    gw_state.canned_text = "```doc\n# 採購清單\n\n- 紙箱 100 個\n```\n"  # 圍欄外沒有說明
    _say(client, auth, rid, "@researcher 列清單")
    _wait_idle(client)
    made = next(m for m in _msgs(client, auth, rid) if m["sender_name"] == "researcher")
    card = next(a for a in made["attachments"] if a["type"] == "doc")
    assert card["summary"] == "紙箱 100 個"  # 取文件第一行正文，不是「建立文件」
    sent = _say(client, auth, rid, "好", reply_to_id=made["id"])
    assert sent["reply_to"]["sender_name"] == "researcher" and sent["reply_to"]["has_doc"] is True


def test_new_profile_not_served_yet_falls_back_to_default(client, auth, gw_state):
    """新建的 Bot：gateway 還沒服務它的 profile（404）→ 這一輪借 default 跑，回覆照常出現。"""
    ags = _agents(client, auth)
    gw_state.unserved.add("writer")
    dm = client.post("/groupchat/dm", json={"agent_id": ags["writer"]}, headers=auth).json()
    _say(client, auth, dm["id"], "你好")
    _wait_idle(client)
    ai = [m for m in _msgs(client, auth, dm["id"]) if m["sender_kind"] == "ai"]
    assert ai and ai[0]["status"] == "done" and "echo[default" in ai[0]["content"]


def test_create_bot_registers_profile_in_gateway_allowlist(client, auth, hermes_home, gw_state, monkeypatch):
    """建 Bot 會把新設定檔加進 gateway 服務名單；名單只在 gateway 啟動時讀，所以回傳要說「要重啟」。"""
    from studio.modules.groupchat import bots_api
    cfg = hermes_home / "config.yaml"
    cfg.write_text("model:\n  default: gpt-default\ngateway:\n  multiplex_profiles: true\n"
                   "  multiplex_profile_allowlist:\n    - default\n    - researcher\n", encoding="utf-8")

    async def _run(*args, timeout=30.0):
        d = hermes_home / "profiles" / args[2]
        d.mkdir(parents=True)
        (d / "config.yaml").write_text("model:\n  default: gpt-default\n")
    client.app.state.cli._run = _run
    monkeypatch.setattr(bots_api, "_socket_safe_create", lambda *a, **k: None)
    r = client.post("/groupchat/bots", json={"name": "研究員"}, headers=auth)
    assert r.status_code == 201, r.text
    assert r.json()["gateway"]["status"] == "preparing" and r.json()["bot"]["served"] is False
    slug = _wait_setup(client, auth, r.json()["bot"]["id"])["profile"]
    import yaml
    assert yaml.safe_load(cfg.read_text(encoding="utf-8"))["gateway"]["multiplex_profile_allowlist"] == ["default", "researcher", slug]
    assert len(list(hermes_home.glob("config.yaml.bak-*"))) == 1
    # 清單的 served 是問 gateway 拿的（加名單≠已生效）：模擬 gateway 還沒重啟
    from studio.hermes import allowlist as AL
    assert AL.is_served(yaml.safe_load(cfg.read_text(encoding="utf-8")), slug), "設定上已經允許"
    client.app.state.__dict__.get("bot_served_cache", {}).clear()
    gw_state.unserved.add(slug)
    bots = {b["profile"]: b for b in client.get("/groupchat/bots", headers=auth).json()}
    assert bots["researcher"]["served"] is True and bots[slug]["served"] is False


def test_github_account_per_bot(client, auth, tmp_path, monkeypatch):
    """一個 Bot 一個 gh 設定目錄：建目錄與包裝指令、回登入指令、檢查後記住帳號、角色設定帶上用哪個 gh。"""
    from studio.modules.groupchat import github_link as GH
    from studio.modules.groupchat.service import Orchestrator
    monkeypatch.setattr(GH, "ROOT", tmp_path / "gh-accounts")
    monkeypatch.setattr(GH, "_which", lambda name: f"/usr/bin/{name}")
    states = {"logged_in": False}

    async def fake_status(dir_path):
        if dir_path and states["logged_in"]:
            return {"ready": True, "host": "github.com", "account": "second-account", "message": ""}
        if dir_path:
            return {"ready": False, "account": "", "host": "", "message": "還沒登入。"}
        return {"ready": True, "host": "github.com", "account": "main-account", "message": ""}
    monkeypatch.setattr(GH, "status", fake_status)

    ags = _agents(client, auth)
    aid = ags["researcher"]
    r = client.get(f"/groupchat/bots/{aid}/github", headers=auth).json()
    assert r["mode"] == "shared" and r["shared_account"] == "main-account"

    r = client.post(f"/groupchat/bots/{aid}/github", headers=auth).json()
    d = Path(r["dir"])
    assert d.is_dir() and (d / "bin" / "gh").exists() and (d / "bin" / "git").exists()
    assert (d / "bin" / "gh").read_text().count("GH_CONFIG_DIR") == 1
    assert r["login_cmd"].startswith('GH_CONFIG_DIR=') and r["ready"] is False

    assert client.post(f"/groupchat/bots/{aid}/github/check", headers=auth).json()["ready"] is False
    states["logged_in"] = True
    chk = client.post(f"/groupchat/bots/{aid}/github/check", headers=auth).json()
    assert chk["ready"] is True and chk["account"] == "second-account"
    bots = {b["id"]: b for b in client.get("/groupchat/bots", headers=auth).json()}
    assert bots[aid]["gh_account"] == "second-account" and bots[aid]["gh_dir"] == str(d)

    # 角色設定要告訴 Bot 用哪個 gh
    orch: Orchestrator = client.app.state.groupchat
    room = _group(client, auth, policy="none")
    _, members = orch._load(room["id"])
    prompt = next(m.system_prompt for m in members if m.display_name == "researcher")
    assert str(d / "bin") in prompt and "second-account" in prompt

    # 改回共用：目錄留著
    back = client.delete(f"/groupchat/bots/{aid}/github", headers=auth).json()
    assert back["mode"] == "shared" and Path(back["kept_dir"]).is_dir()
    assert client.get(f"/groupchat/bots/{aid}/github", headers=auth).json()["mode"] == "shared"
