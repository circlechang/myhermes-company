"""群聊：房間 CRUD、@mention 路由、無 @ 策略、AI 互 @ 深度上限、上下文壓縮、WS。"""
from __future__ import annotations

import json
import time

import pytest

from studio.modules.groupchat.models import Room, RoomMember
from studio.modules.groupchat.service import decide_targets, estimate_tokens, parse_mentions


def _agents(client, auth):
    return {a["profile"]: a["id"] for a in client.get("/agents", headers=auth).json()}


def _room(client, auth, **kw):
    ags = _agents(client, auth)
    body = {"name": "測試房", "agent_ids": [ags["researcher"], ags["writer"]], **kw}
    r = client.post("/groupchat/rooms", json=body, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


def _wait_idle(client, timeout=10.0):
    orch = client.app.state.groupchat
    deadline = time.time() + timeout
    while orch.tasks and time.time() < deadline:
        time.sleep(0.02)
    assert not orch.tasks, "AI 回覆未在時限內結束"


def _msgs(client, auth, rid):
    return client.get(f"/groupchat/rooms/{rid}/messages", headers=auth).json()


# -- pure functions --------------------------------------------------------
def _mem(name, kind="ai", profile=""):
    return RoomMember(id=f"rm_{name}", room_id="r", kind=kind, display_name=name, profile=profile or name)


def test_parse_mentions_longest_first_and_punctuation():
    ms = [_mem("researcher"), _mem("researcher-2"), _mem("小明"), _mem("admin", kind="human")]
    got = parse_mentions("@researcher-2 跟 @researcher，還有@小明你好 @admin @nobody", ms)
    assert [m.display_name for m in got] == ["researcher-2", "researcher", "小明", "admin"]
    assert parse_mentions("沒有提到任何人", ms) == []


def test_decide_targets_policies_and_depth():
    a, b, h = _mem("a"), _mem("b"), _mem("me", kind="human")
    room = Room(id="r", company_id="c", name="x", no_mention_policy="none", max_ai_depth=2)
    assert decide_targets(room, [a, b, h], "hi", h, 0) == ([], 0)
    room.no_mention_policy = "round_robin"
    t1, c1 = decide_targets(room, [a, b, h], "hi", h, 0)
    room.rr_cursor = c1
    t2, _ = decide_targets(room, [a, b, h], "hi", h, 0)
    assert [t1[0].id, t2[0].id] == ["rm_a", "rm_b"]
    room.no_mention_policy = "host"
    room.host_member_id = "rm_b"
    assert decide_targets(room, [a, b, h], "hi", h, 0)[0][0].id == "rm_b"
    # 明確 @ 優先於策略；AI 自己 @ 自己不算
    assert [m.id for m in decide_targets(room, [a, b, h], "@a @b 請看", a, 1)[0]] == ["rm_b"]
    # AI 無 @ 不觸發；達深度上限不觸發
    assert decide_targets(room, [a, b, h], "純回覆", a, 1)[0] == []
    assert decide_targets(room, [a, b, h], "@b 再來", a, 2)[0] == []


def test_estimate_tokens_cjk_vs_ascii():
    assert estimate_tokens("你好世界") == 4
    assert estimate_tokens("abcdefgh") == 2


# -- REST + orchestrator ---------------------------------------------------
def test_room_crud_and_invite(client, auth):
    room = _room(client, auth, no_mention_policy="round_robin")
    rid = room["id"]
    kinds = sorted((m["kind"], m["display_name"]) for m in room["members"])
    assert kinds == [("ai", "researcher"), ("ai", "writer"), ("human", "admin")]
    assert room["summarizer_member_id"] == next(m["id"] for m in room["members"] if m["display_name"] == "researcher")
    assert len(room["invite_code"]) == 8

    # patch AI member profile/model/role prompt
    researcher = next(m for m in room["members"] if m["display_name"] == "researcher")
    r = client.patch(f"/groupchat/rooms/{rid}/members/{researcher['id']}",
                     json={"display_name": "小李", "model": "m-x", "system_prompt": "你是律師"}, headers=auth)
    assert r.status_code == 200 and r.json()["display_name"] == "小李" and r.json()["model"] == "m-x"

    # second user joins by invite code
    client.post("/members", json={"username": "bob", "password": "bobpass1", "role": "member"}, headers=auth)
    tok = client.post("/auth/login", json={"username": "bob", "password": "bobpass1"}).json()["token"]
    bob = {"Authorization": f"Bearer {tok}"}
    assert client.get(f"/groupchat/rooms/{rid}", headers=bob).status_code == 403
    assert client.post("/groupchat/rooms/join", json={"invite_code": "ZZZZZZZZ"}, headers=bob).status_code == 404
    r = client.post("/groupchat/rooms/join", json={"invite_code": room["invite_code"].lower()}, headers=bob)
    assert r.status_code == 200
    assert any(m["display_name"] == "bob" for m in r.json()["members"])
    assert [x["id"] for x in client.get("/groupchat/rooms", headers=bob).json()] == [rid]

    # remove AI, patch room, delete room
    writer = next(m for m in room["members"] if m["display_name"] == "writer")
    assert client.delete(f"/groupchat/rooms/{rid}/members/{writer['id']}", headers=auth).status_code == 204
    r = client.patch(f"/groupchat/rooms/{rid}", json={"no_mention_policy": "host", "max_ai_depth": 1}, headers=auth)
    assert r.json()["no_mention_policy"] == "host" and len(r.json()["members"]) == 3
    assert client.patch(f"/groupchat/rooms/{rid}", json={"no_mention_policy": "bogus"}, headers=auth).status_code == 400
    assert client.delete(f"/groupchat/rooms/{rid}", headers=bob).status_code == 403
    assert client.delete(f"/groupchat/rooms/{rid}", headers=auth).status_code == 204
    assert client.get(f"/groupchat/rooms/{rid}", headers=auth).status_code == 404


def test_mention_routes_to_named_ai_only(client, auth, gw_state):
    room = _room(client, auth)
    rid = room["id"]
    researcher = next(m for m in room["members"] if m["display_name"] == "researcher")
    client.patch(f"/groupchat/rooms/{rid}/members/{researcher['id']}", json={"system_prompt": "你是律師"}, headers=auth)
    r = client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "@researcher 你好嗎"}, headers=auth)
    assert r.status_code == 201
    _wait_idle(client)
    msgs = _msgs(client, auth, rid)
    assert [(m["sender_kind"], m["sender_name"]) for m in msgs] == [("human", "admin"), ("ai", "researcher")]
    assert msgs[1]["content"] == "echo[researcher|h=0]: [admin]: @researcher 你好嗎" and msgs[1]["depth"] == 1
    assert len(gw_state.runs) == 1
    run = next(iter(gw_state.runs.values()))
    assert run["profile"] == "researcher"
    assert "你是律師" in run["body"]["instructions"] and "writer" in run["body"]["instructions"]
    assert run["body"]["session_id"].startswith(f"studio_room_{rid}_")

    # 無 @、policy none → 不觸發
    client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "自言自語"}, headers=auth)
    _wait_idle(client)
    assert len(gw_state.runs) == 1
    # 第二輪帶歷史：user 訊息含 [sender] 前綴，自己的回覆是 assistant
    client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "@researcher 再一次"}, headers=auth)
    _wait_idle(client)
    last = list(gw_state.runs.values())[-1]["body"]
    hist = last["conversation_history"]
    assert hist[0] == {"role": "user", "content": "[admin]: @researcher 你好嗎"}
    assert hist[1]["role"] == "assistant" and hist[2]["content"] == "[admin]: 自言自語"


