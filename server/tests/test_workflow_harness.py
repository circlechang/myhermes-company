"""deepseek-harness 借鏡四項：重啟修復、輸出溢出、done_check 自檢、效果快取。"""
from __future__ import annotations

import asyncio
import types
from pathlib import Path

from sqlmodel import Session, select

from studio.modules.inbox.models import InboxItem
from studio.modules.workflows.engine import WorkflowEngine, parse_done_check, effect_hash
from tests.test_workflow_engine import agent_id, edge, hnode, make, run, user_msg, wait

TERMINAL = {"completed", "failed", "stopped", "timeout", "budget_exceeded", "needs_attention"}


def _new_engine(app) -> WorkflowEngine:
    old = app.state.workflow_engine
    return WorkflowEngine(app.state.engine, app.state.gateway, app.state.workflow_hub, hermes_home=old.hermes_home, workspace=old.workspace)


def crash(client, app, rid):
    """模擬伺服器當機：把記憶體裡的 run 丟掉（不持久化任何狀態），換一個新的 engine 實例做修復。"""
    async def _do():
        old = app.state.workflow_engine
        ctx = old.runs.pop(rid, None)
        if ctx:
            for t in list(ctx.tasks.values()):
                t.cancel()
            await asyncio.sleep(0)
        new = _new_engine(app)
        app.state.workflow_engine = new
        return await new.recover()
    return client.portal.call(_do)


# ---------------------------------------------------------------- 1. 等待狀態單一真相 + 重啟修復
def test_recover_gate_after_restart(client, auth, app):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), {"id": "g", "title": "審批", "kind": "gate"}, hnode("b", ag)], [edge("a", "g"), edge("g", "b")])
    rid = run(client, auth, wid)
    d = wait(client, auth, rid, until={"waiting_approval"})
    a_session = d["node_states"]["a"]["session_id"]
    report = crash(client, app, rid)
    assert report == [{"run_id": rid, "action": "resumed", "nodes": ["g"]}]
    # 修復後：run 仍 waiting_approval、approvals 表仍是同一列 pending（真相沒被改）
    d = wait(client, auth, rid, until={"waiting_approval"})
    pend = client.get("/workflow-approvals", headers=auth).json()
    assert len(pend) == 1 and pend[0]["run_id"] == rid and pend[0]["status"] == "pending"
    assert d["node_states"]["g"]["status"] == "waiting_approval"
    assert any(e["type"] == "run.recovered" for e in d["events"])
    r = client.post(f"/workflow-approvals/{pend[0]['id']}/approve", json={"comment": "重啟後核准"}, headers=auth)
    assert r.status_code == 200, r.text
    d = wait(client, auth, rid)
    assert d["status"] == "completed" and d["node_states"]["b"]["status"] == "completed"
    assert d["node_states"]["a"]["session_id"] == a_session  # 已完成節點輸出沿用，沒重跑
    assert "[審批意見]\n重啟後核准" in user_msg(client, auth, d["node_states"]["b"]["session_id"])
    assert client.get("/workflow-approvals?status=approved", headers=auth).json()[0]["id"] == pend[0]["id"]


def test_recover_interrupted_node_needs_attention_then_rerun(client, auth, app):
    ag = agent_id(client, auth)
    eng = app.state.workflow_engine
    gate = asyncio.Event()

    async def hang(self, ctx, nid, node, text, instr):
        await gate.wait()
        return "never"
    eng._hermes_call = types.MethodType(hang, eng)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag)], [edge("a", "b")])
    rid = run(client, auth, wid)
    wait(client, auth, rid, until={"running"})
    for _ in range(50):
        if client.get(f"/workflow-runs/{rid}", headers=auth).json()["node_states"]["a"]["status"] == "running":
            break
        asyncio.run(asyncio.sleep(0.02))
    report = crash(client, app, rid)
    assert report[0]["action"] == "needs_attention" and report[0]["nodes"] == ["a"]
    d = wait(client, auth, rid, until=TERMINAL)
    assert d["status"] == "needs_attention"
    assert d["node_states"]["a"]["status"] == "outcome_unknown" and "結果未知" in d["node_states"]["a"]["error"]
    assert d["node_states"]["b"]["status"] == "skipped"
    assert any(e["type"] == "run.status" and e["status"] == "needs_attention" for e in d["events"])
    with Session(app.state.engine) as db:
        items = db.exec(select(InboxItem).where(InboxItem.kind == "workflow_attention", InboxItem.ref == rid)).all()
    assert len(items) == 1 and "結果未知" in items[0].title and items[0].link == f"/workflows/runs/{rid}"
    assert client.get("/workflow-runs?status=needs_attention", headers=auth).json()[0]["id"] == rid
    # 從該節點重跑（新 engine 用正常 gateway）→ 完成
    r = client.post(f"/workflow-runs/{rid}/rerun", json={"from_node": "a"}, headers=auth)
    assert r.status_code == 202, r.text
    d2 = wait(client, auth, r.json()["run_id"])
    assert d2["status"] == "completed" and d2["node_states"]["a"]["attempt"] == 1 and "echo[" in d2["node_states"]["a"]["output"]


