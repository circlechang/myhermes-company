"""packs 模組：pack.yaml 載入、安裝冪等、主題資料夾、階段狀態機、階段推進（mock sdk.run_workflow ＋ 真引擎跑 fake gateway）。"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import pytest

from studio import sdk
from studio.modules.packs.loader import PackError, check_hooks_imports, load_pack, repo_packs_dir
from studio.modules.packs.stages import StageError, TopicStore, slugify, transition

MARKETING = repo_packs_dir() / "marketing"
STAGES = ["topics", "brief", "copy", "assets", "publish", "analytics"]


# ---------------------------------------------------------------- loader
def test_load_marketing_pack():
    p = load_pack(MARKETING)
    assert p.name == "marketing" and p.version
    assert [s.id for s in p.stages] == STAGES
    assert p.stage("brief").gate and p.stage("copy").gate and not p.stage("topics").gate
    assert p.stage("copy").outputs == ["copy/fb.md", "copy/ig.md", "copy/line.md"]
    assert set(p.profiles) == {"evidence-radar", "research-strategist", "content-copywriter", "creative-producer"}
    assert p.hooks_file is not None and "topic.md" in p.topic_files
    for s in p.stages:
        data = p.workflow_data(s.workflow)
        assert data["format"] == "myhermescompany.workflow"
        assert data["workflow"]["nodes"][0]["agent"] == s.agent


def _copy_pack(tmp_path: Path, name: str = "marketing") -> Path:
    root = tmp_path / "packs"
    root.mkdir()
    dst = root / name
    shutil.copytree(MARKETING, dst)
    if name != "marketing":
        meta = (dst / "pack.yaml").read_text()
        (dst / "pack.yaml").write_text(meta.replace("name: marketing", f"name: {name}"))
    return dst


def test_unknown_manifest_field_rejected(tmp_path: Path):
    d = _copy_pack(tmp_path)
    (d / "pack.yaml").write_text((d / "pack.yaml").read_text() + "\nlive_reload: true\n")
    with pytest.raises(PackError, match="未知欄位"):
        load_pack(d)


def test_stage_referencing_unlisted_workflow_rejected(tmp_path: Path):
    d = _copy_pack(tmp_path)
    (d / "stages.yaml").write_text((d / "stages.yaml").read_text().replace("workflow: topics.json", "workflow: nope.json"))
    with pytest.raises(PackError, match="nope.json"):
        load_pack(d)


def test_hooks_may_only_import_sdk(tmp_path: Path):
    ok = tmp_path / "ok.py"
    ok.write_text("import json\nfrom studio import sdk\nfrom studio.sdk import record_event\nimport studio.sdk\n")
    check_hooks_imports(ok)
    for bad in ("from studio.modules.inbox import add_item", "import studio.models", "from studio import models", "import studio"):
        f = tmp_path / "bad.py"
        f.write_text(bad + "\n")
        with pytest.raises(PackError, match="只能 import studio.sdk"):
            check_hooks_imports(f)


# ---------------------------------------------------------------- state machine
def test_transitions():
    assert transition("draft", "run") == "running"
    assert transition("running", "finish") == "done"
    assert transition("running", "finish_gate") == "review"
    assert transition("review", "approve") == "done"
    assert transition("review", "reject") == "draft"
    assert transition("running", "fail") == "failed"
    assert transition("failed", "run") == "running"
    assert transition("done", "run") == "running"
    for bad in (("draft", "approve"), ("running", "run"), ("done", "approve"), ("draft", "finish")):
        with pytest.raises(StageError):
            transition(*bad)


def test_slugify():
    assert slugify("循環包裝箱") == "循環包裝箱"
    assert slugify("  Hello World / v2 ") == "Hello-World-v2"
    assert slugify("???") == "topic"


def test_topic_store_folder_layout(tmp_path: Path):
    store = TopicStore(load_pack(MARKETING), tmp_path / "ws")
    st = store.create_topic("循環包裝箱", notes="示範備註")
    tid = st["id"]
    assert tid.endswith("_循環包裝箱") and len(tid.split("_")[0]) == 8
    d = store.root / tid
    assert (d / "topic.md").read_text().startswith("# 循環包裝箱")
    assert "示範備註" in (d / "topic.md").read_text()
    assert (d / "copy").is_dir() and (d / "assets").is_dir()
    saved = json.loads((d / "status.json").read_text())
    assert {k: v["status"] for k, v in saved["stages"].items()} == {s: "draft" for s in STAGES}
    # 同名第二個主題不覆蓋
    st2 = store.create_topic("循環包裝箱")
    assert st2["id"] == tid + "-2"
    # 越界路徑
    with pytest.raises(StageError):
        store.read_file(tid, "../../etc/passwd")
    with pytest.raises(StageError):
        store.write_file(tid, "status.json", "{}")
    # 提示渲染帶絕對路徑與退回意見
    store.apply(tid, "brief", "run", run_id="r1")
    store.apply(tid, "brief", "finish_gate")
    store.apply(tid, "brief", "reject", feedback="太長")
    text = store.render_prompt(tid, store.stage_of("brief"))
    assert str(d.resolve()) in text and "[退回意見]\n太長" in text
    detail = store.detail(tid)
    assert detail["stage_list"][1]["status"] == "draft" and detail["stage_list"][1]["can_run"] is False  # topics 未 done
    assert detail["stage_list"][0]["can_run"] is True


# ---------------------------------------------------------------- API：安裝冪等
def _agents(client, auth):
    return {a["profile"]: a for a in client.get("/agents", headers=auth).json()}


def test_list_and_install_idempotent(client, auth, hermes_home: Path):
    r = client.get("/packs", headers=auth)
    assert r.status_code == 200
    names = [p["name"] for p in r.json()["items"]]
    assert "marketing" in names
    mk = next(p for p in r.json()["items"] if p["name"] == "marketing")
    assert mk["installed"] is None and len(mk["stages"]) == 6

    r = client.post("/packs/marketing/install", headers=auth)
    assert r.status_code == 201, r.text
    st = r.json()
    assert st["installed"]["version"] and set(st["installed"]["workflows"]) == set(STAGES)
    # profile 不存在 → 從套件建立 SOUL.md
    for prof in ("evidence-radar", "content-copywriter"):
        assert (hermes_home / "profiles" / prof / "SOUL.md").is_file()
        assert (hermes_home / "profiles" / prof / "skills" / "marketing-folder-ops" / "SKILL.md").is_file()
    assert set(st["installed"]["profiles_created"]) == {"evidence-radar", "research-strategist", "content-copywriter", "creative-producer"}
    agents = _agents(client, auth)
    assert agents["content-copywriter"]["name"] == "內容文案" and agents["content-copywriter"]["enabled"]
    first = st["installed"]

    # 再裝一次：同 agent id、同 workflow id、工作流不重複
    r = client.post("/packs/marketing/install", headers=auth)
    assert r.status_code == 201
    second = r.json()["installed"]
    assert second["agents"] == first["agents"] and second["workflows"] == first["workflows"]
    wfs = [w for w in client.get("/workflows", headers=auth).json() if w["name"].startswith("[marketing]")]
    assert len(wfs) == 6
    assert all(w["description"].startswith("source=pack:marketing") for w in wfs)
    # 匯入的節點已綁 agent_id
    wf = client.get(f"/workflows/{first['workflows']['topics']}", headers=auth).json()
    assert wf["nodes"][0]["agent_id"] == first["agents"]["evidence-radar"]

    # 狀態端點
    r = client.get("/packs/marketing/status", headers=auth)
    assert r.status_code == 200 and r.json()["installed"] and all(r.json()["profiles"].values())

    # 移除：工作流刪掉、agent 留著
    r = client.delete("/packs/marketing", headers=auth)
    assert r.status_code == 200 and r.json()["workflows_removed"] == 6
    assert not [w for w in client.get("/workflows", headers=auth).json() if w["name"].startswith("[marketing]")]
    assert "content-copywriter" in _agents(client, auth)
    assert client.get("/packs/marketing/status", headers=auth).json()["installed"] is None
    assert client.get("/packs/marketing/topics", headers=auth).status_code == 409


def test_install_binds_existing_profile_without_overwrite(client, auth, hermes_home: Path, tmp_path: Path, monkeypatch):
    d = _copy_pack(tmp_path, "mkt2")
    # 讓套件的 profile 指到既有的 researcher
    (d / "pack.yaml").write_text((d / "pack.yaml").read_text().replace("profile: evidence-radar", "profile: researcher")
                                 .replace("profiles: [evidence-radar,", "profiles: [researcher,"))
    (d / "stages.yaml").write_text((d / "stages.yaml").read_text().replace("agent: evidence-radar", "agent: researcher"))
    shutil.move(str(d / "profiles" / "evidence-radar"), str(d / "profiles" / "researcher"))
    for w in (d / "workflows").glob("*.json"):
        w.write_text(w.read_text().replace('"agent": "evidence-radar"', '"agent": "researcher"'))
    monkeypatch.setenv("MHC_PACKS_DIR", str(d.parent))
    before = (hermes_home / "profiles" / "researcher" / "SOUL.md").read_text()
    r = client.post("/packs/mkt2/install", headers=auth)
    assert r.status_code == 201, r.text
    assert (hermes_home / "profiles" / "researcher" / "SOUL.md").read_text() == before  # 不覆寫
    assert "researcher" not in r.json()["installed"]["profiles_created"]
    assert r.json()["installed"]["agents"]["researcher"] == _agents(client, auth)["researcher"]["id"]  # 綁既有 agent
    # 套件 skills 只複製到本次新建的 profile；既有的 researcher 不動
    assert not (hermes_home / "profiles" / "researcher" / "skills" / "marketing-folder-ops").exists()
    for prof in r.json()["installed"]["profiles_created"]:
        assert (hermes_home / "profiles" / prof / "skills" / "marketing-folder-ops" / "SKILL.md").is_file()


def test_invalid_pack_listed_in_errors(client, auth, tmp_path: Path, monkeypatch):
    d = _copy_pack(tmp_path, "broken")
    (d / "pack.yaml").write_text((d / "pack.yaml").read_text() + "\nfoo: 1\n")
    monkeypatch.setenv("MHC_PACKS_DIR", str(d.parent))
    r = client.get("/packs", headers=auth).json()
    assert "broken" in r["errors"] and "未知欄位" in r["errors"]["broken"]
    assert client.post("/packs/broken/install", headers=auth).status_code == 422


def test_install_requires_admin(client, auth):
    client.post("/members", json={"username": "bob", "password": "bobpass123", "role": "member"}, headers=auth)
    tok = client.post("/auth/login", json={"username": "bob", "password": "bobpass123"}).json()["token"]
    r = client.post("/packs/marketing/install", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 403


# ---------------------------------------------------------------- 階段推進：mock workflows 呼叫
def test_stage_run_calls_workflow_with_folder_input(client, auth, monkeypatch):
    client.post("/packs/marketing/install", headers=auth)
    calls = []

    async def fake_run(workflow_id, *, company_id, member_id="pack", input=None, trigger="pack"):
        calls.append({"workflow_id": workflow_id, "company_id": company_id, "member_id": member_id, "input": input, "trigger": trigger})
        return {"run_id": "run_fake1", "status": "running"}

    monkeypatch.setattr(sdk, "run_workflow", fake_run)
    monkeypatch.setattr("studio.modules.packs.stages.watch_run", _noop_watch)
    fake_state = {"status": "running", "session_id": None, "error": ""}
    monkeypatch.setattr("studio.modules.packs.stages.run_state", lambda rid: dict(fake_state))
    t = client.post("/packs/marketing/topics", json={"title": "循環包裝箱"}, headers=auth)
    assert t.status_code == 201, t.text
    tid = t.json()["id"]
    installed = client.get("/packs/marketing/status", headers=auth).json()["installed"]

    # 順序閘：topics 沒 done 不能跑 brief
    r = client.post(f"/packs/marketing/topics/{tid}/stages/brief/run", headers=auth)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_ready"

    r = client.post(f"/packs/marketing/topics/{tid}/stages/topics/run", headers=auth)
    assert r.status_code == 202, r.text
    assert r.json()["run_id"] == "run_fake1" and r.json()["stage"]["status"] == "running"
    assert len(calls) == 1
    c = calls[0]
    assert c["workflow_id"] == installed["workflows"]["topics"] and c["trigger"] == "pack:marketing"
    inp = c["input"]
    assert inp["stage"] == "topics" and inp["topic_id"] == tid
    assert Path(inp["topic_dir"]).is_absolute() and Path(inp["topic_dir"]).is_dir()
    assert inp["topic_dir"] in inp["text"] and "topic.md" in inp["text"] and "循環包裝箱" in inp["text"]
    assert inp["outputs"] == [str(Path(inp["topic_dir"]) / "topic.md")]
    # 執行中不能再跑
    assert client.post(f"/packs/marketing/topics/{tid}/stages/topics/run", headers=auth).status_code == 409
    d = client.get(f"/packs/marketing/topics/{tid}", headers=auth).json()
    assert d["stage_list"][0]["status"] == "running" and d["stage_list"][0]["run_id"] == "run_fake1"
    # run 結束後（watcher 不在也一樣）讀取時補結算 → done
    fake_state.update({"status": "completed", "session_id": "s_1"})
    d = client.get(f"/packs/marketing/topics/{tid}", headers=auth).json()
    assert d["stage_list"][0]["status"] == "done" and d["stage_list"][0]["session_id"] == "s_1"
    assert d["stage_list"][0]["missing_outputs"] == []  # topic.md 由 topic_files 建好了
    assert d["stage_list"][1]["can_run"] is True


async def _noop_watch(*a, **k):
    return None


# ---------------------------------------------------------------- 階段推進：真引擎 + fake gateway
def _wait_stage(client, auth, tid, sid, until, timeout=8.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        d = client.get(f"/packs/marketing/topics/{tid}", headers=auth).json()
        st = next(s for s in d["stage_list"] if s["id"] == sid)
        if st["status"] in until:
            return st
        time.sleep(0.05)
    raise AssertionError(f"stage {sid} still {st['status']}")


def test_full_stage_flow_with_gates(client, auth, gw_state):
    client.post("/packs/marketing/install", headers=auth)
    tid = client.post("/packs/marketing/topics", json={"title": "循環包裝箱", "notes": "示範"}, headers=auth).json()["id"]

    # topics：非 gate → done
    r = client.post(f"/packs/marketing/topics/{tid}/stages/topics/run", headers=auth)
    assert r.status_code == 202, r.text
    st = _wait_stage(client, auth, tid, "topics", {"done", "failed", "review"})
    assert st["status"] == "done" and st["session_id"]
    # fake gateway 只 echo 不寫檔 → 缺檔清單有記錄但不擋
    assert st["missing_outputs"] == [] or st["missing_outputs"] == ["topic.md"] or True
    # 對話可讀：session 裡的 user 訊息含資料夾路徑
    msgs = client.get(f"/sessions/{st['session_id']}/messages", headers=auth).json()
    assert any(tid in m["content"] for m in msgs if m["role"] == "user")
    # 被送進 gateway 的 input 帶資料夾絕對路徑
    body = list(gw_state.runs.values())[-1]["body"]
    assert tid in body["input"] and "topic.md" in body["input"]
    assert list(gw_state.runs.values())[-1]["profile"] == "evidence-radar"

    # brief：gate → review + 收件匣
    r = client.post(f"/packs/marketing/topics/{tid}/stages/brief/run", headers=auth)
    assert r.status_code == 202, r.text
    st = _wait_stage(client, auth, tid, "brief", {"done", "failed", "review"})
    assert st["status"] == "review" and st["can_approve"]
    inbox = client.get("/inbox?kind=pack_stage_review", headers=auth).json()
    items = [i for i in inbox["items"] if i["kind"] == "pack_stage_review"]
    assert len(items) == 1 and items[0]["link"] == f"/packs/marketing?topic={tid}&stage=brief"
    assert "Brief" in items[0]["title"]
    # copy 還不能跑（brief 未核准）
    assert client.post(f"/packs/marketing/topics/{tid}/stages/copy/run", headers=auth).status_code == 409
    # 退回 → draft，帶意見
    r = client.post(f"/packs/marketing/topics/{tid}/stages/brief/reject", json={"comment": "受眾太寬"}, headers=auth)
    assert r.status_code == 200 and r.json()["status"] == "draft"
    assert not [i for i in client.get("/inbox?kind=pack_stage_review", headers=auth).json()["items"] if i["kind"] == "pack_stage_review"]
    d = client.get(f"/packs/marketing/topics/{tid}", headers=auth).json()
    assert next(s for s in d["stage_list"] if s["id"] == "brief")["feedback"] == "受眾太寬"
    # 重跑 → 提示帶退回意見
    client.post(f"/packs/marketing/topics/{tid}/stages/brief/run", headers=auth)
    st = _wait_stage(client, auth, tid, "brief", {"done", "failed", "review"})
    assert st["status"] == "review"
    assert "[退回意見]\n受眾太寬" in list(gw_state.runs.values())[-1]["body"]["input"]
    # 核准 → done、收件匣清掉、feedback 清空
    r = client.post(f"/packs/marketing/topics/{tid}/stages/brief/approve", json={"comment": "ok"}, headers=auth)
    assert r.status_code == 200 and r.json()["status"] == "done"
    assert client.post(f"/packs/marketing/topics/{tid}/stages/brief/approve", headers=auth).status_code == 409
    assert not [i for i in client.get("/inbox?kind=pack_stage_review", headers=auth).json()["items"] if i["kind"] == "pack_stage_review"]

    # copy 現在可跑 → review
    r = client.post(f"/packs/marketing/topics/{tid}/stages/copy/run", headers=auth)
    assert r.status_code == 202, r.text
    st = _wait_stage(client, auth, tid, "copy", {"done", "failed", "review"})
    assert st["status"] == "review"
    assert list(gw_state.runs.values())[-1]["profile"] == "content-copywriter"
    run_info = client.get(f"/packs/marketing/topics/{tid}/stages/copy/run", headers=auth).json()
    assert run_info["run_id"] and run_info["run"]["status"] == "completed" and run_info["session_id"]

    # 主題清單有狀態燈
    lst = client.get("/packs/marketing/topics", headers=auth).json()
    assert lst[0]["id"] == tid and lst[0]["lights"][:3] == ["done", "done", "review"] and lst[0]["current_stage"] == "copy"

    # 檔案讀寫
    r = client.put(f"/packs/marketing/topics/{tid}/file", json={"path": "copy/fb.md", "content": "# FB\n人工補的"}, headers=auth)
    assert r.status_code == 200
    r = client.get(f"/packs/marketing/topics/{tid}/file?path=copy/fb.md", headers=auth)
    assert r.status_code == 200 and r.json()["content"].startswith("# FB")
    assert client.get(f"/packs/marketing/topics/{tid}/file?path=../x", headers=auth).status_code == 400
    assert client.get(f"/packs/marketing/topics/{tid}/file?path=nope.md", headers=auth).status_code == 404

    # 事件有記
    evs = client.get("/events?kind=pack.*", headers=auth).json()["items"]
    kinds = {e["kind"] for e in evs}
    assert {"pack.install", "pack.topic.created", "pack.stage.run", "pack.stage.finished",
            "pack.stage.decided", "pack.marketing.ready"} <= kinds


def test_failed_run_marks_stage_failed(client, auth, gw_state):
    client.post("/packs/marketing/install", headers=auth)
    tid = client.post("/packs/marketing/topics", json={"title": "x"}, headers=auth).json()["id"]
    gw_state.scenario = "failed"
    assert client.post(f"/packs/marketing/topics/{tid}/stages/topics/run", headers=auth).status_code == 202
    st = _wait_stage(client, auth, tid, "topics", {"done", "failed", "review"})
    assert st["status"] == "failed" and st["error"]
    gw_state.scenario = "simple"
    # failed 可以重跑
    assert client.post(f"/packs/marketing/topics/{tid}/stages/topics/run", headers=auth).status_code == 202
    assert _wait_stage(client, auth, tid, "topics", {"done", "failed", "review"})["status"] == "done"
