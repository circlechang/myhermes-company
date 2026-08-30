"""首次設定精靈（modules/setup）。"""
from __future__ import annotations

import time
from pathlib import Path

from studio.modules import setup as S

GATEWAY_STATUS_RUNNING = "✓ Gateway is supervised by launchd (PID 123)\n\nOther profiles:\n  ✓ researcher — PID 456\n"
GATEWAY_STATUS_STOPPED = "✗ Gateway is not running\n"


def _fake_run(mapping: dict[str, str], calls: list[tuple[str, ...]]):
    async def run(*args, timeout=30.0):
        calls.append(args)
        for prefix, out in mapping.items():
            if " ".join(args).startswith(prefix):
                return out
        return ""
    return run


def _wait_job(client, auth, timeout=5.0) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = client.get("/setup/enable-api/progress", headers=auth).json()["job"]
        if j and j["done"]:
            return j
        time.sleep(0.05)
    raise AssertionError("job never finished")


def test_state_visible_to_everyone_and_status_owner_only(client, auth, app, monkeypatch):
    r = client.get("/setup/state", headers=auth)
    assert r.status_code == 200 and r.json() == {"completed": False, "is_owner": True}
    # 建一個 member 帳號 → status 403、state 200
    m = client.post("/members", headers=auth, json={"username": "bob", "password": "bobpass1", "role": "member"})
    assert m.status_code == 201, m.text
    tok = client.post("/auth/login", json={"username": "bob", "password": "bobpass1"}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert client.get("/setup/status", headers=h).status_code == 403
    assert client.post("/setup/complete", headers=h).status_code == 403
    assert client.post("/setup/enable-api", headers=h, json={}).status_code == 403
    assert client.get("/setup/state", headers=h).json() == {"completed": False, "is_owner": False}


def test_status_detects_everything(client, auth, app, hermes_home: Path, monkeypatch):
    calls: list = []
    app.state.fake_cli._run = _fake_run({"--version": "Hermes Agent v0.20.5 (2026.8.19) · upstream 5831d836",
                                         "gateway status": GATEWAY_STATUS_RUNNING}, calls)
    monkeypatch.setattr(S, "_resolve_bin", lambda b: "/fake/bin/hermes")
    # tmp home 沒有 .env → key 未設；Studio 是用 fake key 起的，所以 8642（假 gateway）連得上
    r = client.get("/setup/status", headers=auth)
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["hermes"]["installed"] is True and s["hermes"]["version"] == "0.20.5"
    assert s["hermes"]["home_exists"] is True
    assert s["api"]["key_configured"] is False and s["api"]["key_source"] == "none"
    assert s["api"]["reachable"] is True and s["api"]["version"] == "0.20.5-fake"
    assert s["gateway"]["running"] is True and s["gateway"]["pid"] == 123
    assert s["profiles"]["count"] == 3 and "researcher" in s["profiles"]["names"]
    assert s["admin"]["default_password"] is True
    assert s["completed"] is False and s["next_step"] == "api"
    assert "test-key" not in r.text  # 永不回 key 值

    # 沒裝 hermes
    monkeypatch.setattr(S, "_resolve_bin", lambda b: None)
    s = client.get("/setup/status", headers=auth).json()
    assert s["hermes"]["installed"] is False and s["next_step"] == "install"
    assert s["hermes"]["install_cmd"].startswith("curl")

    # key 已設＋gateway 沒跑
    (hermes_home / ".env").write_text("API_SERVER_KEY=" + "x" * 32 + "\n")
    monkeypatch.setattr(S, "_resolve_bin", lambda b: "/fake/bin/hermes")
    app.state.fake_cli._run = _fake_run({"gateway status": GATEWAY_STATUS_STOPPED}, calls)
    s = client.get("/setup/status", headers=auth).json()
    assert s["api"]["key_configured"] is True and s["api"]["key_source"] == "env_file"
    assert s["gateway"]["running"] is False


def test_enable_api_writes_key_only_that_line_with_backup(client, auth, app, hermes_home: Path):
    env = hermes_home / ".env"
    env.write_text("# my comment\nOPENROUTER_API_KEY=abc\nLINE_PORT=8646\n")
    calls: list = []
    app.state.fake_cli._run = _fake_run({"gateway status": GATEWAY_STATUS_RUNNING, "gateway restart": "ok"}, calls)
    r = client.post("/setup/enable-api", headers=auth, json={"dry_run": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "written" and body["changed"] is True
    assert body["backup"] and Path(body["backup"]).exists() and Path(body["backup"]).name.startswith(".env.bak-")
    lines = env.read_text().splitlines()
    assert lines[:3] == ["# my comment", "OPENROUTER_API_KEY=abc", "LINE_PORT=8646"]
    assert len(lines) == 4 and lines[3].startswith("API_SERVER_KEY=")
    key = lines[3].split("=", 1)[1]
    assert len(key) >= 32
    assert key not in r.text  # 回應絕不含 key
    # 備份是寫入前的內容
    assert Path(body["backup"]).read_text().splitlines() == lines[:3]
    # 已同步到 Studio
    assert app.state.settings.hermes_api_key == key and app.state.gateway.api_key == key
    job = _wait_job(client, auth)
    assert job["ok"] is True and job["dry_run"] is True
    assert [s["name"] for s in job["steps"]] == ["write_key", "gateway", "health"]
    assert key not in str(job)
    # dry-run 不碰 gateway
    assert not any(a[:1] == ("gateway",) and a[1] in ("restart", "start") for a in calls)


def test_enable_api_does_not_overwrite_existing_key(client, auth, app, hermes_home: Path):
    env = hermes_home / ".env"
    original = "API_SERVER_KEY=test-key-already-set-0123456789\nFOO=bar\n"
    env.write_text(original)
    app.state.gateway.api_key = "test-key"  # 假 gateway 只認這把；模擬「檔案 key 對不上 gateway」
    calls: list = []
    app.state.fake_cli._run = _fake_run({"gateway status": GATEWAY_STATUS_RUNNING, "gateway restart": "restarted"}, calls)
    r = client.post("/setup/enable-api", headers=auth, json={"dry_run": True})
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is False
    assert env.read_text() == original
    assert not list(hermes_home.glob(".env.bak-*"))  # 沒改就不備份
    # 檔案的 key 被同步到 Studio（不覆寫檔案）
    assert app.state.gateway.api_key == "test-key-already-set-0123456789"


def test_enable_api_already_configured_and_reachable(client, auth, app, hermes_home: Path):
    from tests.conftest import FAKE_KEY
    (hermes_home / ".env").write_text(f"API_SERVER_KEY={FAKE_KEY}-padded-to-16chars\n")
    # 讓檔案 key 等於假 gateway 認的 key：直接寫成 FAKE_KEY 太短（<16），改用 monkeypatch 門檻
    S_MIN = S.MIN_KEY_LEN
    S.MIN_KEY_LEN = 4
    try:
        (hermes_home / ".env").write_text(f"API_SERVER_KEY={FAKE_KEY}\n")
        r = client.post("/setup/enable-api", headers=auth, json={})
        assert r.status_code == 200, r.text
        assert r.json() == {"status": "configured", "changed": False, "reachable": True, "job": None}
    finally:
        S.MIN_KEY_LEN = S_MIN


def test_enable_api_real_restart_path_with_fake_cli(client, auth, app, hermes_home: Path, monkeypatch):
    monkeypatch.setattr(S, "HEALTH_WAIT_SECONDS", 3)
    calls: list = []
    app.state.fake_cli._run = _fake_run({"gateway status": GATEWAY_STATUS_STOPPED, "gateway start": "started"}, calls)
    app_key_before = app.state.gateway.api_key
    r = client.post("/setup/enable-api", headers=auth, json={"dry_run": False})
    assert r.status_code == 200, r.text
    job = _wait_job(client, auth, timeout=10.0)
    # 寫入的是新 key，假 gateway 不認 → health 會失敗；但流程要走到 gateway start + health
    assert any(a == ("gateway", "start") for a in calls)
    assert job["steps"][1] == {"name": "gateway", "status": "ok", "detail": "hermes gateway start"}
    assert job["steps"][2]["name"] == "health" and job["steps"][2]["status"] == "failed" and job["ok"] is False
    assert job["error"] and job["manual_cmd"].startswith("hermes gateway restart")
    assert app.state.gateway.api_key != app_key_before
    app.state.gateway.api_key = app_key_before  # 還原給其他請求


def test_admin_password_and_complete(client, auth, app):
    assert client.post("/setup/admin-password", headers=auth, json={"password": "short"}).status_code == 400
    assert client.post("/setup/admin-password", headers=auth, json={"password": "admin"}).status_code == 400
    r = client.post("/setup/admin-password", headers=auth, json={"password": "new-strong-pass-1"})
    assert r.status_code == 200 and r.json()["default_password"] is False
    assert client.post("/auth/login", json={"username": "admin", "password": "admin"}).status_code == 401
    assert client.post("/auth/login", json={"username": "admin", "password": "new-strong-pass-1"}).status_code == 200
    assert client.post("/setup/complete", headers=auth).json()["completed"] is True
    assert client.get("/setup/state", headers=auth).json()["completed"] is True
    assert client.post("/setup/reset", headers=auth).json()["completed"] is False
