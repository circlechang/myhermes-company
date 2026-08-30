"""K. Coding Agents：解析器、指令組裝、WS 串流＋落庫＋diff、proxy 轉換。"""
from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient

from studio.app import create_app
from studio.config import Settings
from studio.db import make_engine
from studio.hermes.gateway import GatewayClient
from studio.modules.coding_agents import parsers, runner
from studio.modules.coding_agents.proxy import anthropic_to_chat, chat_to_anthropic

FAKE_DIR = Path(__file__).parent / "fake_cli"
FAKE_BINS = {"claude": str(FAKE_DIR / "fake_claude.sh"), "codex": str(FAKE_DIR / "fake_codex.sh"), "pi": str(FAKE_DIR / "fake_pi.sh")}


# ---------------------------------------------------------------- parsers (pure)
def _feed(parser, script: str):
    st = parsers.ParserState()
    events = []
    out = subprocess.run(["sh", script, "-p", "x"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        events.extend(parser(line, st))
    return events, st


def test_parse_claude_sample():
    events, st = _feed(parsers.parse_claude, FAKE_BINS["claude"])
    types = [e["type"] for e in events]
    assert types == ["session.init", "message.delta", "message.delta", "run.completed"]
    assert events[0]["external_session_id"] == "fake-claude-session-1"
    assert events[-1]["output"].startswith("Here is hello") and events[-1]["usage"]["cost_usd"] == 0.001
    assert st.done


def test_parse_claude_tool_and_error():
    st = parsers.ParserState()
    ev = parsers.parse_claude('{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}', st)
    assert ev == [{"type": "tool.started", "name": "Bash", "args": {"command": "ls"}, "call_id": "t1"}]
    ev = parsers.parse_claude('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"a"}],"is_error":false}]}}', st)
    assert ev[0]["type"] == "tool.completed" and ev[0]["name"] == "Bash" and ev[0]["result"] == "a"
    ev = parsers.parse_claude('{"type":"result","subtype":"error_max_turns","is_error":true,"session_id":"s"}', st)
    assert ev[0]["type"] == "run.failed" and "error_max_turns" in ev[0]["error"]
    assert parsers.parse_claude("garbage", st) == [{"type": "log", "text": "garbage"}]


def test_parse_codex_sample():
    events, _ = _feed(parsers.parse_codex, FAKE_BINS["codex"])
    types = [e["type"] for e in events]
    assert types == ["session.init", "tool.started", "tool.completed", "message.delta", "run.completed"]
    assert events[0]["external_session_id"] == "thread-fake-1"
    assert events[1]["name"] == "command_execution" and events[1]["args"] == "ls"
    assert events[2]["result"] == "a.txt\n" and events[2]["error"] is False
    assert events[-1]["output"] == "hello from codex" and events[-1]["usage"]["input_tokens"] == 100
    st = parsers.ParserState()
    assert parsers.parse_codex('{"type":"turn.failed","error":{"message":"x"}}', st)[0] == {"type": "run.failed", "error": "x", "external_session_id": ""}


def test_parse_pi_sample():
    events, _ = _feed(parsers.parse_pi, FAKE_BINS["pi"])
    types = [e["type"] for e in events]
    assert types == ["session.init", "tool.started", "tool.completed", "message.delta", "message.delta", "run.completed"]
    assert events[-1]["output"] == "hi pi" and events[0]["external_session_id"] == "pi-sess-1"


# ---------------------------------------------------------------- command building
def test_build_command_claude_direct_and_proxy():
    spec = runner.RunSpec(agent="claude", prompt="hi", workspace="/tmp", bin_path="/x/claude", model="sonnet",
                          resume_id="abc", images=["/tmp/a.png"], extra={"permission_mode": "plan", "max_turns": 3})
    argv, env = runner.build_command(spec)
    assert argv[:2] == ["/x/claude", "-p"] and "/tmp/a.png" in argv[2]
    assert "--output-format" in argv and "stream-json" in argv and "--verbose" in argv
    assert argv[argv.index("--model") + 1] == "sonnet" and argv[argv.index("--resume") + 1] == "abc"
    assert argv[argv.index("--permission-mode") + 1] == "plan" and argv[argv.index("--max-turns") + 1] == "3"
    assert "ANTHROPIC_BASE_URL" not in env
    spec.proxy = {"base": "http://127.0.0.1:8700", "token": "tok"}
    spec.extra = {"dangerously_skip_permissions": True}
    argv, env = runner.build_command(spec)
    assert "--dangerously-skip-permissions" in argv
    assert env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:8700/coding/proxy/anthropic" and env["ANTHROPIC_AUTH_TOKEN"] == "tok"


def test_build_command_codex_and_pi():
    spec = runner.RunSpec(agent="codex", prompt="do it", workspace="/tmp", bin_path="/x/codex", images=["/i.png"],
                          proxy={"base": "http://127.0.0.1:8700", "token": "tok"})
    argv, env = runner.build_command(spec)
    assert argv[:4] == ["/x/codex", "exec", "--json", "--skip-git-repo-check"]
    assert argv[argv.index("-C") + 1] == "/tmp" and argv[-1] == "do it" and argv[argv.index("-i") + 1] == "/i.png"
    assert 'model_providers.myhermescompany.base_url="http://127.0.0.1:8700/coding/proxy/openai/v1"' in argv
    assert argv[argv.index("-m") + 1] == "hermes-agent" and env[runner.PROXY_ENV_KEY] == "tok"
    spec.resume_id = "thread-1"
    spec.proxy = None
    argv, _ = runner.build_command(spec)
    assert argv[-3:] == ["resume", "thread-1", "do it"]
    argv, _ = runner.build_command(runner.RunSpec(agent="pi", prompt="p", workspace="", bin_path="/x/pi", resume_id="s.json"))
    assert argv == ["/x/pi", "-p", "--mode", "json", "--session", "s.json", "p"]


# ---------------------------------------------------------------- proxy conversion (pure)
def test_anthropic_to_chat_and_back():
    body = {"model": "claude-x", "system": [{"type": "text", "text": "SYS"}], "max_tokens": 10, "stream": True,
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": [{"type": "text", "text": "ok"}, {"type": "tool_use", "id": "t", "name": "Bash", "input": {"c": 1}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "res"}, {"type": "text", "text": "next"}]},
            ], "tools": [{"name": "Bash"}]}
    chat = anthropic_to_chat(body)
    assert "model" not in chat and "tools" not in chat and chat["stream"] is True and chat["max_tokens"] == 10
    assert chat["messages"][0] == {"role": "system", "content": "SYS"}
    assert chat["messages"][1] == {"role": "user", "content": "hi"}
    assert chat["messages"][2]["role"] == "assistant" and "[tool_use Bash]" in chat["messages"][2]["content"]
    assert chat["messages"][3]["role"] == "user" and chat["messages"][3]["content"].startswith("[tool_result] res")
    a = chat_to_anthropic({"id": "x", "choices": [{"message": {"content": "hello"}}], "usage": {"prompt_tokens": 3, "completion_tokens": 4}}, "m")
    assert a["content"] == [{"type": "text", "text": "hello"}] and a["usage"] == {"input_tokens": 3, "output_tokens": 4} and a["stop_reason"] == "end_turn"


# ---------------------------------------------------------------- app-level（假 CLI + 假上游）
def make_fake_upstream(calls: list):
    up = FastAPI()

    @up.post("/v1/chat/completions")
    @up.post("/p/{profile}/v1/chat/completions")
    async def chat(request: Request, profile: str = ""):
        body = await request.json()
        calls.append(("chat", profile, body, request.headers.get("authorization")))
        last = body["messages"][-1]["content"]
        if body.get("stream"):
            async def gen():
                for piece in ("echo:", last):
                    yield f"data: {json.dumps({'choices': [{'delta': {'content': piece}}]})}\n\n".encode()
                yield f"data: {json.dumps({'choices': [], 'usage': {'prompt_tokens': 5, 'completion_tokens': 2}})}\n\n".encode()
                yield b"data: [DONE]\n\n"
            return StreamingResponse(gen(), media_type="text/event-stream")
        return {"id": "chatcmpl-1", "choices": [{"message": {"role": "assistant", "content": "echo:" + last}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 2}}

    @up.post("/v1/responses")
    @up.post("/p/{profile}/v1/responses")
    async def responses(request: Request, profile: str = ""):
        body = await request.json()
        calls.append(("responses", profile, body, request.headers.get("authorization")))
        if body.get("stream"):
            async def gen():
                yield b'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
                yield b'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n'
            return StreamingResponse(gen(), media_type="text/event-stream")
        return JSONResponse({"id": "resp_1", "object": "response", "output": [{"type": "message", "content": [{"type": "output_text", "text": "hi"}]}]})

    @up.get("/v1/models")
    @up.get("/p/{profile}/v1/models")
    async def models(profile: str = ""):
        return {"object": "list", "data": [{"id": "hermes-agent"}]}

    return up


@pytest.fixture
def upstream_calls():
    return []


@pytest.fixture
def upstream_url(upstream_calls):
    import socket
    import uvicorn
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(make_fake_upstream(upstream_calls), host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.02)
    assert server.started
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    th.join(timeout=5)


@pytest.fixture
def capp(tmp_path, hermes_home, upstream_url):
    from tests.conftest import FakeCli
    settings = Settings(port=8799, db_path=tmp_path / "studio.db", secret="test-secret-test-secret-test-secret-32",
                        hermes_api_url=upstream_url, hermes_api_key="up-key", hermes_home=hermes_home, hermes_bin="hermes-fake")
    app = create_app(settings, gateway=GatewayClient(upstream_url, "up-key"), cli=FakeCli(hermes_home),
                     engine=make_engine(settings.db_path), sync_agents=False)
    app.state.coding_bins = dict(FAKE_BINS)
    return app


@pytest.fixture
def cclient(capp):
    with TestClient(capp) as c:
        yield c


@pytest.fixture
def cauth(cclient):
    r = cclient.post("/auth/login", json={"username": "admin", "password": "admin"})
    tok = r.json()["token"]
    return tok, {"Authorization": f"Bearer {tok}"}


@pytest.fixture
def git_ws(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=ws, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], cwd=ws, check=True)
    return ws


def test_agents_listed_with_settings(cclient, cauth):
    _, auth = cauth
    agents = cclient.get("/coding/agents", headers=auth).json()
    assert [a["id"] for a in agents] == ["claude", "codex", "pi"]
    a = agents[0]
    assert a["installed"] and a["install_cmd"].startswith("npm i -g @anthropic-ai/claude-code")
    assert a["settings"]["api_mode"] == "direct" and a["settings"]["extra"]["permission_mode"] == "acceptEdits"
    assert "studio_module" not in a  # sanity
    assert "studio.modules.coding_agents" in cclient.app.state.modules


def test_settings_roundtrip_and_validation(cclient, cauth, tmp_path):
    _, auth = cauth
    r = cclient.put("/coding/settings/claude", json={"workspace": str(tmp_path), "model": "sonnet", "api_mode": "hermes",
                                                     "hermes_profile": "researcher", "extra": {"max_turns": 5}}, headers=auth)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["workspace"] == str(tmp_path) and d["api_mode"] == "hermes" and d["extra"] == {"permission_mode": "acceptEdits", "max_turns": 5}
    assert cclient.put("/coding/settings/claude", json={"workspace": "/nonexistent/xyz"}, headers=auth).status_code == 400
    assert cclient.put("/coding/settings/claude", json={"api_mode": "weird"}, headers=auth).status_code == 400
    assert cclient.get("/coding/settings/nope", headers=auth).status_code == 404


def test_fs_browse(cclient, cauth, git_ws):
    _, auth = cauth
    r = cclient.get("/coding/fs", params={"path": str(git_ws.parent)}, headers=auth).json()
    assert any(d["name"] == "ws" and d["is_git"] for d in r["dirs"])
    assert cclient.get("/coding/fs", params={"path": str(git_ws)}, headers=auth).json()["is_git"] is True


def _collect(ws, until=("run.completed", "run.failed", "run.cancelled")):
    events = []
    while True:
        ev = json.loads(ws.receive_text())
        events.append(ev)
        if ev["type"] in until:
            return events


def test_ws_claude_run_streams_persists_and_diffs(cclient, cauth, git_ws):
    tok, auth = cauth
    s = cclient.post("/coding/sessions", json={"agent": "claude", "workspace": str(git_ws)}, headers=auth).json()
    assert s["agent"] == "claude" and s["source"] == "coding:claude" and s["workspace"] == str(git_ws)
    with cclient.websocket_connect(f"/ws/coding?token={tok}") as ws:
        assert json.loads(ws.receive_text())["type"] == "ready"
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "WRITE_FILE please"}))
        events = _collect(ws)
    types = [e["type"] for e in events]
    assert types[0] == "run.started" and "claude" in events[0]["command"]
    assert types[-1] == "run.completed"
    assert "tool.started" in types and "tool.completed" in types and types.count("message.delta") == 2
    assert any(e["type"] == "log" and e.get("stream") == "stderr" for e in events)
    done = events[-1]
    assert done["output"].startswith("Here is hello") and done["usage"]["output_tokens"] == 20
    assert done["external_session_id"] == "fake-claude-session-1"
    assert done["diff"]["is_git"] and done["diff"]["before"] == "" and "hello.py" in done["diff"]["after"]
    assert done["diff"]["files"] == [{"status": "??", "path": "hello.py"}]
    # persisted: messages + runs + meta
    msgs = cclient.get(f"/coding/sessions/{s['id']}/messages", headers=auth).json()
    assert [m["role"] for m in msgs] == ["user", "tool", "assistant"]
    assert msgs[1]["tool_name"] == "Write" and msgs[1]["tool_args"]["file_path"] == "hello.py"
    runs = cclient.get(f"/coding/sessions/{s['id']}/runs", headers=auth).json()
    assert len(runs) == 1 and runs[0]["status"] == "completed" and "hello.py" in runs[0]["diff_after"] and runs[0]["exit_code"] == 0
    s2 = cclient.get(f"/coding/sessions/{s['id']}", headers=auth).json()
    assert s2["external_session_id"] == "fake-claude-session-1" and s2["status"] == "idle"
    # 出現在共用 sessions 表（source=coding:claude），但 /coding/sessions 只列 coding 的
    assert [x["id"] for x in cclient.get("/coding/sessions", headers=auth).json()] == [s["id"]]
    assert cclient.get("/coding/sessions", params={"agent": "codex"}, headers=auth).json() == []


