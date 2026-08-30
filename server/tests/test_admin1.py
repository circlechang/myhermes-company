"""B 頻道 / C 用量 / D 排程 / G 模型 / H Profile 的自動測試。
檔案操作全在 tmp HERMES_HOME；gateway 用 fake（擴充 conftest 的 fake 加上 /api/jobs 與 /api/model/options）；
CLI 用檔案系統模擬 `hermes profile|gateway|auth|config`。"""
from __future__ import annotations

import asyncio
import json
import shutil
import sqlite3
import tarfile
import time
from pathlib import Path

import httpx
import pytest
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from studio.app import create_app
from studio.config import Settings
from studio.db import make_engine
from studio.hermes.cli import CliError
from studio.hermes.gateway import GatewayClient
from tests.conftest import FAKE_KEY, FakeCli, FakeGatewayState, make_fake_gateway


# -- fakes -------------------------------------------------------------------
class AdminFakeCli(FakeCli):
    """用檔案系統模擬 hermes profile / gateway / auth / config 指令。"""

    def __init__(self, home: Path):
        super().__init__(home)
        self.calls: list[tuple[str, ...]] = []

    async def _run(self, *args, timeout=30.0):
        self.calls.append(tuple(args))
        cmd = args[0]
        if cmd == "profile":
            return self._profile(list(args[1:]))
        if cmd == "gateway":
            if args[1] == "status":
                return ("Launchd plist: /x/ai.hermes.gateway.plist\n✓ Gateway is supervised by launchd (PID 111)\n\n"
                        "Other profiles:\n  ✓ researcher              — PID 222\n  ✗ writer           — not running\n")
            if args[1] == "restart":
                return "Gateway restarted\n"
        if cmd == "auth":
            if args[1] == "logout":
                return f"{args[2]}: logged out\n"
            if args[1] == "status":
                return f"{args[2]}: logged out\n"
        raise CliError(f"unsupported fake command: {args}")

    def _profile(self, a: list[str]) -> str:
        sub = a[0]
        pdir = self.home / "profiles"
        if sub == "list":
            return " Profile  Model  Gateway\n" + "\n".join(f"  {n}  m  running" for n in self.list_profiles_fs())
        if sub == "create":
            name = a[1]
            d = pdir / name
            d.mkdir(parents=True)
            src = None
            if "--clone-from" in a:
                src = a[a.index("--clone-from") + 1]
            if src:
                sd = self.profile_dir(src)
                for f in ("config.yaml", "SOUL.md", ".env"):
                    if (sd / f).exists():
                        shutil.copy(sd / f, d / f)
            else:
                (d / "config.yaml").write_text("# fresh\nmodel:\n  default: gpt-new\n")
                (d / "SOUL.md").write_text(f"# {name}\n")
            if "--description" in a:
                (d / "profile.yaml").write_text(f"description: {a[a.index('--description') + 1]}\n")
            return f"Created profile {name}\n"
        if sub == "delete":
            shutil.rmtree(pdir / a[1])
            return "deleted\n"
        if sub == "rename":
            if a[1] == "default":
                return "renamed display name\n"
            (pdir / a[1]).rename(pdir / a[2])
            return "renamed\n"
        if sub == "use":
            (self.home / "active_profile").write_text(a[1])
            return "ok\n"
        if sub == "export":
            out = Path(a[a.index("-o") + 1])
            with tarfile.open(out, "w:gz") as tf:
                tf.add(self.profile_dir(a[1]), arcname=a[1])
            return "exported\n"
        if sub == "import":
            arc = Path(a[1])
            with tarfile.open(arc, "r:gz") as tf:
                top = tf.getnames()[0].split("/")[0]
                name = a[a.index("--name") + 1] if "--name" in a else top
                tmp = self.home / "tmp_import"
                tf.extractall(tmp)
                shutil.move(str(tmp / top), str(pdir / name))
                shutil.rmtree(tmp, ignore_errors=True)
            return "imported\n"
        raise CliError(f"unsupported: {a}")


