"""notify 模組：偏好 CRUD／管理者關卡、emit 三種訊息格式、去重、停用、安靜時段、閘門整合（engine → LINE）。
LINE 推播一律 monkeypatch 成記錄器，測試不打外網。"""
from __future__ import annotations

import time
from datetime import datetime

import pytest

from studio.modules import notify
from tests.test_workflow_engine import agent_id, edge, hnode, make, run, wait


def _company(client, auth) -> str:
    return client.get("/auth/me", headers=auth).json()["company_id"]


def _member_auth(client, auth, role="member") -> dict[str, str]:
    r = client.post("/members", json={"username": f"u_{role}", "password": "pass1234", "role": role}, headers=auth)
    assert r.status_code == 201, r.text
    tok = client.post("/auth/login", json={"username": f"u_{role}", "password": "pass1234"}).json()["token"]
    return {"Authorization": f"Bearer {tok}"}


@pytest.fixture
def sent(monkeypatch) -> list[tuple[str, str]]:
    """把 push_line 換成記錄器：(to, text)。"""
    box: list[tuple[str, str]] = []

    def fake(to: str, text: str) -> bool:
        box.append((to, text))
        return True

    monkeypatch.setattr(notify, "push_line", fake)
    return box


def _enable(client, auth, **over):
    body = {"enabled": True, "line_to": "Uboss", "public_url": "https://studio.example.com/", **over}
    r = client.put("/notify/prefs", json=body, headers=auth)
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------- prefs
def test_prefs_defaults_and_crud(client, auth):
    d = client.get("/notify/prefs", headers=auth).json()
    assert d["enabled"] is False and d["line_to"] == "" and d["on_waiting"] and d["on_failed"] and d["on_chat_approval"]
    # 啟用但沒填對象 → 擋
    assert client.put("/notify/prefs", json={"enabled": True}, headers=auth).status_code == 400
    # 網址／安靜時段格式
    assert client.put("/notify/prefs", json={"public_url": "studio.example.com"}, headers=auth).status_code == 400
    assert client.put("/notify/prefs", json={"quiet_hours": "23:00-07:00"}, headers=auth).status_code == 400
    d = _enable(client, auth, quiet_hours="23-07", on_failed=False)
    assert d["enabled"] is True and d["line_to"] == "Uboss" and d["public_url"] == "https://studio.example.com"  # 尾斜線被拿掉
    assert d["quiet_hours"] == "23-07" and d["on_failed"] is False and d["on_waiting"] is True
    # 部分更新不會把其他欄位洗掉
    d = client.put("/notify/prefs", json={"on_failed": True}, headers=auth).json()
    assert d["on_failed"] is True and d["line_to"] == "Uboss" and d["enabled"] is True
    assert client.get("/notify/prefs", headers=auth).json()["line_to"] == "Uboss"


def test_prefs_admin_gate_and_status(client, auth):
    member = _member_auth(client, auth, "member")
    assert client.get("/notify/prefs", headers=member).status_code == 200  # 看得到
    assert client.put("/notify/prefs", json={"line_to": "x"}, headers=member).status_code == 403
    assert client.post("/notify/test", json={}, headers=member).status_code == 403
    admin = _member_auth(client, auth, "admin")
    assert client.put("/notify/prefs", json={"line_to": "Uadmin"}, headers=admin).status_code == 200
    # 測試用 hermes_home 沒有 .env → LINE 未設定；回 bool 而已，絕不吐 token
    st = client.get("/notify/status", headers=member).json()
    assert st == {"line_configured": False}


def test_test_endpoint(client, auth, monkeypatch):
    # 沒 token：回清楚的錯，不是 500
    r = client.post("/notify/test", json={"line_to": "Uboss"}, headers=auth)
    assert r.status_code == 200 and r.json()["ok"] is False and "LINE 未設定" in r.json()["error"]
    # 沒對象
    assert client.post("/notify/test", json={}, headers=auth).json()["ok"] is False
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(notify, "push_line_detail", lambda to, text: (calls.append((to, text)) or (True, "")))
    r = client.post("/notify/test", json={"line_to": "Uboss"}, headers=auth)
    assert r.json() == {"ok": True, "error": ""}
    assert calls == [("Uboss", "MyHermesCompany 測試訊息")]