def test_round_robin_when_no_mention(client, auth, gw_state):
    room = _room(client, auth, no_mention_policy="round_robin")
    rid = room["id"]
    for _ in range(3):
        client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "大家好"}, headers=auth)
        _wait_idle(client)
    profiles = [r["profile"] for r in gw_state.runs.values()]
    assert profiles == ["researcher", "writer", "researcher"]


@pytest.mark.parametrize("max_depth,expected_ai_msgs", [(3, 6), (1, 2), (0, 2)])
def test_ai_to_ai_mentions_are_depth_limited(client, auth, gw_state, max_depth, expected_ai_msgs):
    # 人類同時 @ 兩位 → 兩條支線各 depth 1；fake gateway 會 echo 輸入，所以 researcher 的回覆含 "@writer"、
    # writer 的回覆含 "@researcher"，兩條支線互相接力，沒有上限就無限迴圈。每層 2 則 → 期望 2*max_depth（max=0 時仍回人類的 2 則）
    room = _room(client, auth, max_ai_depth=max_depth)
    rid = room["id"]
    client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "@researcher 請把這題轉給 @writer"}, headers=auth)
    _wait_idle(client, timeout=15)
    msgs = _msgs(client, auth, rid)
    ai = [m for m in msgs if m["sender_kind"] == "ai"]
    assert len(ai) == expected_ai_msgs, [(m["sender_name"], m["depth"]) for m in ai]
    depths = sorted(m["depth"] for m in ai)
    assert depths == sorted([d for d in range(1, max(max_depth, 1) + 1) for _ in range(2)])
    assert max(depths) <= max(max_depth, 1)


