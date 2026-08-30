"""Serve the built web app (studio/web_dist) as an SPA from the same origin.

Design:
- Frontend (web/src/api/client.ts) always calls ``/api/<path>``; the server's routers
  have no prefix. ``ApiPrefixMiddleware`` rewrites ``/api/x`` → ``/x`` (pure ASGI, so
  it also applies to WebSocket paths) and marks the scope so the SPA fallback never
  answers an API path with index.html.
- ``install_static(app)`` adds the middleware and, when ``web_dist/index.html`` exists,
  a catch-all GET route: real file → FileResponse; anything else → index.html.
  ``/ws/*`` and marked ``/api/*`` paths return 404 JSON instead.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

log = logging.getLogger("studio.static")

WEB_DIST = Path(__file__).resolve().parent / "web_dist"
API_PREFIX = "/api"


class ApiPrefixMiddleware:
    """Strip ``/api`` prefix from HTTP and WebSocket paths; tag the scope."""

    def __init__(self, app, prefix: str = API_PREFIX, dist: Optional[Path] = None):
        self.app = app
        self.prefix = prefix.rstrip("/")
        self.dist = dist

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            path: str = scope.get("path", "")
            # SPA 深連結：瀏覽器導覽（GET + Accept: text/html）且沒有 /api 前綴 → 直接回前端，
            # 避免被同名的 API 路由（如 /workflows）攔走。
            if (self.dist is not None and scope["type"] == "http" and scope.get("method") == "GET"
                    and not (path == self.prefix or path.startswith(self.prefix + "/"))
                    and not path.startswith("/ws")):
                accept = ""
                for k, v in scope.get("headers", []):
                    if k == b"accept":
                        accept = v.decode("latin-1", "ignore"); break
                if "text/html" in accept:
                    f = resolve_static(self.dist, path) or (self.dist / "index.html")
                    resp = FileResponse(f, headers={"Cache-Control": "no-cache"} if f.name == "index.html" else None)
                    await resp(scope, receive, send)
                    return
            if path == self.prefix or path.startswith(self.prefix + "/"):
                new_path = path[len(self.prefix):] or "/"
                scope = dict(scope)
                scope["path"] = new_path
                raw = scope.get("raw_path")
                if isinstance(raw, (bytes, bytearray)):
                    rp = raw.decode("latin-1")
                    if rp.startswith(self.prefix):
                        scope["raw_path"] = rp[len(self.prefix):].encode("latin-1") or b"/"
                scope["studio_api"] = True
        await self.app(scope, receive, send)


def resolve_static(dist: Path, url_path: str) -> Optional[Path]:
    """Map a URL path to a file inside ``dist``; None if missing or escapes dist."""
    rel = url_path.lstrip("/")
    if not rel:
        return None
    try:
        p = (dist / rel).resolve()
        p.relative_to(dist.resolve())
    except (ValueError, OSError):
        return None
    return p if p.is_file() else None


def install_static(app: FastAPI, dist: Optional[Path] = None, *, api_prefix: str = API_PREFIX) -> bool:
    """Add /api prefix stripping + SPA fallback. Returns True if a web build was mounted."""
    dist = (dist or WEB_DIST).resolve()
    index = dist / "index.html"
    if not index.is_file():
        app.add_middleware(ApiPrefixMiddleware, prefix=api_prefix)
        log.warning(
            "找不到前端產物（%s），目前只服務 API，用瀏覽器打開會看到 404。\n"
            "  修法一（推薦）：安裝含前端的 release wheel\n"
            "      pip install <myhermescompany-*.whl>\n"
            "  修法二：在這份原始碼裡自己建前端（需要 Node 22+）\n"
            "      cd web && npm ci && npm run build",
            dist,
        )

        @app.get("/{full_path:path}", include_in_schema=False)
        async def _no_web(full_path: str, request: Request):
            if request.scope.get("studio_api") or full_path.startswith("ws"):
                return JSONResponse({"error": {"code": "not_found", "message": "not found"}}, status_code=404)
            return JSONResponse(
                {"error": {
                    "code": "web_not_built",
                    "message": "前端尚未建置：請安裝含前端的 release wheel，或在原始碼目錄執行 cd web && npm ci && npm run build 後重啟。",
                }},
                status_code=503,
            )

        return False
    app.add_middleware(ApiPrefixMiddleware, prefix=api_prefix, dist=dist)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str, request: Request):
        path = "/" + full_path
        if request.scope.get("studio_api") or path.startswith("/ws/") or path == "/ws":
            return JSONResponse({"error": {"code": "not_found", "message": "not found"}}, status_code=404)
        f = resolve_static(dist, path)
        if f is not None:
            return FileResponse(f)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    log.info("web_dist 已掛載：%s", dist)
    return True
