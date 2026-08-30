"""Executor tests against the fake gateway (conftest). Each hermes node echoes `echo[profile|h=0]: <input>`
and reports usage total_tokens=3."""
from __future__ import annotations

import json
import time
from datetime import timedelta

import pytest

from studio.modules.workflows.conditions import evaluate_rule, parse_yes_no
from studio.modules.workflows.cron import CronError, matches, next_run, parse_cron
from studio.workflow_validate import WorkflowValidationError, loop_body, validate_workflow

TERMINAL = {"completed", "failed", "stopped", "timeout", "budget_exceeded"}


def agent_id(client, auth, profile="researcher"):
    for a in client.get("/agents", headers=auth).json():
        if a["profile"] == profile:
            return a["id"]
    raise AssertionError("no agent")


def hnode(i, ag, prompt=None, **kw):
    return {"id": i, "title": f"節點{i}", "kind": "hermes", "agent_id": ag, "prompt": prompt or f"do {i}", **kw}


def edge(s, t, **kw):
    return {"id": f"{s}-{t}-{kw.get('sourceHandle','output')}", "source": s, "target": t, **kw}


def make(client, auth, nodes, edges, **extra):
    r = client.post("/workflows", json={"name": extra.pop("name", "wf"), "nodes": nodes, "edges": edges, **extra}, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def run(client, auth, wid, body=None):
    r = client.post(f"/workflows/{wid}/run", json=body or {}, headers=auth)
    assert r.status_code == 202, r.text
    return r.json()["run_id"]


def wait(client, auth, rid, until=TERMINAL, timeout=8.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = client.get(f"/workflow-runs/{rid}", headers=auth).json()
        if d["status"] in until:
            return d
        time.sleep(0.03)
    raise AssertionError(f"run {rid} still {d['status']}: {json.dumps(d['node_states'], ensure_ascii=False)[:500]}")


def user_msg(client, auth, session_id):
    msgs = client.get(f"/sessions/{session_id}/messages", headers=auth).json()
    return [m["content"] for m in msgs if m["role"] == "user"][0]


# ---------------------------------------------------------------- linear + snapshot + conversation
def test_linear_snapshot_and_conversation(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag)], [edge("a", "b")], name="線性")
    rid = run(client, auth, wid)
    d = wait(client, auth, rid)
    assert d["status"] == "completed", d
    ns = d["node_states"]
    assert ns["a"]["status"] == "completed" and ns["b"]["status"] == "completed"
    assert "echo[researcher" in ns["a"]["output"]
    assert ns["a"]["session_id"] and ns["a"]["hermes_session_id"].startswith(f"wf-{rid}-a-")
    # snapshot is frozen graph + per node session/usage/timestamps + edge decisions
    assert [n["id"] for n in d["snapshot"]["nodes"]] == ["a", "b"]
    assert d["edge_decisions"] == {"a-b-output": True}
    assert ns["a"]["usage"]["total_tokens"] == 3 and d["usage"]["total_tokens"] == 6
    assert ns["a"]["started_at"] and ns["a"]["finished_at"]
    assert {n["node_id"] for n in d["nodes"]} == {"a", "b"}
    # b's message is [上游結果] + [本節點任務]
    m = user_msg(client, auth, ns["b"]["session_id"])
    assert m.startswith("[上游結果]") and "### 節點a" in m and "[本節點任務]\ndo b" in m
    msgs = client.get(f"/sessions/{ns['b']['session_id']}/messages", headers=auth).json()
    assert [x["role"] for x in msgs] == ["user", "assistant"]
    # evidence replay timeline
    types = [e["type"] for e in d["events"]]
    assert types[0] == "run.status" and "edge.decision" in types and types[-1] == "run.status"
    assert all("ts" in e and "seq" in e for e in d["events"])
    # history lists
    runs = client.get(f"/workflows/{wid}/runs", headers=auth).json()
    assert runs[0]["id"] == rid and "snapshot" not in runs[0]
    assert client.get("/workflow-runs", headers=auth).json()[0]["id"] == rid
    # workflow sessions visible in session list with source=workflow
    assert any(s["source"] == "workflow" for s in client.get("/sessions", headers=auth).json())