def test_ws_second_turn_resumes_with_external_id(cclient, cauth, git_ws, tmp_path):
    tok, auth = cauth
    argv_out = tmp_path / "argv.txt"
    s = cclient.post("/coding/sessions", json={"agent": "claude", "workspace": str(git_ws)}, headers=auth).json()
    import os
    os.environ["FAKE_ARGV_OUT"] = str(argv_out)
    try:
        with cclient.websocket_connect(f"/ws/coding?token={tok}") as ws:
            ws.receive_text()
            ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "first"}))
            _collect(ws)
            assert "--resume" not in argv_out.read_text()
            ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "second"}))
            _collect(ws)
            lines = argv_out.read_text().splitlines()
            assert "--resume" in lines and lines[lines.index("--resume") + 1] == "fake-claude-session-1"
    finally:
        os.environ.pop("FAKE_ARGV_OUT", None)


def test_ws_hermes_mode_sets_proxy_env(cclient, cauth, git_ws, tmp_path):
    tok, auth = cauth
    argv_out = tmp_path / "argv2.txt"
    cclient.put("/coding/settings/claude", json={"api_mode": "hermes"}, headers=auth)
    s = cclient.post("/coding/sessions", json={"agent": "claude", "workspace": str(git_ws)}, headers=auth).json()
    import os
    os.environ["FAKE_ARGV_OUT"] = str(argv_out)
    try:
        with cclient.websocket_connect(f"/ws/coding?token={tok}") as ws:
            ws.receive_text()
            ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "x"}))
            _collect(ws)
    finally:
        os.environ.pop("FAKE_ARGV_OUT", None)
    text = argv_out.read_text()
    info = cclient.get("/coding/proxy-info", headers=auth).json()
    assert "ANTHROPIC_BASE_URL=http://127.0.0.1:8799/coding/proxy/anthropic" in text
    assert f"ANTHROPIC_AUTH_TOKEN={info['token']}" in text