def add_admin_routes(gw, state: FakeGatewayState):
    jobs: dict[str, dict] = {}
    state.jobs = jobs

    def _routes(prefix: str):
        @gw.get(prefix + "/api/jobs")
        async def list_jobs(profile: str = ""):
            return {"jobs": list(jobs.values())}

        @gw.post(prefix + "/api/jobs")
        async def create_job(request: Request, profile: str = ""):
            b = await request.json()
            if not b.get("name") or not b.get("schedule"):
                return JSONResponse({"error": "Name is required"}, status_code=400)
            jid = f"job{len(jobs) + 1:03d}"
            jobs[jid] = {"id": jid, "name": b["name"], "prompt": b.get("prompt", ""), "deliver": b.get("deliver", "local"),
                         "schedule": {"kind": "cron", "expr": b["schedule"], "display": b["schedule"]}, "schedule_display": b["schedule"],
                         "enabled": True, "state": "scheduled", "profile": profile or "default", "runs": 0}
            return {"job": jobs[jid]}

        @gw.get(prefix + "/api/jobs/{job_id}")
        async def get_job(job_id: str, profile: str = ""):
            return {"job": jobs[job_id]} if job_id in jobs else JSONResponse({"error": "Job not found"}, status_code=404)

        @gw.patch(prefix + "/api/jobs/{job_id}")
        async def patch_job(job_id: str, request: Request, profile: str = ""):
            if job_id not in jobs:
                return JSONResponse({"error": "Job not found"}, status_code=404)
            jobs[job_id].update(await request.json())
            return {"job": jobs[job_id]}

        @gw.delete(prefix + "/api/jobs/{job_id}")
        async def del_job(job_id: str, profile: str = ""):
            return {"ok": True} if jobs.pop(job_id, None) else JSONResponse({"error": "Job not found"}, status_code=404)

        @gw.post(prefix + "/api/jobs/{job_id}/{action}")
        async def act(job_id: str, action: str, profile: str = ""):
            j = jobs.get(job_id)
            if not j:
                return JSONResponse({"error": "Job not found"}, status_code=404)
            if action == "pause":
                j["state"], j["enabled"] = "paused", False
            elif action == "resume":
                j["state"], j["enabled"] = "scheduled", True
            elif action == "run":
                j["runs"] += 1
            return {"job": j}

        @gw.get(prefix + "/api/model/options")
        async def options(profile: str = ""):
            return {"providers": [{"slug": "openai-codex", "name": "Codex", "is_current": True, "models": ["gpt-5.6-luna", "gpt-5.5"]},
                                  {"slug": "openrouter", "name": "OpenRouter", "is_current": False, "models": ["x/y"]}],
                    "model": "gpt-5.6-luna", "provider": "openai-codex"}

    _routes("")
    _routes("/p/{profile}")


@pytest.fixture
def fake_gateway_url(gw_state: FakeGatewayState):
    import socket
    import threading

    import uvicorn

    gw = make_fake_gateway(gw_state)
    add_admin_routes(gw, gw_state)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(gw, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.02)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    th.join(timeout=5)


def _provider_transport() -> httpx.MockTransport:
    def handler(req: httpx.Request) -> httpx.Response:
        auth = req.headers.get("authorization", "")
        if req.url.path == "/v4/models" and req.url.host == "v4.example.com":
            return httpx.Response(200, json={"data": [{"id": "glm-5"}, {"id": "glm-5-flash"}]})
        if req.url.path == "/v1/models" and req.url.host == "v1.example.com":
            if auth != "Bearer sk-test-1":
                return httpx.Response(401, json={"error": "bad key"})
            return httpx.Response(200, json={"data": [{"id": "m-a"}, {"id": "m-b"}]})
        if req.url.host == "openrouter.ai":
            return httpx.Response(200, json={"data": [{"id": "or/one"}]})
        return httpx.Response(404, text="nope")

    return httpx.MockTransport(handler)