def test_fan_in_parallel(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag), hnode("c", ag)], [edge("a", "c"), edge("b", "c")])
    d = wait(client, auth, run(client, auth, wid))
    assert d["status"] == "completed"
    m = user_msg(client, auth, d["node_states"]["c"]["session_id"])
    assert "### 節點a" in m and "### 節點b" in m


def test_failure_route(client, auth, gw_state):
    gw_state.scenario = "failed"
    ag = agent_id(client, auth)
    nodes = [hnode("a", ag),
             {"id": "ok", "title": "ok", "kind": "delivery", "channel": "file", "path": "ok.txt"},
             {"id": "bad", "title": "bad", "kind": "delivery", "channel": "file", "path": "bad.txt"}]
    wid = make(client, auth, nodes, [edge("a", "ok", on="success"), edge("a", "bad", on="failure")])
    d = wait(client, auth, run(client, auth, wid))
    ns = d["node_states"]
    assert ns["a"]["status"] == "failed" and "boom" in ns["a"]["error"]
    assert ns["bad"]["status"] == "completed" and ns["ok"]["status"] == "skipped"
    assert d["edge_decisions"] == {"a-ok-output": False, "a-bad-output": True}
    assert d["status"] == "completed"  # failure was handled by a failure route
    # unhandled failure → run failed
    wid2 = make(client, auth, [hnode("a", ag), hnode("b", ag)], [edge("a", "b", on="success")])
    d2 = wait(client, auth, run(client, auth, wid2))
    assert d2["status"] == "failed" and d2["node_states"]["b"]["status"] == "skipped" and "boom" in d2["error"]


def test_condition_branches(client, auth):
    ag = agent_id(client, auth)
    cond = {"id": "c", "title": "c", "kind": "condition", "mode": "rule", "rule": {"op": "contains", "value": "echo["}}
    wid = make(client, auth, [hnode("a", ag), cond, hnode("yes", ag), hnode("no", ag)],
               [edge("a", "c"), edge("c", "yes", sourceHandle="true"), edge("c", "no", sourceHandle="false")])
    d = wait(client, auth, run(client, auth, wid))
    ns = d["node_states"]
    assert ns["c"]["decision"] is True and ns["yes"]["status"] == "completed" and ns["no"]["status"] == "skipped"
    assert d["status"] == "completed"


def test_condition_ai_yes_no(client, auth):
    ag = agent_id(client, auth)
    # fake gateway echoes the prompt; prompt starting with YES makes parse_yes_no → True
    cond = {"id": "c", "title": "c", "kind": "condition", "mode": "ai", "agent_id": ag, "prompt": "judge"}
    wid = make(client, auth, [hnode("a", ag, prompt="YES this is fine"), cond, hnode("t", ag), hnode("f", ag)],
               [edge("a", "c"), edge("c", "t", sourceHandle="true"), edge("c", "f", sourceHandle="false")])
    d = wait(client, auth, run(client, auth, wid))
    ns = d["node_states"]  # echo contains the word YES → parsed True
    assert ns["c"]["decision"] is True and ns["t"]["status"] == "completed" and ns["f"]["status"] == "skipped"
    assert ns["c"]["session_id"]  # AI judge has its own conversation


def test_loop_max_iterations(client, auth):
    ag = agent_id(client, auth)
    loop = {"id": "L", "title": "L", "kind": "loop", "max_iterations": 2}
    edges = [edge("s", "L"), edge("L", "body", sourceHandle="body"), edge("body", "L", loop_back=True), edge("L", "end", sourceHandle="exit")]
    nodes = [hnode("s", ag), loop, hnode("body", ag), hnode("end", ag)]
    validate_workflow(nodes, edges)
    assert loop_body(nodes, edges, "L") == {"body"}
    wid = make(client, auth, nodes, edges)
    d = wait(client, auth, run(client, auth, wid))
    ns = d["node_states"]
    assert d["status"] == "completed", d["error"]
    assert ns["body"]["attempt"] == 2 and ns["L"]["iterations"] == 2 and ns["L"]["attempt"] == 3
    assert ns["end"]["status"] == "completed" and "達上限 2 次" in ns["L"]["output"]
    assert sum(1 for e in d["events"] if e["type"] == "loop.iteration") == 2


