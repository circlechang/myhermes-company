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


# --- 人事檔案 GET /agents/{id}/dossier ---------------------------------------
def test_dossier_empty_for_fresh_agent(client, auth):
    r = client.post("/agents", json={"name": "文案", "profile": "writer"}, headers=auth)
    aid = r.json()["id"]
    d = client.get(f"/agents/{aid}/dossier", headers=auth).json()
    assert d["agent_id"] == aid and d["days"] == 7 and d["since"]
    assert d["chat"] == {"sessions": 0, "messages": 0}
    assert d["workflow"] == {"node_runs": 0, "completed": 0, "failed": 0, "workflows": []}
    assert d["usage"] == {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cost_usd": 0.0}
    assert d["approvals"] == {"requested": 0, "approved": 0, "rejected": 0}
    assert d["docs"] == {"versions": 0, "docs": 0} and d["recent"] == []
    assert client.get("/agents/ag_nope/dossier", headers=auth).status_code == 404
    assert client.get(f"/agents/{aid}/dossier?days=0", headers=auth).status_code == 422


def test_dossier_counts_chat_and_usage(client, auth, app):
    from sqlmodel import Session as DbSession
    from studio.models import Message, ChatSession, now
    aid = client.post("/agents", json={"name": "文案", "profile": "writer"}, headers=auth).json()["id"]
    s = client.post("/sessions", json={"agent_id": aid, "title": "寫貼文"}, headers=auth).json()
    with DbSession(app.state.engine) as db:
        db.add(Message(session_id=s["id"], role="user", content="幫我寫"))
        db.add(Message(session_id=s["id"], role="assistant", content="好", usage='{"input_tokens": 1000, "output_tokens": 500, "cost_usd": 0.02}'))
        row = db.get(ChatSession, s["id"])
        row.last_message_at = now()
        row.run_status = "completed"
        company_id = row.company_id
        db.add(row)
        db.commit()
    d = client.get(f"/agents/{aid}/dossier", headers=auth).json()
    assert d["chat"] == {"sessions": 1, "messages": 2}
    assert d["usage"]["total_tokens"] == 1500 and d["usage"]["cost_usd"] == 0.02
    assert d["recent"][0]["kind"] == "chat" and d["recent"][0]["title"] == "寫貼文"
    assert d["recent"][0]["link"] == f"/workbench?session={s['id']}" and d["recent"][0]["status"] == "completed"
    # 對話端審批：deny 算退回、once 算通過
    from studio.modules.inbox.models import PendingApproval
    with DbSession(app.state.engine) as db:
        db.add(PendingApproval(company_id=company_id, session_id=s["id"], agent="writer", status="resolved", decision="deny"))
        db.add(PendingApproval(company_id=company_id, session_id=s["id"], agent="writer", status="resolved", decision="once"))
        db.commit()
    d = client.get(f"/agents/{aid}/dossier", headers=auth).json()
    assert d["approvals"] == {"requested": 2, "approved": 1, "rejected": 1}