@pytest.fixture
def app(tmp_path: Path, hermes_home: Path, gw_state: FakeGatewayState, fake_gateway_url: str):
    (hermes_home / ".env").write_text("# hermes env\nAPI_SERVER_KEY=abc\nOPENROUTER_API_KEY=or-key\nKEEP_ME=1\n")
    (hermes_home / "auth.json").write_text(json.dumps({
        "version": 1, "active_provider": "openai-codex",
        "providers": {"openai-codex": {"tokens": {"access_token": "SECRET"}, "auth_mode": "chatgpt"},
                      "nous": {"last_auth_error": {"relogin_required": True, "message": "Invalid refresh token"}}},
        "credential_pool": {"openai-codex": [{"id": "ac451f", "label": "device_code", "auth_type": "oauth", "source": "device_code", "access_token": "SECRET"}],
                            "openrouter": [{"id": "87c504", "label": "OPENROUTER_API_KEY", "auth_type": "api_key", "source": "env:OPENROUTER_API_KEY"}]},
    }))
    (hermes_home / "config.yaml").write_text(
        "# top comment\nmodel:\n  default: gpt-default  # keep me\n  provider: openai-codex\ntelegram:\n  reactions: false\ntts:\n  provider: edge\nstt:\n  provider: local\n")
    settings = Settings(port=0, db_path=tmp_path / "studio.db", secret="test-secret-test-secret-test-secret-32",
                        hermes_api_url=fake_gateway_url, hermes_api_key=FAKE_KEY, hermes_home=hermes_home, hermes_bin="hermes-fake")
    gateway = GatewayClient(settings.hermes_api_url, settings.hermes_api_key)
    cli = AdminFakeCli(hermes_home)
    application = create_app(settings, gateway=gateway, cli=cli, engine=make_engine(settings.db_path))
    application.state.fake_cli = cli
    application.state.models_transport = _provider_transport()
    return application


def _member_token(client, auth, username="bob", role="member", profiles=None):
    r = client.post("/members", json={"username": username, "password": "pass1234", "role": role, "profiles": profiles or []}, headers=auth)
    assert r.status_code == 201, r.text
    tok = client.post("/auth/login", json={"username": username, "password": "pass1234"}).json()["token"]
    return r.json(), {"Authorization": f"Bearer {tok}"}


# -- H. profiles -------------------------------------------------------------------
def test_profile_lifecycle(client, auth, hermes_home):
    names = {p["name"] for p in client.get("/profiles", headers=auth).json()["profiles"]}
    assert names == {"default", "researcher", "writer"}
    r = client.post("/profiles", json={"name": "studio-test-tmp", "description": "測試用"}, headers=auth)
    assert r.status_code == 201, r.text
    assert r.json()["description"] == "測試用" and (hermes_home / "profiles/studio-test-tmp/config.yaml").exists()
    assert client.post("/profiles", json={"name": "Bad Name"}, headers=auth).status_code == 400
    assert client.post("/profiles", json={"name": "studio-test-tmp"}, headers=auth).status_code == 409
    # agent auto-synced for the company
    assert any(a["profile"] == "studio-test-tmp" for a in client.get("/agents", headers=auth).json())
    # clone
    r = client.post("/profiles/researcher/clone", json={"new_name": "researcher-copy"}, headers=auth)
    assert r.status_code == 201 and r.json()["model"] == "stealth/ox-alpha"
    # rename (agents follow)
    r = client.post("/profiles/researcher-copy/rename", json={"new_name": "researcher2"}, headers=auth)
    assert r.status_code == 200 and (hermes_home / "profiles/researcher2").is_dir() and not (hermes_home / "profiles/researcher-copy").exists()
    assert any(a["profile"] == "researcher2" for a in client.get("/agents", headers=auth).json())
    # default switch
    assert client.post("/profiles/researcher2/use", headers=auth).json()["active"] == "researcher2"
    assert client.get("/profiles/researcher2", headers=auth).json()["is_default"] is True
    # export → import roundtrip
    r = client.get("/profiles/researcher2/export", headers=auth)
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/gzip")
    r2 = client.post("/profiles/import", files={"file": ("researcher2.tar.gz", r.content, "application/gzip")}, data={"name": "researcher3"}, headers=auth)
    assert r2.status_code == 201, r2.text
    assert (hermes_home / "profiles/researcher3/config.yaml").read_text() == (hermes_home / "profiles/researcher2/config.yaml").read_text()
    # delete
    assert client.delete("/profiles/default", headers=auth).status_code == 400
    for n in ("studio-test-tmp", "researcher2", "researcher3"):
        assert client.delete(f"/profiles/{n}", headers=auth).json()["ok"] is True
    assert not (hermes_home / "profiles/researcher3").exists()
    assert not any(a["profile"] == "researcher2" for a in client.get("/agents", headers=auth).json())