def test_ws_codex_and_failure(cclient, cauth, git_ws):
    tok, auth = cauth
    s = cclient.post("/coding/sessions", json={"agent": "codex", "workspace": str(git_ws)}, headers=auth).json()
    with cclient.websocket_connect(f"/ws/coding?token={tok}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "list"}))
        ev = _collect(ws)
        assert ev[-1]["type"] == "run.completed" and ev[-1]["output"] == "hello from codex"
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "FAIL now"}))
        ev = _collect(ws)
        assert ev[-1]["type"] == "run.failed" and ev[-1]["error"] == "codex boom"
    runs = cclient.get(f"/coding/sessions/{s['id']}/runs", headers=auth).json()
    assert [r["status"] for r in runs] == ["completed", "failed"] and runs[1]["exit_code"] == 1
    assert cclient.get(f"/coding/sessions/{s['id']}", headers=auth).json()["external_session_id"] == "thread-fake-1"


def test_ws_stop_kills_process(cclient, cauth, git_ws):
    tok, auth = cauth
    s = cclient.post("/coding/sessions", json={"agent": "claude", "workspace": str(git_ws)}, headers=auth).json()
    with cclient.websocket_connect(f"/ws/coding?token={tok}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "SLEEP"}))
        started = _collect(ws, until=("session.init",))
        run_id = started[0]["run_id"]
        t0 = time.time()
        ws.send_text(json.dumps({"type": "stop", "run_id": run_id}))
        ev = _collect(ws)
    assert ev[-1]["type"] == "run.cancelled" and time.time() - t0 < 10
    assert cclient.get(f"/coding/sessions/{s['id']}/runs", headers=auth).json()[0]["status"] == "cancelled"


def test_ws_missing_cli_reports_install_hint(cclient, cauth, git_ws):
    tok, auth = cauth
    cclient.app.state.coding_bins = {"claude": FAKE_BINS["claude"]}  # codex/pi 假裝沒裝
    try:
        # find_bin 也可能在本機找到真的 pi；用 monkeypatch 確保沒有
        from studio.modules.coding_agents import router as r, detect
        orig = detect.find_bin
        detect.find_bin = lambda name: None
        s = cclient.post("/coding/sessions", json={"agent": "pi", "workspace": str(git_ws)}, headers=auth).json()
        with cclient.websocket_connect(f"/ws/coding?token={tok}") as ws:
            ws.receive_text()
            ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "x"}))
            ev = _collect(ws)
        assert ev[-1]["type"] == "run.failed" and "npm i -g @mariozechner/pi-coding-agent" in ev[-1]["error"]
    finally:
        detect.find_bin = orig
        cclient.app.state.coding_bins = dict(FAKE_BINS)


