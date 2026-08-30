import pytest

from studio.workflow_validate import WorkflowValidationError, topological_order, validate_workflow


def node(i, kind="agent", **kw):
    d = {"id": i, "title": i, "kind": kind, "agent_id": "ag_1", "prompt": f"do {i}"}
    d.update(kw)
    return d


def edge(s, t, **kw):
    return {"source": s, "target": t, "sourceHandle": "output", "targetHandle": "input", **kw}


def test_valid_linear_and_topo():
    nodes = [node("a"), node("gate", kind="gate"), node("b")]
    edges = [edge("a", "gate"), edge("gate", "b")]
    validate_workflow(nodes, edges)
    assert topological_order(nodes, edges) == ["a", "gate", "b"]


def test_single_node_ok():
    validate_workflow([node("a")], [])


@pytest.mark.parametrize("nodes,edges,needle", [
    ([], [], "至少要有 1"),
    ([node("a", agent_id=None)], [], "agent_id"),
    ([node("a", prompt="  ")], [], "prompt"),
    ([node("a"), node("b")], [edge("a", "b"), edge("b", "a")], "環"),
    ([node("a"), node("b"), node("c")], [edge("a", "b")], "連通"),
    ([node("a"), node("b")], [edge("a", "b", sourceHandle="input")], "output"),
    ([node("a"), node("b")], [edge("a", "b", targetHandle="output")], "input"),
    ([node("a"), node("b")], [edge("a", "zzz")], "不存在"),
    ([node("a")], [edge("a", "a")], "自迴圈"),
    ([node("a"), node("a")], [], "重複"),
    ([node("a"), node("b")], [edge("a", "b"), edge("a", "b")], "重複的邊"),
    ([node("a"), node("b")], [edge("a", "b", on="maybe")], "on"),
])
def test_invalid(nodes, edges, needle):
    with pytest.raises(WorkflowValidationError) as ei:
        validate_workflow(nodes, edges)
    assert needle in str(ei.value)


def test_workflow_api_crud(client, auth):
    wf = {"name": "內容流程", "nodes": [node("a"), node("g", kind="gate"), node("b")], "edges": [edge("a", "g"), edge("g", "b")],
          "viewport": {"x": 0, "y": 0, "zoom": 1}}
    r = client.post("/workflows", json=wf, headers=auth)
    assert r.status_code == 201, r.text
    wid = r.json()["id"]
    assert r.json()["nodes"][1]["kind"] == "gate"
    bad = dict(wf, edges=[edge("a", "g"), edge("g", "b"), edge("b", "a")])
    r = client.post("/workflows", json=bad, headers=auth)
    assert r.status_code == 422 and r.json()["error"]["code"] == "workflow_invalid" and "環" in r.json()["error"]["message"]
    assert len(client.get("/workflows", headers=auth).json()) == 1
    r = client.patch(f"/workflows/{wid}", json={"name": "改名", "edges": [edge("a", "g")]}, headers=auth)
    assert r.status_code == 422  # b becomes isolated
    r = client.patch(f"/workflows/{wid}", json={"name": "改名"}, headers=auth)
    assert r.json()["name"] == "改名"
    assert client.post(f"/workflows/{wid}/run", headers=auth).status_code == 202
    assert len(client.get(f"/workflows/{wid}/runs", headers=auth).json()) == 1
    assert client.get("/workflow-runs/wr_nope", headers=auth).status_code == 404
    assert client.delete(f"/workflows/{wid}", headers=auth).json()["ok"] is True
    assert client.get(f"/workflows/{wid}", headers=auth).status_code == 404
