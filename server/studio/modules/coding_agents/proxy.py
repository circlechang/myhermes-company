"""本機相容 proxy：讓沒有 Anthropic／OpenAI key 的人用 Hermes 的模型跑 Claude Code／Codex。

- POST /coding/proxy/anthropic/v1/messages  → Hermes /v1/chat/completions（Anthropic Messages ⇄ OpenAI Chat 轉換）
- POST /coding/proxy/openai/v1/responses     → Hermes /v1/responses（直通）
- POST /coding/proxy/openai/v1/chat/completions → Hermes /v1/chat/completions（直通）
- GET  /coding/proxy/openai/v1/models        → Hermes /v1/models

驗證：header `x-api-key` 或 `Authorization: Bearer` 必須等於公司 proxy token（或 Studio JWT）。
profile：query `?profile=` 或 header `X-Hermes-Profile`；否則用該公司 claude/codex 設定的 hermes_profile。
"""
from __future__ import annotations

import json
import logging
import secrets
import time
import uuid
from typing import Any, AsyncIterator, Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlmodel import Session, select

from ...auth import decode_token
from ...models import Member
from .models import CodingAgentSetting, CodingProxyToken

log = logging.getLogger("studio.coding.proxy")
router = APIRouter(prefix="/coding/proxy", tags=["coding-proxy"])


# ---------------------------------------------------------------- token
def get_or_create_proxy_token(db: Session, company_id: str) -> str:
    row = db.get(CodingProxyToken, company_id)
    if row is None:
        row = CodingProxyToken(company_id=company_id, token="hsp_" + secrets.token_urlsafe(32))
        db.add(row)
        db.commit()
    return row.token


def rotate_proxy_token(db: Session, company_id: str) -> str:
    row = db.get(CodingProxyToken, company_id)
    if row is None:
        return get_or_create_proxy_token(db, company_id)
    row.token = "hsp_" + secrets.token_urlsafe(32)
    db.add(row)
    db.commit()
    return row.token


def _authorize(request: Request) -> Optional[str]:
    """回傳 company_id；失敗回 None。"""
    token = request.headers.get("x-api-key") or ""
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
    if not token:
        return None
    engine = request.app.state.engine
    with Session(engine) as db:
        row = db.exec(select(CodingProxyToken).where(CodingProxyToken.token == token)).first()
        if row:
            return row.company_id
        try:
            claims = decode_token(token, request.app.state.settings.secret)
            m = db.get(Member, claims.get("sub", ""))
            return m.company_id if m else None
        except Exception:
            return None


def _profile_for(request: Request, company_id: str, agent: str) -> str:
    p = request.query_params.get("profile") or request.headers.get("x-hermes-profile") or ""
    if p:
        return p
    with Session(request.app.state.engine) as db:
        row = db.exec(select(CodingAgentSetting).where(CodingAgentSetting.company_id == company_id,
                                                       CodingAgentSetting.agent == agent)).first()
        return (row.hermes_profile if row else "") or ""


def _upstream(request: Request, profile: str, path: str) -> str:
    base = request.app.state.settings.hermes_api_url.rstrip("/")
    return f"{base}/p/{profile}{path}" if profile else f"{base}{path}"


def _headers(request: Request) -> dict[str, str]:
    return {"Authorization": f"Bearer {request.app.state.settings.hermes_api_key}", "Content-Type": "application/json"}


def _unauth() -> JSONResponse:
    return JSONResponse({"type": "error", "error": {"type": "authentication_error", "message": "invalid proxy token"}}, status_code=401)


# ---------------------------------------------------------------- Anthropic ⇄ OpenAI
def _block_text(block: Any) -> str:
    if isinstance(block, str):
        return block
    if not isinstance(block, dict):
        return str(block)
    bt = block.get("type")
    if bt == "text":
        return str(block.get("text") or "")
    if bt == "tool_use":
        return f"[tool_use {block.get('name')}] {json.dumps(block.get('input'), ensure_ascii=False)}"
    if bt == "tool_result":
        c = block.get("content")
        if isinstance(c, list):
            c = "\n".join(_block_text(x) for x in c)
        return f"[tool_result] {c}"
    if bt == "image":
        return "[image omitted]"
    if bt == "thinking":
        return ""
    return json.dumps(block, ensure_ascii=False)