def test_profile_config_roundtrip_keeps_comments(client, auth, hermes_home):
    r = client.get("/profiles/default/config", headers=auth)
    assert r.json()["config"]["model"]["default"] == "gpt-default"
    r = client.put("/profiles/default/config", json={"set": {"model.default": "gpt-new", "agent.max_turns": 5}, "patch": {"telegram": {"reactions": True}}},
                   headers=auth)
    assert r.status_code == 200, r.text
    text = (hermes_home / "config.yaml").read_text()
    assert "# top comment" in text and "# keep me" in text and "default: gpt-new" in text and "max_turns: 5" in text
    assert "reactions: true" in text
    client.put("/profiles/default/config", json={"unset": ["agent.max_turns"]}, headers=auth)
    assert "max_turns" not in (hermes_home / "config.yaml").read_text()
    assert client.put("/profiles/default/config", json={"text": "model: [unclosed"}, headers=auth).status_code == 400
    raw = client.get("/profiles/default/config?raw=1", headers=auth).json()["text"]
    assert raw.startswith("# top comment")


def test_profile_assignment_limits_visibility(client, auth):
    bob, bob_auth = _member_token(client, auth, "bob", "member")
    assert bob["profiles"] == [] and bob["all_profiles"] is False
    assert client.get("/agents", headers=bob_auth).json() == []
    assert client.get("/profiles", headers=bob_auth).json()["profiles"] == []
    r = client.patch(f"/members/{bob['id']}", json={"profiles": ["researcher"]}, headers=auth)
    assert r.json()["profiles"] == ["researcher"]
    assert {a["profile"] for a in client.get("/agents", headers=bob_auth).json()} == {"researcher"}
    assert {p["name"] for p in client.get("/profiles", headers=bob_auth).json()["profiles"]} == {"researcher"}
    assert client.get("/profiles/writer", headers=bob_auth).status_code == 404
    assert client.get("/profiles/researcher", headers=bob_auth).status_code == 200
    # member cannot self-assign
    assert client.patch(f"/members/{bob['id']}", json={"profiles": ["writer"]}, headers=bob_auth).status_code == 403
    # assignment endpoint validates profile names
    assert client.put(f"/profiles/assignments/members/{bob['id']}", json={"profiles": ["nope"]}, headers=auth).status_code == 400
    # admin with no assignment sees all (backwards compatible); owner always all
    _, adm_auth = _member_token(client, auth, "alice", "admin")
    assert len(client.get("/agents", headers=adm_auth).json()) == 3
    me = client.get("/auth/me", headers=auth).json()
    assert me["all_profiles"] is True


# -- B. channels ---------------------------------------------------------------------
def test_channels_env_roundtrip_keeps_other_lines(client, auth, hermes_home):
    data = client.get("/channels", headers=auth).json()
    ids = [p["id"] for p in data["platforms"]]
    assert ids == ["line", "telegram", "discord", "slack", "whatsapp", "matrix", "feishu", "dingtalk", "qqbot", "weixin", "wecom"]
    line = data["platforms"][0]
    assert line["configured"] is False and line["webhook_path"] == "/line/webhook"
    assert all("value" not in f for f in line["fields"] if f["secret"])
    r = client.put("/channels/line", json={"env": {"LINE_CHANNEL_ACCESS_TOKEN": "tok#1", "LINE_CHANNEL_SECRET": "sec", "LINE_PUBLIC_URL": "https://t.example.com/"}},
                   headers=auth)
    assert r.status_code == 200, r.text
    pl = r.json()["platform"]
    assert pl["configured"] is True and pl["webhook_url"] == "https://t.example.com/line/webhook"
    tok_field = next(f for f in pl["fields"] if f["name"] == "LINE_CHANNEL_ACCESS_TOKEN")
    assert tok_field["set"] is True and "value" not in tok_field
    text = (hermes_home / ".env").read_text()
    assert "# hermes env" in text and "KEEP_ME=1" in text and 'LINE_CHANNEL_ACCESS_TOKEN="tok#1"' in text
    assert client.put("/channels/line", json={"env": {"NOT_A_FIELD": "x"}}, headers=auth).status_code == 400
    # telegram config.yaml section
    r = client.put("/channels/telegram", json={"config": {"reactions": True, "allowed_chats": "1,2"}}, headers=auth)
    assert r.json()["platform"]["config"]["reactions"] is True
    assert "reactions: true" in (hermes_home / "config.yaml").read_text()
    # remove
    r = client.delete("/channels/line", headers=auth)
    assert r.json()["env"]["LINE_CHANNEL_SECRET"] == "removed"
    text = (hermes_home / ".env").read_text()
    assert "LINE_" not in text and "KEEP_ME=1" in text and "OPENROUTER_API_KEY=or-key" in text
    # member forbidden
    _, bob_auth = _member_token(client, auth)
    assert client.get("/channels", headers=bob_auth).status_code == 403


