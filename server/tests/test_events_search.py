"""events 強化（seq / causes / kind 白名單）＋ search 模組（FTS5 中文、scope、機器 token 唯讀、skill 安裝）。"""
from __future__ import annotations

import json
from pathlib import Path

from sqlmodel import Session

from studio.models import ChatSession, Message, WorkflowApproval, WorkflowRun, WorkflowRunNode, now


def _me(client, auth):
    return client.get("/auth/me", headers=auth).json()


def _agent(client, auth, profile="default"):
    return next(a for a in client.get("/agents", headers=auth).json() if a["profile"] == profile)


# ---------------------------------------------------------------- events: seq / causes / whitelist

def test_events_seq_monotonic_and_kind_whitelist(client, auth, app, caplog):
    from studio.modules.events import record
    a = record("line.inbound", "line", "user:U1", {"text": "你好"}, company_id=_me(client, auth)["company_id"])
    b = record("form.submit", "webhook", "form:1", {}, company_id=a.company_id)
    assert a.seq >= 1 and b.seq == a.seq + 1
    # 未知 kind → other.* 並 warning
    with caplog.at_level("WARNING", logger="studio.events.kinds"):
        c = record("weird.thing", "api", "x:1", {}, company_id=a.company_id, causes=[a.id, b.id])
    assert c.kind == "other.weird.thing" and c.seq == b.seq + 1 and c.causes == [a.id, b.id]
    assert any("unknown kind" in r.message for r in caplog.records)
    # REST：POST 也走白名單＋causes 只留存在的 id；列表依 seq 反序
    r = client.post("/events", json={"kind": "nope.kind", "subject": "s", "causes": [c.id, "ev_missing"]}, headers=auth)
    assert r.status_code == 201 and r.json()["kind"] == "other.nope.kind" and r.json()["causes"] == [c.id]
    items = client.get("/events", headers=auth).json()["items"]
    seqs = [e["seq"] for e in items]
    assert seqs == sorted(seqs, reverse=True) and len(set(seqs)) == len(seqs)
    # 白名單端點
    k = client.get("/events/kinds", headers=auth).json()
    assert "workflow.node.completed" in k["kinds"] and "line." in k["prefixes"]
    # 因果鏈：d ← c ← {a, b}
    d = r.json()
    chain = client.get(f"/events/{d['id']}/chain", headers=auth).json()
    assert chain["event"]["id"] == d["id"]
    assert [u["id"] for u in chain["upstream"]] == [c.id, a.id, b.id]
    assert chain["downstream"] == []
    chain_c = client.get(f"/events/{c.id}/chain", headers=auth).json()
    assert [x["id"] for x in chain_c["downstream"]] == [d["id"]]


def test_events_backfill_seq_for_legacy_rows(client, app):
    from sqlalchemy import text
    from studio.modules.events import Event, backfill_seq
    with Session(app.state.engine) as db:
        for i in range(3):
            db.add(Event(kind="chat.run", source="chat", subject=f"legacy:{i}", seq=0))
        db.commit()
    assert backfill_seq(app.state.engine) == 3
    with app.state.engine.connect() as conn:
        rows = conn.execute(text("SELECT subject, seq FROM events WHERE subject LIKE 'legacy:%' ORDER BY seq")).fetchall()
    assert [r[0] for r in rows] == ["legacy:0", "legacy:1", "legacy:2"] and rows[0][1] >= 1
    assert backfill_seq(app.state.engine) == 0


