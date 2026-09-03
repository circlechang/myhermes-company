"""試跑這一站（POST /workflows/{wf}/nodes/{node}/try）：只跑一站、借上一次的上游結果、不污染正式紀錄。"""
from __future__ import annotations

from test_workflow_engine import agent_id, edge, hnode, make, run, user_msg, wait


def try_node(client, auth, wid, nid, body=None):
    return client.post(f"/workflows/{wid}/nodes/{nid}/try", json=body or {}, headers=auth)


def test_try_hermes_node_with_latest_upstream(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag)], [edge("a", "b")], name="試跑")
    # 還沒正式跑過：只有 [外部輸入]
    r = try_node(client, auth, wid, "b", {"input": "先用這段試"})
    assert r.status_code == 202, r.text
    assert r.json()["upstream_run_id"] is None
    d = wait(client, auth, r.json()["run_id"])
    assert d["status"] == "completed" and d["trigger"] == "try"
    assert [n["id"] for n in d["snapshot"]["nodes"]] == ["b"] and d["snapshot"]["edges"] == []
    assert "echo[researcher" in d["node_states"]["b"]["output"]
    m = user_msg(client, auth, d["node_states"]["b"]["session_id"])
    assert "### 外部輸入\n先用這段試" in m and "### 節點a" not in m and "[本節點任務]\ndo b" in m
    # 正式跑一次後再試跑 b：上游 a 的輸出用 [上游結果] 帶進來，排版跟正式執行一樣
    rid = run(client, auth, wid)
    d1 = wait(client, auth, rid)
    assert d1["status"] == "completed"
    r = try_node(client, auth, wid, "b")
    assert r.status_code == 202 and r.json()["upstream_run_id"] == rid
    d2 = wait(client, auth, r.json()["run_id"])
    assert d2["status"] == "completed"
    m2 = user_msg(client, auth, d2["node_states"]["b"]["session_id"])
    formal = user_msg(client, auth, d1["node_states"]["b"]["session_id"])
    assert m2 == formal, (m2, formal)
    assert m2.startswith("[上游結果]\n### 節點a\n")
    # WS 事件照常寫進 events（前端靠這些更新站卡）
    assert any(ev["type"] == "node.status" and ev["node_id"] == "b" and ev["status"] == "completed" for ev in d2["events"])
    # 完整輸出端點對試跑也有效
    out = client.get(f"/workflow-runs/{d2['id']}/nodes/b/output", headers=auth).json()
    assert out["content"] == d2["node_states"]["b"]["output"]


def test_try_gate_and_missing_node_rejected(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), {"id": "g", "title": "等我確認", "kind": "gate"}], [edge("a", "g")])
    r = try_node(client, auth, wid, "g")
    assert r.status_code == 422 and r.json()["error"]["code"] == "node_not_triable" and "等我確認" in r.json()["error"]["message"]
    assert try_node(client, auth, wid, "zzz").status_code == 404
    # 看情況分岔／重複直到 也不能試跑
    wc = make(client, auth, [hnode("a", ag), {"id": "k", "title": "k", "kind": "condition", "mode": "rule", "rule": {"op": "contains", "value": "x"}}, hnode("b", ag)],
              [edge("a", "k"), edge("k", "b", sourceHandle="true")])
    assert try_node(client, auth, wc, "k").status_code == 422
    wl = make(client, auth, [hnode("s", ag), {"id": "L", "title": "L", "kind": "loop", "max_iterations": 2}, hnode("body", ag), hnode("end", ag)],
              [edge("s", "L"), edge("L", "body", sourceHandle="body"), edge("body", "L", loop_back=True), edge("L", "end", sourceHandle="exit")])
    assert try_node(client, auth, wl, "L").status_code == 422
    # 迴圈本體那一站可以試跑（它是 AI 員工站）
    assert try_node(client, auth, wl, "body").status_code == 202


def test_try_run_excluded_from_history_and_rerun_parent(client, auth):
    ag = agent_id(client, auth)
    wid = make(client, auth, [hnode("a", ag), hnode("b", ag)], [edge("a", "b")])
    rid = run(client, auth, wid)
    wait(client, auth, rid)
    r = try_node(client, auth, wid, "b")
    trid = r.json()["run_id"]
    wait(client, auth, trid)
    # 歷史清單／全公司清單預設看不到試跑（「上一次的產出」永遠是正式執行）
    runs = client.get(f"/workflows/{wid}/runs", headers=auth).json()
    assert [x["id"] for x in runs] == [rid]
    assert trid in [x["id"] for x in client.get(f"/workflows/{wid}/runs?include_try=true", headers=auth).json()]
    assert trid not in [x["id"] for x in client.get("/workflow-runs", headers=auth).json()]
    # 試跑不能當重跑的父 run；正式 run 的重跑父 run 仍是正式 run
    r = client.post(f"/workflow-runs/{trid}/rerun", json={}, headers=auth)
    assert r.status_code == 422 and r.json()["error"]["code"] == "try_run"
    r = client.post(f"/workflow-runs/{rid}/rerun", json={"from_node": "b"}, headers=auth)
    assert r.status_code == 202 and r.json()["parent_run_id"] == rid
    d = wait(client, auth, r.json()["run_id"])
    assert d["parent_run_id"] == rid and d["node_states"]["a"]["status"] == "reused"
    # 再試跑 b：借的是最新的正式 run（重跑那筆），不是之前的試跑
    r = try_node(client, auth, wid, "b")
    assert r.json()["upstream_run_id"] == d["id"]
    wait(client, auth, r.json()["run_id"])