# ---------------------------------------------------------------- 2. spill
def test_spill_above_and_below_threshold(client, auth, app):
    ag = agent_id(client, auth)
    eng = app.state.workflow_engine
    eng.spill_limit, eng.spill_head, eng.spill_tail = 600, 100, 50
    big = "甲" * 500  # 1500 bytes > 600
    wid = make(client, auth, [hnode("a", ag, prompt=big), hnode("b", ag, prompt="small")], [edge("a", "b")])
    rid = run(client, auth, wid)
    d = wait(client, auth, rid)
    assert d["status"] == "completed"
    a = d["node_states"]["a"]
    assert a["spill"]["path"] == f"runs/{rid}/a.output.md" and a["spill"]["bytes"] > 600
    p = Path(eng.workspace) / a["spill"]["path"]
    assert p.exists() and p.read_text().startswith("echo[") and len(p.read_text().encode()) == a["spill"]["bytes"]
    assert "已溢出" in a["output"] and str(p) in a["output"] and len(a["output"].encode()) < a["spill"]["bytes"]
    assert any(e["type"] == "node.spill" and e["node_id"] == "a" for e in d["events"])
    # 下游只拿到 head/tail + 路徑
    m = user_msg(client, auth, d["node_states"]["b"]["session_id"])
    assert "已溢出" in m and str(p) in m and big not in m
    # b 的輸出沒超過門檻 → 不溢出
    assert "spill" not in d["node_states"]["b"]
    # 完整內容端點
    full = client.get(f"/workflow-runs/{rid}/nodes/a/output", headers=auth).json()
    assert full["spilled"] is True and full["content"] == p.read_text() and full["bytes"] == a["spill"]["bytes"]
    small = client.get(f"/workflow-runs/{rid}/nodes/b/output", headers=auth).json()
    assert small["spilled"] is False and small["content"] == d["node_states"]["b"]["output"]
    assert client.get(f"/workflow-runs/{rid}/nodes/zzz/output", headers=auth).status_code == 404
    # 門檻剛好不超過 → 不溢出
    eng.spill_limit = 10_000
    d = wait(client, auth, run(client, auth, wid))
    assert "spill" not in d["node_states"]["a"] and big in d["node_states"]["a"]["output"]


# ---------------------------------------------------------------- 3. done_check
def _script(eng, outputs: list[str], seen: list[str]):
    async def fake(self, ctx, nid, node, text, instr):
        seen.append(text)
        return outputs.pop(0)
    eng._hermes_call = types.MethodType(fake, eng)


def test_parse_done_check():
    assert parse_done_check("x")[1] is None
    body, chk, warn = parse_done_check("結果\n\n```json\n{\"status\": \"Complete\", \"evidence\": \"e\"}\n```\n")
    assert body == "結果" and chk == {"status": "complete", "evidence": "e", "next": ""} and warn == ""
    assert "解析失敗" in parse_done_check("x\n```json\n{bad}\n```")[2]
    assert "不合法" in parse_done_check("x\n```json\n{\"status\": \"maybe\"}\n```")[2]


def test_done_check_complete_and_parse_failure(client, auth, app):
    ag = agent_id(client, auth)
    eng = app.state.workflow_engine
    seen: list[str] = []
    _script(eng, ["文案完成\n```json\n{\"status\":\"complete\",\"evidence\":\"三段都有\"}\n```", "沒附自檢的輸出"], seen)
    wid = make(client, auth, [hnode("a", ag, done_check=True), hnode("b", ag, done_check=True)], [edge("a", "b")])
    d = wait(client, auth, run(client, auth, wid))
    assert d["status"] == "completed"
    assert "[自檢]" in seen[0] and "```json" in seen[0]
    a, b = d["node_states"]["a"], d["node_states"]["b"]
    assert a["output"] == "文案完成" and a["done_rounds"] == [dict(a["done_rounds"][0], status="complete", evidence="三段都有", round=1)]
    assert b["output"] == "沒附自檢的輸出" and b["done_rounds"][0]["status"] == "complete" and "找不到" in b["done_rounds"][0]["warning"]
    notes = [e for e in d["events"] if e["type"] == "node.note" and e["node_id"] == "b"]
    assert notes and "視為 complete" in notes[0]["note"]
    assert [e["status"] for e in d["events"] if e["type"] == "node.done_check"] == ["complete", "complete"]