def test_collector_fills_causes_for_workflow_chain(client, auth, app):
    from studio.modules.events import collector
    me = _me(client, auth)
    with Session(app.state.engine) as db:
        run = WorkflowRun(company_id=me["company_id"], workflow_id="wf_1", workflow_name="週報", status="completed",
                          started_at=now(), finished_at=now(), created_by=me["id"])
        db.add(run)
        db.flush()
        db.add(WorkflowRunNode(run_id=run.id, node_id="n1", kind="agent", status="completed", attempt=1, output="草稿：本週文案", finished_at=now()))
        db.add(WorkflowApproval(company_id=me["company_id"], run_id=run.id, workflow_name="週報", node_id="g", node_title="閘門",
                                status="approved", decided_by=me["id"], decided_at=now(), comment="ok"))
        db.commit()
        run_id = run.id
    collector.collect_sync(app.state.engine)
    items = client.get("/events?source=workflow", headers=auth).json()["items"]
    by = {e["kind"]: e for e in items}
    assert set(by) == {"workflow.run.started", "workflow.node.completed", "approval.requested", "approval.decided", "workflow.run"}
    started = by["workflow.run.started"]
    assert started["subject"] == f"run:{run_id}" and started["causes"] == []
    assert by["workflow.node.completed"]["causes"] == [started["id"]]
    assert by["approval.requested"]["causes"] == [started["id"]]
    assert by["approval.decided"]["causes"] == [by["approval.requested"]["id"]]
    assert set(by["workflow.run"]["causes"]) == {started["id"], by["workflow.node.completed"]["id"]}
    # seq 順序＝因果順序
    assert started["seq"] < by["workflow.node.completed"]["seq"] < by["workflow.run"]["seq"]
    chain = client.get(f"/events/{by['approval.decided']['id']}/chain", headers=auth).json()
    assert [u["kind"] for u in chain["upstream"]] == ["approval.requested", "workflow.run.started"]
    # 再掃不重複
    assert collector.collect_sync(app.state.engine) == 0


# ---------------------------------------------------------------- search

def _seed_all(client, auth, app):
    me = _me(client, auth)
    ag = _agent(client, auth)
    with Session(app.state.engine) as db:
        s = ChatSession(company_id=me["company_id"], member_id=me["id"], agent_id=ag["id"], title="貼文討論")
        db.add(s)
        db.flush()
        db.add(Message(session_id=s.id, role="user", content="幫我寫一段文案給新品上市"))
        db.add(Message(session_id=s.id, role="assistant", content="好的，這是 Launch 文案初稿：全新登場。", run_id="run_1"))
        db.add(Message(session_id=s.id, role="tool", content="文案 tool noise should not index"))
        run = WorkflowRun(company_id=me["company_id"], workflow_id="wf_1", workflow_name="每週貼文", status="completed",
                          started_at=now(), finished_at=now(), created_by=me["id"])
        db.add(run)
        db.flush()
        db.add(WorkflowRunNode(run_id=run.id, node_id="write", kind="agent", status="completed", attempt=1,
                               output="節點輸出：熱點整理完成，文案交給閘門", finished_at=now()))
        db.commit()
        sid = s.id
    from studio.modules.groupchat.models import Room, RoomMember, RoomMessage
    with Session(app.state.engine) as db:
        room = Room(company_id=me["company_id"], name="行銷群")
        db.add(room)
        db.flush()
        rm = RoomMember(room_id=room.id, kind="ai", display_name="小編", profile="default")
        db.add(rm)
        db.flush()
        db.add(RoomMessage(room_id=room.id, seq=1, sender_id=rm.id, sender_name="小編", sender_kind="ai", content="群組裡也提到文案要改", depth=1))
        db.commit()
    from studio.modules.events import record
    record("form.submit", "webhook", "form:9", {"note": "表單留言：文案太長"}, company_id=me["company_id"])
    return sid


def test_search_fts_chinese_hits_all_scopes(client, auth, app):
    _seed_all(client, auth, app)
    r = client.get("/search?q=文案", headers=auth)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["match"] == '"文 案"'
    scopes = {it["scope"] for it in data["items"]}
    assert scopes == {"chat", "group", "workflow", "events"}, data
    assert data["total"] == 5  # user + assistant + node + group + event（tool 訊息不索引）
    for it in data["items"]:
        assert "文案" in it["snippet"] and it["link"]
    # 兩個字以上的詞、英文前綴、AND
    assert client.get("/search?q=Launch", headers=auth).json()["total"] == 1
    assert client.get("/search?q=laun", headers=auth).json()["total"] == 1  # 拉丁字前綴
    assert client.get("/search?q=文案 閘門", headers=auth).json()["total"] == 1
    assert client.get("/search?q=不存在的詞", headers=auth).json()["total"] == 0
    # 引號不會變成 FTS 語法錯
    assert client.get('/search?q="文案" OR', headers=auth).status_code == 200
    # 空字串
    assert client.get("/search?q=", headers=auth).json()["total"] == 0