# ---------------------------------------------------------------- emit
def test_emit_formats(client, auth, sent):
    cid = _company(client, auth)
    _enable(client, auth)
    assert notify.emit("gate", cid, {"ref": "wa_1", "n": 2, "workflow_name": "熱點產線", "wf_id": "w1",
                                     "text": "\n  第一行很重要\n第二行"}) is True
    assert notify.emit("failed", cid, {"ref": "run_1", "n": 3, "workflow_name": "熱點產線", "wf_id": "w1",
                                       "error": "LINE push 失敗 401: bad token\nstack…"}) is True
    long_cmd = "rm -rf " + "x" * 200
    assert notify.emit("chat", cid, {"ref": "run_2", "profile": "researcher", "command": long_cmd}) is True
    assert [to for to, _ in sent] == ["Uboss"] * 3
    gate, failed, chat = [t for _, t in sent]
    assert gate == "⏸ 第 2 步等你看｜熱點產線\n第一行很重要\nhttps://studio.example.com/workflows/w1"
    assert failed == "⚠ 流程失敗｜熱點產線\n第 3 步：LINE push 失敗 401: bad token\nhttps://studio.example.com/workflows/w1"
    lines = chat.splitlines()
    assert lines[0].startswith("⚠ ") and " 想執行：rm -rf " in lines[0] and len(lines[0].split("想執行：")[1]) <= 80
    assert "researcher" in lines[0]  # profile 解析成員工名（測試資料員工名＝profile）
    assert lines[1] == "到收件匣決定：https://studio.example.com/today"


def test_emit_without_public_url_omits_link(client, auth, sent):
    cid = _company(client, auth)
    _enable(client, auth, public_url="")
    notify.emit("gate", cid, {"ref": "wa_1", "n": 1, "workflow_name": "wf", "wf_id": "w1", "text": "hi"})
    notify.emit("chat", cid, {"ref": "run_9", "agent": "小編", "command": "curl x | sh"})
    assert sent[0][1] == "⏸ 第 1 步等你看｜wf\nhi"
    assert sent[1][1] == "⚠ 小編 想執行：curl x | sh"


def test_emit_dedupe_window(client, auth, sent, monkeypatch):
    cid = _company(client, auth)
    _enable(client, auth)
    p = {"ref": "wa_dup", "n": 1, "workflow_name": "wf", "wf_id": "w1", "text": "x"}
    assert notify.emit("gate", cid, p) is True
    assert notify.emit("gate", cid, p) is False  # 10 分鐘內同一件事不再推
    assert notify.emit("failed", cid, {**p, "error": "e"}) is True  # 不同 kind 不互相吃掉
    assert notify.emit("gate", cid, {**p, "ref": "wa_other"}) is True
    assert len(sent) == 3
    # 窗口過了就能再推
    monkeypatch.setattr(notify, "_clock", lambda: time.monotonic() + notify.DEDUPE_SECONDS + 1)
    assert notify.emit("gate", cid, p) is True
    assert len(sent) == 4


def test_emit_disabled_flags_and_quiet_hours(client, auth, sent):
    cid = _company(client, auth)
    p = {"ref": "wa_1", "n": 1, "workflow_name": "wf", "wf_id": "w1", "text": "x", "error": "e", "command": "c", "agent": "a"}
    # 沒設定過 → 不推
    assert notify.emit("gate", cid, p) is False
    # 個別開關
    _enable(client, auth, on_failed=False, on_chat_approval=False)
    assert notify.emit("failed", cid, {**p, "ref": "r1"}) is False
    assert notify.emit("chat", cid, {**p, "ref": "r2"}) is False
    assert notify.emit("gate", cid, {**p, "ref": "r3"}) is True
    # 停用
    _enable(client, auth, enabled=False)
    assert notify.emit("gate", cid, {**p, "ref": "r4"}) is False
    # 安靜時段：涵蓋現在這個小時
    h = datetime.now().hour
    _enable(client, auth, quiet_hours=f"{h}-{(h + 1) % 24}")
    assert notify.emit("gate", cid, {**p, "ref": "r5"}) is False
    _enable(client, auth, quiet_hours=f"{(h + 1) % 24}-{(h + 2) % 24}")
    assert notify.emit("gate", cid, {**p, "ref": "r6"}) is True
    assert len(sent) == 2
    # 不認識的 kind 不會炸到呼叫端
    assert notify.emit("bogus", cid, p) is False
    # 空 payload／沒有 ref 也安全，而且不推
    assert notify.emit("gate", cid, None) is False  # type: ignore[arg-type]
    assert notify.emit("gate", cid, {"n": 1, "workflow_name": "wf", "text": "x"}) is False