def test_loop_until_condition(client, auth):
    ag = agent_id(client, auth)
    loop = {"id": "L", "title": "L", "kind": "loop", "max_iterations": 5, "until": {"op": "contains", "value": "echo["}}
    edges = [edge("s", "L"), edge("L", "body", sourceHandle="body"), edge("body", "L", loop_back=True), edge("L", "end", sourceHandle="exit")]
    wid = make(client, auth, [hnode("s", ag), loop, hnode("body", ag), hnode("end", ag)], edges)
    d = wait(client, auth, run(client, auth, wid))
    assert d["status"] == "completed" and d["node_states"]["L"]["iterations"] == 1 and "條件成立" in d["node_states"]["L"]["output"]


def test_loop_validation():
    ag = "ag"
    loop = {"id": "L", "title": "L", "kind": "loop", "max_iterations": 2}
    with pytest.raises(WorkflowValidationError, match="loop_back"):  # cycle without loop_back flag
        validate_workflow([hnode("a", ag), hnode("b", ag)], [edge("a", "b"), edge("b", "a")])
    with pytest.raises(WorkflowValidationError, match="target 必須是 loop"):
        validate_workflow([hnode("a", ag), hnode("b", ag)], [edge("a", "b"), edge("b", "a", loop_back=True)])
    with pytest.raises(WorkflowValidationError, match="不在 loop 節點"):  # back edge from outside the body
        validate_workflow([hnode("s", ag), loop, hnode("x", ag)], [edge("s", "L"), edge("L", "x", sourceHandle="exit"), edge("x", "L", loop_back=True)])
    with pytest.raises(WorkflowValidationError, match="body/exit"):
        validate_workflow([loop, hnode("x", ag)], [edge("L", "x", sourceHandle="true")])
    with pytest.raises(WorkflowValidationError, match="max_iterations"):
        validate_workflow([{"id": "L", "kind": "loop", "max_iterations": 0}], [])


def test_gate_reject_then_approve(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), {"id": "g", "title": "審批", "kind": "gate"}, hnode("b", ag)], [edge("a", "g"), edge("g", "b")])
    rid = run(client, auth, wid)
    d = wait(client, auth, rid, until={"waiting_approval"})
    assert d["node_states"]["g"]["status"] == "waiting_approval"
    pend = client.get("/workflow-approvals", headers=auth).json()
    assert len(pend) == 1 and pend[0]["run_id"] == rid and "echo[" in pend[0]["payload"]
    first_session = d["node_states"]["a"]["session_id"]
    r = client.post(f"/workflow-approvals/{pend[0]['id']}/reject", json={"comment": "太短，重寫"}, headers=auth)
    assert r.status_code == 200
    # upstream reruns with the comment, then gate waits again
    d = wait(client, auth, rid, until={"waiting_approval"})
    ns = d["node_states"]
    assert ns["a"]["attempt"] == 2 and ns["a"]["session_id"] != first_session
    assert "[退回意見]\n太短，重寫" in user_msg(client, auth, ns["a"]["session_id"])
    pend = client.get("/workflow-approvals", headers=auth).json()
    assert len(pend) == 1 and pend[0]["status"] == "pending"
    assert client.post(f"/workflow-approvals/{pend[0]['id']}/approve", json={"comment": "OK"}, headers=auth).status_code == 200
    d = wait(client, auth, rid)
    assert d["status"] == "completed" and d["node_states"]["b"]["status"] == "completed"
    assert "[審批意見]\nOK" in user_msg(client, auth, d["node_states"]["b"]["session_id"])
    allap = client.get("/workflow-approvals?status=all", headers=auth).json()
    assert sorted(a["status"] for a in allap) == ["approved", "rejected"]
    assert client.post(f"/workflow-approvals/{pend[0]['id']}/approve", headers=auth).status_code == 409
    kinds = [e["type"] for e in d["events"]]
    assert kinds.count("approval.request") == 2 and kinds.count("approval.decided") == 2


