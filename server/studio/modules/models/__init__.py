"""G. 模型管理：供應商發現／模型清單／自訂 OpenAI 相容供應商／OAuth／預設模型／分組與可見性／STT-TTS 目錄。

資料源（全在後端，key 永不回前端）：
- `~/.hermes/auth.json`：providers（OAuth 狀態）、credential_pool（各供應商的憑證列表）、active_provider
- `~/.hermes/.env`：API key 是否存在（依供應商 key_envs）
- `config.yaml`：`providers.<id>`（v12+ 自訂供應商）、`custom_providers`（舊格式）、`model.{default,provider,base_url}`、`tts` / `stt`
- gateway `/api/model/options`：Hermes 自己整理好的模型清單（含 OAuth 供應商）
- 直接打供應商 `base_url/models`：自訂／API-key 供應商即時抓取，並做 `/v1` `/v4` 自動偵測
寫入規則（學 `hermes_cli/config.py` 與 dashboard `_write_custom_endpoint`）：
自訂供應商 → `providers.<slug>` {name, base_url, model, models{}, key_env}；key → `.env` 的 `HERMES_CUSTOM_<SLUG>`。
OAuth → 子程序包 `hermes auth add <provider> --type oauth --no-browser`，抓 URL／code，輪詢狀態。
預設模型 → 直接寫 config.yaml `model.*`（`hermes model` 是互動式 TUI，無法非互動使用）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlmodel import Field, Session, SQLModel, select

from ...auth import Principal, current_principal, get_db, profile_visible
from ...errors import ApiError, not_found
from ...hermes.cli import CliError
from ...models import new_id, now
from ..profiles import files as F
from .registry import BUILTIN_PROVIDERS, DEFAULT_GROUPS, OAUTH_PROVIDERS, STT_PROVIDERS, TTS_PROVIDERS

log = logging.getLogger("studio.models")
router = APIRouter(prefix="/models", tags=["models"])

BUILTIN_BY_ID = {p["id"]: p for p in BUILTIN_PROVIDERS}
CUSTOM_KEY_PREFIX = "HERMES_CUSTOM_"
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


class ModelPref(SQLModel, table=True):
    """Studio 端的供應商分組／可見模型／別名（每家公司一份）。"""
    __tablename__ = "model_prefs"
    id: str = Field(default_factory=lambda: new_id("mp"), primary_key=True)
    company_id: str = Field(index=True)
    provider: str = Field(index=True)
    group: str = ""
    hidden_json: str = "[]"  # 隱藏的模型 id
    aliases_json: str = "{}"  # {model_id: alias}
    enabled: bool = True
    updated_at: datetime = Field(default_factory=now)


# -- helpers ---------------------------------------------------------------
def _home(request: Request) -> Path:
    return Path(request.app.state.settings.hermes_home)


def _config_path(home: Path, profile: Optional[str]) -> Path:
    return F.profile_dir(home, profile or "default") / "config.yaml"


def _transport(request: Request) -> Optional[httpx.AsyncBaseTransport]:
    return getattr(request.app.state, "models_transport", None)


def custom_key_env(slug: str) -> str:
    s = re.sub(r"[^A-Z0-9]+", "_", slug.upper()).strip("_")
    return f"{CUSTOM_KEY_PREFIX}{s}"


def slugify(raw: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_-]+", "-", (raw or "").strip()).strip("-_").lower()
    return s or "custom"


def read_auth_json(home: Path) -> dict[str, Any]:
    p = home / "auth.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8")) or {}
    except (OSError, ValueError):
        return {}


def _cred_public(c: dict[str, Any]) -> dict[str, Any]:
    keep = ("id", "label", "auth_type", "priority", "source", "last_status", "last_status_at", "last_error_code",
            "last_error_reason", "base_url", "request_count", "expires_at_ms")
    return {k: c.get(k) for k in keep if k in c}


def custom_providers_from_config(cfg: dict) -> list[dict[str, Any]]:
    """config.yaml 的 providers.<id>（v12）＋ custom_providers 舊列表 → 統一形狀（不含 api_key 值）。"""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    provs = cfg.get("providers")
    if isinstance(provs, dict):
        for key, e in provs.items():
            if not isinstance(e, dict):
                continue
            base = e.get("base_url") or e.get("url") or e.get("api") or ""
            models = e.get("models")
            model_ids = list(models.keys()) if isinstance(models, dict) else (list(models) if isinstance(models, list) else [])
            out.append({"id": str(key), "name": e.get("name") or str(key), "base_url": base, "model": e.get("model") or e.get("default_model") or "",
                        "models": model_ids, "key_env": e.get("key_env") or e.get("api_key_env") or "", "has_inline_key": bool(e.get("api_key")),
                        "api_mode": e.get("api_mode") or e.get("transport") or "", "format": "providers", "enabled": e.get("enabled", True) is not False,
                        "context_length": e.get("context_length")})
            seen.add(str(key))
    legacy = cfg.get("custom_providers")
    if isinstance(legacy, list):
        for e in legacy:
            if not isinstance(e, dict) or not e.get("base_url"):
                continue
            key = slugify(e.get("name") or e["base_url"])
            if key in seen:
                continue
            models = e.get("models")
            model_ids = list(models.keys()) if isinstance(models, dict) else (list(models) if isinstance(models, list) else [])
            out.append({"id": key, "name": e.get("name") or key, "base_url": e["base_url"], "model": e.get("model") or "", "models": model_ids,
                        "key_env": e.get("key_env") or "", "has_inline_key": bool(e.get("api_key")), "api_mode": e.get("api_mode") or "",
                        "format": "custom_providers", "enabled": True, "context_length": e.get("context_length")})
    return out


def _env_all(home: Path, profile: Optional[str]) -> dict[str, str]:
    env = F.read_env(home / ".env")
    if profile and profile != "default":
        env.update(F.read_env(F.profile_dir(home, profile) / ".env"))
    return env


def build_providers(home: Path, profile: Optional[str]) -> dict[str, Any]:
    auth = read_auth_json(home)
    env = _env_all(home, profile)
    cfg = F.plain(F.load_yaml(_config_path(home, profile)))
    pool = auth.get("credential_pool") or {}
    oauth = auth.get("providers") or {}
    active = auth.get("active_provider") or ""
    model_cfg = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    current_provider = str(model_cfg.get("provider") or "")
    out = []
    for b in BUILTIN_PROVIDERS:
        pid = b["id"]
        creds = [_cred_public(c) for c in (pool.get(pid) or []) if isinstance(c, dict)]
        key_env_set = next((k for k in b["key_envs"] if env.get(k)), None)
        o = oauth.get(pid) if isinstance(oauth.get(pid), dict) else None
        oauth_ok = bool(o) and not (isinstance(o.get("last_auth_error"), dict) and o["last_auth_error"].get("relogin_required"))
        configured = bool(creds) or bool(key_env_set) or oauth_ok
        out.append({
            "id": pid, "name": b["name"], "kind": "builtin", "auth_type": b["auth_type"],
            "base_url": env.get(b["base_url_env"]) if b.get("base_url_env") and env.get(b["base_url_env"]) else b["base_url"],
            "key_envs": b["key_envs"], "key_env_set": key_env_set, "base_url_env": b.get("base_url_env") or "",
            "oauth_capable": pid in OAUTH_PROVIDERS, "oauth_logged_in": oauth_ok,
            "oauth_error": (o or {}).get("last_auth_error", {}).get("message") if o and isinstance(o.get("last_auth_error"), dict) else None,
            "credentials": creds, "configured": configured, "is_active": pid == active, "is_current": pid == current_provider,
        })
    for c in custom_providers_from_config(cfg):
        key_env = c["key_env"] or custom_key_env(c["id"])
        out.append({**c, "kind": "custom", "auth_type": "api_key", "key_envs": [key_env], "key_env_set": key_env if env.get(key_env) else None,
                    "oauth_capable": False, "oauth_logged_in": False, "credentials": [],
                    "configured": bool(env.get(key_env)) or c["has_inline_key"] or True, "is_active": False,
                    "is_current": c["id"] == current_provider or (bool(c["base_url"]) and c["base_url"].rstrip("/") == str(model_cfg.get("base_url") or "").rstrip("/"))})
    return {"providers": out, "active_provider": active, "current": {"model": model_cfg.get("default") or "", "provider": current_provider,
                                                                      "base_url": model_cfg.get("base_url") or ""}}


# -- model fetching ----------------------------------------------------------
def _models_url_candidates(base_url: str) -> list[str]:
    b = base_url.rstrip("/")
    if re.search(r"/v\d+(beta)?$", b) or b.endswith(("/openai", "/codex", "/anthropic", "/gateway")):
        return [b]
    return [b, f"{b}/v1", f"{b}/v4", f"{b}/api/v1", f"{b}/api/paas/v4", f"{b}/openai/v1", f"{b}/v1beta"]


async def fetch_models(base_url: str, api_key: str, transport: Optional[httpx.AsyncBaseTransport] = None, timeout: float = 15.0) -> list[str]:
    """打供應商 /models；Anthropic 與 Gemini 的差異在這裡吸收。"""
    b = base_url.rstrip("/")
    headers: dict[str, str] = {}
    url = f"{b}/models"
    if "anthropic.com" in b or b.endswith("/anthropic"):
        headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
        if not re.search(r"/v\d+$", b):
            url = f"{b}/v1/models"
    elif "generativelanguage.googleapis.com" in b:
        headers = {"x-goog-api-key": api_key}
    elif api_key:
        headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=timeout, transport=transport, follow_redirects=True) as c:
        r = await c.get(url, headers=headers)
    if r.status_code >= 400:
        raise ApiError(502, "provider_error", f"{url} → HTTP {r.status_code}: {r.text[:200]}")
    try:
        data = r.json()
    except ValueError:
        raise ApiError(502, "provider_error", f"{url} 回傳非 JSON")
    items = data.get("data") if isinstance(data, dict) and isinstance(data.get("data"), list) else None
    if items is None and isinstance(data, dict) and isinstance(data.get("models"), list):
        items = data["models"]
    if items is None and isinstance(data, list):
        items = data
    if items is None:
        raise ApiError(502, "provider_error", f"{url} 回傳格式不認得")
    ids = []
    for it in items:
        if isinstance(it, str):
            ids.append(it)
        elif isinstance(it, dict):
            mid = it.get("id") or it.get("name") or it.get("model")
            if mid:
                ids.append(str(mid).removeprefix("models/"))
    return sorted(set(ids))


async def detect_base_url(base_url: str, api_key: str, transport=None) -> dict[str, Any]:
    tried = []
    for cand in _models_url_candidates(base_url):
        try:
            ids = await fetch_models(cand, api_key, transport, timeout=8.0)
            return {"base_url": cand, "models": ids, "tried": tried + [cand], "detected": cand != base_url.rstrip("/")}
        except (ApiError, httpx.HTTPError) as e:
            tried.append(cand)
            last = str(e)
    raise ApiError(502, "provider_unreachable", f"找不到可用的 /models 端點；試過 {tried}；最後錯誤：{last}")


async def gateway_catalog(request: Request, refresh: bool = False, profile: Optional[str] = None) -> dict[str, Any]:
    """gateway `/api/model/options`；帶 profile 就走 `/p/{profile}` 前綴（與 gateway.py／cron 同一規則）。"""
    gw = request.app.state.gateway
    prefix = gw._prefix(profile)
    try:
        async with httpx.AsyncClient(base_url=gw.base_url, headers={"Authorization": f"Bearer {gw.api_key}"}, timeout=90.0,
                                     transport=getattr(gw, "_transport", None)) as c:
            r = await c.get(f"{prefix}/api/model/options", params={"refresh": "true"} if refresh else None)
    except httpx.HTTPError as e:
        raise ApiError(502, "gateway_unreachable", str(e))
    if r.status_code >= 400:
        raise ApiError(502, "gateway_error", r.text[:300])
    return r.json()


# -- endpoints: providers ------------------------------------------------------
@router.get("/providers")
def list_providers(request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    if profile and not profile_visible(p.member, profile):
        raise not_found("profile")
    data = build_providers(_home(request), profile)
    prefs = {r.provider: r for r in db.exec(select(ModelPref).where(ModelPref.company_id == p.company_id)).all()}
    group_of = {pid: g for g, ids in DEFAULT_GROUPS.items() for pid in ids}
    for pr in data["providers"]:
        pref = prefs.get(pr["id"])
        pr["group"] = (pref.group if pref and pref.group else group_of.get(pr["id"], "自訂" if pr["kind"] == "custom" else "其他"))
        pr["hidden_models"] = json.loads(pref.hidden_json) if pref else []
        pr["aliases"] = json.loads(pref.aliases_json) if pref else {}
        pr["enabled"] = pref.enabled if pref else True
    data["groups"] = list(DEFAULT_GROUPS.keys()) + ["自訂", "其他"]
    return data


@router.get("/catalog")
async def catalog(request: Request, refresh: bool = False, p: Principal = Depends(current_principal)):
    """gateway /api/model/options 的原樣（providers[{slug,name,models[],is_current}] + model/provider）。"""
    return await gateway_catalog(request, refresh)


@router.get("/providers/{provider_id}/models")
async def provider_models(provider_id: str, request: Request, profile: Optional[str] = None, live: bool = False,
                          p: Principal = Depends(current_principal)):
    """先用 gateway 目錄；live=1 或 gateway 沒有時直接打供應商 /models（key 只在後端）。"""
    p.require_admin()
    home = _home(request)
    env = _env_all(home, profile)
    b = BUILTIN_BY_ID.get(provider_id)
    custom = next((c for c in custom_providers_from_config(F.plain(F.load_yaml(_config_path(home, profile)))) if c["id"] == provider_id), None)
    if b is None and custom is None:
        raise not_found("provider")
    if not live:
        try:
            cat = await gateway_catalog(request)
            for pr in cat.get("providers") or []:
                if pr.get("slug") == provider_id and pr.get("models"):
                    return {"provider": provider_id, "models": pr["models"], "source": "gateway"}
        except ApiError as e:
            log.info("gateway catalog unavailable: %s", e.message)
    if custom is not None:
        key_env = custom["key_env"] or custom_key_env(custom["id"])
        api_key = env.get(key_env, "")
        base = custom["base_url"]
    else:
        api_key = next((env[k] for k in b["key_envs"] if env.get(k)), "")
        base = env.get(b["base_url_env"]) if b.get("base_url_env") and env.get(b["base_url_env"]) else b["base_url"]
        if b["auth_type"] != "api_key":
            raise ApiError(400, "not_supported", f"{b['name']} 是 OAuth／SDK 供應商，模型清單請用 gateway 目錄（refresh）")
    if not base:
        raise ApiError(400, "no_base_url", "此供應商沒有 base_url")
    try:
        ids = await fetch_models(base, api_key, _transport(request))
    except httpx.HTTPError as e:
        raise ApiError(502, "provider_unreachable", str(e))
    return {"provider": provider_id, "models": ids, "source": "live", "base_url": base}


class DetectBody(BaseModel):
    base_url: str
    api_key: Optional[str] = None
    provider_id: Optional[str] = None  # 用已存的 key


@router.post("/providers/detect")
async def detect(body: DetectBody, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    key = body.api_key or ""
    if not key and body.provider_id:
        env = _env_all(_home(request), profile)
        key = env.get(custom_key_env(body.provider_id), "")
    if not re.match(r"^https?://", body.base_url.strip()):
        raise ApiError(400, "bad_url", "base_url 需以 http:// 或 https:// 開頭")
    return await detect_base_url(body.base_url.strip(), key, _transport(request))


class CustomProviderBody(BaseModel):
    id: Optional[str] = None
    name: str
    base_url: str
    api_key: Optional[str] = None  # None=不動；""=清除
    model: Optional[str] = None
    models: Optional[list[str]] = None
    api_mode: Optional[str] = None  # chat_completions | responses | anthropic_messages
    context_length: Optional[int] = None
    detect: bool = True


@router.post("/providers", status_code=201)
async def create_custom(body: CustomProviderBody, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    return await _upsert_custom(body, request, profile, create=True)


@router.put("/providers/{provider_id}")
async def update_custom(provider_id: str, body: CustomProviderBody, request: Request, profile: Optional[str] = None,
                        p: Principal = Depends(current_principal)):
    p.require_admin()
    body.id = provider_id
    return await _upsert_custom(body, request, profile, create=False)


async def _upsert_custom(body: CustomProviderBody, request: Request, profile: Optional[str], create: bool) -> dict[str, Any]:
    home = _home(request)
    slug = slugify(body.id or body.name)
    if slug in BUILTIN_BY_ID:
        raise ApiError(400, "conflict", f"{slug} 是內建供應商，不能覆蓋")
    base = body.base_url.strip().rstrip("/")
    if not re.match(r"^https?://[^/\s]+", base):
        raise ApiError(400, "bad_url", "base_url 需含 scheme 與 host")
    cfg_path = _config_path(home, profile)
    data = F.load_yaml(cfg_path)
    provs = data.get("providers")
    if provs is None or not isinstance(provs, dict):
        from ruamel.yaml.comments import CommentedMap
        provs = CommentedMap()
        data["providers"] = provs
    existing = provs.get(slug)
    if create and existing is not None:
        raise ApiError(409, "conflict", f"供應商已存在: {slug}")
    if not create and existing is None:
        raise not_found("provider")
    key_env = custom_key_env(slug)
    env_path = home / ".env" if not profile or profile == "default" else F.profile_dir(home, profile) / ".env"
    if body.api_key is not None:
        if body.api_key.strip():
            F.write_env(env_path, {key_env: body.api_key.strip()})
        else:
            F.write_env(env_path, {key_env: None})
    api_key_now = F.read_env(env_path).get(key_env, "") or F.read_env(home / ".env").get(key_env, "")
    models = list(body.models or [])
    detected = None
    if body.detect:
        try:
            det = await detect_base_url(base, api_key_now, _transport(request))
            base = det["base_url"]
            detected = det
            if not models:
                models = det["models"]
        except ApiError as e:
            detected = {"error": e.message}
    from ruamel.yaml.comments import CommentedMap
    entry = existing if isinstance(existing, dict) else CommentedMap()
    entry["name"] = body.name.strip() or slug
    entry["base_url"] = base
    if body.model:
        entry["model"] = body.model.strip()
    elif not entry.get("model") and models:
        entry["model"] = models[0]
    if body.api_mode:
        entry["api_mode"] = body.api_mode
    if body.context_length:
        entry["context_length"] = int(body.context_length)
    mm = entry.get("models")
    if not isinstance(mm, dict):
        mm = CommentedMap()
    for mid in [*models, entry.get("model") or ""]:
        if mid and mid not in mm:
            mm[mid] = CommentedMap()
    entry["models"] = mm
    if api_key_now:
        entry["key_env"] = key_env
        entry.pop("api_key", None)
    elif body.api_key == "":
        entry.pop("key_env", None)
        entry.pop("api_key", None)
    provs[slug] = entry
    F.dump_yaml(cfg_path, data)
    return {"ok": True, "id": slug, "key_env": key_env, "key_set": bool(api_key_now), "detected": detected,
            "provider": next(c for c in custom_providers_from_config(F.plain(F.load_yaml(cfg_path))) if c["id"] == slug)}


@router.delete("/providers/{provider_id}")
def delete_custom(provider_id: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    if provider_id in BUILTIN_BY_ID:
        raise ApiError(400, "bad_request", "內建供應商不能刪除；要清憑證請用 DELETE /models/providers/{id}/key 或 /models/auth/{id}")
    home = _home(request)
    cfg_path = _config_path(home, profile)
    data = F.load_yaml(cfg_path)
    removed = False
    provs = data.get("providers")
    if isinstance(provs, dict) and provider_id in provs:
        del provs[provider_id]
        removed = True
    legacy = data.get("custom_providers")
    if isinstance(legacy, list):
        keep = [e for e in legacy if not (isinstance(e, dict) and slugify(e.get("name") or e.get("base_url") or "") == provider_id)]
        if len(keep) != len(legacy):
            data["custom_providers"] = keep
            removed = True
    if not removed:
        raise not_found("provider")
    F.dump_yaml(cfg_path, data)
    env_path = home / ".env" if not profile or profile == "default" else F.profile_dir(home, profile) / ".env"
    F.write_env(env_path, {custom_key_env(provider_id): None})
    return {"ok": True}


class KeyBody(BaseModel):
    api_key: str
    env_var: Optional[str] = None  # 預設用供應商第一個 key env


@router.put("/providers/{provider_id}/key")
def set_key(provider_id: str, body: KeyBody, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    """內建 API-key 供應商：寫 .env（不經 CLI argv，避免 key 出現在 ps）。"""
    p.require_admin()
    b = BUILTIN_BY_ID.get(provider_id)
    home = _home(request)
    if b is None:
        if provider_id in {c["id"] for c in custom_providers_from_config(F.plain(F.load_yaml(_config_path(home, profile))))}:
            var = custom_key_env(provider_id)
        else:
            raise not_found("provider")
    else:
        if not b["key_envs"]:
            raise ApiError(400, "not_supported", f"{b['name']} 不用 API key（請走 OAuth）")
        var = body.env_var or b["key_envs"][0]
        if var not in b["key_envs"]:
            raise ApiError(400, "bad_field", f"env_var 需為 {b['key_envs']}")
    if not body.api_key.strip():
        raise ApiError(400, "bad_request", "api_key 不可空白")
    env_path = home / ".env" if not profile or profile == "default" else F.profile_dir(home, profile) / ".env"
    F.write_env(env_path, {var: body.api_key.strip()})
    return {"ok": True, "env_var": var}


@router.delete("/providers/{provider_id}/key")
def clear_key(provider_id: str, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    b = BUILTIN_BY_ID.get(provider_id)
    home = _home(request)
    vars_ = b["key_envs"] if b else [custom_key_env(provider_id)]
    env_path = home / ".env" if not profile or profile == "default" else F.profile_dir(home, profile) / ".env"
    res = F.write_env(env_path, {v: None for v in vars_})
    return {"ok": True, "env": res}


# -- OAuth / device flow (hermes auth subprocess) ---------------------------------
class AuthSession:
    def __init__(self, provider: str):
        self.id = uuid.uuid4().hex[:12]
        self.provider = provider
        self.status = "starting"  # starting | waiting | done | failed | cancelled
        self.url: Optional[str] = None
        self.code: Optional[str] = None
        self.lines: list[str] = []
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.created = time.time()
        self.error: Optional[str] = None

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "provider": self.provider, "status": self.status, "url": self.url, "code": self.code,
                "output": "\n".join(self.lines[-30:]), "error": self.error, "age_s": int(time.time() - self.created)}


_AUTH_SESSIONS: dict[str, AuthSession] = {}
_URL_RE = re.compile(r"https?://[^\s\x1b\"']+")
_CODE_RE = re.compile(r"\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8}|[A-Z0-9]{8,10})\b")


def parse_auth_output(lines: list[str]) -> tuple[Optional[str], Optional[str]]:
    url = code = None
    for i, line in enumerate(lines):
        clean = _ANSI.sub("", line)
        m = _URL_RE.search(clean)
        if m and not url:
            url = m.group(0).rstrip(".,)")
        low = clean.lower()
        if ("code" in low or "enter" in low) and not code:
            cands = [_ANSI.sub("", x).strip() for x in lines[i:i + 3]]
            for c in cands:
                mm = _CODE_RE.search(c)
                if mm and not c.lower().startswith("http"):
                    code = mm.group(1)
                    break
    return url, code


async def _pump(sess: AuthSession) -> None:
    assert sess.proc and sess.proc.stdout
    try:
        while True:
            raw = await sess.proc.stdout.readline()
            if not raw:
                break
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                sess.lines.append(line)
                url, code = parse_auth_output(sess.lines)
                sess.url, sess.code = url or sess.url, code or sess.code
                if sess.url and sess.status == "starting":
                    sess.status = "waiting"
        rc = await sess.proc.wait()
        if sess.status != "cancelled":
            sess.status = "done" if rc == 0 else "failed"
            if rc != 0:
                sess.error = "\n".join(sess.lines[-5:]) or f"exit {rc}"
    except Exception as e:  # pragma: no cover
        sess.status = "failed"
        sess.error = str(e)


@router.post("/auth/{provider_id}/start", status_code=201)
async def auth_start(provider_id: str, request: Request, p: Principal = Depends(current_principal)):
    """啟動 `hermes auth add <provider> --type oauth --no-browser`；回 URL／code，之後輪詢。"""
    p.require_admin()
    if provider_id not in OAUTH_PROVIDERS:
        raise ApiError(400, "not_supported", f"{provider_id} 不支援 OAuth；支援：{sorted(OAUTH_PROVIDERS)}")
    for s in list(_AUTH_SESSIONS.values()):
        if s.provider == provider_id and s.status in ("starting", "waiting"):
            return s.public()
    cli = request.app.state.cli
    sess = AuthSession(provider_id)
    args = ["auth", "add", provider_id, "--type", "oauth", "--no-browser"]
    try:
        sess.proc = await asyncio.create_subprocess_exec(
            cli.bin, *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            env={**__import__("os").environ, "HERMES_HOME": str(cli.home), "NO_COLOR": "1", "TERM": "dumb"})
    except FileNotFoundError:
        raise ApiError(502, "hermes_cli_error", f"hermes CLI not found: {cli.bin}")
    _AUTH_SESSIONS[sess.id] = sess
    asyncio.create_task(_pump(sess))
    for _ in range(100):  # 最多等 10 秒抓 URL
        if sess.url or sess.status in ("done", "failed"):
            break
        await asyncio.sleep(0.1)
    return sess.public()


@router.get("/auth/sessions/{session_id}")
def auth_poll(session_id: str, p: Principal = Depends(current_principal)):
    p.require_admin()
    s = _AUTH_SESSIONS.get(session_id)
    if s is None:
        raise not_found("auth session")
    return s.public()


class SubmitBody(BaseModel):
    text: str


@router.post("/auth/sessions/{session_id}/submit")
async def auth_submit(session_id: str, body: SubmitBody, p: Principal = Depends(current_principal)):
    """PKCE 型（Anthropic）流程要把回呼 code 貼回 CLI stdin。"""
    p.require_admin()
    s = _AUTH_SESSIONS.get(session_id)
    if s is None or s.proc is None or s.proc.stdin is None:
        raise not_found("auth session")
    s.proc.stdin.write((body.text.strip() + "\n").encode())
    await s.proc.stdin.drain()
    return s.public()


@router.delete("/auth/sessions/{session_id}")
async def auth_cancel(session_id: str, p: Principal = Depends(current_principal)):
    p.require_admin()
    s = _AUTH_SESSIONS.pop(session_id, None)
    if s is None:
        raise not_found("auth session")
    if s.proc and s.proc.returncode is None:
        s.status = "cancelled"
        s.proc.terminate()
    return {"ok": True}


@router.delete("/auth/{provider_id}")
async def auth_logout(provider_id: str, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    try:
        out = await request.app.state.cli._run("auth", "logout", provider_id, timeout=30.0)
    except CliError as e:
        raise ApiError(502, "hermes_cli_error", str(e))
    return {"ok": True, "output": _ANSI.sub("", out)[-500:]}


@router.get("/auth/{provider_id}/status")
async def auth_status(provider_id: str, request: Request, p: Principal = Depends(current_principal)):
    p.require_admin()
    try:
        out = await request.app.state.cli._run("auth", "status", provider_id, timeout=30.0)
        ok = True
    except CliError as e:
        out, ok = str(e), False
    text = _ANSI.sub("", out)
    return {"ok": ok, "logged_in": bool(re.search(r"(?i)logged in|active|✓", text)) and "logged out" not in text.lower(), "raw": text[-1000:]}


# -- default model -------------------------------------------------------------
@router.get("/default")
def get_default(request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    if profile and not profile_visible(p.member, profile):
        raise not_found("profile")
    cfg = F.plain(F.load_yaml(_config_path(_home(request), profile)))
    m = cfg.get("model") if isinstance(cfg.get("model"), dict) else {"default": cfg.get("model")}
    return {"profile": profile or "default", "model": m.get("default") or "", "provider": m.get("provider") or "", "base_url": m.get("base_url") or "",
            "fallback_providers": cfg.get("fallback_providers") or []}


class DefaultBody(BaseModel):
    model: str
    provider: Optional[str] = None
    base_url: Optional[str] = None


@router.put("/default")
def set_default(body: DefaultBody, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    """寫 config.yaml `model.default/provider/base_url`（等同 `hermes model` 的落盤結果）。"""
    p.require_admin()
    if profile and not profile_visible(p.member, profile):
        raise not_found("profile")
    home = _home(request)
    path = _config_path(home, profile)
    data = F.load_yaml(path)
    from ruamel.yaml.comments import CommentedMap
    m = data.get("model")
    if not isinstance(m, dict):
        m = CommentedMap()
        data["model"] = m
    model = body.model.strip()
    if not model:
        raise ApiError(400, "bad_request", "model 必填")
    m["default"] = model
    provider = (body.provider or "").strip()
    base_url = (body.base_url or "").strip()
    if provider:
        m["provider"] = provider
        if not base_url:
            b = BUILTIN_BY_ID.get(provider)
            if b and b["base_url"]:
                base_url = b["base_url"]
            else:
                c = next((c for c in custom_providers_from_config(F.plain(data)) if c["id"] == provider), None)
                if c:
                    base_url = c["base_url"]
                    m["provider"] = "custom"
    if base_url:
        m["base_url"] = base_url
    F.dump_yaml(path, data)
    return {"ok": True, "profile": profile or "default", "model": model, "provider": m.get("provider") or "", "base_url": m.get("base_url") or ""}


# -- prefs (group / hidden / alias) -----------------------------------------------
class PrefBody(BaseModel):
    group: Optional[str] = None
    hidden_models: Optional[list[str]] = None
    aliases: Optional[dict[str, str]] = None
    enabled: Optional[bool] = None


@router.put("/providers/{provider_id}/prefs")
def set_prefs(provider_id: str, body: PrefBody, p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    p.require_admin()
    r = db.exec(select(ModelPref).where(ModelPref.company_id == p.company_id, ModelPref.provider == provider_id)).first()
    if r is None:
        r = ModelPref(company_id=p.company_id, provider=provider_id)
    if body.group is not None:
        r.group = body.group.strip()
    if body.hidden_models is not None:
        r.hidden_json = json.dumps(sorted(set(body.hidden_models)))
    if body.aliases is not None:
        r.aliases_json = json.dumps({k: v for k, v in body.aliases.items() if k and v})
    if body.enabled is not None:
        r.enabled = body.enabled
    r.updated_at = now()
    db.add(r)
    db.commit()
    return {"ok": True, "provider": provider_id, "group": r.group, "hidden_models": json.loads(r.hidden_json),
            "aliases": json.loads(r.aliases_json), "enabled": r.enabled}


# -- STT / TTS directory ------------------------------------------------------------
@router.get("/speech")
def speech(request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    if profile and not profile_visible(p.member, profile):
        raise not_found("profile")
    home = _home(request)
    env = _env_all(home, profile)
    cfg = F.plain(F.load_yaml(_config_path(home, profile)))
    tts = cfg.get("tts") if isinstance(cfg.get("tts"), dict) else {}
    stt = cfg.get("stt") if isinstance(cfg.get("stt"), dict) else {}

    def rows(cat, section):
        out = []
        for c in cat:
            out.append({**c, "key_set": any(env.get(k) for k in c["key_envs"]) if c["key_envs"] else True,
                        "current": section.get("provider") == c["id"], "settings": F.redact(section.get(c["id"]) or {})})
        return out

    return {"tts": {"provider": tts.get("provider") or "", "providers": rows(TTS_PROVIDERS, tts)},
            "stt": {"provider": stt.get("provider") or "", "enabled": stt.get("enabled", True), "providers": rows(STT_PROVIDERS, stt)},
            "voice": F.redact(cfg.get("voice") or {})}


class SpeechBody(BaseModel):
    tts: Optional[dict[str, Any]] = None  # {provider, <provider>: {...}}
    stt: Optional[dict[str, Any]] = None
    env: Optional[dict[str, Optional[str]]] = None  # 相關 API key


@router.put("/speech")
def put_speech(body: SpeechBody, request: Request, profile: Optional[str] = None, p: Principal = Depends(current_principal)):
    p.require_admin()
    home = _home(request)
    patch: dict[str, Any] = {}
    if body.tts is not None:
        if body.tts.get("provider") and body.tts["provider"] not in {c["id"] for c in TTS_PROVIDERS}:
            raise ApiError(400, "bad_field", "未知的 TTS 供應商")
        patch["tts"] = body.tts
    if body.stt is not None:
        if body.stt.get("provider") and body.stt["provider"] not in {c["id"] for c in STT_PROVIDERS}:
            raise ApiError(400, "bad_field", "未知的 STT 供應商")
        patch["stt"] = body.stt
    if patch:
        F.update_yaml(_config_path(home, profile), patch)
    if body.env:
        allowed = {k for c in TTS_PROVIDERS + STT_PROVIDERS for k in c["key_envs"]}
        bad = set(body.env) - allowed
        if bad:
            raise ApiError(400, "bad_field", f"不允許的 env: {sorted(bad)}")
        env_path = home / ".env" if not profile or profile == "default" else F.profile_dir(home, profile) / ".env"
        F.write_env(env_path, {k: (v.strip() if v else None) for k, v in body.env.items()})
    return speech(request, profile, p)
