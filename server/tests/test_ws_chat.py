import json


def _mk_session(client, auth, profile="default"):
    aid = next(a["id"] for a in client.get("/agents", headers=auth).json() if a["profile"] == profile)
    return client.post("/sessions", json={"agent_id": aid}, headers=auth).json()["id"]


def _collect(ws, until=("run.completed", "run.failed", "run.cancelled")):
    events = []
    while True:
        ev = json.loads(ws.receive_text())
        events.append(ev)
        if ev["type"] in until:
            return events


def test_ws_requires_token(client):
    from starlette.websockets import WebSocketDisconnect
    import pytest
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/chat?token=bad") as ws:
            ws.receive_text()


def test_ws_run_forwards_events_and_persists(client, auth, token, gw_state):
    sid = _mk_session(client, auth, "researcher")
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "你好"}))
        events = _collect(ws)
    types = [e["type"] for e in events]
    assert types[0] == "run.started" and types[-1] == "run.completed", events
    assert types.count("message.delta") == 2
    assert all(e["session_id"] == sid for e in events)
    run_id = events[0]["run_id"]
    assert all(e["run_id"] == run_id for e in events)
    done = events[-1]
    assert done["output"] == "echo[researcher|h=0]: 你好" and done["usage"]["total_tokens"] == 3
    # profile prefix used
    assert gw_state.runs[run_id]["profile"] == "researcher"
    # persisted
    msgs = client.get(f"/sessions/{sid}/messages", headers=auth).json()
    assert [(m["role"], m["content"]) for m in msgs] == [("user", "你好"), ("assistant", "echo[researcher|h=0]: 你好")]
    assert msgs[1]["run_id"] == run_id


def test_ws_second_turn_carries_history_and_stable_session(client, auth, token, gw_state):
    sid = _mk_session(client, auth)
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "第一句"}))
        e1 = _collect(ws)
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "第二句"}))
        e2 = _collect(ws)
    r1, r2 = gw_state.runs[e1[0]["run_id"]]["body"], gw_state.runs[e2[0]["run_id"]]["body"]
    assert "conversation_history" not in r1
    assert r2["conversation_history"] == [{"role": "user", "content": "第一句"}, {"role": "assistant", "content": "echo[default|h=0]: 第一句"}]
    assert r1["session_id"] == r2["session_id"] and r1["session_id"].startswith("studio_")
    assert e2[-1]["output"].startswith("echo[default|h=2]")


def test_ws_tool_events_and_approval(client, auth, token, gw_state):
    gw_state.scenario = "approval"
    sid = _mk_session(client, auth)
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "刪東西"}))
        events = _collect(ws, until=("approval.request",))
        run_id = events[0]["run_id"]
        appr = events[-1]
        assert appr["command"] == "rm -rf x" and appr["approval_id"] and "choices" in appr["context"]
        assert [e["type"] for e in events][1:3] == ["tool.started", "approval.request"]
        ws.send_text(json.dumps({"type": "approval", "run_id": run_id, "decision": "once"}))
        rest = _collect(ws)
    types = [e["type"] for e in rest]
    assert "approval.ack" in types and types[-1] == "run.completed" and "tool.completed" in types
    assert gw_state.approvals == [(run_id, "once")]
    tool_ev = next(e for e in rest if e["type"] == "tool.completed")
    assert tool_ev["name"] == "terminal"
    msgs = client.get(f"/sessions/{sid}/messages", headers=auth).json()
    assert [m["role"] for m in msgs] == ["user", "tool", "assistant"]
    assert msgs[1]["tool_name"] == "terminal" and msgs[1]["tool_args"] == "ls -la" and msgs[1]["tool_result"]["duration"] == 0.1


def test_ws_stop_steer_and_failure(client, auth, token, gw_state):
    gw_state.scenario = "failed"
    sid = _mk_session(client, auth)
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "x"}))
        events = _collect(ws)
        assert events[-1]["type"] == "run.failed" and events[-1]["error"] == "boom"
        ws.send_text(json.dumps({"type": "stop", "run_id": "run_unknown"}))
        err = json.loads(ws.receive_text())
        assert err["type"] == "error" and err["code"] == "unknown_run"
        ws.send_text(json.dumps({"type": "run", "session_id": "s_nope", "input": "x"}))
        assert json.loads(ws.receive_text())["code"] == "not_found"
        ws.send_text("not json")
        assert json.loads(ws.receive_text())["code"] == "bad_message"
    # failed run: user message stored, no assistant message
    assert [m["role"] for m in client.get(f"/sessions/{sid}/messages", headers=auth).json()] == ["user"]