def test_search_scope_time_agent_filters(client, auth, app):
    _seed_all(client, auth, app)
    j = lambda url: client.get(url, headers=auth).json()  # noqa: E731
    assert {it["scope"] for it in j("/search?q=文案&scope=chat")["items"]} == {"chat"}
    assert {it["scope"] for it in j("/search?q=文案&scope=group")["items"]} == {"group"}
    assert {it["scope"] for it in j("/search?q=文案&scope=workflow")["items"]} == {"workflow"}
    assert {it["scope"] for it in j("/search?q=文案&scope=events")["items"]} == {"events"}
    assert {it["scope"] for it in j("/search?q=文案&scope=chat,events")["items"]} == {"chat", "events"}
    assert client.get("/search?q=文案&scope=bogus", headers=auth).status_code == 400
    assert j("/search?q=文案&from=2999-01-01")["total"] == 0
    assert j("/search?q=文案&to=2000-01-01")["total"] == 0
    assert j("/search?q=文案&from=2000-01-01&to=2999-01-01")["total"] == 5
    assert client.get("/search?q=文案&from=bad", headers=auth).status_code == 400
    # agent 篩選：chat（default）＋group（default）命中，workflow/events 的 agent 空白 → 不含
    assert {it["scope"] for it in j("/search?q=文案&agent=default")["items"]} == {"chat", "group"}
    assert j("/search?q=文案&agent=nobody")["total"] == 0
    # 狀態
    st = j("/search/status")
    assert st["documents"] >= 5 and st["by_scope"]["chat"] == 2
    # 更新／刪除同步：改掉 assistant 訊息內容後不再命中
    with Session(app.state.engine) as db:
        from sqlmodel import select
        m = db.exec(select(Message).where(Message.role == "assistant")).first()
        m.content = "改成別的內容"
        db.add(m)
        db.commit()
    assert j("/search?q=Launch")["total"] == 0
    assert j("/search?q=別的內容")["total"] == 1


def test_search_member_scoping(client, auth, app):
    _seed_all(client, auth, app)
    me = _me(client, auth)
    r = client.post("/members", json={"username": "bob", "password": "bobpass1", "role": "member"}, headers=auth)
    assert r.status_code in (200, 201), r.text
    tok = client.post("/auth/login", json={"username": "bob", "password": "bobpass1"}).json()["token"]
    bob = {"Authorization": f"Bearer {tok}"}
    # member 沒指派 profile → 看不到 default 的東西；chat 只看自己的 session
    data = client.get("/search?q=文案", headers=bob).json()
    assert {it["scope"] for it in data["items"]} <= {"events", "workflow"}
    assert all(it["scope"] != "chat" for it in data["items"])


def test_search_machine_token_readonly(client, auth, app):
    _seed_all(client, auth, app)
    r = client.post("/search/tokens", json={"label": "skill"}, headers=auth)
    assert r.status_code == 201
    raw = r.json()["token"]
    assert raw.startswith("mhc_") and "token" not in client.get("/search/tokens", headers=auth).json()[0]
    mh = {"Authorization": f"Bearer {raw}"}
    # 讀：search / events / chain 都可以
    assert client.get("/search?q=文案", headers=mh).json()["total"] == 5
    ev = client.get("/events?kind=form.*", headers=mh).json()
    assert ev["total"] == 1
    assert client.get(f"/events/{ev['items'][0]['id']}/chain", headers=mh).status_code == 200
    # 寫：一律 401（不是 JWT）
    assert client.post("/events", json={"kind": "form.submit"}, headers=mh).status_code == 401
    assert client.post("/search/tokens", json={}, headers=mh).status_code == 401
    assert client.post("/search/reindex", headers=mh).status_code == 401
    assert client.get("/auth/me", headers=mh).status_code == 401
    assert client.get("/agents", headers=mh).status_code == 401
    # 撤銷後失效
    tid = r.json()["id"]
    assert client.delete(f"/search/tokens/{tid}", headers=auth).json()["revoked"] is True
    assert client.get("/search?q=文案", headers=mh).status_code == 401
    # 非 owner 不能發
    me = _me(client, auth)
    client.post("/members", json={"username": "adm", "password": "admpass1", "role": "admin"}, headers=auth)
    tok = client.post("/auth/login", json={"username": "adm", "password": "admpass1"}).json()["token"]
    assert client.post("/search/tokens", json={}, headers={"Authorization": f"Bearer {tok}"}).status_code == 403
    # 事件有記
    kinds = {e["kind"] for e in client.get("/events?source=studio", headers=auth).json()["items"]}
    assert {"search.token.created", "search.token.revoked"} <= kinds


