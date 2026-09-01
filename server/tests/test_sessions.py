def _agent_id(client, auth, profile="default"):
    return next(a["id"] for a in client.get("/agents", headers=auth).json() if a["profile"] == profile)


def test_sessions_crud_and_isolation(client, auth):
    aid = _agent_id(client, auth)
    r = client.post("/sessions", json={"agent_id": aid}, headers=auth)
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["agent_id"] == aid and s["title"].startswith("與 default")
    assert client.post("/sessions", json={"agent_id": "ag_nope"}, headers=auth).status_code == 404
    lst = client.get("/sessions", params={"agent_id": aid}, headers=auth).json()
    assert [x["id"] for x in lst] == [s["id"]]
    assert client.get(f"/sessions/{s['id']}/messages", headers=auth).json() == []
    # other member cannot see it
    client.post("/members", json={"username": "eve", "password": "evepass", "role": "member"}, headers=auth)
    eve = {"Authorization": "Bearer " + client.post("/auth/login", json={"username": "eve", "password": "evepass"}).json()["token"]}
    assert client.get("/sessions", headers=eve).json() == []
    assert client.get(f"/sessions/{s['id']}/messages", headers=eve).status_code == 404
    assert client.delete(f"/sessions/{s['id']}", headers=auth).json()["ok"] is True
    assert client.get("/sessions", headers=auth).json() == []


def test_kanban_proxy(client, auth, app):
    tasks = client.get("/kanban/tasks", headers=auth).json()
    assert len(tasks) == 2
    assert [t["id"] for t in client.get("/kanban/tasks", params={"status": "done"}, headers=auth).json()] == ["t_bbb222"]
    r = client.post("/kanban/tasks", json={"title": "new", "assignee": "researcher", "priority": 5}, headers=auth)
    assert r.status_code == 201 and r.json()["assignee"] == "researcher"
    tid = r.json()["id"]
    assert client.post(f"/kanban/tasks/{tid}/status", json={"status": "done"}, headers=auth).json()["status"] == "done"
    assert client.post(f"/kanban/tasks/{tid}/comment", json={"text": "hi"}, headers=auth).status_code == 200
    assert app.state.fake_cli.comments == [(tid, "hi")]
    assert client.post("/kanban/tasks/t_none/status", json={"status": "done"}, headers=auth).status_code == 502


def test_session_list_carries_preview_of_first_user_message(client, auth, app):
    """側欄要靠預覽分辨標題重複的對話（「與 default 的對話」會有一大票）。

    取最早的一則 user 訊息：它最能識別主題，也不會隨對話變長而跳動。
    """
    from sqlmodel import Session as DbSession

    from studio.models import Message

    aid = _agent_id(client, auth)
    a = client.post("/sessions", json={"agent_id": aid}, headers=auth).json()
    b = client.post("/sessions", json={"agent_id": aid}, headers=auth).json()
    with DbSession(app.state.engine) as db:
        db.add(Message(session_id=a["id"], role="user", content="  幫我看一下\n\n這份規格書  "))
        db.add(Message(session_id=a["id"], role="assistant", content="好的"))
        db.add(Message(session_id=a["id"], role="user", content="第二個問題"))
        db.add(Message(session_id=b["id"], role="assistant", content="只有助理發言，沒有預覽"))
        db.commit()

    by_id = {s["id"]: s for s in client.get("/sessions", headers=auth).json()}
    # 換行與連續空白收成單行；取最早那則，不是最新那則
    assert by_id[a["id"]]["preview"] == "幫我看一下 這份規格書"
    # 沒有使用者訊息就給空字串，前端不會渲染副標
    assert by_id[b["id"]]["preview"] == ""


def test_session_preview_is_truncated_not_unbounded(client, auth, app):
    from sqlmodel import Session as DbSession

    from studio.api.sessions import PREVIEW_CHARS
    from studio.models import Message

    aid = _agent_id(client, auth)
    s = client.post("/sessions", json={"agent_id": aid}, headers=auth).json()
    with DbSession(app.state.engine) as db:
        db.add(Message(session_id=s["id"], role="user", content="長" * 500))
        db.commit()
    prev = next(x for x in client.get("/sessions", headers=auth).json() if x["id"] == s["id"])["preview"]
    assert len(prev) == PREVIEW_CHARS and prev.endswith("…")