def test_channels_gateway_status_and_restart(client, auth, app):
    st = client.get("/channels/gateway/status", headers=auth).json()
    assert st["running"] is True and st["pid"] == 111 and st["supervised"] is True
    assert {p["name"]: p["running"] for p in st["profiles"]} == {"researcher": True, "writer": False}
    r = client.put("/channels/telegram", json={"env": {"TELEGRAM_BOT_TOKEN": "t"}, "restart": True}, headers=auth)
    assert "restarted" in r.json()["restart"]
    assert ("gateway", "restart") in app.state.fake_cli.calls
    assert client.post("/channels/gateway/restart", headers=auth).json()["ok"] is True


def test_parse_gateway_status_not_running():
    from studio.modules.channels import parse_gateway_status
    st = parse_gateway_status("✗ Gateway is not running\n")
    assert st["running"] is False and st["pid"] is None


# -- D. cron -----------------------------------------------------------------------------
def test_cron_crud_pause_resume_run_history(client, auth, hermes_home, gw_state):
    assert any(p["schedule"] == "0 3 * * *" for p in client.get("/cron/presets", headers=auth).json()["presets"])
    t = client.get("/cron/targets", headers=auth).json()["targets"]
    assert {x["id"] for x in t} >= {"local", "origin", "bot-chat:default", "bot-chat:researcher"}
    assert not any(x["id"] == "line" for x in t)
    r = client.post("/cron/jobs", json={"name": "studio-test", "schedule": "0 3 * * *", "prompt": "hi", "deliver": "local"}, headers=auth)
    assert r.status_code == 201, r.text
    jid = r.json()["id"]
    assert r.json()["schedule_display"] == "0 3 * * *" and r.json()["paused"] is False
    assert client.post("/cron/jobs", json={"name": "", "schedule": "x"}, headers=auth).status_code == 400
    assert [j["id"] for j in client.get("/cron/jobs", headers=auth).json()["jobs"]] == [jid]
    assert client.patch(f"/cron/jobs/{jid}", json={"name": "renamed"}, headers=auth).json()["name"] == "renamed"
    assert client.post(f"/cron/jobs/{jid}/pause", headers=auth).json()["paused"] is True
    assert client.post(f"/cron/jobs/{jid}/resume", headers=auth).json()["paused"] is False
    assert client.post(f"/cron/jobs/{jid}/run", headers=auth).json()["runs"] == 1
    # profile prefix
    r = client.post("/cron/jobs", json={"name": "p", "schedule": "30m", "profile": "researcher"}, headers=auth)
    assert r.json()["profile"] == "researcher"
    # history from executions.db + output dir
    cron_dir = hermes_home / "cron"
    cron_dir.mkdir()
    con = sqlite3.connect(cron_dir / "executions.db")
    con.execute("CREATE TABLE executions (id TEXT PRIMARY KEY, job_id TEXT, source TEXT, process_id TEXT, pid INTEGER, process_started_at INTEGER, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT, error TEXT)")
    con.execute("INSERT INTO executions VALUES ('e1', ?, 'builtin', 'p', 1, 0, 'completed', '2026-08-29T03:00:00+08:00', '2026-08-29T03:00:01+08:00', '2026-08-29T03:00:31+08:00', NULL)", (jid,))
    con.execute("INSERT INTO executions VALUES ('e2', 'other', 'builtin', 'p', 1, 0, 'failed', '2026-08-29T04:00:00+08:00', NULL, NULL, 'boom')")
    con.commit()
    con.close()
    (cron_dir / "output" / jid).mkdir(parents=True)
    (cron_dir / "output" / jid / "2026-08-29_03-00-31.md").write_text("# result\nok")
    h = client.get(f"/cron/jobs/{jid}/runs", headers=auth).json()
    assert len(h["runs"]) == 1 and h["runs"][0]["duration_s"] == 30.0 and h["outputs"][0]["filename"].endswith(".md")
    assert client.get(f"/cron/jobs/{jid}/output/2026-08-29_03-00-31.md", headers=auth).json()["text"].startswith("# result")
    assert client.get(f"/cron/jobs/{jid}/output/../x", headers=auth).status_code in (400, 404)
    assert client.delete(f"/cron/jobs/{jid}", headers=auth).json()["ok"] is True
    assert client.get(f"/cron/jobs/{jid}", headers=auth).status_code == 404
    _, bob_auth = _member_token(client, auth)
    assert client.post("/cron/jobs", json={"name": "x", "schedule": "1h"}, headers=bob_auth).status_code == 403