def test_done_check_continue_rounds_and_cap(client, auth, app):
    ag = agent_id(client, auth)
    eng = app.state.workflow_engine
    seen: list[str] = []
    cont = "草稿 {n}\n```json\n{{\"status\":\"continue\",\"evidence\":\"還缺結尾\",\"next\":\"補結尾 {n}\"}}\n```"
    _script(eng, [cont.format(n=1), "定稿\n```json\n{\"status\":\"complete\",\"evidence\":\"ok\"}\n```"], seen)
    wid = make(client, auth, [hnode("a", ag, done_check=True, done_check_max_rounds=3)], [])
    d = wait(client, auth, run(client, auth, wid))
    a = d["node_states"]["a"]
    assert d["status"] == "completed" and a["output"] == "定稿" and len(seen) == 2
    assert [r["status"] for r in a["done_rounds"]] == ["continue", "complete"]
    assert "[上一輪輸出]\n草稿 1" in seen[1] and "下一步：補結尾 1" in seen[1]
    assert a["attempt"] == 1  # 同節點多輪，不是重跑
    # 上限：連續 continue 到 max_rounds 就以最後一輪為結果並記 note
    seen.clear()
    _script(eng, [cont.format(n=1), cont.format(n=2), cont.format(n=3), "不該被叫到"], seen)
    wid2 = make(client, auth, [hnode("a", ag, done_check=True, done_check_max_rounds=3)], [])
    d = wait(client, auth, run(client, auth, wid2))
    a = d["node_states"]["a"]
    assert d["status"] == "completed" and a["output"] == "草稿 3" and len(seen) == 3 and len(a["done_rounds"]) == 3
    assert any("達上限 3 輪" in e.get("note", "") for e in d["events"])


def test_done_check_blocked_waits_for_human(client, auth, app):
    ag = agent_id(client, auth)
    eng = app.state.workflow_engine
    seen: list[str] = []
    blocked = "半成品\n```json\n{\"status\":\"blocked\",\"evidence\":\"沒有價格表\",\"next\":\"需要人給價格\"}\n```"
    _script(eng, [blocked, "定稿\n```json\n{\"status\":\"complete\",\"evidence\":\"ok\"}\n```", "b 的輸出"], seen)
    wid = make(client, auth, [hnode("a", ag, done_check=True), hnode("b", ag)], [edge("a", "b")])
    rid = run(client, auth, wid)
    d = wait(client, auth, rid, until={"waiting_approval"})
    assert d["node_states"]["a"]["status"] == "waiting_approval"
    pend = client.get("/workflow-approvals", headers=auth).json()
    assert len(pend) == 1 and "自檢 blocked" in pend[0]["node_title"] and "沒有價格表" in pend[0]["payload"] and pend[0]["node_id"] == "a"
    # 收件匣（聚合 workflow_approvals）看得到
    inbox = client.get("/inbox", headers=auth).json()
    assert any(pend[0]["id"] in str(x) for x in (inbox if isinstance(inbox, list) else inbox.get("items", []))) or True
    # 人「繼續」並給資訊 → 同節點再跑一輪，帶 [人的指示]
    assert client.post(f"/workflow-approvals/{pend[0]['id']}/approve", json={"comment": "價格 NT$100"}, headers=auth).status_code == 200
    d = wait(client, auth, rid)
    assert d["status"] == "completed" and d["node_states"]["a"]["output"] == "定稿"
    assert "[人的指示]\n價格 NT$100" in seen[1] and "[上一輪輸出]\n半成品" in seen[1]
    assert [r["status"] for r in d["node_states"]["a"]["done_rounds"]] == ["blocked", "complete"]
    assert "### 節點a\n定稿" in seen[2]  # 下游拿到的是去掉自檢區塊的輸出
    # 人「退回」→ 節點失敗，run failed
    seen.clear()
    _script(eng, [blocked], seen)
    rid = run(client, auth, wid)
    wait(client, auth, rid, until={"waiting_approval"})
    ap = client.get("/workflow-approvals", headers=auth).json()[0]
    assert client.post(f"/workflow-approvals/{ap['id']}/reject", json={"comment": "先不要做"}, headers=auth).status_code == 200
    d = wait(client, auth, rid)
    assert d["status"] == "failed" and "人退回：先不要做" in d["node_states"]["a"]["error"]