def test_stop_while_waiting_gate_and_rerun_from_node(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), {"id": "g", "kind": "gate", "title": "g"}, hnode("b", ag)], [edge("a", "g"), edge("g", "b")])
    rid = run(client, auth, wid)
    wait(client, auth, rid, until={"waiting_approval"})
    assert client.post(f"/workflow-runs/{rid}/rerun", headers=auth).status_code == 409
    assert client.post(f"/workflow-runs/{rid}/stop", headers=auth).json()["status"] == "stopped"
    d = wait(client, auth, rid)
    assert d["status"] == "stopped" and d["node_states"]["g"]["status"] == "stopped" and d["node_states"]["b"]["status"] == "skipped"
    assert client.get("/workflow-approvals?status=cancelled", headers=auth).json()[0]["run_id"] == rid
    assert client.post(f"/workflow-runs/{rid}/stop", headers=auth).status_code == 409
    # rerun from the gate: a is reused (no new session), gate waits again
    r = client.post(f"/workflow-runs/{rid}/rerun", json={"from_node": "g"}, headers=auth)
    assert r.status_code == 202 and r.json()["parent_run_id"] == rid
    rid2 = r.json()["run_id"]
    d2 = wait(client, auth, rid2, until={"waiting_approval"})
    assert d2["trigger"] == "rerun" and d2["node_states"]["a"]["status"] == "reused"
    assert d2["node_states"]["a"]["session_id"] == d["node_states"]["a"]["session_id"]
    ap = [a for a in client.get("/workflow-approvals", headers=auth).json() if a["run_id"] == rid2][0]
    client.post(f"/workflow-approvals/{ap['id']}/approve", headers=auth)
    assert wait(client, auth, rid2)["status"] == "completed"
    assert client.post(f"/workflow-runs/{rid2}/rerun", json={"from_node": "zzz"}, headers=auth).status_code == 400


def test_budget_stop(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag), hnode("c", ag)], [edge("a", "b"), edge("b", "c")], budget={"max_tokens": 4})
    d = wait(client, auth, run(client, auth, wid))
    assert d["status"] == "budget_exceeded" and "token 預算" in d["error"]
    assert d["node_states"]["a"]["status"] == "completed"
    assert d["node_states"]["c"]["status"] == "skipped"


def test_deadline_timeout(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), {"id": "g", "kind": "gate", "title": "g"}], [edge("a", "g")], budget={"deadline_seconds": 0.3})
    d = wait(client, auth, run(client, auth, wid))
    assert d["status"] == "timeout" and "期限" in d["error"]


def test_coding_agent_skip_and_mock(client, auth, app):
    eng = app.state.workflow_engine
    ag = agent_id(client, auth)
    node = {"id": "cc", "title": "cc", "kind": "coding-agent", "tool": "pi", "prompt": "fix it", "cwd": ""}
    eng.coding_available = lambda tool: None
    wid = make(client, auth, [node, hnode("b", ag)], [edge("cc", "b")])
    d = wait(client, auth, run(client, auth, wid))
    assert d["status"] == "completed" and d["node_states"]["cc"]["skipped_reason"] == "pi 未安裝"
    calls = []

    async def fake_runner(tool, prompt, cwd, *, on_delta=None, timeout=0):
        calls.append((tool, prompt, cwd))
        await on_delta("hello ")
        return {"output": "patched 3 files", "exit_code": 0, "usage": {"input_tokens": 10, "output_tokens": 5, "cost_usd": 0.01}}

    eng.coding_available = lambda tool: "/usr/bin/fake"
    eng.coding_runner = fake_runner
    d = wait(client, auth, run(client, auth, wid))
    assert d["node_states"]["cc"]["output"] == "patched 3 files" and calls[0][0] == "pi" and "[本節點任務]\nfix it" in calls[0][1]
    assert d["usage"]["cost_usd"] == 0.01
    assert "patched 3 files" in user_msg(client, auth, d["node_states"]["b"]["session_id"])
    env = client.get("/workflow-env", headers=auth).json()
    assert set(env["coding_tools"]) == {"claude-code", "codex", "pi"} and env["line_configured"] is False


