"""SPEC 專屬四模組：events / inbox / soul_history / limits。"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from sqlmodel import Session, select

from studio.models import Agent, ChatSession, Message, WorkflowApproval, WorkflowRun, now


def _me(client, auth):
    return client.get("/auth/me", headers=auth).json()


def _agent(client, auth, profile="default"):
    return next(a for a in client.get("/agents", headers=auth).json() if a["profile"] == profile)


def _seed_run(app, company_id, member_id, agent_id, usage, when=None):
    with Session(app.state.engine) as db:
        s = ChatSession(company_id=company_id, member_id=member_id, agent_id=agent_id, title="t")
        db.add(s)
        db.flush()
        db.add(Message(session_id=s.id, role="user", content="hi"))
        m = Message(session_id=s.id, role="assistant", content="hello world", run_id="run_x", usage=json.dumps(usage),
                    created_at=when or now())
        db.add(m)
        db.commit()
        return s.id, m.id


# -- events -------------------------------------------------------------------
def test_events_record_query_export(client, auth, app):
    from studio.modules.events import record
    ev = record("line.inbound", "line", "user:U1", {"text": "你好"}, agent="default", company_id=_me(client, auth)["company_id"])
    assert ev is not None and ev.id.startswith("ev_")
    r = client.post("/events", json={"kind": "form.submit", "source": "webhook", "subject": "form:1", "payload": {"a": 1}}, headers=auth)
    assert r.status_code == 201 and r.json()["member_id"]
    r = client.get("/events", headers=auth)
    assert r.status_code == 200 and r.json()["total"] == 2
    assert client.get("/events?source=line", headers=auth).json()["total"] == 1
    assert client.get("/events?kind=form.*", headers=auth).json()["total"] == 1
    assert client.get("/events?q=你好", headers=auth).json()["total"] == 1
    assert client.get("/events?agent=default", headers=auth).json()["total"] == 1
    assert client.get("/events?since=bad", headers=auth).status_code == 400
    f = client.get("/events/facets", headers=auth).json()
    assert {x["value"] for x in f["sources"]} == {"line", "webhook"}
    csv = client.get("/events/export.csv", headers=auth)
    assert csv.status_code == 200 and "text/csv" in csv.headers["content-type"]
    assert "line.inbound" in csv.text and "form.submit" in csv.text
    assert client.get(f"/events/{ev.id}", headers=auth).json()["payload"] == {"text": "你好"}
    assert client.get("/events/ev_nope", headers=auth).status_code == 404


def test_events_collector_chat_workflow_kanban(client, auth, app):
    from studio.modules.events import collector
    me = _me(client, auth)
    ag = _agent(client, auth)
    sid, mid = _seed_run(app, me["company_id"], me["id"], ag["id"], {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15})
    with Session(app.state.engine) as db:
        run = WorkflowRun(company_id=me["company_id"], workflow_id="wf_1", workflow_name="日報", status="completed", finished_at=now(), created_by=me["id"])
        db.add(run)
        db.flush()
        db.add(WorkflowApproval(company_id=me["company_id"], run_id=run.id, workflow_name="日報", node_id="g", node_title="閘門",
                                status="approved", decided_by=me["id"], decided_at=now(), comment="ok"))
        db.commit()
    tasks = [{"id": "t_1", "title": "A", "status": "todo", "assignee": "default"}]
    n = collector.collect_sync(app.state.engine, tasks)
    assert n == 4  # chat.run + workflow.run + approval.requested + approval.decided；kanban 第一次只建快照
    # 再掃一次不重複
    assert collector.collect_sync(app.state.engine, tasks) == 0
    # 看板狀態變了 → 事件
    tasks[0]["status"] = "blocked"
    assert collector.collect_sync(app.state.engine, tasks) == 1
    items = client.get("/events", headers=auth).json()["items"]
    kinds = sorted(e["kind"] for e in items)
    assert kinds == ["approval.decided", "approval.requested", "chat.run", "kanban.status", "workflow.run"]
    chat = next(e for e in items if e["kind"] == "chat.run")
    assert chat["subject"] == f"message:{mid}" and chat["agent"] == "default" and chat["payload"]["usage"]["total_tokens"] == 15
    kb = next(e for e in items if e["kind"] == "kanban.status")
    assert kb["payload"] == {"task_id": "t_1", "title": "A", "from": "todo", "to": "blocked", "priority": None}
    # admin 可手動觸發掃描（FakeCli.kanban_list 可用）
    assert client.post("/events/collect", headers=auth).json()["ok"] is True


# -- inbox --------------------------------------------------------------------
def test_inbox_aggregates_and_resolves(client, auth, app, gw_state):
    me = _me(client, auth)
    with Session(app.state.engine) as db:
        run = WorkflowRun(company_id=me["company_id"], workflow_id="wf_1", workflow_name="日報", status="waiting_approval")
        db.add(run)
        db.flush()
        wa = WorkflowApproval(company_id=me["company_id"], run_id=run.id, workflow_id="wf_1", workflow_name="日報", node_id="g",
                              node_title="閘門", status="pending", payload="上游結果")
        db.add(wa)
        db.commit()
        wa_id = wa.id
    # 看板：FakeCli 加一張 blocked 卡
    app.state.fake_cli.kanban.append({"id": "t_blk", "title": "卡住的卡", "status": "blocked", "assignee": "researcher", "priority": 1})
    # 對話危險指令
    r = client.post("/inbox/approvals", json={"run_id": "run_9", "command": "rm -rf x", "context": {"tool": "terminal"}, "agent": "default"}, headers=auth)
    assert r.status_code == 201
    pa_id = r.json()["id"]
    # 重複記錄回同一筆
    assert client.post("/inbox/approvals", json={"run_id": "run_9", "command": "rm -rf x"}, headers=auth).json()["id"] == pa_id
    # 一般待辦
    assert client.post("/inbox/items", json={"title": "看一下", "link": "/usage"}, headers=auth).status_code == 201

    data = client.get("/inbox", headers=auth).json()
    assert data["count"] == 4 and data["warnings"] == []
    assert data["by_kind"] == {"workflow_gate": 1, "chat_approval": 1, "kanban_blocked": 1, "notice": 1}
    wf = next(x for x in data["items"] if x["kind"] == "workflow_gate")
    assert wf["api"]["approve"] == f"/workflow-approvals/{wa_id}/approve" and "上游結果" in wf["detail"]
    kb = next(x for x in data["items"] if x["kind"] == "kanban_blocked")
    assert kb["title"] == "卡住的卡" and kb["agent"] == "researcher" and kb["link"] == "/kanban?task=t_blk"
    assert client.get("/inbox/count", headers=auth).json()["count"] == 4
    assert client.get("/inbox?kind=chat_approval", headers=auth).json()["items"][0]["title"] == "rm -rf x"

    # 解決危險指令 → 代呼 gateway
    r = client.post(f"/inbox/approvals/{pa_id}/resolve", json={"decision": "once"}, headers=auth)
    assert r.status_code == 200 and r.json()["forwarded"] is True
    assert ("run_9", "once") in gw_state.approvals
    assert client.post(f"/inbox/approvals/{pa_id}/resolve", json={"decision": "deny"}, headers=auth).status_code == 409
    assert client.post("/inbox/approvals/x/resolve", json={"decision": "deny"}, headers=auth).status_code == 404
    # 看板卡標已處理
    assert client.post("/inbox/done", json={"ref": "kanban:t_blk"}, headers=auth).json()["ok"] is True
    assert client.post("/inbox/done", json={"ref": "weird"}, headers=auth).status_code == 400
    # 一般待辦完成
    item_id = next(x for x in data["items"] if x["kind"] == "notice")["ref_id"]
    assert client.post(f"/inbox/items/{item_id}/done", headers=auth).json()["status"] == "done"
    data = client.get("/inbox", headers=auth).json()
    assert data["by_kind"] == {"workflow_gate": 1}
    # 事件有記
    kinds = [e["kind"] for e in client.get("/events?source=chat", headers=auth).json()["items"]]
    assert "approval.request" in kinds and "approval.decided" in kinds
    # 取消已處理標記 → 看板卡回來
    client.delete("/inbox/done?ref=kanban:t_blk", headers=auth)
    assert client.get("/inbox/count", headers=auth).json()["by_kind"].get("kanban_blocked") == 1


def test_inbox_groupchat_mention(client, auth, app):
    from studio.modules.groupchat.models import Room, RoomMember, RoomMessage
    me = _me(client, auth)
    with Session(app.state.engine) as db:
        room = Room(company_id=me["company_id"], name="行銷群")
        db.add(room)
        db.flush()
        human = RoomMember(room_id=room.id, kind="human", member_id=me["id"], display_name="admin")
        ai = RoomMember(room_id=room.id, kind="ai", agent_id="x", display_name="小編", profile="default")
        db.add(human)
        db.add(ai)
        db.flush()
        db.add(RoomMessage(room_id=room.id, seq=1, sender_id=ai.id, sender_name="小編", sender_kind="ai", content="@admin 請確認標題"))
        db.add(RoomMessage(room_id=room.id, seq=2, sender_id=ai.id, sender_name="小編", sender_kind="ai", content="沒有點名"))
        db.commit()
    data = client.get("/inbox?kind=groupchat_mention", headers=auth).json()
    assert len(data["items"]) == 1
    it = data["items"][0]
    assert it["detail"] == "@admin 請確認標題" and it["agent"] == "default" and it["title"].startswith("小編 在「行銷群」@ admin")
    client.post("/inbox/done", json={"ref": it["ref"]}, headers=auth)
    assert client.get("/inbox?kind=groupchat_mention", headers=auth).json()["items"] == []


# -- soul_history -------------------------------------------------------------
def test_soul_history_versions_diff_rollback(client, auth, app, hermes_home):
    lst = client.get("/soul-history", headers=auth).json()
    by = {x["profile"]: x for x in lst}
    assert set(by) == {"default", "researcher", "writer"}
    assert by["researcher"]["versions"] == 1 and by["researcher"]["latest"]["version"] == 0 and by["researcher"]["latest"]["note"] == "startup snapshot"
    # 冪等：再跑 snapshot_all 不新增
    from studio.modules.soul_history import snapshot_all
    assert snapshot_all(app.state.engine, app.state.cli) == 0
    v0 = client.get("/soul-history/researcher/0", headers=auth).json()
    assert v0["content"] == "# researcher soul\n"
    # 寫入 → v1，檔案真的改了
    r = client.put("/soul-history/researcher", json={"content": "# researcher soul\n更直接一點\n", "note": "語氣調整"}, headers=auth)
    assert r.status_code == 200 and r.json()["version"] == 1 and r.json()["same"] is False
    assert (hermes_home / "profiles" / "researcher" / "SOUL.md").read_text() == "# researcher soul\n更直接一點\n"
    # 相同內容不新增
    assert client.put("/soul-history/researcher", json={"content": "# researcher soul\n更直接一點\n"}, headers=auth).json()["same"] is True
    vs = client.get("/soul-history/researcher", headers=auth).json()
    assert [v["version"] for v in vs] == [1, 0] and vs[0]["note"] == "語氣調整"
    d = client.get("/soul-history/researcher/diff", headers=auth).json()
    assert d["from"] == 0 and d["to"] == 1 and d["added"] == 1 and d["removed"] == 0 and "+更直接一點" in d["diff"]
    # 漂移：別的路徑改了檔案
    (hermes_home / "profiles" / "researcher" / "SOUL.md").write_text("外部改的\n")
    cur = client.get("/soul-history/researcher/current", headers=auth).json()
    assert cur["drift"] is True and cur["latest_version"] == 1
    assert client.get("/soul-history/researcher/diff?b=-1", headers=auth).json()["diff"].count("+外部改的") == 1
    assert client.post("/soul-history/researcher/snapshot", headers=auth).json()["version"] == 2
    assert client.get("/soul-history/researcher/current", headers=auth).json()["drift"] is False
    # 回滾到 v0 → 產生 v3，檔案內容＝v0
    r = client.post("/soul-history/researcher/rollback", json={"version": 0}, headers=auth)
    assert r.status_code == 200 and r.json()["version"] == 3 and r.json()["rolled_back_to"] == 0
    assert (hermes_home / "profiles" / "researcher" / "SOUL.md").read_text() == "# researcher soul\n"
    assert client.post("/soul-history/researcher/rollback", json={"version": 99}, headers=auth).status_code == 404
    assert client.get("/soul-history/nope", headers=auth).status_code == 404
    kinds = [e["kind"] for e in client.get("/events?agent=researcher", headers=auth).json()["items"]]
    assert kinds.count("soul.write") == 1 and kinds.count("soul.rollback") == 1


def test_soul_history_member_cannot_write(client, auth, app):
    client.post("/members", json={"username": "bob", "password": "bobpass1", "role": "member", "profiles": ["researcher"]}, headers=auth)
    tok = client.post("/auth/login", json={"username": "bob", "password": "bobpass1"}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert [x["profile"] for x in client.get("/soul-history", headers=h).json()] == ["researcher"]
    assert client.get("/soul-history/writer", headers=h).status_code == 404
    assert client.put("/soul-history/researcher", json={"content": "x"}, headers=h).status_code == 403


# -- limits -------------------------------------------------------------------
def test_limits_trigger_disable_and_reset(client, auth, app):
    me = _me(client, auth)
    ag = _agent(client, auth)
    assert ag["enabled"] is True
    r = client.post("/limits", json={"scope": "agent", "agent_id": ag["id"], "daily_tokens": 100}, headers=auth)
    assert r.status_code == 201
    lim = r.json()
    assert client.post("/limits", json={"scope": "agent", "agent_id": ag["id"]}, headers=auth).status_code == 400
    assert client.post("/limits", json={"scope": "agent", "agent_id": "ag_nope", "daily_tokens": 1}, headers=auth).status_code == 404
    assert client.post("/limits", json={"scope": "x", "daily_tokens": 1}, headers=auth).status_code == 400
    # 60 tokens：未超
    _seed_run(app, me["company_id"], me["id"], ag["id"], {"input_tokens": 40, "output_tokens": 20, "total_tokens": 60})
    lst = client.get("/limits", headers=auth).json()
    assert lst[0]["today"]["tokens"] == 60 and lst[0]["today"]["tokens_pct"] == 60.0 and lst[0]["today"]["exceeded"] is False
    assert client.post("/limits/check", headers=auth).json()["fired"] == []
    # 昨天的不算
    _seed_run(app, me["company_id"], me["id"], ag["id"], {"total_tokens": 500}, when=now() - timedelta(days=1))
    assert client.get("/limits/today", headers=auth).json()["company"]["tokens"] == 60
    # 再 50 → 110 超過 → 停用
    _seed_run(app, me["company_id"], me["id"], ag["id"], {"input_tokens": 30, "output_tokens": 20, "total_tokens": 50})
    fired = client.post("/limits/check", headers=auth).json()["fired"]
    assert len(fired) == 1 and fired[0]["disabled"] == [ag["id"]]
    assert _agent(client, auth)["enabled"] is False
    lst = client.get("/limits", headers=auth).json()
    assert lst[0]["today"]["exceeded"] is True and lst[0]["today"]["triggered_today"] is True and lst[0]["agent"]["enabled"] is False
    # 同一天不重複觸發
    assert client.post("/limits/check", headers=auth).json()["fired"] == []
    # 事件＋收件匣
    evs = client.get("/events?kind=limit.exceeded", headers=auth).json()["items"]
    assert len(evs) == 1 and evs[0]["payload"]["disabled_agents"] == [ag["id"]]
    inbox = client.get("/inbox?kind=limit_exceeded", headers=auth).json()["items"]
    assert len(inbox) == 1 and "已停用" in inbox[0]["detail"] and inbox[0]["link"] == "/limits"
    # reset → 重新啟用
    r = client.post(f"/limits/{lim['id']}/reset", headers=auth)
    assert r.json()["re_enabled"] == [ag["id"]] and _agent(client, auth)["enabled"] is True
    # PATCH 提高上限；check_all 走全公司
    assert client.patch(f"/limits/{lim['id']}", json={"daily_tokens": 1000}, headers=auth).json()["daily_tokens"] == 1000
    from studio.modules.limits import check_all
    assert check_all(app.state.engine) == []
    assert client.delete(f"/limits/{lim['id']}", headers=auth).status_code == 204
    assert client.get("/limits", headers=auth).json() == []


def test_limits_company_scope_usd_notify(client, auth, app):
    me = _me(client, auth)
    ag = _agent(client, auth)
    r = client.post("/limits", json={"scope": "company", "daily_usd": 0.5, "action": "notify"}, headers=auth)
    assert r.status_code == 201
    _seed_run(app, me["company_id"], me["id"], ag["id"], {"total_tokens": 10, "cost_usd": 0.7})
    fired = client.post("/limits/check", headers=auth).json()["fired"]
    assert len(fired) == 1 and fired[0]["disabled"] == [] and fired[0]["usage"]["usd"] == 0.7
    assert _agent(client, auth)["enabled"] is True  # notify 不停用
    assert client.get("/inbox/count", headers=auth).json()["by_kind"] == {"limit_exceeded": 1}
