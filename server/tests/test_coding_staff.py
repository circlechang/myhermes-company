"""AI 員工＝Coding Agent：runtime 欄位、建立、三處分派（聊天／工作流／群聊）、派工作端點與 token 權限。"""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import pytest
from sqlmodel import Session, select

from studio.db import init_db, make_engine
from studio.models import Agent
from studio.modules.coding_agents import staff

FAKE_DIR = Path(__file__).parent / "fake_cli"
FAKE_BINS = {"claude": str(FAKE_DIR / "fake_claude.sh"), "codex": str(FAKE_DIR / "fake_codex.sh")}


# ---------------------------------------------------------------- fixtures
@pytest.fixture
def allowed_root(tmp_path, monkeypatch) -> Path:
    """一個在白名單裡的 git repo（透過 STUDIO_FILE_ROOTS 開放）。"""
    root = tmp_path / "roots"
    repo = root / "repo"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
                   cwd=repo, check=True)
    monkeypatch.setenv("STUDIO_FILE_ROOTS", f"code={root}")
    return repo


@pytest.fixture
def capp(app, allowed_root):
    app.state.coding_bins = dict(FAKE_BINS)  # pi 故意不給 → 測「未安裝擋下」
    return app


@pytest.fixture
def cclient(capp):
    from fastapi.testclient import TestClient
    with TestClient(capp) as c:
        yield c


@pytest.fixture
def cauth(cclient) -> tuple[str, dict[str, str]]:
    tok = cclient.post("/auth/login", json={"username": "admin", "password": "admin"}).json()["token"]
    return tok, {"Authorization": f"Bearer {tok}"}


