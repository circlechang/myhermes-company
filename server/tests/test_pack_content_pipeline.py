"""content-pipeline 套件：載入、條件分支（總分<18 封存）、退回到指定節點重跑、可關閉階段（extras）、chief-editor 新建；fake gateway。"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from studio.modules.packs.loader import PackError, load_pack, repo_packs_dir
from studio.modules.packs.stages import StageError, TopicStore, transition

PACK = repo_packs_dir() / "content-pipeline"
STAGES = ["sources", "pick", "research", "master", "social", "video", "extras", "review", "publish", "analytics"]
P = "/packs/content-pipeline"


# ---------------------------------------------------------------- 載入
def test_load_content_pipeline_pack():
    p = load_pack(PACK)
    assert p.name == "content-pipeline" and [s.id for s in p.stages] == STAGES
    assert "chief-editor" in p.profiles and p.soul_path("chief-editor")
    for s in p.stages:  # 三欄每個階段都有
        assert s.criteria and s.role and s.deliverables, s.id
        d = s.to_dict()
        assert {"criteria", "role", "deliverables", "optional", "branch", "hint"} <= set(d)
        wf = p.workflow_data(s.workflow)["workflow"]
        assert wf["nodes"][0]["agent"] == s.agent and wf["nodes"][0]["tool_approval"] == "allow"
    assert p.stage("pick").gate and p.stage("review").gate and not p.stage("master").gate
    assert p.stage("pick").branch["min"] == 18 and p.stage("pick").branch["file"] == "topic-scorecard.md"
    assert p.stage("review").hint["file"] == "review.md"
    assert p.stage("extras").optional and p.stage("extras").default_enabled and not p.stage("social").optional
    # 研究、母稿、審核三個節點開 done_check
    for sid in ("research", "master", "review"):
        assert p.workflow_data(p.stage(sid).workflow)["workflow"]["nodes"][0]["done_check"] is True
    assert "done_check" not in p.workflow_data(p.stage("social").workflow)["workflow"]["nodes"][0]
    # 提示裡有絕對路徑變數與交付物路徑
    assert "{topic_dir}/topic-scorecard.md" in p.stage("pick").prompt and "{workspace_dir}/_learnings.md" in p.stage("pick").prompt
    assert "{workspace_dir}/_learnings.md" in p.stage("analytics").prompt
    assert "沒有來源" in p.stage("research").prompt


def test_branch_and_hint_validation(tmp_path: Path):
    import shutil
    d = tmp_path / "packs" / "content-pipeline"
    shutil.copytree(PACK, d)
    y = (d / "stages.yaml").read_text()
    (d / "stages.yaml").write_text(y.replace("on_fail: archived", "on_fail: deleted"))
    with pytest.raises(PackError, match="on_fail"):
        load_pack(d)
    (d / "stages.yaml").write_text(y.replace('pattern: "總分[：:]\\\\s*(\\\\d+)"', 'pattern: "總分[：:]\\\\s*(\\\\d+"'))
    with pytest.raises(PackError, match="branch"):
        load_pack(d)


def test_new_transitions():
    assert transition("running", "archive") == "archived"
    assert transition("archived", "run") == "running"
    assert transition("draft", "skip") == "skipped" and transition("skipped", "unskip") == "draft"
    assert transition("done", "rollback") == "draft" and transition("review", "rollback") == "draft"
    with pytest.raises(StageError):
        transition("skipped", "run")


# ---------------------------------------------------------------- store 層：分支評估、退回、關閉
def _mark_done(store: TopicStore, tid: str, *sids: str):
    for sid in sids:
        store.apply(tid, sid, "run", run_id=f"r_{sid}")
        store.apply(tid, sid, "finish")


def test_store_branch_rollback_toggle(tmp_path: Path):
    store = TopicStore(load_pack(PACK), tmp_path / "ws")
    st = store.create_topic("循環包裝箱", notes="先講省 30%")
    tid = st["id"]
    d = store.root / tid
    assert (d / "sources" / "README.md").is_file() and (d / "social").is_dir() and (d / "video").is_dir()
    assert st["archived"] is False and st["stages"]["extras"]["status"] == "draft"  # 預設開
    # 分支評估：沒檔 → None passed；<18 → 不過；≥18 → 過
    pick = store.stage_of("pick")
    assert store.evaluate_branch(tid, pick)["passed"] is None
    (d / "topic-scorecard.md").write_text("## 評分\n| 受眾 | 3 |\n\n總分：15\n\n封存理由：時效已過\n")
    br = store.evaluate_branch(tid, pick)
    assert br["passed"] is False and br["score"] == 15 and br["reason"] == "時效已過"
    (d / "topic-scorecard.md").write_text("總分: 21\n")
    assert store.evaluate_branch(tid, pick)["passed"] is True
    # 提示帶 workspace_dir（_learnings.md）與 skipped_stages
    text = store.render_prompt(tid, pick)
    assert str((tmp_path / "ws" / "content-pipeline").resolve() / "_learnings.md") in text
    # 關閉 extras → skipped；review 不再被 extras 擋
    _mark_done(store, tid, "sources")
    store.apply(tid, "pick", "run", run_id="r"); store.apply(tid, "pick", "finish_gate"); store.apply(tid, "pick", "approve")
    _mark_done(store, tid, "research", "master", "social", "video")
    with pytest.raises(StageError):
        store.set_enabled(tid, "social", False)  # 不是 optional
    assert store.set_enabled(tid, "extras", False)["status"] == "skipped"
    detail = store.detail(tid)
    rv = next(s for s in detail["stage_list"] if s["id"] == "review")
    ex = next(s for s in detail["stage_list"] if s["id"] == "extras")
    assert rv["can_run"] is True and ex["can_run"] is False and ex["enabled"] is False and ex["can_toggle"] is True
    assert "extras" not in rv["rollback_targets"] and rv["rollback_targets"][-1] == "review"
    assert "extras" in store.render_prompt(tid, store.stage_of("review"))
    # review → 待核准，人退回到 master
    store.apply(tid, "review", "run", run_id="r_rv"); store.apply(tid, "review", "finish_gate")
    (d / "review.md").write_text("| 事實 | fail | 母稿第二段 30% 無來源 |\n\n建議退回到：master\n")
    assert store.review_hint(tid, store.stage_of("review")) == "master"
    with pytest.raises(StageError):
        store.reject_to(tid, "review", "publish", "x")  # 不能退到後面
    with pytest.raises(StageError):
        store.reject_to(tid, "review", "extras", "x")  # 已關閉的不能當目標
    store.reject_to(tid, "review", "master", "30% 沒來源", member_id="m1")
    saved = json.loads((d / "status.json").read_text())["stages"]
    assert saved["research"]["status"] == "done"
    assert {k: saved[k]["status"] for k in ("master", "social", "video", "review")} == {k: "draft" for k in ("master", "social", "video", "review")}
    assert saved["extras"]["status"] == "skipped"  # 關閉的不動
    assert saved["master"]["feedback"] == "30% 沒來源" and saved["social"]["feedback"] == ""
    assert saved["review"]["history"][-1]["rollback_to"] == "master"
    assert "[退回意見]\n30% 沒來源" in store.render_prompt(tid, store.stage_of("master"))
    assert store.detail(tid)["current_stage"] == "master"
    # 重新開啟 extras → draft
    assert store.set_enabled(tid, "extras", True)["status"] == "draft"


# ---------------------------------------------------------------- API：安裝建 chief-editor
def test_install_creates_chief_editor(client, auth, hermes_home: Path):
    before = (hermes_home / "profiles" / "researcher" / "SOUL.md").read_text()
    r = client.post(f"{P}/install", headers=auth)
    assert r.status_code == 201, r.text
    st = r.json()
    assert "chief-editor" in st["installed"]["profiles_created"]
    soul = hermes_home / "profiles" / "chief-editor" / "SOUL.md"
    assert soul.is_file() and "只挑錯" in soul.read_text() and "不改寫" in soul.read_text()
    assert (hermes_home / "profiles" / "researcher" / "SOUL.md").read_text() == before
    agents = {a["profile"]: a for a in client.get("/agents", headers=auth).json()}
    assert agents["chief-editor"]["name"] == "審稿主編" and agents["chief-editor"]["enabled"]
    assert set(st["installed"]["workflows"]) == set(STAGES)
    # 階段卡三欄由 API 吐出
    pk = client.get(P, headers=auth).json()
    rv = next(s for s in pk["stages"] if s["id"] == "review")
    assert rv["criteria"] and rv["role"].startswith("審稿主編") and rv["deliverables"][0].startswith("review.md")
    assert next(s for s in pk["stages"] if s["id"] == "extras")["optional"] is True
    # 重裝冪等：profile 不再列為新建之外的東西、SOUL 不覆寫
    soul.write_text(soul.read_text() + "\n# 人改過")
    assert client.post(f"{P}/install", headers=auth).status_code == 201
    assert soul.read_text().endswith("# 人改過")


# ---------------------------------------------------------------- API：真引擎 + fake gateway
def _wait(client, auth, tid, sid, until=("done", "failed", "review", "archived"), timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = client.get(f"{P}/topics/{tid}", headers=auth).json()
        st = next(s for s in d["stage_list"] if s["id"] == sid)
        if st["status"] in until:
            return st
        time.sleep(0.05)
    raise AssertionError(f"stage {sid} still {st['status']}")


def _put(client, auth, tid, path, content):
    assert client.put(f"{P}/topics/{tid}/file", json={"path": path, "content": content}, headers=auth).status_code == 200


def test_pick_below_threshold_is_archived_then_rerun_passes(client, auth, gw_state):
    client.post(f"{P}/install", headers=auth)
    tid = client.post(f"{P}/topics", json={"title": "循環包裝箱", "notes": "找 2 筆就好"}, headers=auth).json()["id"]
    assert client.post(f"{P}/topics/{tid}/stages/sources/run", headers=auth).status_code == 202
    assert _wait(client, auth, tid, "sources")["status"] == "done"
    body = list(gw_state.runs.values())[-1]["body"]["input"]
    assert "sources/" in body and "找 2 筆就好" in body and list(gw_state.runs.values())[-1]["profile"] == "evidence-radar"
    # fake gateway 只 echo 不寫檔：先把「AI 會寫的」scorecard 放好，分數 14 → 封存
    _put(client, auth, tid, "topic-scorecard.md", "## 評分\n| 時效 | 1 |\n\n總分：14\n\n封存理由：素材都是 2023 年的\n")
    assert client.post(f"{P}/topics/{tid}/stages/pick/run", headers=auth).status_code == 202
    st = _wait(client, auth, tid, "pick")
    assert st["status"] == "archived" and st["archived_reason"] == "素材都是 2023 年的" and st["branch_result"]["score"] == 14
    d = client.get(f"{P}/topics/{tid}", headers=auth).json()
    assert d["archived"] is True and d["archived_reason"] == "素材都是 2023 年的"
    assert next(s for s in d["stage_list"] if s["id"] == "research")["can_run"] is False
    assert not [i for i in client.get("/inbox?kind=pack_stage_review", headers=auth).json()["items"] if i["kind"] == "pack_stage_review"]
    lst = client.get(f"{P}/topics", headers=auth).json()
    assert lst[0]["archived"] and lst[0]["lights"][1] == "archived"
    kinds = {e["kind"] for e in client.get("/events?kind=pack.*", headers=auth).json()["items"]}
    assert "pack.content-pipeline.archived" in kinds
    # 補素材後重跑：分數 21 → 進閘門（收件匣有分數）
    _put(client, auth, tid, "topic-scorecard.md", "總分：21\n## 選題主張\n省 30%\n")
    assert client.post(f"{P}/topics/{tid}/stages/pick/run", headers=auth).status_code == 202
    st = _wait(client, auth, tid, "pick")
    assert st["status"] == "review" and st["branch_result"]["passed"] is True
    d = client.get(f"{P}/topics/{tid}", headers=auth).json()
    assert d["archived"] is False and d["archived_reason"] == ""
    items = [i for i in client.get("/inbox?kind=pack_stage_review", headers=auth).json()["items"] if i["kind"] == "pack_stage_review"]
    assert len(items) == 1 and "分數 21／門檻 18" in items[0]["detail"] and items[0]["link"] == f"{P}?topic={tid}&stage=pick"
    assert client.post(f"{P}/topics/{tid}/stages/pick/approve", headers=auth).json()["status"] == "done"


def test_extras_off_and_review_reject_to_node(client, auth, gw_state):
    client.post(f"{P}/install", headers=auth)
    tid = client.post(f"{P}/topics", json={"title": "循環包裝箱"}, headers=auth).json()["id"]
    # 前面幾段用 force 快轉（fake gateway 不寫檔）
    for sid in ("sources", "research", "master", "social", "video"):
        assert client.post(f"{P}/topics/{tid}/stages/{sid}/run", json={"force": True}, headers=auth).status_code == 202, sid
        assert _wait(client, auth, tid, sid)["status"] == "done"
    _put(client, auth, tid, "topic-scorecard.md", "總分：20\n")
    client.post(f"{P}/topics/{tid}/stages/pick/run", json={"force": True}, headers=auth)
    assert _wait(client, auth, tid, "pick")["status"] == "review"
    client.post(f"{P}/topics/{tid}/stages/pick/approve", headers=auth)
    # 關閉 extras
    r = client.post(f"{P}/topics/{tid}/stages/extras/enabled", json={"enabled": False}, headers=auth)
    assert r.status_code == 200 and r.json()["status"] == "skipped" and r.json()["enabled"] is False
    assert client.post(f"{P}/topics/{tid}/stages/social/enabled", json={"enabled": False}, headers=auth).status_code == 400
    assert client.post(f"{P}/topics/{tid}/stages/extras/run", headers=auth).status_code == 409  # 關閉的不能跑
    d = client.get(f"{P}/topics/{tid}", headers=auth).json()
    assert next(s for s in d["stage_list"] if s["id"] == "review")["can_run"] is True
    # review：chief-editor 預審 → 待核准；提示告訴它 extras 已關；收件匣帶 AI 建議
    _put(client, auth, tid, "review.md", "| 事實對照 brief | fail | 母稿「省 30%」brief 無此事實 |\n\n建議退回到：master\n")
    assert client.post(f"{P}/topics/{tid}/stages/review/run", headers=auth).status_code == 202
    st = _wait(client, auth, tid, "review")
    assert st["status"] == "review" and st["review_hint"] == "master"
    run = list(gw_state.runs.values())[-1]
    assert run["profile"] == "chief-editor" and "extras" in run["body"]["input"] and "review.md" in run["body"]["input"]
    items = [i for i in client.get("/inbox?kind=pack_stage_review", headers=auth).json()["items"] if i["kind"] == "pack_stage_review"]
    assert len(items) == 1 and "AI 建議：退回到 master" in items[0]["detail"]
    # 人退回到 master → master/social/video/review 重置，research 不動，extras 仍 skipped
    assert client.post(f"{P}/topics/{tid}/stages/review/reject", json={"comment": "30% 沒來源", "to": "publish"}, headers=auth).status_code == 400
    r = client.post(f"{P}/topics/{tid}/stages/review/reject", json={"comment": "30% 沒來源", "to": "master"}, headers=auth)
    assert r.status_code == 200 and r.json()["status"] == "draft" and r.json()["to"] == "master"
    d = client.get(f"{P}/topics/{tid}", headers=auth).json()
    stt = {s["id"]: s for s in d["stage_list"]}
    assert stt["research"]["status"] == "done" and stt["extras"]["status"] == "skipped"
    assert all(stt[k]["status"] == "draft" for k in ("master", "social", "video", "review"))
    assert stt["master"]["feedback"] == "30% 沒來源" and stt["master"]["can_run"] and not stt["social"]["can_run"]
    assert d["current_stage"] == "master"
    assert not [i for i in client.get("/inbox?kind=pack_stage_review", headers=auth).json()["items"] if i["kind"] == "pack_stage_review"]
    # 重跑 master → 提示帶退回意見
    assert client.post(f"{P}/topics/{tid}/stages/master/run", headers=auth).status_code == 202
    assert _wait(client, auth, tid, "master")["status"] == "done"
    assert "[退回意見]\n30% 沒來源" in list(gw_state.runs.values())[-1]["body"]["input"]
    # 一路到 review 核准 → publish → analytics（_learnings.md 由 AI 追加，這裡只驗流程通）
    for sid in ("social", "video"):
        client.post(f"{P}/topics/{tid}/stages/{sid}/run", headers=auth)
        assert _wait(client, auth, tid, sid)["status"] == "done"
    _put(client, auth, tid, "review.md", "全 pass\n\n建議退回到：無\n")
    client.post(f"{P}/topics/{tid}/stages/review/run", headers=auth)
    st = _wait(client, auth, tid, "review")
    assert st["status"] == "review" and st.get("review_hint", "") == ""  # 「無」不是節點 id
    assert client.post(f"{P}/topics/{tid}/stages/review/approve", headers=auth).json()["status"] == "done"
    for sid in ("publish", "analytics"):
        assert client.post(f"{P}/topics/{tid}/stages/{sid}/run", headers=auth).status_code == 202
        assert _wait(client, auth, tid, sid)["status"] == "done"
    assert "_learnings.md" in list(gw_state.runs.values())[-1]["body"]["input"]
    assert client.get(f"{P}/topics", headers=auth).json()[0]["current_stage"] is None
    kinds = {e["kind"] for e in client.get("/events?kind=pack.*", headers=auth).json()["items"]}
    assert {"pack.stage.toggled", "pack.content-pipeline.topic_done", "pack.stage.decided"} <= kinds