def anthropic_to_chat(body: dict[str, Any], *, model: str = "") -> dict[str, Any]:
    """Anthropic Messages 請求 → OpenAI Chat Completions 請求（工具定義丟掉；Hermes 自己有工具）。"""
    msgs: list[dict[str, Any]] = []
    system = body.get("system")
    if system:
        text = system if isinstance(system, str) else "\n".join(_block_text(b) for b in system)
        if text.strip():
            msgs.append({"role": "system", "content": text})
    for m in body.get("messages") or []:
        role = "assistant" if m.get("role") == "assistant" else "user"
        content = m.get("content")
        if isinstance(content, list):
            # tool_result 區塊 → user 訊息；其他照文字合併
            text = "\n".join(t for t in (_block_text(b) for b in content) if t)
        else:
            text = str(content or "")
        if not text.strip():
            continue
        if msgs and msgs[-1]["role"] == role and role != "system":
            msgs[-1]["content"] += "\n" + text
        else:
            msgs.append({"role": role, "content": text})
    out: dict[str, Any] = {"messages": msgs, "stream": bool(body.get("stream"))}
    if model:
        out["model"] = model
    for k in ("max_tokens", "temperature", "top_p"):
        if body.get(k) is not None:
            out[k] = body[k]
    return out


def chat_to_anthropic(resp: dict[str, Any], model: str) -> dict[str, Any]:
    choice = (resp.get("choices") or [{}])[0]
    text = ((choice.get("message") or {}).get("content")) or ""
    usage = resp.get("usage") or {}
    return {
        "id": resp.get("id") or f"msg_{uuid.uuid4().hex[:24]}", "type": "message", "role": "assistant",
        "model": model, "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": usage.get("prompt_tokens", 0), "output_tokens": usage.get("completion_tokens", 0)},
    }


def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


async def _iter_openai_sse(r: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    async for raw in r.aiter_lines():
        line = raw.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            return
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            continue


async def anthropic_stream(client: httpx.AsyncClient, url: str, headers: dict[str, str], body: dict[str, Any],
                           model: str) -> AsyncIterator[bytes]:
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    yield _sse("message_start", {"type": "message_start", "message": {
        "id": msg_id, "type": "message", "role": "assistant", "content": [], "model": model,
        "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 0, "output_tokens": 0}}})
    yield _sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
    out_tokens = 0
    in_tokens = 0
    try:
        async with client.stream("POST", url, headers=headers, json=body) as r:
            if r.status_code >= 400:
                text = (await r.aread()).decode("utf-8", "replace")
                yield _sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                   "delta": {"type": "text_delta", "text": f"[hermes error {r.status_code}] {text[:500]}"}})
            else:
                async for chunk in _iter_openai_sse(r):
                    for ch in chunk.get("choices") or []:
                        delta = (ch.get("delta") or {}).get("content")
                        if delta:
                            yield _sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                                               "delta": {"type": "text_delta", "text": delta}})
                    u = chunk.get("usage") or {}
                    out_tokens = u.get("completion_tokens", out_tokens)
                    in_tokens = u.get("prompt_tokens", in_tokens)
    except httpx.HTTPError as e:
        yield _sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                           "delta": {"type": "text_delta", "text": f"[hermes unreachable] {e}"}})
    yield _sse("content_block_stop", {"type": "content_block_stop", "index": 0})
    yield _sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                                 "usage": {"input_tokens": in_tokens, "output_tokens": out_tokens}})
    yield _sse("message_stop", {"type": "message_stop"})


# ---------------------------------------------------------------- routes
@router.post("/anthropic/v1/messages")
async def anthropic_messages(request: Request):
    company_id = _authorize(request)
    if not company_id:
        return _unauth()
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"type": "error", "error": {"type": "invalid_request_error", "message": "invalid JSON"}}, status_code=400)
    profile = _profile_for(request, company_id, "claude")
    model = str(body.get("model") or "hermes-agent")
    chat_body = anthropic_to_chat(body)  # model 交給 Hermes profile 決定
    url = _upstream(request, profile, "/v1/chat/completions")
    headers = _headers(request)
    if chat_body["stream"]:
        client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10.0))

        async def gen():
            try:
                async for b in anthropic_stream(client, url, headers, chat_body, model):
                    yield b
            finally:
                await client.aclose()

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})
    async with httpx.AsyncClient(timeout=600.0) as client:
        try:
            r = await client.post(url, headers=headers, json=chat_body)
        except httpx.HTTPError as e:
            return JSONResponse({"type": "error", "error": {"type": "api_error", "message": f"hermes unreachable: {e}"}}, status_code=502)
    if r.status_code >= 400:
        return JSONResponse({"type": "error", "error": {"type": "api_error", "message": r.text[:500]}}, status_code=r.status_code)
    return JSONResponse(chat_to_anthropic(r.json(), model))


