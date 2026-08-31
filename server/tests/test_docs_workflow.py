"""工作流的文件模式節點（io_mode: doc）：transform / fanout / select（human＋ai）/ merge。

fake gateway 會把送進去的訊息原樣 echo 回來，所以把 ```doc 圍欄寫在節點 prompt 裡，
就等於模擬「模型輸出了一份文件」。
"""
from __future__ import annotations

import json
import time

TERMINAL = {"completed", "failed", "stopped", "timeout", "budget_exceeded"}


def agent_id(client, auth, profile="researcher"):
    return next(a["id"] for a in client.get("/agents", headers=auth).json() if a["profile"] == profile)


def make(client, auth, nodes, edges, name="wf"):
    r = client.post("/workflows", json={"name": name, "nodes": nodes, "edges": edges}, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def run(client, auth, wid, body=None):
    r = client.post(f"/workflows/{wid}/run", json=body or {}, headers=auth)
    assert r.status_code == 202, r.text
    return r.json()["run_id"]


def wait(client, auth, rid, until=TERMINAL, timeout=10.0):
    d = {}
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = client.get(f"/workflow-runs/{rid}", headers=auth).json()
        if d["status"] in until:
            return d
        time.sleep(0.03)
    raise AssertionError(f"run {rid} still {d.get('status')}: {json.dumps(d.get('node_states'), ensure_ascii=False)[:600]}")


def fence(*docs: str) -> str:
    return "```doc\n" + "\n---doc---\n".join(docs) + "\n```"


def edge(s, t):
    return {"id": f"{s}-{t}", "source": s, "target": t}


# ------------------------------------------------------------------ transform
def test_transform_creates_doc_with_version_1(client, auth):
    ag = agent_id(client, auth)
    node = {"id": "t", "title": "起草", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "transform",
            "doc_new": True, "doc_path": "docs/spec.md", "doc_stage": "intake",
            "prompt": "寫規格。\n" + fence("# 登入規格\n一、背景\n二、驗收條件")}
    d = wait(client, auth, run(client, auth, make(client, auth, [node], [], name="起草")))
    assert d["status"] == "completed", d["error"]
    st = d["node_states"]["t"]
    assert len(st["doc_ids"]) == 1 and st["docs"][0]["version"] == 1
    doc = client.get(f"/docs/{st['doc_ids'][0]}", headers=auth).json()
    assert doc["path"] == "docs/spec.md" and doc["title"] == "登入規格" and doc["stage"] == "intake"
    assert doc["origin"] == "workflow" and "二、驗收條件" in doc["content"]
    assert "[文件] 登入規格 → v1" in st["output"]


def test_transform_across_runs_finds_doc_by_glob_and_bumps_version(client, auth):
    ag = agent_id(client, auth)
    first = {"id": "t", "title": "起草", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "transform",
             "doc_new": True, "doc_path": "docs/spec.md", "prompt": "起草。\n" + fence("# 規格\n一、背景")}
    r1 = wait(client, auth, run(client, auth, make(client, auth, [first], [], name="一")))
    doc_id = r1["node_states"]["t"]["doc_ids"][0]
    second = {"id": "u", "title": "補完", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "transform",
              "doc_glob": "docs/spec.md", "doc_status": "review",
              "prompt": "補完。\n" + fence("# 規格\n一、背景\n二、驗收條件")}
    r2 = wait(client, auth, run(client, auth, make(client, auth, [second], [], name="二")))
    assert r2["status"] == "completed", r2["error"]
    st = r2["node_states"]["u"]
    assert st["input_doc_ids"] == [doc_id] and st["doc_ids"] == [doc_id]
    doc = client.get(f"/docs/{doc_id}", headers=auth).json()
    assert doc["latest_version"] == 2 and doc["status"] == "review"
    versions = client.get(f"/docs/{doc_id}/versions", headers=auth).json()
    assert versions[0]["diff_stat"]["added"] == 1 and versions[0]["author_kind"] == "agent"


def test_doc_node_without_fence_fails_the_node(client, auth):
    ag = agent_id(client, auth)
    node = {"id": "t", "title": "壞", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "transform",
            "doc_new": True, "doc_path": "docs/x.md", "prompt": "沒有圍欄"}
    d = wait(client, auth, run(client, auth, make(client, auth, [node], [], name="壞")))
    assert d["status"] == "failed"
    assert "圍欄" in d["node_states"]["t"]["error"]


# ------------------------------------------------------------------ fanout
def _fanout_node(ag, nid="f"):
    return {"id": nid, "title": "三個取向", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "fanout",
            "fanout_count": 3, "doc_path_pattern": "docs/{run_id}/draft-{i}.md", "doc_stage": "directions",
            "prompt": "三個取向。\n" + fence("# A 最小可行\n只做一件事", "# B 完整平台\n一次做齊", "# C 外接整合\n不自建")}


def test_fanout_produces_three_docs(client, auth):
    ag = agent_id(client, auth)
    d = wait(client, auth, run(client, auth, make(client, auth, [_fanout_node(ag)], [], name="扇出")))
    assert d["status"] == "completed", d["error"]
    st = d["node_states"]["f"]
    assert len(st["doc_ids"]) == 3
    titles = [x["title"] for x in st["docs"]]
    assert titles == ["A 最小可行", "B 完整平台", "C 外接整合"]
    assert all(x["path"].endswith(f"draft-{i}.md") for i, x in enumerate(st["docs"], start=1))
    docs = client.get("/docs?stage=directions", headers=auth).json()
    assert len(docs) == 3 and all(x["latest_version"] == 1 for x in docs)


def _source_node(ag, nid="src"):
    return {"id": nid, "title": "起草", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "transform",
            "doc_new": True, "doc_path": "docs/spec.md", "doc_stage": "intake",
            "prompt": "起草。\n" + fence("# 母規格\n一、背景")}


def test_full_chain_source_fanout_select_keeps_lineage(client, auth):
    """一份文件從 A 站傳到 B 站再到 C 站：起草 → 分岔 3 份 → AI 挑一份，血緣三種邊都在。"""
    ag = agent_id(client, auth)
    sel = {"id": "s", "title": "挑一份", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "select",
           "select_by": "ai", "criteria": "先看能不能兩週上線", "doc_path": "docs/picked.md", "doc_stage": "pick",
           "prompt": "挑一份。\n選擇：2\n理由：B 的範圍最完整。"}
    wid = make(client, auth, [_source_node(ag), _fanout_node(ag), sel],
               [edge("src", "f"), edge("f", "s")], name="全鏈")
    d = wait(client, auth, run(client, auth, wid))
    assert d["status"] == "completed", d["error"]
    st = d["node_states"]["s"]
    assert len(st["input_doc_ids"]) == 3
    picked = client.get(f"/docs/{st['doc_ids'][0]}", headers=auth).json()
    assert picked["path"] == "docs/picked.md" and "B 完整平台" in picked["content"]
    lin = client.get(f"/docs/{picked['id']}/lineage", headers=auth).json()
    assert any(e["kind"] == "selected" and e["to_doc_id"] == picked["id"] for e in lin["edges"])
    assert sum(1 for e in lin["edges"] if e["kind"] == "split") == 3
    # 母規格 → 三份草稿 → 選中的 → 落地的 picked.md，共 5 個節點
    assert len(lin["nodes"]) == 5


def test_select_by_ai_rejects_out_of_range_choice(client, auth):
    ag = agent_id(client, auth)
    sel = {"id": "s", "title": "挑", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "select",
           "select_by": "ai", "prompt": "挑。\n選擇：9"}
    d = wait(client, auth, run(client, auth, make(client, auth, [_fanout_node(ag), sel], [edge("f", "s")], name="爆")))
    assert d["status"] == "failed"
    assert "不存在的編號" in d["node_states"]["s"]["error"]


def test_fanout_then_select_by_human_is_a_gate(client, auth):
    ag = agent_id(client, auth)
    sel = {"id": "s", "title": "人選一份", "kind": "hermes", "io_mode": "doc", "doc_op": "select",
           "select_by": "human", "doc_path": "docs/spec.md"}
    rid = run(client, auth, make(client, auth, [_fanout_node(ag), sel], [edge("f", "s")], name="閘門"))
    wait(client, auth, rid, until={"waiting_approval"})
    aps = client.get("/workflow-approvals", headers=auth).json()
    a = next(x for x in aps if x["run_id"] == rid)
    assert a["kind"] == "doc_select" and len(a["options"]) == 3
    assert [o["title"] for o in a["options"]] == ["A 最小可行", "B 完整平台", "C 外接整合"]
    assert a["options"][0]["excerpt"].startswith("# A 最小可行")
    # 亂選一個不在清單裡的 → 400
    bad = client.post(f"/workflow-approvals/{a['id']}/approve", json={"choice": "doc_nope"}, headers=auth)
    assert bad.status_code == 400 and bad.json()["error"]["code"] == "bad_choice"
    chosen = a["options"][2]["doc_id"]
    ok = client.post(f"/workflow-approvals/{a['id']}/approve", json={"choice": chosen, "comment": "先做外接"}, headers=auth)
    assert ok.status_code == 200, ok.text
    d = wait(client, auth, rid)
    assert d["status"] == "completed", d["error"]
    spec = client.get(f"/docs/{d['node_states']['s']['doc_ids'][0]}", headers=auth).json()
    assert spec["path"] == "docs/spec.md" and "C 外接整合" in spec["content"]
    assert "先做外接" in d["node_states"]["s"]["select_reason"]


def test_select_human_reject_fails_the_node(client, auth):
    ag = agent_id(client, auth)
    sel = {"id": "s", "title": "人選", "kind": "hermes", "io_mode": "doc", "doc_op": "select", "select_by": "human"}
    rid = run(client, auth, make(client, auth, [_fanout_node(ag), sel], [edge("f", "s")], name="退"))
    wait(client, auth, rid, until={"waiting_approval"})
    a = next(x for x in client.get("/workflow-approvals", headers=auth).json() if x["run_id"] == rid)
    client.post(f"/workflow-approvals/{a['id']}/reject", json={"comment": "三份都不行"}, headers=auth)
    d = wait(client, auth, rid)
    assert d["status"] == "failed" and "三份都不行" in d["node_states"]["s"]["error"]


# ------------------------------------------------------------------ merge
def test_merge_joins_upstream_docs(client, auth):
    ag = agent_id(client, auth)
    mg = {"id": "m", "title": "合併", "kind": "hermes", "agent_id": ag, "io_mode": "doc", "doc_op": "merge",
          "doc_path": "docs/merged.md", "doc_status": "final",
          "prompt": "合成一份。\n" + fence("# 合併版規格\n取 A 的範圍＋C 的整合")}
    d = wait(client, auth, run(client, auth, make(client, auth, [_fanout_node(ag), mg], [edge("f", "m")], name="合")))
    assert d["status"] == "completed", d["error"]
    merged = client.get(f"/docs/{d['node_states']['m']['doc_ids'][0]}", headers=auth).json()
    assert merged["path"] == "docs/merged.md" and merged["status"] == "final"
    lin = client.get(f"/docs/{merged['id']}/lineage", headers=auth).json()
    assert sum(1 for e in lin["edges"] if e["kind"] == "merged") == 3


# ------------------------------------------------------------------ 相容性
def test_text_nodes_are_unchanged(client, auth):
    """沒設 io_mode 的節點行為完全不變（向後相容）。"""
    ag = agent_id(client, auth)
    nodes = [{"id": "a", "title": "節點a", "kind": "hermes", "agent_id": ag, "prompt": "do a"},
             {"id": "b", "title": "節點b", "kind": "hermes", "agent_id": ag, "prompt": "do b"}]
    d = wait(client, auth, run(client, auth, make(client, auth, nodes, [edge("a", "b")], name="純文字")))
    assert d["status"] == "completed"
    assert "echo[researcher" in d["node_states"]["a"]["output"]
    assert "doc_ids" not in d["node_states"]["a"]
    assert client.get("/docs", headers=auth).json() == []


def test_validation_rejects_bad_doc_config(client, auth):
    ag = agent_id(client, auth)
    bad = [{"id": "x", "title": "x", "kind": "hermes", "agent_id": ag, "prompt": "p", "io_mode": "doc", "doc_op": "nope"}]
    r = client.post("/workflows", json={"name": "壞", "nodes": bad, "edges": []}, headers=auth)
    assert r.status_code == 422 and "doc_op" in r.json()["error"]["message"]
    bad2 = [{"id": "x", "title": "x", "kind": "hermes", "agent_id": ag, "prompt": "p", "io_mode": "doc",
             "doc_op": "fanout", "fanout_count": 99}]
    r2 = client.post("/workflows", json={"name": "壞2", "nodes": bad2, "edges": []}, headers=auth)
    assert r2.status_code == 422 and "fanout_count" in r2.json()["error"]["message"]
    bad3 = [{"id": "x", "title": "x", "kind": "hermes", "agent_id": ag, "prompt": "p", "io_mode": "doc",
             "doc_op": "fanout", "doc_path_pattern": "docs/a.md"}]
    r3 = client.post("/workflows", json={"name": "壞3", "nodes": bad3, "edges": []}, headers=auth)
    assert r3.status_code == 422 and "{i}" in r3.json()["error"]["message"]


def test_human_select_node_needs_no_agent_or_prompt(client, auth):
    ag = agent_id(client, auth)
    nodes = [_fanout_node(ag), {"id": "s", "title": "人選", "kind": "hermes", "io_mode": "doc",
                                "doc_op": "select", "select_by": "human"}]
    r = client.post("/workflows", json={"name": "ok", "nodes": nodes, "edges": [edge("f", "s")]}, headers=auth)
    assert r.status_code == 201, r.text


# ------------------------------------------------------------------ 套件
def test_spec_builder_pack_installs_with_doc_nodes(client, auth):
    packs = client.get("/packs", headers=auth).json()
    sb = next((p for p in packs["items"] if p["name"] == "spec-builder"), None)
    assert sb is not None, packs["errors"]
    assert [s["id"] for s in sb["stages"]] == ["intake", "directions", "pick", "flesh_out", "review", "final"]
    assert all(s["criteria"] and s["role"] and s["deliverables"] for s in sb["stages"])
    r = client.post("/packs/spec-builder/install", headers=auth)
    assert r.status_code == 201, r.text
    wfs = {w["name"]: w for w in client.get("/workflows", headers=auth).json()}
    picked = wfs["[spec-builder] 2 選一份"]
    node = client.get(f"/workflows/{picked['id']}", headers=auth).json()["nodes"][0]
    assert node["io_mode"] == "doc" and node["doc_op"] == "select" and node["select_by"] == "human"
    fan = client.get(f"/workflows/{wfs['[spec-builder] 1 三個取向']['id']}", headers=auth).json()["nodes"][0]
    assert fan["doc_op"] == "fanout" and fan["fanout_count"] == 3
    t = client.post("/packs/spec-builder/topics", json={"title": "會員系統"}, headers=auth)
    assert t.status_code == 201, t.text
    assert t.json()["stage_list"][0]["id"] == "intake" and t.json()["stage_list"][0]["can_run"] is True