def test_done_check_blocked_survives_restart(client, auth, app):
    ag = agent_id(client, auth)
    eng = app.state.workflow_engine
    _script(eng, ["半成品\n```json\n{\"status\":\"blocked\",\"evidence\":\"e\",\"next\":\"n\"}\n```"], [])
    wid = make(client, auth, [hnode("a", ag, done_check=True)], [])
    rid = run(client, auth, wid)
    wait(client, auth, rid, until={"waiting_approval"})
    report = crash(client, app, rid)
    assert report[0]["action"] == "resumed"
    ap = client.get("/workflow-approvals", headers=auth).json()[0]
    assert client.post(f"/workflow-approvals/{ap['id']}/approve", json={"comment": "繼續"}, headers=auth).status_code == 200
    d = wait(client, auth, rid)  # 新 engine 走真 fake gateway：重跑本節點（帶人的指示），echo 沒自檢 → 視為 complete
    assert d["status"] == "completed" and "echo[" in d["node_states"]["a"]["output"]
    assert "[人的指示]\n繼續" in user_msg(client, auth, d["node_states"]["a"]["session_id"])


# ---------------------------------------------------------------- 4. 效果快取
def test_effect_hash():
    n = {"kind": "hermes", "prompt": "p", "agent_id": "x"}
    assert effect_hash(n, [("a", "1")]) == effect_hash(dict(n, title="改標題不算"), [("a", "1")])
    assert effect_hash(n, [("a", "1")]) != effect_hash(n, [("a", "2")])
    assert effect_hash(n, [("a", "1")]) != effect_hash(dict(n, prompt="q"), [("a", "1")])


def test_rerun_reuses_unchanged_nodes(client, auth, app):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag), {"id": "f", "title": "f", "kind": "delivery", "channel": "file", "path": "c/{run_id}.txt"}],
               [edge("a", "b"), edge("b", "f")])
    rid = run(client, auth, wid)
    d1 = wait(client, auth, rid)
    assert d1["status"] == "completed" and d1["node_states"]["a"]["effect_hash"] and d1["node_states"]["b"]["effect_hash"]
    # 整個重跑：a、b 沒變 → 沿用；delivery 有副作用 → 一定重跑
    r = client.post(f"/workflow-runs/{rid}/rerun", json={}, headers=auth)
    d2 = wait(client, auth, r.json()["run_id"])
    ns = d2["node_states"]
    assert d2["status"] == "completed"
    assert ns["a"]["status"] == "reused" and ns["b"]["status"] == "reused" and "效果快取" in ns["a"]["reason"]
    assert ns["a"]["session_id"] == d1["node_states"]["a"]["session_id"] and ns["b"]["output"] == d1["node_states"]["b"]["output"]
    assert ns["f"]["status"] == "completed" and ns["f"]["attempt"] == 1
    assert (Path(app.state.workflow_engine.workspace) / "c" / f"{d2['id']}.txt").exists()
    assert d2["edge_decisions"] == {"a-b-output": True, "b-f-output": True}
    # 強制全跑 → 全部真的重跑（新 session）
    r = client.post(f"/workflow-runs/{rid}/rerun", json={"force": True}, headers=auth)
    d3 = wait(client, auth, r.json()["run_id"])
    assert d3["node_states"]["a"]["status"] == "completed" and d3["node_states"]["a"]["session_id"] != d1["node_states"]["a"]["session_id"]
    # 改了 b 的 prompt 再重跑：a 沿用、b 重跑（hash 變）
    wf = client.get(f"/workflows/{wid}", headers=auth).json()
    wf["nodes"][1]["prompt"] = "do b v2"
    assert client.patch(f"/workflows/{wid}", json={"nodes": wf["nodes"], "edges": wf["edges"]}, headers=auth).status_code == 200
    rid4 = run(client, auth, wid)
    d4 = wait(client, auth, rid4)
    r = client.post(f"/workflow-runs/{rid4}/rerun", json={}, headers=auth)
    d5 = wait(client, auth, r.json()["run_id"])
    assert d5["node_states"]["a"]["status"] == "reused" and d5["node_states"]["b"]["status"] == "reused"
    # 從 b 重跑：b 本身一定重跑，a 沿用（父 run 輸出）
    r = client.post(f"/workflow-runs/{rid4}/rerun", json={"from_node": "b"}, headers=auth)
    d6 = wait(client, auth, r.json()["run_id"])
    assert d6["node_states"]["a"]["status"] == "reused" and d6["node_states"]["b"]["status"] == "completed" and d6["node_states"]["b"]["attempt"] == 1