def make_coder(client, auth, root: Path, *, name="devbot", runtime="claude-code", **extra):
    body = {"name": name, "runtime": runtime, "workspace": str(root), "title": "工程", **extra}
    r = client.post("/agents", json=body, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------- A1 欄位與遷移
def test_runtime_column_added_to_existing_db_with_hermes_default(tmp_path):
    """舊資料庫（沒有 runtime 欄位）啟動後自動補欄位，既有列一律是 hermes。"""
    db = tmp_path / "old.db"
    eng = make_engine(db)
    import sqlalchemy as sa
    with eng.begin() as conn:
        conn.execute(sa.text("CREATE TABLE companies (id VARCHAR PRIMARY KEY, name VARCHAR, created_at DATETIME)"))
        conn.execute(sa.text("CREATE TABLE agents (id VARCHAR PRIMARY KEY, company_id VARCHAR, name VARCHAR, profile VARCHAR,"
                             " title VARCHAR, description VARCHAR, avatar VARCHAR, model VARCHAR, enabled BOOLEAN,"
                             " created_at DATETIME, updated_at DATETIME)"))
        conn.execute(sa.text("INSERT INTO agents (id, company_id, name, profile, enabled) VALUES ('ag_old', 'co', '舊員工', 'researcher', 1)"))
    init_db(eng)  # _add_missing_columns 會補 runtime / workspace / coding_config_json
    with Session(eng) as s:
        a = s.get(Agent, "ag_old")
        assert a.runtime == "hermes" and a.workspace == "" and a.coding_config_json == "{}"
        assert staff.is_coding(staff.runtime_of(a)) is False


def test_synced_hermes_agents_are_runtime_hermes(client, auth):
    rows = client.get("/agents", headers=auth).json()
    assert rows and all(a["runtime"] == "hermes" for a in rows)
    assert all(a["installed"] is True and a["coding_config"] is None for a in rows)


# ---------------------------------------------------------------- A2 建立三種 runtime
def test_create_three_runtimes_and_block_uninstalled(cclient, cauth, allowed_root):
    _, auth = cauth
    cat = cclient.get("/agents/runtimes", headers=auth).json()
    by_id = {r["id"]: r for r in cat["runtimes"]}
    assert set(by_id) == {"hermes", "claude-code", "codex", "pi"}
    assert by_id["claude-code"]["installed"] and by_id["codex"]["installed"]
    assert by_id["pi"]["installed"] is False and by_id["pi"]["install_cmd"].startswith("npm i -g")
    assert any(r["path"] == str(allowed_root.parent) for r in cat["workspace_roots"])

    h = cclient.post("/agents", json={"name": "小助", "profile": "researcher", "runtime": "hermes"}, headers=auth)
    assert h.status_code == 201 and h.json()["runtime"] == "hermes" and h.json()["profile"] == "researcher"

    cc = make_coder(cclient, auth, allowed_root, name="devbot")
    assert cc["runtime"] == "claude-code" and cc["runtime_name"] == "Claude Code"
    assert cc["workspace"] == str(allowed_root) and cc["profile"] == "" and cc["installed"] is True
    assert cc["coding_config"]["extra"] == {"permission_mode": "acceptEdits"} and cc["coding_config"]["api_mode"] == "direct"
    assert cc["workspace_vpath"].startswith("extra:code/")

    cx = make_coder(cclient, auth, allowed_root, name="codexbot", runtime="codex")
    assert cx["runtime"] == "codex" and cx["coding_config"]["extra"] == {"sandbox": "workspace-write"}

    # 未安裝：擋下並給安裝指令
    r = cclient.post("/agents", json={"name": "pibot", "runtime": "pi", "workspace": str(allowed_root)}, headers=auth)
    assert r.status_code == 400 and r.json()["error"]["code"] == "agent_not_installed"
    assert "npm i -g @mariozechner/pi-coding-agent" in r.json()["error"]["message"]

    # runtime 亂寫
    assert cclient.post("/agents", json={"name": "x", "runtime": "gpt5"}, headers=auth).status_code == 400


def test_workspace_allowlist(cclient, cauth, allowed_root, tmp_path):
    _, auth = cauth
    outside = tmp_path / "outside"
    outside.mkdir()
    r = cclient.post("/agents", json={"name": "bad", "runtime": "claude-code", "workspace": str(outside)}, headers=auth)
    assert r.status_code == 400 and r.json()["error"]["code"] == "workspace_not_allowed"
    r = cclient.post("/agents", json={"name": "bad2", "runtime": "claude-code", "workspace": ""}, headers=auth)
    assert r.status_code == 400 and r.json()["error"]["code"] == "workspace_required"
    r = cclient.post("/agents", json={"name": "bad3", "runtime": "claude-code", "workspace": str(allowed_root / "nope")}, headers=auth)
    assert r.status_code == 400 and r.json()["error"]["code"] == "workspace_missing"
    # 子目錄可以
    sub = allowed_root / "sub"
    sub.mkdir()
    ok = make_coder(cclient, auth, sub, name="subbot")
    assert ok["workspace"] == str(sub)


def test_coding_agent_has_no_soul_or_skills(cclient, cauth, allowed_root):
    _, auth = cauth
    a = make_coder(cclient, auth, allowed_root)
    assert cclient.get(f"/agents/{a['id']}/soul", headers=auth).status_code == 400
    assert cclient.get(f"/agents/{a['id']}/skills", headers=auth).status_code == 400
    # patch 設定
    r = cclient.patch(f"/agents/{a['id']}", json={"coding_config": {"model": "sonnet", "api_mode": "hermes"}}, headers=auth)
    assert r.status_code == 200 and r.json()["coding_config"]["model"] == "sonnet" and r.json()["model"] == "sonnet"
    assert cclient.patch(f"/agents/{a['id']}", json={"coding_config": {"api_mode": "weird"}}, headers=auth).status_code == 400


# ---------------------------------------------------------------- A3 聊天分派
def _collect(ws, until=("run.completed", "run.failed", "run.cancelled")):
    events = []
    while True:
        ev = json.loads(ws.receive_text())
        events.append(ev)
        if ev["type"] in until:
            return events


def test_chat_ws_dispatches_by_runtime(cclient, cauth, allowed_root):
    tok, auth = cauth
    a = make_coder(cclient, auth, allowed_root)
    s = cclient.post("/sessions", json={"agent_id": a["id"]}, headers=auth).json()
    assert s["source"] == "coding:claude"  # 對話照樣落庫，標成 coding:<cli>
    with cclient.websocket_connect(f"/ws/chat?token={tok}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "WRITE_FILE please"}))
        events = _collect(ws)
    types = [e["type"] for e in events]
    assert types[0] == "run.started" and types[-1] == "run.completed"
    assert events[0]["runtime"] == "claude-code" and events[0]["workspace"] == str(allowed_root)
    assert "tool.started" in types and "tool.completed" in types and types.count("message.delta") == 2
    done = events[-1]
    assert done["output"].startswith("Here is hello")
    assert (allowed_root / "hello.py").read_text().strip() == 'print("hello")'
    assert "hello.py" in done["diff"]["after"]
    # 落庫：user / tool / assistant 三則
    msgs = cclient.get(f"/sessions/{s['id']}/messages", headers=auth).json()
    assert [m["role"] for m in msgs] == ["user", "tool", "assistant"]
    # session 也出現在 coding 頁的清單（同一份資料）
    assert s["id"] in [x["id"] for x in cclient.get("/coding/sessions", headers=auth).json()]


def test_chat_ws_second_turn_resumes(cclient, cauth, allowed_root, tmp_path, monkeypatch):
    tok, auth = cauth
    argv_out = tmp_path / "argv.txt"
    a = make_coder(cclient, auth, allowed_root)
    s = cclient.post("/sessions", json={"agent_id": a["id"]}, headers=auth).json()
    monkeypatch.setenv("FAKE_ARGV_OUT", str(argv_out))
    with cclient.websocket_connect(f"/ws/chat?token={tok}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "first"}))
        _collect(ws)
        assert "--resume" not in argv_out.read_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "second"}))
        _collect(ws)
    lines = argv_out.read_text().splitlines()
    assert "--resume" in lines and lines[lines.index("--resume") + 1] == "fake-claude-session-1"