def test_install_skill_api_and_module_cli(client, auth, app, hermes_home: Path, tmp_path: Path):
    r = client.post("/search/install-skill", json={"profile": "researcher"}, headers=auth)
    assert r.status_code == 200, r.text
    dst = Path(r.json()["installed_to"])
    assert dst == hermes_home / "profiles" / "researcher" / "skills" / "mhc-search"
    assert (dst / "SKILL.md").is_file() and (dst / "scripts" / "mhc_search.py").is_file()
    assert not (hermes_home / "profiles" / "researcher" / ".env").exists()  # 預設不動 .env
    # 帶 token 寫 .env（只寫兩個鍵、保留舊行、不回顯 token）
    (hermes_home / "profiles" / "writer" / ".env").write_text("FOO=bar\nMHC_STUDIO_URL=http://old\n")
    r = client.post("/search/install-skill", json={"profile": "writer", "write_env": True, "create_token": True, "studio_url": "http://127.0.0.1:8700"}, headers=auth)
    assert r.status_code == 200 and r.json()["token_created"] is True and "token" not in r.json()
    env = (hermes_home / "profiles" / "writer" / ".env").read_text()
    assert "FOO=bar" in env and "MHC_STUDIO_URL=http://127.0.0.1:8700" in env and env.count("MHC_STUDIO_URL=") == 1
    assert "MHC_SEARCH_TOKEN=mhc_" in env
    # default profile → ~/.hermes/skills
    r = client.post("/search/install-skill", json={}, headers=auth)
    assert Path(r.json()["installed_to"]) == hermes_home / "skills" / "mhc-search"
    assert client.post("/search/install-skill", json={"profile": "nope"}, headers=auth).status_code == 404
    # module CLI
    from studio.modules.search.install import main
    assert main(["mhc-search", "--profile", "researcher", "--hermes-home", str(hermes_home)]) == 0


def test_skill_script_reads_env_and_calls_api(client, auth, app, hermes_home: Path, monkeypatch, capsys):
    """用 TestClient 模擬 skill 腳本的 HTTP 呼叫：token 從 .env 讀、輸出 JSON。"""
    import importlib.util
    import sys
    _seed_all(client, auth, app)
    raw = client.post("/search/tokens", json={"label": "t"}, headers=auth).json()["token"]
    (hermes_home / ".env").write_text(f"MHC_STUDIO_URL=http://testserver\nMHC_SEARCH_TOKEN={raw}\n")
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.delenv("MHC_SEARCH_TOKEN", raising=False)
    spec = importlib.util.spec_from_file_location("mhc_search", Path(__file__).resolve().parents[2] / "hermes-skills" / "mhc-search" / "scripts" / "mhc_search.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def fake_call(url, token, path, params):
        assert url == "http://testserver" and token == raw
        r = client.get(path, params={k: v for k, v in params.items() if v not in (None, "")}, headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200, r.text
        return r.json()

    monkeypatch.setattr(mod, "call", fake_call)
    assert mod.main(["search", "文案", "--since", "7d", "--scope", "chat,events"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["total"] == 3 and {i["scope"] for i in out["items"]} == {"chat", "events"}
    assert mod.main(["events", "--kind", "form.*", "--text"]) == 0
    assert "form.submit" in capsys.readouterr().out
    ev_id = client.get("/events?kind=form.*", headers=auth).json()["items"][0]["id"]
    assert mod.main(["chain", ev_id]) == 0
    assert json.loads(capsys.readouterr().out)["event"]["id"] == ev_id
    # 沒 token → exit 2
    (hermes_home / ".env").write_text("")
    assert mod.main(["search", "x"]) == 2
