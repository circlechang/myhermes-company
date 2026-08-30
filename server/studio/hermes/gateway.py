"""Thin async client for the Hermes Gateway API server (http://127.0.0.1:8642).

Multi-profile requests use the `/p/{profile}` path prefix. SSE parsing is
done here so the rest of the server only sees dict events.
"""
from __future__ import annotations

import json
import logging
from typing import Any, AsyncIterator, Optional

import httpx

log = logging.getLogger("studio.gateway")


class GatewayError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class GatewayAuthError(GatewayError):
    """Bearer key 錯誤。Hermes 0.20.5 對錯 key 回 HTTP 200＋`{"error":{"code":"gateway_auth_failed"}}`（不是 401），
    所以除了 401/403 之外，也要從 2xx 的 body 辨識。"""

    def __init__(self, status: int = 401, message: str = "gateway_auth_failed"):
        super().__init__(status, message)
        self.code = "gateway_auth_failed"


# 正常回應一定會有其中一個欄位；只有 `error` 而沒有這些 → 是 Hermes 包成 200 的錯誤
_EXPECTED_KEYS = ("data", "status", "run_id", "id", "ok", "object", "choices", "output", "jobs", "providers", "sessions", "model")


class GatewayClient:
    def __init__(self, base_url: str, api_key: str, *, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._transport = transport

    # -- helpers -----------------------------------------------------------
    def _client(self, timeout: float = 30.0) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=timeout,
            transport=self._transport,
        )

    @staticmethod
    def _prefix(profile: Optional[str]) -> str:
        return f"/p/{profile}" if profile else ""

    @staticmethod
    def _error_body(r: httpx.Response) -> Optional[dict[str, Any]]:
        """回應 body 是「只有 error、沒有任何預期欄位」的 JSON 物件時回傳它；否則 None。串流回應（body 尚未讀）回 None。"""
        try:
            data = r.json()
        except Exception:
            return None
        if not isinstance(data, dict) or "error" not in data:
            return None
        if any(k in data for k in _EXPECTED_KEYS):
            return None
        return data

    @staticmethod
    def _raise(r: httpx.Response) -> None:
        if r.status_code in (401, 403):
            msg = r.text
            try:
                msg = r.json().get("error", {}).get("message") or msg
            except Exception:
                pass
            raise GatewayAuthError(r.status_code, msg or "gateway_auth_failed")
        if r.status_code >= 400:
            msg = r.text
            try:
                msg = r.json().get("error", {}).get("message") or msg
            except Exception:
                pass
            raise GatewayError(r.status_code, msg)
        body = GatewayClient._error_body(r)
        if body is not None:
            err = body.get("error")
            code = err.get("code") if isinstance(err, dict) else ""
            msg = (err.get("message") if isinstance(err, dict) else str(err)) or code or "gateway error"
            if code == "gateway_auth_failed" or "auth" in str(code):
                raise GatewayAuthError(r.status_code, msg)
            raise GatewayError(r.status_code or 502, msg)

    # -- read-only ---------------------------------------------------------
    async def health(self) -> dict[str, Any]:
        async with self._client(5.0) as c:
            r = await c.get("/v1/health")
            self._raise(r)
            return r.json()

    async def models(self, profile: Optional[str] = None) -> list[dict[str, Any]]:
        async with self._client() as c:
            r = await c.get(f"{self._prefix(profile)}/v1/models")
            self._raise(r)
            return r.json().get("data", [])

    async def skills(self, profile: Optional[str] = None) -> list[dict[str, Any]]:
        async with self._client() as c:
            r = await c.get(f"{self._prefix(profile)}/v1/skills")
            self._raise(r)
            return r.json().get("data", [])

    # -- runs --------------------------------------------------------------
    async def start_run(
        self,
        profile: Optional[str],
        input_text: str,
        *,
        session_id: Optional[str] = None,
        conversation_history: Optional[list[dict[str, str]]] = None,
        instructions: Optional[str] = None,
        previous_response_id: Optional[str] = None,
        model: Optional[str] = None,
    ) -> str:
        body: dict[str, Any] = {"input": input_text}
        if session_id:
            body["session_id"] = session_id
        if conversation_history:
            body["conversation_history"] = conversation_history
        if instructions:
            body["instructions"] = instructions
        if previous_response_id:
            body["previous_response_id"] = previous_response_id
        if model:
            body["model"] = model
        async with self._client() as c:
            r = await c.post(f"{self._prefix(profile)}/v1/runs", json=body)
            self._raise(r)
            data = r.json()
            run_id = data.get("run_id") or data.get("id")
            if not run_id:
                raise GatewayError(502, "gateway returned no run_id")
            return run_id

    async def run_status(self, profile: Optional[str], run_id: str) -> dict[str, Any]:
        async with self._client() as c:
            r = await c.get(f"{self._prefix(profile)}/v1/runs/{run_id}")
            self._raise(r)
            return r.json()

    async def run_events(self, profile: Optional[str], run_id: str) -> AsyncIterator[dict[str, Any]]:
        """Yield decoded SSE `data:` JSON objects until the stream closes."""
        async with self._client(timeout=httpx.Timeout(None, connect=10.0)) as c:
            async with c.stream("GET", f"{self._prefix(profile)}/v1/runs/{run_id}/events") as r:
                self._raise(r)
                data_lines: list[str] = []
                async for raw in r.aiter_lines():
                    line = raw.rstrip("\r")
                    if line == "":
                        if data_lines:
                            payload = "\n".join(data_lines)
                            data_lines = []
                            try:
                                yield json.loads(payload)
                            except json.JSONDecodeError:
                                log.debug("non-JSON SSE payload: %r", payload[:200])
                        continue
                    if line.startswith(":"):
                        continue  # comment / keepalive
                    if line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                if data_lines:
                    try:
                        yield json.loads("\n".join(data_lines))
                    except json.JSONDecodeError:
                        pass

    async def approve(self, profile: Optional[str], run_id: str, choice: str, resolve_all: bool = False) -> dict[str, Any]:
        async with self._client() as c:
            r = await c.post(f"{self._prefix(profile)}/v1/runs/{run_id}/approval", json={"choice": choice, "all": resolve_all})
            self._raise(r)
            return r.json()

    async def stop(self, profile: Optional[str], run_id: str) -> dict[str, Any]:
        async with self._client() as c:
            r = await c.post(f"{self._prefix(profile)}/v1/runs/{run_id}/stop", json={})
            self._raise(r)
            return r.json()

    async def steer(self, profile: Optional[str], run_id: str, text: str) -> dict[str, Any]:
        async with self._client() as c:
            r = await c.post(f"{self._prefix(profile)}/v1/runs/{run_id}/steer", json={"input": text})
            self._raise(r)
            return r.json()