def test_image_upload(cclient, cauth, git_ws):
    _, auth = cauth
    s = cclient.post("/coding/sessions", json={"agent": "claude", "workspace": str(git_ws)}, headers=auth).json()
    import base64
    r = cclient.post(f"/coding/sessions/{s['id']}/images", json={"filename": "a b.png", "data_base64": base64.b64encode(b"PNG").decode()}, headers=auth)
    assert r.status_code == 201 and r.json()["path"].startswith(str(git_ws / ".studio-uploads")) and r.json()["path"].endswith("a_b.png")
    assert Path(r.json()["path"]).read_bytes() == b"PNG"


def test_install_requires_owner_and_runs_job(cclient, cauth, monkeypatch):
    _, auth = cauth
    from studio.modules.coding_agents import detect
    monkeypatch.setattr(detect, "find_npm", lambda: "/bin/echo")
    r = cclient.post("/coding/agents/pi/install", headers=auth)
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    for _ in range(100):
        job = cclient.get(f"/coding/install/{job_id}", headers=auth).json()
        if job["status"] != "running":
            break
        time.sleep(0.05)
    assert job["status"] == "completed" and "@mariozechner/pi-coding-agent" in job["log"]
    # member 不能裝
    cclient.post("/members", json={"username": "u", "password": "pw1234", "role": "member"}, headers=auth)
    tok2 = cclient.post("/auth/login", json={"username": "u", "password": "pw1234"}).json()["token"]
    assert cclient.post("/coding/agents/pi/install", headers={"Authorization": f"Bearer {tok2}"}).status_code == 403