def test_ws_stop_and_steer_forwarded(client, auth, token, gw_state):
    gw_state.scenario = "approval"  # pauses at approval so the run is still alive
    sid = _mk_session(client, auth)
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "x"}))
        events = _collect(ws, until=("approval.request",))
        run_id = events[0]["run_id"]
        ws.send_text(json.dumps({"type": "steer", "run_id": run_id, "input": "快一點"}))
        assert json.loads(ws.receive_text())["type"] == "steer.ack"
        ws.send_text(json.dumps({"type": "stop", "run_id": run_id}))
        assert json.loads(ws.receive_text())["type"] == "stop.ack"
        ws.send_text(json.dumps({"type": "approval", "run_id": run_id, "decision": "deny"}))
        _collect(ws)
    assert gw_state.steered == [(run_id, "快一點")] and gw_state.stopped == [run_id]


def test_ws_approval_lands_in_inbox_and_chat_decision_resolves_it(client, auth, token, gw_state):
    """危險指令：approval.request 直接落 inbox pending；對話頁決定後 inbox 變 resolved，gateway 只收到一次。"""
    gw_state.scenario = "approval"
    sid = _mk_session(client, auth)
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "刪東西"}))
        events = _collect(ws, until=("approval.request",))
        run_id = events[0]["run_id"]
        appr = events[-1]
        assert appr.get("pending_id", "").startswith("pa_")
        pend = client.get("/inbox/approvals", headers=auth).json()
        assert [x["run_id"] for x in pend] == [run_id] and pend[0]["status"] == "pending" and pend[0]["command"] == "rm -rf x"
        assert client.get("/inbox/count", headers=auth).json()["by_kind"].get("chat_approval") == 1
        ws.send_text(json.dumps({"type": "approval", "run_id": run_id, "decision": "once", "approval_id": appr["approval_id"]}))
        rest = _collect(ws)
    assert "approval.ack" in [e["type"] for e in rest]
    assert gw_state.approvals == [(run_id, "once")]
    done = client.get("/inbox/approvals?status=all", headers=auth).json()
    assert done[0]["status"] == "resolved" and done[0]["decision"] == "once"
    assert client.get("/inbox/approvals", headers=auth).json() == []
    # 對話頁再送一次同一筆 → 不再 forward，只回 already_decided
    with client.websocket_connect(f"/ws/chat?token={token}") as ws2:
        ws2.receive_text()
        ws2.send_text(json.dumps({"type": "approval", "run_id": run_id, "decision": "deny"}))
        err = json.loads(ws2.receive_text())
    assert err["type"] == "error" and err["code"] == "unknown_run"  # run 已結束，這條 WS 也不持有它
    assert gw_state.approvals == [(run_id, "once")]


def test_ws_approval_decided_from_inbox_forwards_once_and_notifies_chat(client, auth, token, gw_state):
    """在收件匣決定：inbox 代呼 gateway（一次），對話 WS 收到 approval.responded；對話頁之後再按只得到 already_decided。"""
    gw_state.scenario = "approval"
    sid = _mk_session(client, auth)
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "刪東西"}))
        events = _collect(ws, until=("approval.request",))
        run_id = events[0]["run_id"]
        pid = events[-1]["pending_id"]
        r = client.post(f"/inbox/approvals/{pid}/resolve", json={"decision": "session"}, headers=auth)
        assert r.status_code == 200 and r.json()["forwarded"] is True
        rest = _collect(ws, until=("approval.responded",))
        assert rest[-1]["run_id"] == run_id and rest[-1]["decision"] == "session" and rest[-1]["via"] == "inbox"
        # 使用者在對話頁也按了 → 不可以再 forward
        ws.send_text(json.dumps({"type": "approval", "run_id": run_id, "decision": "deny", "approval_id": events[-1]["approval_id"]}))
        got = _collect(ws, until=("approval.ack",))
        assert got[-1]["already_decided"] is True and got[-1]["decision"] == "session"
        _collect(ws)
    assert gw_state.approvals == [(run_id, "session")]
    assert client.get("/inbox/approvals", headers=auth).json() == []


def test_ws_subagent_events_forwarded_and_persisted(client, auth, token, gw_state):
    """背景委派：gateway 的 subagent.start/complete 原樣轉發到 WS，complete 落庫成 tool 訊息（name=subagent）。"""
    gw_state.scenario = "subagent"
    sid = _mk_session(client, auth)
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": sid, "input": "去查"}))
        events = _collect(ws)
    types = [e["type"] for e in events]
    assert types[1:5] == ["tool.started", "subagent.start", "subagent.complete", "tool.completed"]
    st = next(e for e in events if e["type"] == "subagent.start")
    done = next(e for e in events if e["type"] == "subagent.complete")
    assert st["goal"] == "查資料" and st["subagent_id"] == "sa_1" and st["session_id"] == sid
    assert done["status"] == "completed" and done["summary"] == "找到 3 筆" and done["output_tokens"] == 5
    msgs = client.get(f"/sessions/{sid}/messages", headers=auth).json()
    sub = [m for m in msgs if m["role"] == "tool" and m["tool_name"] == "subagent"]
    assert len(sub) == 1 and sub[0]["tool_args"]["goal"] == "查資料" and sub[0]["tool_result"]["summary"] == "找到 3 筆"
