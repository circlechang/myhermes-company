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
