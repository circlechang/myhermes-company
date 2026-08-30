def test_agents_synced_from_profiles(client, auth):
    agents = client.get("/agents", headers=auth).json()
    by_profile = {a["profile"]: a for a in agents}
    assert set(by_profile) == {"default", "researcher", "writer"}
    assert by_profile["default"]["enabled"] is True
    assert by_profile["researcher"]["enabled"] is False  # unbound profiles start disabled
    assert by_profile["researcher"]["model"] == "stealth/ox-alpha"
    assert "預設員工" in by_profile["default"]["soul_excerpt"]


def test_sync_is_idempotent(app, client, auth):
    import asyncio
    from studio.api.agents import sync_agents_from_profiles
    n = asyncio.run(sync_agents_from_profiles(app.state.engine, app.state.cli))
    assert n == 0
    assert len(client.get("/agents", headers=auth).json()) == 3


def test_agent_crud_soul_skills(client, auth, hermes_home):
    r = client.post("/agents", json={"name": "文案", "profile": "writer", "title": "Copywriter"}, headers=auth)
    assert r.status_code == 201, r.text
    aid = r.json()["id"]
    assert r.json()["model"] == "gpt-writer"
    assert client.post("/agents", json={"name": "x", "profile": "nope"}, headers=auth).status_code == 400
    r = client.patch(f"/agents/{aid}", json={"title": "資深文案", "enabled": False}, headers=auth)
    assert r.json()["title"] == "資深文案" and r.json()["enabled"] is False
    assert client.get(f"/agents/{aid}/soul", headers=auth).json()["content"].startswith("# writer soul")
    r = client.put(f"/agents/{aid}/soul", json={"content": "# new soul"}, headers=auth)
    assert r.status_code == 200 and r.json()["same"] is False and r.json()["version"] >= 1
    assert (hermes_home / "profiles" / "writer" / "SOUL.md").read_text() == "# new soul"
    # 每次儲存都經 soul_history 記版本：最新版內容＝剛寫的；同內容再存不新增版本
    vers = client.get("/soul-history/writer", headers=auth).json()
    assert vers[0]["version"] == r.json()["version"] and vers[0]["note"].startswith("agents page")
    assert client.get(f"/soul-history/writer/{vers[0]['version']}", headers=auth).json()["content"] == "# new soul"
    assert client.get("/soul-history/writer/current", headers=auth).json()["drift"] is False
    assert client.put(f"/agents/{aid}/soul", json={"content": "# new soul"}, headers=auth).json()["same"] is True
    assert len(client.get("/soul-history/writer", headers=auth).json()) == len(vers)
    skills = client.get(f"/agents/{aid}/skills", headers=auth).json()
    assert skills[0]["name"] == "skill-a-writer" and skills[0]["enabled"] is True
    assert skills[1]["enabled"] is False
    assert client.delete(f"/agents/{aid}", headers=auth).json()["ok"] is True
    assert client.get(f"/agents/{aid}/soul", headers=auth).status_code == 404


def test_hermes_status(client, auth):
    st = client.get("/hermes/status", headers=auth).json()
    assert st["gateway_ok"] is True and st["version"] == "0.20.5-fake"
    assert {p["name"] for p in st["profiles"]} == {"default", "researcher", "writer"}
