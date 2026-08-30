"""CLI pid-file handling, security preflight, and SPA static fallback."""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studio import cli
from studio.app import create_app
from studio.config import Settings
from studio.db import init_db, make_engine
from studio.static import install_static, resolve_static


# ---------- pid ----------

def test_pid_roundtrip_and_stale_cleanup(tmp_path: Path):
    pf = tmp_path / "studio.pid"
    assert cli.read_pid(pf) is None
    cli.write_pid(pf, os.getpid())
    assert cli.read_pid(pf) == os.getpid()
    assert cli.running_pid(pf) == os.getpid()
    # stale: a pid that surely does not exist
    pf.write_text("999999999\n")
    assert cli.running_pid(pf) is None
    assert not pf.exists()  # stale file removed
    pf.write_text("garbage")
    assert cli.read_pid(pf) is None


def test_pid_file_records_port_and_status_uses_it(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("STUDIO_HOME", str(tmp_path))
    pf = cli.pid_file()
    cli.write_pid(pf, os.getpid(), 8765, "127.0.0.1")
    assert cli.read_pid(pf) == os.getpid()
    assert cli.read_meta(pf) == {"port": "8765", "host": "127.0.0.1"}
    assert cli.recorded_port(pf) == 8765
    ns = cli.build_parser().parse_args(["status"])
    assert cli.effective_port(ns, pf) == 8765
    ns = cli.build_parser().parse_args(["status", "--port", "9000"])
    assert cli.effective_port(ns, pf) == 9000
    monkeypatch.setattr(cli, "wait_ready", lambda url, timeout=2.0: url.endswith(":9000"))
    assert cli.cmd_status(ns) == 0
    out = capsys.readouterr()
    assert "port=9000" in out.out and "health=ok" in out.out and "9000 與執行中的服務（port 8765）不同" in out.err
    # stop/logs 也吃 --port（parser 不再報錯）
    assert cli.build_parser().parse_args(["stop", "--port", "8765"]).port == 8765
    assert cli.build_parser().parse_args(["logs", "--port", "8765", "-n", "5"]).port == 8765
    # restart 沒帶 --port 就沿用 pid 檔記錄的 port
    ns = cli.build_parser().parse_args(["restart"])
    calls = {}
    monkeypatch.setattr(cli, "cmd_stop", lambda a=None: 0)
    monkeypatch.setattr(cli, "cmd_start", lambda a: calls.update(port=a.port, daemon=a.daemon) or 0)
    assert cli.cmd_restart(ns) == 0 and calls == {"port": 8765, "daemon": True}


def test_clear_login_locks_cli(tmp_path: Path, monkeypatch, capsys):
    from datetime import timedelta
    from sqlmodel import Session, select
    from studio.models import LoginLock, now

    monkeypatch.setenv("STUDIO_HOME", str(tmp_path))
    monkeypatch.setenv("STUDIO_DB", str(tmp_path / "studio.db"))
    from studio.config import Settings
    from studio.db import init_db, make_engine
    engine = make_engine(Settings.from_env().db_path)
    init_db(engine)
    with Session(engine) as db:
        db.add(LoginLock(key="u:admin", failures=5, locked_until=now() + timedelta(minutes=10)))
        db.add(LoginLock(key="ip:127.0.0.1", failures=5, locked_until=now() + timedelta(minutes=10)))
        db.commit()
    ns = cli.build_parser().parse_args(["clear-login-locks", "--username", "Admin"])
    assert cli.cmd_clear_login_locks(ns) == 0 and "已清除 1 筆" in capsys.readouterr().out
    with Session(engine) as db:
        assert [r.key for r in db.exec(select(LoginLock)).all()] == ["ip:127.0.0.1"]
    ns = cli.build_parser().parse_args(["clear-login-locks"])
    assert cli.cmd_clear_login_locks(ns) == 0 and "已清除 1 筆" in capsys.readouterr().out
    with Session(engine) as db:
        assert db.exec(select(LoginLock)).all() == []


def test_status_and_stop_without_process(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("STUDIO_HOME", str(tmp_path))
    assert cli.pid_file() == tmp_path / "studio.pid"
    assert cli.log_file() == tmp_path / "logs" / "studio.log"
    assert cli.cmd_status(None) == 3
    assert cli.cmd_stop(None) == 0
    assert "stopped" in capsys.readouterr().out


def test_stop_pid_terminates_child():
    import subprocess, sys
    p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    assert cli.pid_alive(p.pid)
    assert cli.stop_pid(p.pid, timeout=5)
    p.wait(timeout=5)
    assert not cli.pid_alive(p.pid)


def test_start_refuses_when_already_running(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("STUDIO_HOME", str(tmp_path))
    cli.write_pid(cli.pid_file(), os.getpid())
    ns = cli.build_parser().parse_args(["start", "--daemon"])
    assert cli.cmd_start(ns) == 1
    assert "已在執行中" in capsys.readouterr().err


# ---------- preflight ----------

def _settings(tmp_path: Path, host: str) -> Settings:
    s = Settings()
    s.host = host
    s.db_path = tmp_path / "studio.db"
    return s


def test_preflight_loopback_ok_with_defaults(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("STUDIO_SECRET", raising=False)
    monkeypatch.delenv("STUDIO_ADMIN_PASSWORD", raising=False)
    engine = make_engine(":memory:")
    assert cli.preflight(_settings(tmp_path, "127.0.0.1"), engine) == []
    assert cli.preflight(_settings(tmp_path, "localhost"), engine) == []


def test_preflight_public_bind_requires_secret_and_password(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("STUDIO_SECRET", raising=False)
    monkeypatch.delenv("STUDIO_ADMIN_PASSWORD", raising=False)
    engine = make_engine(":memory:")
    problems = cli.preflight(_settings(tmp_path, "0.0.0.0"), engine)
    assert len(problems) == 2
    assert any("STUDIO_SECRET" in p for p in problems)
    assert any("admin" in p for p in problems)

    monkeypatch.setenv("STUDIO_SECRET", "x" * 32)
    monkeypatch.setenv("STUDIO_ADMIN_PASSWORD", "short")
    assert cli.preflight(_settings(tmp_path, "0.0.0.0"), engine) == ["STUDIO_ADMIN_PASSWORD 至少 8 個字元"]

    monkeypatch.setenv("STUDIO_ADMIN_PASSWORD", "correct-horse-battery")
    assert cli.preflight(_settings(tmp_path, "0.0.0.0"), engine) == []
    assert not cli.admin_uses_default_password(engine)


def test_reset_admin_changes_login(tmp_path: Path, monkeypatch):
    engine = make_engine(":memory:")
    init_db(engine)
    assert cli.admin_uses_default_password(engine)
    assert cli.set_admin_password(engine, "new-password-1") == 1
    assert not cli.admin_uses_default_password(engine)
    assert cli.set_admin_password(engine, "x", "nobody") == 0


# ---------- static SPA ----------

@pytest.fixture
def dist(tmp_path: Path) -> Path:
    d = tmp_path / "web_dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<html><body>STUDIO-INDEX</body></html>")
    (d / "assets" / "app.js").write_text("console.log('app')")
    (tmp_path / "outside.txt").write_text("secret")
    return d


def _client(dist: Path | None):
    st = Settings()
    st.secret = "test-secret"
    app = create_app(st, engine=make_engine(":memory:"), sync_agents=False)
    mounted = install_static(app, dist)
    c = TestClient(app)
    c.__enter__()  # run lifespan (init_db)
    return c, mounted


def test_resolve_static_blocks_traversal(dist: Path):
    assert resolve_static(dist, "/assets/app.js") == (dist / "assets" / "app.js").resolve()
    assert resolve_static(dist, "/../outside.txt") is None
    assert resolve_static(dist, "/assets/../../outside.txt") is None
    assert resolve_static(dist, "/") is None
    assert resolve_static(dist, "/assets") is None  # directory, not a file


def test_spa_fallback_and_api_prefix(dist: Path):
    c, mounted = _client(dist)
    assert mounted
    r = c.get("/")
    assert r.status_code == 200 and "STUDIO-INDEX" in r.text
    r = c.get("/chat/some/deep/route")
    assert r.status_code == 200 and "STUDIO-INDEX" in r.text
    r = c.get("/assets/app.js")
    assert r.status_code == 200 and "console.log" in r.text
    # API keeps working without prefix and with /api prefix
    assert c.get("/health").json() == {"ok": True}
    assert c.get("/api/health").json() == {"ok": True}
    # unknown API path must be 404 JSON, not index.html
    r = c.get("/api/does-not-exist")
    assert r.status_code == 404 and "STUDIO-INDEX" not in r.text
    r = c.get("/ws/nope")
    assert r.status_code == 404
    # traversal attempt → falls back to index (never leaks outside)
    r = c.get("/..%2Foutside.txt")
    assert "secret" not in r.text


def test_api_prefix_on_post_and_websocket(dist: Path):
    c, _ = _client(dist)
    r = c.post("/api/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 200 and r.json()["token"]
    token = r.json()["token"]
    with c.websocket_connect(f"/api/ws/chat?token={token}") as ws:
        ws.close()


def test_without_dist_only_api(tmp_path: Path):
    c, mounted = _client(tmp_path / "nope")
    assert not mounted
    assert c.get("/health").json() == {"ok": True}
    assert c.get("/api/health").json() == {"ok": True}
    # 沒有前端產物時，瀏覽器路徑回可讀的 503 說明（見 test_missing_web_dist_explains_instead_of_404）
    assert c.get("/").status_code == 503


def test_spa_deep_link_beats_same_named_api_route(tmp_path):
    """瀏覽器直接開 /workflows（Accept: text/html）要拿到 index.html，不是 API 的 401。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from studio.static import install_static
    dist = tmp_path / "dist"; dist.mkdir(); (dist / "index.html").write_text("<html>SPA</html>")
    app = FastAPI()

    @app.get("/workflows")
    def wf():
        return {"api": True}

    install_static(app, dist)
    c = TestClient(app)
    assert "SPA" in c.get("/workflows", headers={"Accept": "text/html,*/*"}).text
    assert c.get("/api/workflows", headers={"Accept": "text/html"}).json() == {"api": True}
    assert c.get("/workflows", headers={"Accept": "application/json"}).json() == {"api": True}


def test_rename_legacy_home_is_moved(monkeypatch, tmp_path):
    """舊 ~/.hermes-studio-tw 存在、新目錄不存在 → 自動 rename，DB 跟著過去。"""
    from studio import config

    old, new = tmp_path / ".hermes-studio-tw", tmp_path / ".myhermescompany"
    old.mkdir()
    (old / "studio.db").write_text("x")
    monkeypatch.delenv("STUDIO_HOME", raising=False)
    monkeypatch.delenv("MHC_HOME", raising=False)
    monkeypatch.setattr(config, "DEFAULT_HOME", new)
    monkeypatch.setattr(config, "LEGACY_HOME", old)
    assert config.data_home() == new
    assert (new / "studio.db").read_text() == "x" and not old.exists()
    # 再叫一次不會動（新目錄已存在）
    assert config.data_home() == new


def test_rename_mhc_env_overrides_studio_env(monkeypatch, tmp_path):
    import studio
    from studio import config

    monkeypatch.setenv("STUDIO_HOME", str(tmp_path / "old"))
    monkeypatch.setenv("MHC_HOME", str(tmp_path / "new"))
    monkeypatch.setenv("MHC_PORT", "8799")
    studio.alias_env()
    assert config.data_home() == tmp_path / "new"
    assert os.environ["STUDIO_PORT"] == "8799"


# ---------- round3：hermes-check / install-skill / precheck 子命令 ----------

def test_new_subcommands_parse_and_dispatch(tmp_path: Path, monkeypatch, capsys):
    import studio.modules.compat.__main__ as compat_main
    import studio.modules.search.install as search_install

    seen: dict = {}
    monkeypatch.setattr(compat_main, "main", lambda argv: seen.update(compat=argv) or 0)
    ns = cli.build_parser().parse_args(["hermes-check", "--json", "--writes", "--only", "gw.health,gw.models"])
    assert ns.fn(ns) == 0 and seen["compat"] == ["hermes-check", "--json", "--writes", "--only", "gw.health,gw.models"]

    monkeypatch.setattr(search_install, "main", lambda argv: seen.update(skill=argv) or 0)
    ns = cli.build_parser().parse_args(["install-skill", "mhc-search", "--profile", "researcher", "--hermes-home", str(tmp_path)])
    assert ns.fn(ns) == 0 and seen["skill"] == ["mhc-search", "--profile", "researcher", "--hermes-home", str(tmp_path)]
    assert cli.build_parser().parse_args(["install-skill"]).name == "mhc-search"

    ns = cli.build_parser().parse_args(["precheck"])
    assert ns.version == "latest" and ns.fn is cli.cmd_precheck
    assert cli.build_parser().parse_args(["precheck", "v2026.8.19", "--json"]).version == "v2026.8.19"


def test_install_skill_cli_end_to_end(tmp_path: Path, monkeypatch, capsys):
    """真的透過 cli 把 mhc-search 裝進暫存 HERMES_HOME 的 profile。"""
    (tmp_path / "profiles" / "researcher").mkdir(parents=True)
    ns = cli.build_parser().parse_args(["install-skill", "mhc-search", "--profile", "researcher", "--hermes-home", str(tmp_path)])
    assert ns.fn(ns) == 0
    assert (tmp_path / "profiles" / "researcher" / "skills" / "mhc-search" / "SKILL.md").is_file()
    assert "installed mhc-search" in capsys.readouterr().out


def test_precheck_cli_prints_report_and_exit_code(monkeypatch, capsys):
    from studio.modules.compat import precheck as pc

    async def fake_run(job, *, workdir_root=None, keep=False, on_update=None, **kw):
        job.step("cloning", "v2026.8.19")
        job.tag = "v2026.8.19"
        job.report = {"hermes": {"version": "0.20.5"}, "summary": {"verdict": "partial", "pass": 1, "fail": 1, "skip": 0, "total": 2,
                                                                     "affected_modules": [{"module": "cron", "failed": ["gw.jobs.list"]}]},
                      "mode": {"sandbox": True, "writes": True}, "duration_ms": 10, "items": [
                          {"id": "gw.health", "status": "pass", "reason": "", "risk": "low", "label": "health"},
                          {"id": "gw.jobs.list", "status": "fail", "reason": "404", "risk": "low", "label": "jobs"}]}
        job.status = "done"
        return job

    monkeypatch.setattr(pc, "run_precheck", fake_run)
    ns = cli.build_parser().parse_args(["precheck", "v2026.8.19"])
    assert ns.fn(ns) == 1  # partial
    out = capsys.readouterr()
    assert "部分相容" in out.out and "gw.jobs.list" in out.out and "[cloning] v2026.8.19" in out.err
    ns = cli.build_parser().parse_args(["precheck", "--json"])
    assert ns.fn(ns) == 1
    assert '"verdict": "partial"' in capsys.readouterr().out


def test_missing_web_dist_explains_instead_of_404(tmp_path):
    """沒有前端產物時，瀏覽器該拿到可讀的 503 說明，不是無聲 404。"""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from studio.static import install_static

    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    assert install_static(app, tmp_path / "nope") is False
    c = TestClient(app)
    r = c.get("/", headers={"Accept": "text/html"})
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "web_not_built"
    assert c.get("/api/health").json() == {"ok": True}
