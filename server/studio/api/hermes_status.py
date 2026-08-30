from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from ..auth import Principal, current_principal
from ..hermes.gateway import GatewayAuthError

router = APIRouter(tags=["hermes"])


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/hermes/status")
async def hermes_status(request: Request, p: Principal = Depends(current_principal)):
    st = request.app.state.settings
    gw = request.app.state.gateway
    ok, version, auth_error, error = False, "", False, ""
    try:
        h = await gw.health()
        ok = h.get("status") == "ok"
        version = h.get("version", "")
    except GatewayAuthError as e:
        ok, auth_error, error = False, True, "API key 錯誤（gateway 回 gateway_auth_failed）"
    except Exception as e:
        ok, error = False, str(e)[:300]
    if ok:
        # /v1/health 不驗 key（沒 key 也回 200）；用 /v1/models 確認 Studio 手上的 key 真的被接受
        try:
            await gw.models()
        except GatewayAuthError:
            auth_error, error = True, "API key 錯誤（gateway 回 gateway_auth_failed）"
        except Exception:
            pass
    try:
        profiles = await request.app.state.cli.list_profiles()
    except Exception:
        profiles = []
    return {"gateway_ok": ok and not auth_error, "gateway_reachable": ok, "auth_error": auth_error, "error": error,
            "version": version, "profiles": profiles, "api_server_url": st.hermes_api_url,
            "api_key_configured": bool(st.hermes_api_key)}
