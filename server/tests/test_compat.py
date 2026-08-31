"""compat 模組＋ studio.hermes.contract 測試。"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime
from pathlib import Path

import pytest

from studio.hermes import contract
from studio.hermes.contract.report import build_report, capabilities, summarize
from studio.modules.compat import precheck as pc
from studio.modules.compat import scheduler as sched

FAKE_KEY = "test-key"


@pytest.fixture(autouse=True)
def _no_sched(monkeypatch):
    monkeypatch.setenv("STUDIO_COMPAT_SCHEDULER", "0")


# ---------------------------------------------------------------- surface
def test_surface_loads_and_is_consistent():
    s = contract.load_surface()
    assert s.hermes_tested == "0.20.5"
    assert len(s.items) >= 50
    ids = [i.id for i in s.items]
    assert len(ids) == len(set(ids))
    for it in s.items:
        assert it.kind in ("endpoint", "cli", "file", "db")
        assert it.risk in ("low", "medium", "high")
        for m in it.affects:
            assert m in s.modules, f"{it.id} affects unknown module {m}"
    # 分級規則：gateway 端點原則上是 low（公開 API，上游會維持）；
    # 但「需要使用者在 config.yaml 另外開啟才存在」的端點是 medium——
    # 端點本身在不代表能用，例如多 profile 前綴要開 gateway.multiplex_profiles。
    CONFIG_DEPENDENT_ENDPOINTS = {"gw.prefix.other_profile"}
    for i in s.by_kind("endpoint"):
        want = "medium" if i.id in CONFIG_DEPENDENT_ENDPOINTS else "low"
        assert i.risk == want, f"{i.id} 的 risk 應為 {want}，實際 {i.risk}"
    assert all(i.risk == "high" for i in s.by_kind("file") if i.id != "db.kanban")
    assert all(i.risk == "high" for i in s.by_kind("db"))
    assert s.by_id("cli.profile.list").risk == "high"
    assert s.by_id("cli.kanban.list").risk == "medium"
    assert s.by_id("gw.health").critical


def test_surface_rejects_bad_items(tmp_path: Path):
    bad = tmp_path / "s.yaml"
    bad.write_text("items:\n  - id: x\n    kind: endpoint\n    risk: low\n    affects: [chat]\n")
    with pytest.raises(ValueError):
        contract.load_surface(bad)
    bad.write_text("items:\n  - id: x\n    kind: cli\n    risk: bogus\n    argv: [a]\n    affects: [chat]\n")
    with pytest.raises(ValueError):
        contract.load_surface(bad)


# ---------------------------------------------------------------- report
class _R:
    def __init__(self, id, status, reason="", ms=1, detail=None):
        self.id, self.status, self.reason, self.ms, self.detail = id, status, reason, ms, detail or {}


def test_report_verdict_and_affected_modules():
    s = contract.load_surface()
    results = [_R(i.id, "pass") for i in s.items]
    rep = build_report(s, results, hermes={"version": "0.20.5"}, mode={"sandbox": False, "writes": False}, started=0)
    assert rep["summary"]["verdict"] == "compatible"
    assert rep["summary"]["affected_modules"] == []
    # 一個非 critical 失敗 → partial，受影響模組來自 affects
    results = [_R(i.id, "fail" if i.id == "gw.jobs.list" else "pass", "boom") for i in s.items]
    rep = build_report(s, results, hermes={}, mode={}, started=0)
    assert rep["summary"]["verdict"] == "partial"
    assert rep["summary"]["affected_modules"] == [{"module": "cron", "failed": ["gw.jobs.list"]}]
    caps = capabilities(rep)
    mods = {m["module"]: m for m in caps["modules"]}
    assert mods["cron"]["status"] == "degraded" and mods["cron"]["degraded"] == ["gw.jobs.list"]
    assert mods["chat"]["status"] == "available"
    # critical 失敗 → incompatible，模組 unavailable
    results = [_R(i.id, "fail" if i.id == "gw.health" else "pass") for i in s.items]
    rep = build_report(s, results, hermes={}, mode={}, started=0)
    assert rep["summary"]["verdict"] == "incompatible"
    assert {m["module"]: m["status"] for m in capabilities(rep)["modules"]}["hermes_status"] == "unavailable"
    # 沒報告 → unknown
    assert all(m["status"] == "unknown" for m in capabilities(None)["modules"])


def test_summarize_counts():
    items = [{"id": "a", "status": "pass", "risk": "low", "affects": []}, {"id": "b", "status": "skip", "risk": "high", "affects": ["x"]},
             {"id": "c", "status": "fail", "risk": "medium", "affects": ["x", "y"], "critical": False}]
    s = summarize(items)
    assert (s["pass"], s["fail"], s["skip"], s["total"]) == (1, 1, 1, 3)
    assert s["verdict"] == "partial" and s["failed_ids"] == ["c"]
    assert s["affected_modules"] == [{"module": "x", "failed": ["c"]}, {"module": "y", "failed": ["c"]}]


# ---------------------------------------------------------------- contract vs mock gateway
def test_contract_against_mock_gateway_marks_missing_endpoints(fake_gateway_url, hermes_home):
    """conftest 的假 gateway 沒有 /api/jobs、/api/model/options、/v1/chat/completions、/v1/responses：
    這些要 fail 並正確標到 cron / models / chat / coding_agents；其餘 gateway 端點要 pass。"""
    rep = contract.run(hermes_home, fake_gateway_url, FAKE_KEY, hermes_bin=None, writes=True)
    by = {i["id"]: i for i in rep["items"]}
    assert by["gw.health"]["status"] == "pass"
    assert by["gw.health.profile_prefix"]["status"] == "pass"
    assert by["gw.models"]["status"] == "pass" and by["gw.skills"]["status"] == "pass"
    assert by["gw.runs.create"]["status"] == "pass"
    assert by["gw.runs.status"]["status"] == "pass"
    assert by["gw.runs.events"]["status"] == "pass" and "run.completed" in by["gw.runs.events"]["detail"]["events"]
    assert by["gw.runs.approval"]["status"] == "pass"  # route probe：假 id → 404 JSON
    assert by["gw.jobs.list"]["status"] == "fail"
    assert by["gw.model.options"]["status"] == "fail"
    assert by["gw.chat.completions"]["status"] == "fail"
    # 假 gateway 錯 key 回 401 JSON 但沒有 code → 這項 fail（真 Hermes 有 gateway_auth_failed）
    assert by["gw.auth.reject"]["status"] == "fail"
    # 沒有 hermes 執行檔 → CLI 項目 skip 而不是 fail
    assert all(i["status"] == "skip" for i in rep["items"] if i["kind"] == "cli")
    # 檔案：fixture 有 config.yaml、SOUL.md、profiles/；沒有 .env → file.env optional skip
    assert by["file.config"]["status"] == "pass" and by["file.soul"]["status"] == "pass" and by["dir.profiles"]["status"] == "pass"
    assert by["file.env"]["status"] == "skip"
    assert by["dir.memories"]["status"] == "fail"  # fixture 沒有 memories/（非 optional）
    assert rep["summary"]["verdict"] == "partial"
    affected = {m["module"]: m["failed"] for m in rep["summary"]["affected_modules"]}
    assert "gw.jobs.list" in affected["cron"]
    assert "gw.model.options" in affected["models"] and "gw.model.options" in affected["chat"]
    assert "gw.chat.completions" in affected["coding_agents"]
    assert "cron" not in {m["module"] for m in rep["summary"]["affected_modules"] if "gw.health" in m["failed"]}
    # cleanup：run 有被 stop
    assert any(c.startswith("stop_run:") for c in rep["cleanups"])


def test_contract_only_and_sandbox_skips_missing_files(fake_gateway_url, tmp_path: Path):
    empty_home = tmp_path / "empty"
    empty_home.mkdir()
    rep = contract.run(empty_home, fake_gateway_url, FAKE_KEY, sandbox=True, only=["gw.health", "file.env", "dir.memories", "db.state.sessions"])
    by = {i["id"]: i for i in rep["items"]}
    assert set(by) == {"gw.health", "file.env", "dir.memories", "db.state.sessions"}
    assert by["gw.health"]["status"] == "pass"
    assert by["file.env"]["status"] == "skip" and by["dir.memories"]["status"] == "skip" and by["db.state.sessions"]["status"] == "skip"
    assert rep["mode"]["sandbox"] is True and rep["mode"]["writes"] is True


def test_db_check_reads_columns(tmp_path: Path, fake_gateway_url):
    import sqlite3
    home = tmp_path / "h"
    home.mkdir()
    con = sqlite3.connect(home / "state.db")
    con.execute("CREATE TABLE sessions (id TEXT, source TEXT, title TEXT, model TEXT, started_at REAL, ended_at REAL, last_activity_at REAL, "
                "message_count INT, tool_call_count INT, input_tokens INT, output_tokens INT)")
    con.execute("CREATE TABLE messages (id INT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, tool_calls TEXT, tool_call_id TEXT)")
    con.commit()
    con.close()
    rep = contract.run(home, fake_gateway_url, FAKE_KEY, only=["db.state.sessions", "db.state.messages"])
    by = {i["id"]: i for i in rep["items"]}
    assert by["db.state.sessions"]["status"] == "pass"
    assert "display_name" in by["db.state.sessions"]["detail"]["optional_missing"]
    assert by["db.state.messages"]["status"] == "fail" and "tool_name" in by["db.state.messages"]["reason"]


# ---------------------------------------------------------------- scheduler / precheck helpers
def test_scheduler_due_logic():
    sat_2201 = datetime(2026, 8, 29, 22, 1)  # 2026-08-29 是週六
    assert sched.due(sat_2201, enabled=True, weekday=5, hour=22, minute=0, last_run=None)
    assert not sched.due(sat_2201, enabled=False, weekday=5, hour=22, minute=0, last_run=None)
    assert not sched.due(datetime(2026, 8, 29, 21, 59), enabled=True, weekday=5, hour=22, minute=0, last_run=datetime(2026, 8, 23, 0, 0))
    assert not sched.due(sat_2201, enabled=True, weekday=5, hour=22, minute=0, last_run=datetime(2026, 8, 29, 22, 0, 30))
    assert sched.due(datetime(2026, 9, 2, 8, 0), enabled=True, weekday=5, hour=22, minute=0, last_run=datetime(2026, 8, 22, 22, 0))
    assert sched.scheduled_slot(datetime(2026, 8, 28, 10, 0), 5, 22, 0) == datetime(2026, 8, 22, 22, 0)


def test_scheduler_decide_and_tags():
    assert sched.decide("v2026.8.27", "v2026.8.19", is_newer=pc.is_newer) == "precheck"
    assert sched.decide("v2026.8.19", "v2026.8.19", is_newer=pc.is_newer) == "noop"
    assert sched.decide("v2026.8.16", "v2026.8.19", is_newer=pc.is_newer) == "noop"
    assert sched.decide("", "v2026.8.19", is_newer=pc.is_newer) == "noop"
    assert sched.decide("v2026.8.27", "", is_newer=pc.is_newer) == "precheck"
    raw = "abc\trefs/tags/v2026.8.19\ndef\trefs/tags/v2026.8.19^{}\nghi\trefs/tags/v2026.8.27\njkl\trefs/tags/v2026.8.16.2\nmno\trefs/tags/nightly\n"
    tags = pc.parse_ls_remote(raw)
    assert tags == ["v2026.8.16.2", "v2026.8.19", "v2026.8.27"]
    assert pc.resolve_tag(tags, "latest") == "v2026.8.27"
    assert pc.resolve_tag(tags, "v2026.8.19") == "v2026.8.19"
    assert pc.resolve_tag(tags, "2026.8.19") == "v2026.8.19"
    assert pc.resolve_tag(tags, "0.20.5") is None
    assert pc.is_newer("v2026.8.27", "v2026.8.19") and not pc.is_newer("v2026.8.16.2", "v2026.8.19")
    assert pc.date_to_tag("2026.8.19") == "v2026.8.19"


# ---------------------------------------------------------------- API
def test_compat_api_surface_status_schedule(client, auth):
    r = client.get("/compat/surface", headers=auth)
    assert r.status_code == 200 and r.json()["hermes_tested"] == "0.20.5" and len(r.json()["items"]) >= 50
    r = client.get("/compat/status", headers=auth)
    assert r.status_code == 200
    j = r.json()
    assert {k: j["schedule"][k] for k in ("enabled", "weekday", "hour", "minute")} == {"enabled": True, "weekday": 5, "hour": 22, "minute": 0}
    assert j["schedule"]["last_run"]  # 第一次建立就記現在，等下一個排定時刻
    assert j["current"]["version"] == "" and j["running"] == []
    r = client.patch("/compat/schedule", json={"enabled": False, "weekday": 0, "hour": 3}, headers=auth)
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["weekday"] == 0 and r.json()["hour"] == 3
    assert client.patch("/compat/schedule", json={"weekday": 9}, headers=auth).status_code == 400
    caps = client.get("/compat/capabilities", headers=auth).json()
    assert caps["source"] is None and all(m["status"] == "unknown" for m in caps["modules"])


def test_compat_api_check_saves_run_and_capabilities(client, auth):
    r = client.post("/compat/check", json={"writes": True}, headers=auth)
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["summary"]["verdict"] == "partial" and rep.get("run_id")
    runs = client.get("/compat/runs", headers=auth).json()
    assert runs and runs[0]["kind"] == "check" and runs[0]["verdict"] == "partial"
    full = client.get(f"/compat/runs/{runs[0]['id']}", headers=auth).json()
    assert full["report"]["summary"]["fail"] >= 1
    caps = client.get("/compat/capabilities", headers=auth).json()
    mods = {m["module"]: m for m in caps["modules"]}
    assert mods["cron"]["status"] == "degraded"
    assert caps["source"]["verdict"] == "partial"
    st = client.get("/compat/status", headers=auth).json()
    assert st["current"]["verdict"] == "partial" and st["current"]["run_id"] == runs[0]["id"]
    # 事件與收件匣
    ev = client.get("/events?source=compat", headers=auth)
    assert ev.status_code == 200
    body = ev.json()
    items = body if isinstance(body, list) else body.get("items") or body.get("data") or []
    assert any(str(e.get("kind", "")).endswith("compat.check") for e in items)  # events 模組把未知 kind 轉成 other.compat.check
    inbox = client.get("/inbox", headers=auth).json()
    ib_items = inbox if isinstance(inbox, list) else inbox.get("items") or []
    assert any("compat" in str(i.get("kind", "")) or "compat" in str(i.get("ref", "")) or "compat" in str(i.get("id", "")) for i in ib_items), ib_items


def test_compat_precheck_requires_admin_and_rejects_double(client, auth, monkeypatch):
    from studio.modules import compat

    async def fake_run(job, **kw):
        job.step("done", "fake")
        job.report = {"summary": {"verdict": "compatible", "pass": 1, "fail": 0, "skip": 0}, "hermes": {"version": "9.9.9"}, "items": []}
        return job

    monkeypatch.setattr(compat._pc, "run_precheck", fake_run)
    compat._jobs.clear()
    r = client.post("/compat/precheck", json={"version": "latest"}, headers=auth)
    assert r.status_code == 200 and r.json()["id"].startswith("pc_")
    jid = r.json()["id"]
    for _ in range(50):
        j = client.get(f"/compat/precheck/{jid}", headers=auth).json()
        if j["status"] == "done":
            break
        import time
        time.sleep(0.02)
    assert j["status"] == "done" and j["summary"]["verdict"] == "compatible"
    runs = client.get("/compat/runs?kind=precheck", headers=auth).json()
    assert runs and runs[0]["kind"] == "precheck"
    assert client.get("/compat/precheck/nope", headers=auth).status_code == 404


def test_scheduler_tick_triggers_precheck_when_newer(app, monkeypatch):
    from studio.modules import compat

    async def fake_tags(*a, **k):
        return ["v2026.8.19", "v2026.8.27"]

    started: list[str] = []

    def fake_start(want, *, engine=None, triggered_by="manual"):
        started.append(want)
        return pc.PrecheckJob(id="pc_fake", want=want)

    monkeypatch.setattr(compat._pc, "fetch_remote_tags", fake_tags)
    monkeypatch.setattr(compat, "start_precheck", fake_start)
    from sqlmodel import Session
    with Session(app.state.engine) as s:
        from studio.db import init_db
        init_db(app.state.engine)
        st = compat._state(s)
        st.tested_tag = "v2026.8.19"
        st.last_schedule_run = None  # 第一次建立會設成現在；這裡模擬還沒跑過
        s.add(st)
        s.commit()
    r = asyncio.run(compat.scheduler_tick(app.state.engine, app.state.settings, now_dt=datetime(2026, 8, 29, 22, 5)))
    assert r.startswith("precheck:v2026.8.27") and started == ["v2026.8.27"]
    # 同一個時段不重複跑
    r = asyncio.run(compat.scheduler_tick(app.state.engine, app.state.settings, now_dt=datetime(2026, 8, 29, 22, 6)))
    assert r == "noop"
    # 已測版本就是最新 → noop
    with Session(app.state.engine) as s:
        st = compat._state(s)
        st.tested_tag, st.last_schedule_run = "v2026.8.27", None
        s.add(st)
        s.commit()
    r = asyncio.run(compat.scheduler_tick(app.state.engine, app.state.settings, now_dt=datetime(2026, 9, 5, 22, 5)))
    assert r == "noop:v2026.8.27"


def test_after_precheck_updates_tested_version(app):
    from sqlmodel import Session
    from studio.db import init_db
    from studio.modules import compat

    init_db(app.state.engine)
    rep = {"summary": {"verdict": "compatible", "pass": 3, "fail": 0, "skip": 0, "affected_modules": [], "failed_ids": []},
           "hermes": {"version": "0.21.0"}, "items": []}
    compat._after_check(app.state.engine, rep, kind="precheck", tag="v2026.8.27")
    with Session(app.state.engine) as s:
        st = compat._state(s)
        assert st.tested_tag == "v2026.8.27" and st.tested_version == "0.21.0"
    # partial 不更新已測版本
    rep2 = {**rep, "summary": {**rep["summary"], "verdict": "partial", "fail": 1, "failed_ids": ["gw.jobs.list"],
                                "affected_modules": [{"module": "cron", "failed": ["gw.jobs.list"]}]}, "hermes": {"version": "0.22.0"}}
    compat._after_check(app.state.engine, rep2, kind="precheck", tag="v2026.9.1")
    with Session(app.state.engine) as s:
        assert compat._state(s).tested_tag == "v2026.8.27"
