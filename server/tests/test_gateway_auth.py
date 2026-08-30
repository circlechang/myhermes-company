"""GatewayClient 對「錯 key」的辨識（round3 1c）：
Hermes 0.20.5 對錯 Bearer 回 HTTP 200＋`{"error":{"code":"gateway_auth_failed"}}`，不是 401；
`_raise` 要從 body 認出來丟 GatewayAuthError，hermes_status 與 setup 狀態要能顯示「key 錯誤」。"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from studio.hermes.gateway import GatewayAuthError, GatewayClient, GatewayError


def _client(handler) -> GatewayClient:
    return GatewayClient("http://gw.test", "k", transport=httpx.MockTransport(handler))


def test_raise_recognises_200_error_body_as_auth_error():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"error": {"code": "gateway_auth_failed", "message": "invalid api key"}})
    with pytest.raises(GatewayAuthError) as ei:
        asyncio.run(_client(handler).models())
    assert ei.value.code == "gateway_auth_failed" and "invalid api key" in ei.value.message


def test_raise_401_is_auth_error_and_other_4xx_is_plain_error():
    def h401(req):
        return httpx.Response(401, json={"error": {"message": "unauthorized"}})
    with pytest.raises(GatewayAuthError):
        asyncio.run(_client(h401).models())

    def h404(req):
        return httpx.Response(404, json={"error": {"message": "no such run"}})
    with pytest.raises(GatewayError) as ei:
        asyncio.run(_client(h404).run_status("default", "r1"))
    assert not isinstance(ei.value, GatewayAuthError) and ei.value.status == 404


def test_raise_200_with_error_but_expected_fields_is_not_an_error():
    """正常回應也可能帶 error 欄位（例如 run 狀態帶 error: null）；有預期欄位就不是錯誤。"""
    def handler(req):
        return httpx.Response(200, json={"id": "r1", "status": "failed", "error": "model not found"})
    assert asyncio.run(_client(handler).run_status(None, "r1"))["status"] == "failed"

    def handler2(req):
        return httpx.Response(200, json={"error": {"code": "something_else", "message": "boom"}})
    with pytest.raises(GatewayError) as ei:
        asyncio.run(_client(handler2).models())
    assert not isinstance(ei.value, GatewayAuthError) and ei.value.message == "boom"


def test_sse_stream_not_affected_by_body_check():
    """串流回應在 _raise 時 body 還沒讀，不能因此炸掉。"""
    def handler(req):
        body = b'data: {"type":"run.completed","output":"hi"}\n\n'
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    async def go():
        return [ev async for ev in _client(handler).run_events("default", "r1")]
    assert asyncio.run(go())[0]["type"] == "run.completed"


def test_prefix_always_added_including_default():
    assert GatewayClient._prefix("default") == "/p/default"
    assert GatewayClient._prefix("researcher") == "/p/researcher"
    assert GatewayClient._prefix(None) == "" and GatewayClient._prefix("") == ""


def test_hermes_status_and_setup_report_key_error(client, auth, app, monkeypatch):
    """Studio 手上的 key 錯 → /hermes/status 的 auth_error、/setup/status 的 api.auth_failed。"""
    from studio.modules import setup as S
    monkeypatch.setattr(S, "_resolve_bin", lambda b: "/fake/bin/hermes")  # 當作 hermes 已裝，next_step 才會走到 api

    async def fake_run(*args, timeout=30.0):
        return "Hermes Agent v0.20.5 (2026.8.19)" if args and args[0] == "--version" else ""
    app.state.fake_cli._run = fake_run
    gw = app.state.gateway
    monkeypatch.setattr(gw, "api_key", "wrong-key")
    st = client.get("/hermes/status", headers=auth).json()
    assert st["gateway_ok"] is False and st["auth_error"] is True and "gateway_auth_failed" in st["error"]
    s = client.get("/setup/status", headers=auth).json()
    assert s["api"]["reachable"] is False and s["api"]["auth_failed"] is True
    assert s["next_step"] == "api"
    # 正確 key 恢復
    monkeypatch.setattr(gw, "api_key", "test-key")
    st = client.get("/hermes/status", headers=auth).json()
    assert st["gateway_ok"] is True and st["auth_error"] is False