# ---------------------------------------------------------------- proxy endpoints
def test_proxy_anthropic_messages_non_stream_and_stream(cclient, cauth, upstream_calls):
    _, auth = cauth
    info = cclient.get("/coding/proxy-info", headers=auth).json()
    assert info["anthropic_base_url"].endswith("/coding/proxy/anthropic") and info["token"].startswith("hsp_")
    cclient.put("/coding/settings/claude", json={"hermes_profile": "researcher"}, headers=auth)
    body = {"model": "claude-sonnet-4-5", "max_tokens": 50, "system": "S", "messages": [{"role": "user", "content": "ping"}]}
    r = cclient.post("/coding/proxy/anthropic/v1/messages", json=body, headers={"x-api-key": info["token"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["type"] == "message" and d["content"][0]["text"] == "echo:ping" and d["model"] == "claude-sonnet-4-5"
    kind, profile, sent, authz = upstream_calls[-1]
    assert kind == "chat" and profile == "researcher" and authz == "Bearer up-key" and "model" not in sent
    assert sent["messages"] == [{"role": "system", "content": "S"}, {"role": "user", "content": "ping"}]
    # streaming
    with cclient.stream("POST", "/coding/proxy/anthropic/v1/messages", json={**body, "stream": True}, headers={"x-api-key": info["token"]}) as r:
        assert r.status_code == 200
        text = "".join(r.iter_text())
    events = [l.split(":", 1)[1].strip() for l in text.splitlines() if l.startswith("event:")]
    assert events[0] == "message_start" and events[-1] == "message_stop" and events.count("content_block_delta") == 2
    deltas = [json.loads(l[5:]) for l in text.splitlines() if l.startswith("data:") and "text_delta" in l]
    assert "".join(d["delta"]["text"] for d in deltas) == "echo:ping"
    # wrong token
    assert cclient.post("/coding/proxy/anthropic/v1/messages", json=body, headers={"x-api-key": "nope"}).status_code == 401
    # studio jwt also OK
    assert cclient.post("/coding/proxy/anthropic/v1/messages", json=body, headers=auth).status_code == 200


def test_proxy_openai_responses_passthrough(cclient, cauth, upstream_calls):
    _, auth = cauth
    info = cclient.get("/coding/proxy-info", headers=auth).json()
    h = {"Authorization": f"Bearer {info['token']}"}
    r = cclient.post("/coding/proxy/openai/v1/responses", json={"model": "gpt-5", "input": "hi", "tools": [{"type": "function"}]}, headers=h)
    assert r.status_code == 200 and r.json()["id"] == "resp_1"
    kind, profile, sent, _ = upstream_calls[-1]
    assert kind == "responses" and "tools" not in sent and "model" not in sent and sent["input"] == "hi"
    with cclient.stream("POST", "/coding/proxy/openai/v1/responses", json={"input": "hi", "stream": True}, headers=h) as r:
        text = "".join(r.iter_text())
    assert "response.output_text.delta" in text and "response.completed" in text
    assert cclient.get("/coding/proxy/openai/v1/models", headers=h).json()["data"][0]["id"] == "hermes-agent"
    # rotate token（owner）→ 舊 token 失效
    new = cclient.post("/coding/proxy-info/rotate", headers=auth).json()["token"]
    assert new != info["token"]
    assert cclient.get("/coding/proxy/openai/v1/models", headers=h).status_code == 401
