"""模型清單：gateway `GET /p/<profile>/api/model/options`（回 providers[].models）。

正規化成前端好用的扁平清單；gateway 失敗時退回 `/v1/models`（只有虛擬模型），
再不行回空清單並附 error（不擋 UI）。
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, Request

from ...auth import Principal, current_principal
from ...hermes.gateway import GatewayClient

router = APIRouter()


def normalize_options(payload: dict[str, Any]) -> dict[str, Any]:
    providers_out = []
    flat = []
    for prov in payload.get("providers") or []:
        slug = str(prov.get("slug") or prov.get("id") or prov.get("name") or "")
        pricing = prov.get("pricing") or {}
        models = []
        for m in prov.get("models") or []:
            mid = m if isinstance(m, str) else str((m or {}).get("id") or (m or {}).get("name") or "")
            if not mid:
                continue
            price = pricing.get(mid) if isinstance(pricing, dict) else None
            entry = {"id": mid, "provider": slug, "label": mid,
                     "pricing": {k: price.get(k) for k in ("input", "output", "free")} if isinstance(price, dict) else None}
            models.append(entry)
            flat.append(entry)
        providers_out.append({"slug": slug, "name": prov.get("name") or slug, "is_current": bool(prov.get("is_current")),
                              "authenticated": prov.get("authenticated"), "models": models})
    return {"providers": providers_out, "models": flat,
            "current": {"model": payload.get("model"), "provider": payload.get("provider")}}


async def fetch_model_options(gw: GatewayClient, profile: Optional[str], refresh: bool = False) -> dict[str, Any]:
    prefix = gw._prefix(profile)
    async with gw._client(20.0) as c:
        r = await c.get(f"{prefix}/api/model/options", params={"refresh": "1"} if refresh else None)
        if r.status_code < 400:
            return normalize_options(r.json())
    # fallback: /v1/models (virtual model only)
    data = await gw.models(profile)
    models = [{"id": m.get("id"), "provider": "", "label": m.get("id"), "pricing": None} for m in data if m.get("id")]
    return {"providers": [{"slug": "", "name": "gateway", "is_current": True, "models": models}], "models": models,
            "current": {"model": None, "provider": None}, "fallback": True}


@router.get("/models")
async def list_models(request: Request, profile: Optional[str] = None, refresh: bool = False,
                      p: Principal = Depends(current_principal)):
    gw: GatewayClient = request.app.state.gateway
    profile = profile if profile and profile != "default" else None
    try:
        return await fetch_model_options(gw, profile, refresh)
    except Exception as e:
        return {"providers": [], "models": [], "current": {}, "error": str(e)}
