"""POST /workflows/draft：一句話建流程。用 conftest 的 canned scenario 餵 LLM 回覆，測解析與退路。"""
from __future__ import annotations

import json

from studio.modules.workflows.draft import extract_json_object

TEXT = "每天早上八點找三個循環包裝的熱點，我挑一個，小編寫成 LINE 貼文發到行銷組"


def agents(client, auth):
    return {a["profile"]: a for a in client.get("/agents", headers=auth).json()}


def good_reply(ag_id: str) -> dict:
    return {"name": "每日熱點產線", "steps": [
        {"kind": "hermes", "title": "找出今天三個熱點", "agent_id": ag_id, "prompt": "找三個循環包裝的熱點"},
        {"kind": "gate", "title": "我挑一個"},
        {"kind": "delivery", "title": "送到 LINE", "channel": "line", "to": "行銷組"},
    ], "schedule": {"cron": "0 8 * * *", "label": "每天 08:00"}}


def draft(client, auth, gw_state, reply, text=TEXT, **body):
    gw_state.scenario = "canned"
    gw_state.canned_text = reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False)
    return client.post("/workflows/draft", json={"text": text, **body}, headers=auth)


def test_valid_reply_yields_nodes_edges_schedule(client, auth, gw_state):
    ag = agents(client, auth)["default"]
    r = draft(client, auth, gw_state, good_reply(ag["id"]))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["name"] == "每日熱點產線" and d["agent_id"] == ag["id"]
    assert [n["id"] for n in d["nodes"]] == ["s1", "s2", "s3"]
    assert [n["kind"] for n in d["nodes"]] == ["hermes", "gate", "delivery"]
    assert d["nodes"][0]["agent_id"] == ag["id"] and d["nodes"][0]["prompt"] == "找三個循環包裝的熱點"
    assert d["nodes"][2]["channel"] == "line" and d["nodes"][2]["to"] == "行銷組"
    assert [(e["source"], e["target"]) for e in d["edges"]] == [("s1", "s2"), ("s2", "s3")]
    assert d["schedule"] == {"cron": "0 8 * * *", "label": "每天 08:00"}
    assert [s["who"] for s in d["steps"]] == ["default", "你", "送到 LINE"]
    # 老闆的原話原封不動送給員工；系統提示列了員工名單與三種步驟
    sent = list(gw_state.runs.values())[-1]["body"]
    assert TEXT in sent["input"] and ag["id"] in sent["instructions"] and "delivery" in sent["instructions"]
    # 草稿沒有建流程
    assert client.get("/workflows", headers=auth).json() == []
    # 草稿可以直接餵給 POST /workflows
    assert client.post("/workflows", json={"name": d["name"], "nodes": d["nodes"], "edges": d["edges"]}, headers=auth).status_code == 201


def test_code_fenced_reply_still_parses(client, auth, gw_state):
    ag = agents(client, auth)["default"]
    reply = "好的，排好了：\n```json\n" + json.dumps(good_reply(ag["id"]), ensure_ascii=False) + "\n```\n有問題再說。"
    r = draft(client, auth, gw_state, reply)
    assert r.status_code == 200, r.text
    assert len(r.json()["nodes"]) == 3 and r.json()["raw"].startswith("好的")


def test_unknown_agent_falls_back_and_bad_steps_dropped(client, auth, gw_state):
    ag = agents(client, auth)["default"]
    reply = {"name": "x", "steps": [
        {"kind": "hermes", "title": "找熱點", "agent_id": "ag_nope", "prompt": "找"},
        {"kind": "teleport", "title": "不存在的種類"},
        {"kind": "delivery", "title": "送", "channel": "line"},  # LINE 沒有 to → 丟掉
        {"kind": "delivery", "title": "存檔", "channel": "file"},  # file 沒 path → 補預設
    ], "schedule": {"cron": "not a cron", "label": "壞掉"}}
    r = draft(client, auth, gw_state, reply)
    assert r.status_code == 200, r.text
    d = r.json()
    assert [n["kind"] for n in d["nodes"]] == ["hermes", "delivery"]
    assert d["nodes"][0]["agent_id"] == ag["id"]
    assert d["nodes"][1]["path"] == "output/{run_id}.md"
    assert d["schedule"] is None  # cron 壞掉當沒排程，不擋草稿


def test_garbage_reply_is_draft_failed(client, auth, gw_state):
    r = draft(client, auth, gw_state, "我不太確定你要什麼，可以再說清楚一點嗎？")
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "draft_failed" and "我不太確定" in err["detail"]
    # JSON 是對的但一步都不合法 → 一樣 draft_failed
    r = draft(client, auth, gw_state, {"name": "x", "steps": [{"kind": "delivery", "channel": "webhook", "url": "ftp://x"}]})
    assert r.status_code == 422 and r.json()["error"]["code"] == "draft_failed"


def test_no_enabled_hermes_agent(client, auth, gw_state):
    ag = agents(client, auth)["default"]
    assert client.patch(f"/agents/{ag['id']}", json={"enabled": False}, headers=auth).status_code == 200
    r = draft(client, auth, gw_state, good_reply(ag["id"]))
    assert r.status_code == 422 and r.json()["error"]["code"] == "no_agent"
    # 指定的 agent_id 不在啟用名單裡 → 一樣 no_agent（不偷用停用員工）
    r = draft(client, auth, gw_state, good_reply(ag["id"]), agent_id=ag["id"])
    assert r.status_code == 422 and r.json()["error"]["code"] == "no_agent"


def test_gateway_failure_is_502(client, auth, gw_state):
    gw_state.scenario = "failed"
    r = client.post("/workflows/draft", json={"text": TEXT}, headers=auth)
    assert r.status_code == 502 and r.json()["error"]["code"] == "gateway_error"


def test_extract_json_object():
    assert extract_json_object('前言 {"a": {"b": "}"}} 後記') == {"a": {"b": "}"}}
    assert extract_json_object("```json\n{\"x\": 1}\n```") == {"x": 1}
    assert extract_json_object("[1,2]") is None
    assert extract_json_object("{oops} {\"ok\": true}") == {"ok": True}