def test_chat_ws_hermes_agent_still_uses_gateway(client, auth, token):
    """既有行為不能退步：Hermes 員工照樣走 gateway。"""
    a = client.get("/agents", headers=auth).json()[0]
    s = client.post("/sessions", json={"agent_id": a["id"]}, headers=auth).json()
    assert s["source"] == "workbench"
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "hi"}))
        events = _collect(ws)
    assert events[-1]["type"] == "run.completed" and events[-1]["output"].startswith("echo[")


# ---------------------------------------------------------------- A4 工作流分派
def test_workflow_dispatches_by_runtime(cclient, cauth, allowed_root, capp):
    _, auth = cauth
    a = make_coder(cclient, auth, allowed_root)
    wf = cclient.post("/workflows", json={
        "name": "coding 員工工作流",
        "nodes": [{"id": "n1", "kind": "hermes", "title": "改檔案", "agent_id": a["id"], "prompt": "WRITE_FILE"}],
        "edges": [],
    }, headers=auth).json()
    eng = capp.state.workflow_engine
    seen: list[tuple[str, str, str]] = []

    async def fake_runner(tool, prompt, cwd, *, on_delta=None, timeout=1800.0):
        seen.append((tool, prompt, cwd))
        if on_delta:
            await on_delta("ok")
        return {"output": f"{tool} 做完了", "exit_code": 0, "usage": {}}

    eng.coding_available = lambda tool: "/usr/bin/fake"
    eng.coding_runner = fake_runner
    r = cclient.post(f"/workflows/{wf['id']}/run", json={}, headers=auth)
    assert r.status_code == 202, r.text
    rid = r.json()["run_id"]
    for _ in range(200):
        d = cclient.get(f"/workflow-runs/{rid}", headers=auth).json()
        if d["status"] in ("completed", "failed"):
            break
        time.sleep(0.05)
    assert d["status"] == "completed", d
    assert d["node_states"]["n1"]["output"] == "claude-code 做完了"
    assert seen and seen[0][0] == "claude-code" and seen[0][2] == str(allowed_root)


# ---------------------------------------------------------------- A5 群聊
def test_groupchat_mention_coding_staff(cclient, cauth, allowed_root, capp):
    _, auth = cauth
    a = make_coder(cclient, auth, allowed_root, name="devbot")
    room = cclient.post("/groupchat/rooms", json={"name": "工程室", "agent_ids": [a["id"]]}, headers=auth).json()
    members = cclient.get(f"/groupchat/rooms/{room['id']}/members", headers=auth).json()
    assert any(m["kind"] == "ai" and m["display_name"] == "devbot" for m in members)
    r = cclient.post(f"/groupchat/rooms/{room['id']}/messages", json={"content": "@devbot 幫我 WRITE_FILE"}, headers=auth)
    assert r.status_code == 201, r.text
    orch = capp.state.groupchat
    deadline = time.time() + 30
    while orch.tasks and time.time() < deadline:
        time.sleep(0.05)
    assert not orch.tasks, "coding 員工的群聊回覆沒在時限內結束"
    texts = [m["content"] for m in cclient.get(f"/groupchat/rooms/{room['id']}/messages", headers=auth).json()]
    assert any("Here is hello" in t for t in texts), texts
    assert (allowed_root / "hello.py").exists()


# ---------------------------------------------------------------- B 派工作端點與 token 權限
def _wait_job(client, auth, job_id, timeout=20.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        j = client.get(f"/coding/jobs/{job_id}", headers=auth).json()
        if j["done"]:
            return j
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} 沒有在 {timeout}s 內結束")


def test_jobs_endpoint_runs_and_reports_diff(cclient, cauth, allowed_root):
    _, auth = cauth
    a = make_coder(cclient, auth, allowed_root, name="devbot")
    staff_rows = cclient.get("/coding/staff", headers=auth).json()
    assert [x["name"] for x in staff_rows] == ["devbot"] and staff_rows[0]["installed"]

    r = cclient.post("/coding/jobs", json={"agent": "devbot", "task": "WRITE_FILE 一下"}, headers=auth)
    assert r.status_code == 201, r.text
    job = _wait_job(cclient, auth, r.json()["id"])
    assert job["status"] == "completed" and job["runtime"] == "claude-code"
    assert job["output"].startswith("Here is hello")
    assert [c["path"] for c in job["changes"]] == ["hello.py"]
    assert job["changes"][0]["added"] == 1 and job["changes"][0]["preexisting"] is False
    full = cclient.get(f"/coding/jobs/{job['id']}/diff", headers=auth).json()
    assert "hello.py" in full["diff"] and full["workspace"] == str(allowed_root)
    assert cclient.get("/coding/jobs", headers=auth).json()[0]["id"] == job["id"]

    # 第二次派工作：工作區已經髒了 → hello.py 要被標成 preexisting，不算這次的成果
    r2 = cclient.post("/coding/jobs", json={"agent": "devbot", "task": "什麼都不做"}, headers=auth)
    job2 = _wait_job(cclient, auth, r2.json()["id"])
    assert {c["path"]: c["preexisting"] for c in job2["changes"]} == {"hello.py": True}


