"""Shared fixtures: fake Hermes gateway (ASGI) + fake CLI + in-memory DB."""
from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient

from studio.app import create_app
from studio.config import Settings
from studio.db import make_engine
from studio.hermes.cli import HermesCli
from studio.hermes.gateway import GatewayClient

FAKE_KEY = "test-key"


class FakeGatewayState:
    def __init__(self):
        self.runs: dict[str, dict[str, Any]] = {}
        self.approvals: list[tuple[str, str]] = []
        self.stopped: list[str] = []
        self.steered: list[tuple[str, str]] = []
        self.scenario = "simple"  # simple | tools | approval | failed | subagent | canned
        self.canned_text = ""  # scenario=canned 時整段當 run 的最終輸出（測 LLM 回覆的解析）


def make_fake_gateway(state: FakeGatewayState) -> FastAPI:
    gw = FastAPI()

    @gw.middleware("http")
    async def _auth(request: Request, call_next):
        if request.headers.get("authorization") != f"Bearer {FAKE_KEY}":
            return JSONResponse({"error": {"message": "unauthorized"}}, status_code=401)
        return await call_next(request)

    def _routes(prefix: str):
        @gw.get(prefix + "/v1/health")
        async def health():
            return {"status": "ok", "platform": "hermes-agent", "version": "0.20.5-fake"}

        @gw.get(prefix + "/v1/models")
        async def models(profile: str = ""):
            return {"object": "list", "data": [{"id": "hermes-agent"}]}

        @gw.get(prefix + "/v1/skills")
        async def skills(profile: str = ""):
            return {"object": "list", "data": [{"name": f"skill-a-{profile or 'default'}", "description": "A", "category": "x"},
                                                 {"name": "skill-b", "description": "B", "disabled": True}]}

        @gw.post(prefix + "/v1/runs", status_code=202)
        async def runs(request: Request, profile: str = ""):
            body = await request.json()
            if not body.get("input"):
                return JSONResponse({"error": {"message": "Missing 'input' field"}}, status_code=400)
            run_id = f"run_{uuid.uuid4().hex}"
            state.runs[run_id] = {"body": body, "profile": profile or "default", "status": "queued"}
            return {"run_id": run_id, "status": "queued"}

        @gw.get(prefix + "/v1/runs/{run_id}")
        async def run_status(run_id: str, profile: str = ""):
            r = state.runs.get(run_id)
            if not r:
                return JSONResponse({"error": {"message": "not found"}}, status_code=404)
            return {"run_id": run_id, "status": r["status"], "output": r.get("output", "")}

        @gw.get(prefix + "/v1/runs/{run_id}/events")
        async def run_events(run_id: str, profile: str = ""):
            r = state.runs.get(run_id)
            if not r:
                return JSONResponse({"error": {"message": "not found"}}, status_code=404)

            async def gen():
                def frame(ev: dict) -> bytes:
                    return f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode()

                inp = r["body"]["input"]
                hist_n = len(r["body"].get("conversation_history") or [])
                yield b": keepalive\n\n"
                if state.scenario == "failed":
                    r["status"] = "failed"
                    yield frame({"event": "run.failed", "run_id": run_id, "error": "boom"})
                    return
                if state.scenario == "subagent":
                    yield frame({"event": "tool.started", "run_id": run_id, "tool": "delegate_task", "preview": "查資料"})
                    yield frame({"event": "subagent.start", "run_id": run_id, "goal": "查資料", "subagent_id": "sa_1", "task_index": 0,
                                 "task_count": 1, "depth": 1, "model": "gpt-fake"})
                    yield frame({"event": "subagent.complete", "run_id": run_id, "goal": "查資料", "subagent_id": "sa_1", "status": "completed",
                                 "summary": "找到 3 筆", "duration_seconds": 1.5, "input_tokens": 10, "output_tokens": 5, "tool_count": 2,
                                 "output_tail": "…done"})
                    yield frame({"event": "tool.completed", "run_id": run_id, "tool": "delegate_task", "duration": 1.5, "error": False})
                if state.scenario in ("tools", "approval"):
                    yield frame({"event": "tool.started", "run_id": run_id, "tool": "terminal", "preview": "ls -la"})
                    if state.scenario == "approval":
                        yield frame({"event": "approval.request", "run_id": run_id, "command": "rm -rf x", "choices": ["once", "deny"]})
                        # wait until approved
                        for _ in range(200):
                            if any(a[0] == run_id for a in state.approvals):
                                break
                            await asyncio.sleep(0.01)
                    yield frame({"event": "tool.completed", "run_id": run_id, "tool": "terminal", "duration": 0.1, "error": False})
                text = state.canned_text if state.scenario == "canned" else f"echo[{r['profile']}|h={hist_n}]: {inp}"
                for ch in (text[:5], text[5:]):
                    yield frame({"event": "message.delta", "run_id": run_id, "delta": ch})
                r["status"] = "completed"
                r["output"] = text
                yield frame({"event": "run.completed", "run_id": run_id, "output": text,
                             "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}})
                yield b": stream closed\n\n"

            return StreamingResponse(gen(), media_type="text/event-stream")

        @gw.post(prefix + "/v1/runs/{run_id}/approval")
        async def approval(run_id: str, request: Request, profile: str = ""):
            body = await request.json()
            state.approvals.append((run_id, body.get("choice")))
            return {"run_id": run_id, "status": "waiting_for_approval", "resolved": 1}

        @gw.post(prefix + "/v1/runs/{run_id}/stop")
        async def stop(run_id: str, profile: str = ""):
            state.stopped.append(run_id)
            return {"run_id": run_id, "status": "stopping"}

        @gw.post(prefix + "/v1/runs/{run_id}/steer")
        async def steer(run_id: str, request: Request, profile: str = ""):
            body = await request.json()
            state.steered.append((run_id, body.get("input")))
            return {"run_id": run_id, "status": "running"}

    _routes("")
    _routes("/p/{profile}")
    return gw


class FakeCli(HermesCli):
    def __init__(self, home: Path):
        super().__init__("hermes-fake", home)
        self.kanban: list[dict[str, Any]] = [
            {"id": "t_aaa111", "title": "task A", "status": "todo", "assignee": "default", "priority": 1},
            {"id": "t_bbb222", "title": "task B", "status": "done", "assignee": "researcher", "priority": 2},
        ]
        self.comments: list[tuple[str, str]] = []

    async def _run(self, *args, timeout=30.0):  # pragma: no cover
        raise AssertionError(f"subprocess must not be called in tests: {args}")

    async def list_profiles(self):
        return [{"name": n, "model": self.profile_model(n) or "fake-model", "gateway": "running"} for n in self.list_profiles_fs()]

    async def kanban_list(self, status=None):
        return [t for t in self.kanban if not status or t["status"] == status]

    async def kanban_create(self, title, body="", assignee="", priority=None):
        t = {"id": f"t_{uuid.uuid4().hex[:6]}", "title": title, "body": body, "status": "todo", "assignee": assignee, "priority": priority or 0}
        self.kanban.append(t)
        return t

    async def kanban_set_status(self, task_id, status):
        for t in self.kanban:
            if t["id"] == task_id:
                t["status"] = status
                return t
        from studio.hermes.cli import CliError
        raise CliError("no such task")

    async def kanban_comment(self, task_id, text):
        self.comments.append((task_id, text))
        return {"ok": True, "id": task_id}


@pytest.fixture
def hermes_home(tmp_path: Path) -> Path:
    home = tmp_path / "hermes"
    (home / "profiles").mkdir(parents=True)
    (home / "SOUL.md").write_text("# default soul\n我是預設員工")
    (home / "config.yaml").write_text("model:\n  default: gpt-default\n")
    for name, model in (("researcher", "stealth/ox-alpha"), ("writer", "gpt-writer")):
        d = home / "profiles" / name
        d.mkdir()
        (d / "SOUL.md").write_text(f"# {name} soul\n")
        (d / "config.yaml").write_text(f"model:\n  default: {model}\n")
    return home


@pytest.fixture
def gw_state() -> FakeGatewayState:
    return FakeGatewayState()


@pytest.fixture
def fake_gateway_url(gw_state: FakeGatewayState):
    """Run the fake gateway on a real uvicorn server so SSE streams incrementally
    (httpx.ASGITransport buffers whole bodies, which would deadlock approval flows)."""
    import socket
    import threading
    import time

    import uvicorn

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    config = uvicorn.Config(make_fake_gateway(gw_state), host="127.0.0.1", port=port, log_level="warning", lifespan="off")
    server = uvicorn.Server(config)
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.02)
    assert server.started, "fake gateway failed to start"
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    th.join(timeout=5)


@pytest.fixture
def app(tmp_path: Path, hermes_home: Path, gw_state: FakeGatewayState, fake_gateway_url: str):
    settings = Settings(port=0, db_path=tmp_path / "studio.db", secret="test-secret-test-secret-test-secret-32",
                        hermes_api_url=fake_gateway_url, hermes_api_key=FAKE_KEY, hermes_home=hermes_home, hermes_bin="hermes-fake")
    gateway = GatewayClient(settings.hermes_api_url, settings.hermes_api_key)
    cli = FakeCli(hermes_home)
    application = create_app(settings, gateway=gateway, cli=cli, engine=make_engine(settings.db_path))
    application.state.fake_cli = cli
    return application


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


@pytest.fixture
def token(client) -> str:
    r = client.post("/auth/login", json={"username": "admin", "password": "admin"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture
def auth(token) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