@router.post("/anthropic/v1/messages/count_tokens")
async def anthropic_count_tokens(request: Request):
    if not _authorize(request):
        return _unauth()
    body = await request.json()
    text = json.dumps(body.get("messages") or [], ensure_ascii=False) + str(body.get("system") or "")
    return {"input_tokens": max(1, len(text) // 4)}


async def _passthrough(request: Request, agent: str, path: str, strip: tuple[str, ...] = ()):
    company_id = _authorize(request)
    if not company_id:
        return _unauth()
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": {"message": "invalid JSON", "type": "invalid_request_error"}}, status_code=400)
    for k in strip:
        body.pop(k, None)
    # 模型名交給 Hermes profile；Codex 送的 gpt-* 名稱在 Hermes 端不一定存在
    body.pop("model", None)
    profile = _profile_for(request, company_id, agent)
    url = _upstream(request, profile, path)
    headers = _headers(request)
    if body.get("stream"):
        client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=10.0))

        async def gen():
            try:
                async with client.stream("POST", url, headers=headers, json=body) as r:
                    if r.status_code >= 400:
                        text = (await r.aread()).decode("utf-8", "replace")
                        yield f"data: {json.dumps({'type': 'error', 'error': {'message': text[:500]}})}\n\n".encode()
                        return
                    async for chunk in r.aiter_bytes():
                        yield chunk
            except httpx.HTTPError as e:
                yield f"data: {json.dumps({'type': 'error', 'error': {'message': f'hermes unreachable: {e}'}})}\n\n".encode()
            finally:
                await client.aclose()

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})
    async with httpx.AsyncClient(timeout=600.0) as client:
        try:
            r = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as e:
            return JSONResponse({"error": {"message": f"hermes unreachable: {e}", "type": "api_error"}}, status_code=502)
    return JSONResponse(r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text},
                        status_code=r.status_code)


@router.post("/openai/v1/responses")
async def openai_responses(request: Request):
    # Hermes 的 /v1/responses 會自己跑工具，Codex 傳來的 tools 定義沒有意義，去掉避免被拒
    return await _passthrough(request, "codex", "/v1/responses", strip=("tools", "tool_choice", "parallel_tool_calls", "include"))


@router.post("/openai/v1/chat/completions")
async def openai_chat(request: Request):
    return await _passthrough(request, "codex", "/v1/chat/completions", strip=("tools", "tool_choice", "parallel_tool_calls"))


@router.get("/openai/v1/models")
async def openai_models(request: Request):
    company_id = _authorize(request)
    if not company_id:
        return _unauth()
    profile = _profile_for(request, company_id, "codex")
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            r = await client.get(_upstream(request, profile, "/v1/models"), headers=_headers(request))
        except httpx.HTTPError as e:
            return JSONResponse({"error": {"message": f"hermes unreachable: {e}"}}, status_code=502)
    return JSONResponse(r.json(), status_code=r.status_code)


def proxy_info(base: str, token: str) -> dict[str, Any]:
    return {
        "anthropic_base_url": f"{base}/coding/proxy/anthropic",
        "openai_base_url": f"{base}/coding/proxy/openai/v1",
        "token": token,
        "claude_env": {"ANTHROPIC_BASE_URL": f"{base}/coding/proxy/anthropic", "ANTHROPIC_AUTH_TOKEN": token},
        "codex_config_snippet": (
            "[model_providers.myhermescompany]\nname = \"MyHermesCompany\"\n"
            f"base_url = \"{base}/coding/proxy/openai/v1\"\nwire_api = \"responses\"\nenv_key = \"MHC_PROXY_KEY\"\n\n"
            "model_provider = \"myhermescompany\"\nmodel = \"hermes-agent\"\n"
        ),
        "codex_env": {"MHC_PROXY_KEY": token},
        "generated_at": int(time.time()),
    }