# -- C. usage ------------------------------------------------------------------------------
def _make_state_db(path: Path, rows):
    con = sqlite3.connect(path)
    con.execute("""CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at REAL, message_count INTEGER, tool_call_count INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
        estimated_cost_usd REAL, api_call_count INTEGER, billing_provider TEXT)""")
    con.executemany("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    con.close()


def test_usage_summary_and_prices(client, auth, hermes_home, app):
    t = time.time()
    _make_state_db(hermes_home / "state.db", [
        ("s1", "cli", "gpt-5.6-luna", t - 3600, 4, 1, 1_000_000, 100_000, 500_000, 0, 0, None, 3, "openai-codex"),
        ("s2", "telegram", "claude-sonnet-4-6", t - 2 * 86400, 2, 0, 200_000, 10_000, 0, 0, 0, 1.5, 1, "anthropic"),
        ("old", "cli", "gpt-5.6-luna", t - 90 * 86400, 1, 0, 999, 1, 0, 0, 0, None, 1, ""),
        ("studio_abc", "api_server", "gpt-5.6-luna", t - 60, 1, 0, 1000, 10, 0, 0, 0, None, 1, ""),
    ])
    _make_state_db(hermes_home / "profiles/researcher/state.db", [("l1", "cron", "stealth/ox-alpha", t - 100, 1, 0, 50_000, 5_000, 0, 0, 0, None, 1, "")])
    s = client.get("/usage/summary?days=30", headers=auth).json()
    tot = s["totals"]
    assert tot["sessions"] == 4 and tot["input_tokens"] == 1_251_000 and tot["output_tokens"] == 115_010
    assert tot["cache_hit_rate"] == round(500_000 / (1_251_000 + 500_000), 4)
    # s1 from table: 1.0*1.25 + 0.1*10 + 0.5*0.125 = 2.3125 ; s2 hermes 1.5 ; studio_abc tiny ; researcher stealth 0
    assert tot["cost_hermes_usd"] == 1.5 and abs(tot["cost_table_usd"] - (2.3125 + (1000 * 1.25 + 10 * 10) / 1e6)) < 1e-3
    assert {b["key"] for b in s["by_profile"]} == {"default", "researcher"}
    assert s["by_model"][0]["key"] == "gpt-5.6-luna"
    assert len(s["daily"]) >= 30 and s["daily"][-1]["sessions"] >= 1
    assert {x["profile"] for x in s["sources"]} == {"default", "researcher", "writer"}
    # profile filter
    s2 = client.get("/usage/summary?days=30&profile=researcher", headers=auth).json()
    assert s2["totals"]["sessions"] == 1 and s2["totals"]["input_tokens"] == 50_000
    # company filter: only studio sessions that map to state.db
    from sqlmodel import Session
    from studio.models import Agent, ChatSession
    with Session(app.state.engine) as db:
        ag = db.exec(__import__("sqlmodel").select(Agent)).first()
        db.add(ChatSession(company_id=ag.company_id, member_id="m", agent_id=ag.id, hermes_session_id="studio_abc"))
        db.commit()
    s3 = client.get("/usage/summary?days=30&company=1", headers=auth).json()
    assert s3["totals"]["sessions"] == 1 and s3["totals"]["input_tokens"] == 1000
    assert s3["studio"]["sessions"] == 1
    # custom price overrides builtin
    r = client.put("/usage/prices", json={"model": "gpt-5.6-luna", "input": 10, "output": 10, "cache_read": 0}, headers=auth)
    assert r.status_code == 200
    s4 = client.get("/usage/summary?days=30", headers=auth).json()
    assert abs(s4["totals"]["cost_table_usd"] - ((1_000_000 + 100_000) * 10 / 1e6 + (1000 + 10) * 10 / 1e6)) < 1e-3
    prices = client.get("/usage/prices", headers=auth).json()["prices"]
    assert next(p for p in prices if p["model"] == "gpt-5.6-luna")["source"] == "custom"
    assert client.delete("/usage/prices/gpt-5.6-luna", headers=auth).json()["ok"] is True
    # member with no assigned profile sees nothing
    _, bob_auth = _member_token(client, auth)
    assert client.get("/usage/summary", headers=bob_auth).json()["totals"]["sessions"] == 0


# -- G. models ----------------------------------------------------------------------------
def test_models_providers_discovery_no_secrets(client, auth):
    d = client.get("/models/providers", headers=auth).json()
    by = {p["id"]: p for p in d["providers"]}
    assert d["active_provider"] == "openai-codex" and d["current"]["model"] == "gpt-default"
    assert by["openai-codex"]["configured"] and by["openai-codex"]["oauth_logged_in"] and by["openai-codex"]["is_active"]
    assert by["openrouter"]["configured"] and by["openrouter"]["key_env_set"] == "OPENROUTER_API_KEY"
    assert by["nous"]["configured"] is False and "Invalid refresh token" in by["nous"]["oauth_error"]
    assert by["deepseek"]["configured"] is False and by["deepseek"]["group"] == "官方 API"
    assert "SECRET" not in json.dumps(d) and "or-key" not in json.dumps(d)
    cat = client.get("/models/catalog", headers=auth).json()
    assert cat["provider"] == "openai-codex" and cat["providers"][0]["models"][0] == "gpt-5.6-luna"
    m = client.get("/models/providers/openai-codex/models", headers=auth).json()
    assert m["source"] == "gateway" and "gpt-5.5" in m["models"]
    live = client.get("/models/providers/openrouter/models?live=1", headers=auth).json()
    assert live["source"] == "live" and live["models"] == ["or/one"]


def test_models_custom_provider_detect_and_crud(client, auth, hermes_home):
    r = client.post("/models/providers/detect", json={"base_url": "https://v4.example.com", "api_key": "k"}, headers=auth)
    assert r.json()["base_url"] == "https://v4.example.com/v4" and r.json()["detected"] is True and "glm-5" in r.json()["models"]
    r = client.post("/models/providers", json={"name": "My GLM", "base_url": "https://v4.example.com", "api_key": "sk-glm"}, headers=auth)
    assert r.status_code == 201, r.text
    assert r.json()["id"] == "my-glm" and r.json()["key_env"] == "HERMES_CUSTOM_MY_GLM" and r.json()["key_set"] is True
    cfg = (hermes_home / "config.yaml").read_text()
    assert "# top comment" in cfg and "my-glm:" in cfg and "base_url: https://v4.example.com/v4" in cfg and "key_env: HERMES_CUSTOM_MY_GLM" in cfg
    assert "sk-glm" not in cfg and "HERMES_CUSTOM_MY_GLM=sk-glm" in (hermes_home / ".env").read_text()
    by = {p["id"]: p for p in client.get("/models/providers", headers=auth).json()["providers"]}
    assert by["my-glm"]["kind"] == "custom" and by["my-glm"]["key_env_set"] and by["my-glm"]["models"] == ["glm-5", "glm-5-flash"]
    live = client.get("/models/providers/my-glm/models?live=1", headers=auth).json()
    assert live["models"] == ["glm-5", "glm-5-flash"]
    assert client.post("/models/providers", json={"name": "My GLM", "base_url": "https://v4.example.com"}, headers=auth).status_code == 409
    r = client.put("/models/providers/my-glm", json={"name": "GLM2", "base_url": "https://v4.example.com/v4", "model": "glm-5-flash", "detect": False}, headers=auth)
    assert r.json()["provider"]["model"] == "glm-5-flash" and r.json()["provider"]["name"] == "GLM2"
    # wrong key → detect error surfaced but provider still saved
    r = client.post("/models/providers", json={"name": "v1p", "base_url": "https://v1.example.com", "api_key": "wrong"}, headers=auth)
    assert r.status_code == 201 and "error" in r.json()["detected"]
    # set default model to the custom provider
    r = client.put("/models/default", json={"model": "glm-5", "provider": "my-glm"}, headers=auth)
    assert r.json()["provider"] == "custom" and r.json()["base_url"] == "https://v4.example.com/v4"
    assert client.get("/models/default", headers=auth).json()["model"] == "glm-5"
    assert "# keep me" in (hermes_home / "config.yaml").read_text()
    r = client.put("/models/default?profile=researcher", json={"model": "gpt-5.5", "provider": "openai-codex"}, headers=auth)
    assert r.json()["base_url"] == "https://chatgpt.com/backend-api/codex"
    assert "default: gpt-5.5" in (hermes_home / "profiles/researcher/config.yaml").read_text()
    # delete custom → config + env cleaned
    assert client.delete("/models/providers/my-glm", headers=auth).json()["ok"] is True
    assert "my-glm" not in (hermes_home / "config.yaml").read_text() and "HERMES_CUSTOM_MY_GLM" not in (hermes_home / ".env").read_text()
    assert client.delete("/models/providers/openrouter", headers=auth).status_code == 400


def test_models_keys_prefs_speech_auth(client, auth, hermes_home, app):
    r = client.put("/models/providers/deepseek/key", json={"api_key": "ds-1"}, headers=auth)
    assert r.json()["env_var"] == "DEEPSEEK_API_KEY" and "DEEPSEEK_API_KEY=ds-1" in (hermes_home / ".env").read_text()
    assert client.put("/models/providers/openai-codex/key", json={"api_key": "x"}, headers=auth).status_code == 400
    assert client.delete("/models/providers/deepseek/key", headers=auth).json()["env"]["DEEPSEEK_API_KEY"] == "removed"
    r = client.put("/models/providers/openrouter/prefs", json={"group": "常用", "hidden_models": ["or/one"], "aliases": {"x/y": "小模型"}}, headers=auth)
    assert r.json()["group"] == "常用"
    by = {p["id"]: p for p in client.get("/models/providers", headers=auth).json()["providers"]}
    assert by["openrouter"]["group"] == "常用" and by["openrouter"]["hidden_models"] == ["or/one"] and by["openrouter"]["aliases"] == {"x/y": "小模型"}
    sp = client.get("/models/speech", headers=auth).json()
    assert sp["tts"]["provider"] == "edge" and sp["stt"]["provider"] == "local"
    r = client.put("/models/speech", json={"tts": {"provider": "openai", "openai": {"voice": "nova"}}, "env": {"ELEVENLABS_API_KEY": "el"}}, headers=auth)
    assert r.json()["tts"]["provider"] == "openai"
    assert "voice: nova" in (hermes_home / "config.yaml").read_text() and "ELEVENLABS_API_KEY=el" in (hermes_home / ".env").read_text()
    assert client.put("/models/speech", json={"tts": {"provider": "nope"}}, headers=auth).status_code == 400
    assert client.post("/models/auth/deepseek/start", headers=auth).status_code == 400
    assert client.delete("/models/auth/nous", headers=auth).json()["ok"] is True
    assert ("auth", "logout", "nous") in app.state.fake_cli.calls
    assert client.get("/models/auth/openrouter/status", headers=auth).json()["logged_in"] is False


def test_parse_auth_output():
    from studio.modules.models import parse_auth_output
    lines = ["To continue, follow these steps:", "  1. Open this URL in your browser:", "     \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m",
             "  2. Enter this code:", "     \x1b[94mABCD-EFGH\x1b[0m", "Waiting for sign-in..."]
    assert parse_auth_output(lines) == ("https://auth.openai.com/codex/device", "ABCD-EFGH")
    assert parse_auth_output(["nothing yet"]) == (None, None)


def test_env_writer_unit(tmp_path):
    from studio.modules.profiles import files as F
    p = tmp_path / ".env"
    p.write_text("# c\nA=1\nexport B='two'\nDUP=x\nDUP=y\n")
    res = F.write_env(p, {"A": "1", "B": "2 2", "C": None, "NEW": "v"})
    assert res == {"A": "unchanged", "B": "set", "C": "unchanged", "NEW": "set"}
    assert p.read_text() == '# c\nA=1\nB="2 2"\nDUP=x\nDUP=y\nNEW=v\n'
    assert F.read_env(p) == {"A": "1", "B": "2 2", "DUP": "y", "NEW": "v"}
    F.write_env(p, {"DUP": None})
    assert "DUP" not in p.read_text()
    with pytest.raises(ValueError):
        F.write_env(p, {"bad key": "x"})