def test_delivery_file_webhook_line(client, auth, app, tmp_path):
    ag = agent_id(client, auth)
    nodes = [hnode("a", ag), {"id": "f", "title": "f", "kind": "delivery", "channel": "file", "path": "out/{run_id}.md", "template": "# {{workflow}}\n{{text}}"}]
    wid = make(client, auth, nodes, [edge("a", "f")], name="投遞")
    rid = run(client, auth, wid)
    d = wait(client, auth, rid)
    assert d["status"] == "completed"
    p = tmp_path / "workspace" / "out" / f"{rid}.md"
    assert p.exists() and p.read_text().startswith("# 投遞\n### 節點a")
    # LINE without token → failed with clear message
    nodes = [hnode("a", ag), {"id": "l", "title": "l", "kind": "delivery", "channel": "line", "to": "Uxxx"}]
    d = wait(client, auth, run(client, auth, make(client, auth, nodes, [edge("a", "l")])))
    assert d["node_states"]["l"]["status"] == "failed" and "LINE 未設定" in d["node_states"]["l"]["error"]
    # path escaping the workspace is refused
    nodes = [hnode("a", ag), {"id": "f", "title": "f", "kind": "delivery", "channel": "file", "path": "../../etc/x"}]
    d = wait(client, auth, run(client, auth, make(client, auth, nodes, [edge("a", "f")])))
    assert d["node_states"]["f"]["status"] == "failed" and "工作區" in d["node_states"]["f"]["error"]


def test_webhook_trigger(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag)], [])
    w = client.post(f"/workflows/{wid}/webhooks", headers=auth).json()
    assert w["path"].startswith("/webhooks/wf/")
    assert client.post("/webhooks/wf/nope", json={}).status_code == 404
    r = client.post(w["path"], json={"text": "外部來的題目", "extra": 1})
    assert r.status_code == 202
    d = wait(client, auth, r.json()["run_id"])
    assert d["trigger"] == "webhook" and d["input"]["payload"]["extra"] == 1
    assert "### 外部輸入\n外部來的題目" in user_msg(client, auth, d["node_states"]["a"]["session_id"])
    assert client.get(f"/workflows/{wid}/webhooks", headers=auth).json()[0]["hits"] == 1
    assert client.delete(f"/workflow-webhooks/{w['id']}", headers=auth).json()["ok"]
    assert client.post(w["path"], json={}).status_code == 404


def test_schedule_and_cron(client, auth, app):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag)], [])
    assert client.post(f"/workflows/{wid}/schedules", json={"cron": "bad"}, headers=auth).status_code == 422
    s = client.post(f"/workflows/{wid}/schedules", json={"cron": "*/5 * * * *", "input": {"text": "排程輸入"}}, headers=auth).json()
    assert s["next_run_at"] and s["enabled"]
    sched = app.state.workflow_scheduler
    from datetime import datetime
    nxt = datetime.fromisoformat(s["next_run_at"])
    import anyio
    fired = anyio.from_thread.run(sched.tick, nxt) if False else None  # placeholder for readability
    # drive the scheduler on the app loop via a run in the test client's portal
    from studio.modules.workflows.scheduler import WorkflowScheduler  # noqa
    import asyncio

    async def _tick():
        return await sched.tick(nxt)
    # TestClient runs the app in its own portal; call through it
    fired = client.portal.call(_tick)
    assert fired == 1
    s2 = client.get(f"/workflows/{wid}/schedules", headers=auth).json()[0]
    assert s2["last_run_id"] and datetime.fromisoformat(s2["next_run_at"]) > nxt
    d = wait(client, auth, s2["last_run_id"])
    assert d["trigger"] == "schedule" and "排程輸入" in user_msg(client, auth, d["node_states"]["a"]["session_id"])
    assert client.patch(f"/workflow-schedules/{s['id']}", json={"enabled": False}, headers=auth).json()["enabled"] is False
    assert client.patch(f"/workflow-schedules/{s['id']}", json={"cron": "61 * * * *"}, headers=auth).status_code == 422
    assert client.delete(f"/workflow-schedules/{s['id']}", headers=auth).json()["ok"]
    # cron helper
    from datetime import datetime as dt
    assert matches("30 9 * * 1-5", dt(2026, 8, 31, 9, 30))  # Monday
    assert not matches("30 9 * * 1-5", dt(2026, 8, 30, 9, 30))  # Sunday
    assert next_run("0 0 1 * *", dt(2026, 8, 29, 12, 0)) == dt(2026, 9, 1, 0, 0)
    assert parse_cron("0 */6 * * 0,7")[1] == {0, 6, 12, 18}
    for bad in ("* * *", "60 * * * *", "a * * * *", "*/0 * * * *"):
        with pytest.raises(CronError):
            parse_cron(bad)