def test_quiet_hours_helper():
    assert notify.in_quiet_hours("23-07", 23) and notify.in_quiet_hours("23-07", 3) and not notify.in_quiet_hours("23-07", 7)
    assert notify.in_quiet_hours("9-18", 12) and not notify.in_quiet_hours("9-18", 18) and not notify.in_quiet_hours("9-18", 8)
    assert not notify.in_quiet_hours("", 12) and not notify.in_quiet_hours("bad", 12) and not notify.in_quiet_hours("5-5", 5)


# ---------------------------------------------------------------- integration：閘門 → LINE
def test_gate_run_pushes_line(client, auth, sent):
    _enable(client, auth)
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), {"id": "g", "title": "審批", "kind": "gate"}, hnode("b", ag)], [edge("a", "g"), edge("g", "b")], name="有事找我")
    rid = run(client, auth, wid)
    d = wait(client, auth, rid, until={"waiting_approval"})
    assert d["node_states"]["g"]["status"] == "waiting_approval"
    for _ in range(100):  # 推播在執行緒裡，等一下
        if sent:
            break
        time.sleep(0.02)
    assert len(sent) == 1, sent
    to, text = sent[0]
    assert to == "Uboss"
    assert text.startswith("⏸ 第 2 步等你看｜有事找我\necho[") and "### 節點a" not in text  # 跳過標題，直接給內容
    assert text.endswith(f"\nhttps://studio.example.com/workflows/{wid}")
    # 核准後流程完成，不會再多推（completed 不通知）
    pend = client.get("/workflow-approvals", headers=auth).json()
    assert client.post(f"/workflow-approvals/{pend[0]['id']}/approve", json={}, headers=auth).status_code == 200
    assert wait(client, auth, rid)["status"] == "completed"
    time.sleep(0.1)
    assert len(sent) == 1


def test_failed_run_pushes_line(client, auth, sent, gw_state):
    _enable(client, auth)
    gw_state.scenario = "failed"
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag)], [edge("a", "b")], name="會壞的")
    rid = run(client, auth, wid)
    assert wait(client, auth, rid)["status"] == "failed"
    for _ in range(100):
        if sent:
            break
        time.sleep(0.02)
    assert len(sent) == 1, sent
    text = sent[0][1]
    assert text.startswith("⚠ 流程失敗｜會壞的\n第 1 步：") and "boom" in text
    assert text.endswith(f"/workflows/{wid}")


def test_chat_approval_pushes_line(client, auth, token, sent, gw_state):
    """對話裡的危險指令：chat_ws 收到 approval.request → 推一則到 LINE。"""
    from tests.test_ws_chat import _collect, _mk_session
    import json as _json
    _enable(client, auth)
    gw_state.scenario = "approval"
    sid = _mk_session(client, auth)
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(_json.dumps({"type": "run", "session_id": sid, "input": "刪東西"}))
        events = _collect(ws, until=("approval.request",))
        run_id = events[0]["run_id"]
        for _ in range(100):
            if sent:
                break
            time.sleep(0.02)
        ws.send_text(_json.dumps({"type": "approval", "run_id": run_id, "decision": "once"}))
        _collect(ws)
    assert len(sent) == 1, sent
    text = sent[0][1]
    assert text.startswith("⚠ ") and "想執行：rm -rf x" in text
    assert text.endswith("\n到收件匣決定：https://studio.example.com/today")