def test_jobs_reject_hermes_agent_and_bad_workspace(cclient, cauth, allowed_root, tmp_path):
    _, auth = cauth
    make_coder(cclient, auth, allowed_root, name="devbot")
    hermes = cclient.get("/agents", headers=auth).json()[0]
    r = cclient.post("/coding/jobs", json={"agent_id": hermes["id"], "task": "x"}, headers=auth)
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_a_coding_agent"
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    r = cclient.post("/coding/jobs", json={"agent": "devbot", "task": "x", "workspace": str(outside)}, headers=auth)
    assert r.status_code == 400 and r.json()["error"]["code"] == "workspace_not_allowed"
    assert cclient.post("/coding/jobs", json={"agent": "devbot", "task": "  "}, headers=auth).status_code == 400


def test_machine_token_write_permission(cclient, cauth, allowed_root):
    _, auth = cauth
    make_coder(cclient, auth, allowed_root, name="devbot")
    ro = cclient.post("/search/tokens", json={"label": "ro"}, headers=auth).json()
    rw = cclient.post("/search/tokens", json={"label": "rw", "can_write": True}, headers=auth).json()
    assert ro["can_write"] is False and rw["can_write"] is True
    ro_h = {"Authorization": f"Bearer {ro['token']}"}
    rw_h = {"Authorization": f"Bearer {rw['token']}"}
    # 唯讀 token：查得到員工，但派不了工作
    assert cclient.get("/coding/staff", headers=ro_h).status_code == 200
    r = cclient.post("/coding/jobs", json={"agent": "devbot", "task": "x"}, headers=ro_h)
    assert r.status_code == 403 and "唯讀" in r.json()["error"]["message"]
    # 可寫 token：可以派
    r = cclient.post("/coding/jobs", json={"agent": "devbot", "task": "WRITE_FILE"}, headers=rw_h)
    assert r.status_code == 201
    job = _wait_job(cclient, rw_h, r.json()["id"])
    assert job["status"] == "completed"
    # 撤銷後連查都不行
    cclient.delete(f"/search/tokens/{rw['id']}", headers=auth)
    assert cclient.post("/coding/jobs", json={"agent": "devbot", "task": "x"}, headers=rw_h).status_code == 401


# ---------------------------------------------------------------- B3 skill 安裝
def test_install_mhc_code_skill(cclient, cauth, hermes_home):
    _, auth = cauth
    r = cclient.post("/search/install-skill", json={"name": "mhc-code", "profile": "researcher", "write_env": True,
                                                    "create_token": True}, headers=auth)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["skill"] == "mhc-code" and d["token_can_write"] is True and d["env_key"] == "MHC_CODE_TOKEN"
    dst = hermes_home / "profiles" / "researcher" / "skills" / "mhc-code"
    assert (dst / "SKILL.md").is_file() and (dst / "scripts" / "mhc_code.py").is_file()
    env = (hermes_home / "profiles" / "researcher" / ".env").read_text()
    assert "MHC_CODE_TOKEN=mhc_" in env and "MHC_STUDIO_URL=" in env
    # mhc-search 仍然裝到自己的目錄（target_dir 不再把名字寫死）
    cclient.post("/search/install-skill", json={"name": "mhc-search", "profile": "researcher"}, headers=auth)
    assert (hermes_home / "profiles" / "researcher" / "skills" / "mhc-search" / "SKILL.md").is_file()
    assert cclient.post("/search/install-skill", json={"name": "mhc-nope"}, headers=auth).status_code == 400


def test_skill_script_help_runs():
    """skill 腳本只用標準函式庫，沒有 token 時 exit 2 並給指引。"""
    script = Path(__file__).resolve().parents[2] / "hermes-skills" / "mhc-code" / "scripts" / "mhc_code.py"
    env = {"PATH": "/usr/bin:/bin", "HERMES_HOME": "/nonexistent"}
    r = subprocess.run(["python3", str(script), "agents"], capture_output=True, text=True, env=env)
    assert r.returncode == 2 and "no token" in r.stderr