def test_import_export_batch_delete(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag)], [edge("a", "b")], name="原本", profile="researcher", budget={"max_tokens": 100})
    exp = client.get(f"/workflows/{wid}/export", headers=auth).json()
    assert exp["format"] == "myhermescompany.workflow" and exp["format_version"] == 1 and exp["workflow"]["profile"] == "researcher"
    r = client.post("/workflows/import", json={"data": exp, "name": "複本"}, headers=auth)
    assert r.status_code == 201 and r.json()["name"] == "複本" and r.json()["budget"] == {"max_tokens": 100}
    assert client.post("/workflows/import", json={"data": {"format": "x"}}, headers=auth).status_code == 422
    bad = dict(exp, workflow=dict(exp["workflow"], edges=[edge("a", "b"), edge("b", "a")]))
    assert client.post("/workflows/import", json={"data": bad}, headers=auth).status_code == 422
    assert len(client.get("/workflows?profile=researcher", headers=auth).json()) == 2
    assert len(client.get("/workflows?profile=writer", headers=auth).json()) == 0
    # version bumps on graph edit
    v = client.patch(f"/workflows/{wid}", json={"nodes": [hnode("a", ag)], "edges": []}, headers=auth).json()["version"]
    assert v == 2
    ids = [w["id"] for w in client.get("/workflows", headers=auth).json()]
    assert client.post("/workflows/batch-delete", json={"ids": ids + ["wf_nope"]}, headers=auth).json()["deleted"] == 2
    assert client.get("/workflows", headers=auth).json() == []


def test_ws_workflows_events(client, auth, token):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag)], [])
    with client.websocket_connect(f"/ws/workflows?token={token}") as ws:
        assert ws.receive_json()["type"] == "ready"
        rid = run(client, auth, wid)
        seen = []
        for _ in range(30):
            ev = ws.receive_json()
            seen.append(ev["type"])
            if ev["type"] == "run.status" and ev["status"] in TERMINAL:
                break
        assert seen[0] == "run.status" and "node.status" in seen and "node.delta" in seen
        assert seen[-1] == "run.status"
    assert wait(client, auth, rid)["status"] == "completed"


def test_condition_helpers():
    assert evaluate_rule({"op": "regex", "value": "^ab+c$"}, "abbbc")[0]
    assert not evaluate_rule({"op": "regex", "value": "("}, "x")[0]
    assert evaluate_rule({"op": "json_path", "path": "$.items[1].ok", "value": "true"}, 'text ```json\n{"items":[{},{"ok":true}]}\n```')[0]
    assert evaluate_rule({"op": "json_path", "path": "a.b"}, '{"a":{"b":"x"}}')[0]
    assert not evaluate_rule({"op": "json_path", "path": "a.b"}, 'not json')[0]
    assert evaluate_rule({"op": "min_length", "value": 3}, "abcd")[0] and not evaluate_rule({"op": "max_length", "value": 3}, "abcd")[0]
    assert evaluate_rule({"op": "not_contains", "value": "z"}, "abc")[0] and evaluate_rule({"op": "equals", "value": " a "}, "a")[0]
    assert parse_yes_no("YES\n理由") is True and parse_yes_no("No.") is False and parse_yes_no("是的") is True
    assert parse_yes_no("否，不行") is False and parse_yes_no("嗯") is None