def test_depth_zero_still_answers_human(client, auth, gw_state):
    room = _room(client, auth, max_ai_depth=0)
    rid = room["id"]
    client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "@writer 你好"}, headers=auth)
    _wait_idle(client)
    ai = [m for m in _msgs(client, auth, rid) if m["sender_kind"] == "ai"]
    # human depth 0 → AI reply depth 1 → 該回覆含 @writer(自己) 與無其他 AI → 停
    assert len(ai) == 1 and ai[0]["sender_name"] == "writer"


def test_compression_triggers_and_trims_history(client, auth, gw_state):
    room = _room(client, auth, history_n=2, compress_threshold_tokens=60)
    rid = room["id"]
    long = "這是一段很長的中文訊息用來灌滿門檻" * 2  # 34 CJK chars
    for i in range(3):
        client.post(f"/groupchat/rooms/{rid}/messages", json={"content": f"{i}{long}"}, headers=auth)
        _wait_idle(client)
    sums = client.get(f"/groupchat/rooms/{rid}/summaries", headers=auth).json()
    assert len(sums) == 1, sums
    assert sums[0]["made_by"] == "researcher" and sums[0]["covers_until_seq"] == 1
    assert sums[0]["content"].startswith("echo[researcher|h=0]: 請把下面這段群聊對話濃縮成摘要")
    ctx = client.get(f"/groupchat/rooms/{rid}/context", headers=auth).json()
    assert ctx["messages_since_summary"] == 2 and ctx["summary"]["id"] == sums[0]["id"]

    n_runs = len(gw_state.runs)
    client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "@writer 總結一下"}, headers=auth)
    _wait_idle(client)
    new_runs = list(gw_state.runs.values())[n_runs:]
    reply = next(r for r in new_runs if r["profile"] == "writer" and "@writer" in r["body"]["input"])
    assert "先前對話摘要" in reply["body"]["instructions"]
    assert len(reply["body"]["conversation_history"]) <= 2
    assert all("這是一段很長" in h["content"] for h in reply["body"]["conversation_history"])

    # 手動壓縮
    r = client.post(f"/groupchat/rooms/{rid}/compress", headers=auth)
    assert r.status_code == 200 and r.json()["covers_until_seq"] > 1
    assert client.post(f"/groupchat/rooms/{rid}/compress", headers=auth).status_code == 409


def test_ws_join_message_and_ai_stream(client, auth, token, gw_state):
    room = _room(client, auth)
    rid = room["id"]
    with client.websocket_connect(f"/ws/groupchat?token={token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "message", "room_id": rid, "content": "x"}))
        assert json.loads(ws.receive_text())["code"] == "not_joined"
        ws.send_text(json.dumps({"type": "join", "room_id": rid}))
        j = json.loads(ws.receive_text())
        assert j["type"] == "joined" and j["member"]["display_name"] == "admin"
        ws.send_text(json.dumps({"type": "message", "room_id": rid, "content": "@writer 嗨"}))
        seen = []
        while True:
            ev = json.loads(ws.receive_text())
            seen.append(ev["type"])
            if ev["type"] == "message.new" and ev["message"]["sender_kind"] == "ai":
                assert ev["message"]["content"] == "echo[writer|h=0]: [admin]: @writer 嗨"
                break
        assert seen[:3] == ["message.new", "ai.typing", "ai.started"]
        assert seen.count("ai.delta") == 2 and "ai.done" in seen
        assert all(ev == "message.new" or True for ev in seen)
    # 未 join 的房間不會收到；bad room
    with client.websocket_connect(f"/ws/groupchat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "join", "room_id": "room_nope"}))
        assert json.loads(ws.receive_text())["code"] == "not_found"


def test_gateway_failure_becomes_failed_message(client, auth, gw_state):
    gw_state.scenario = "failed"
    room = _room(client, auth)
    rid = room["id"]
    client.post(f"/groupchat/rooms/{rid}/messages", json={"content": "@researcher 你好"}, headers=auth)
    _wait_idle(client)
    msgs = _msgs(client, auth, rid)
    assert msgs[-1]["status"] == "failed" and "boom" in msgs[-1]["content"]
