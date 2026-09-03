"""FastAPI application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .api import agent_dossier, agents, auth_api, chat_ws, companies, hermes_status, kanban, sessions, workflows
from . import modules as _modules
from .config import Settings
from .db import init_db, make_engine
from .errors import install_error_handlers
from .hermes.cli import HermesCli
from .hermes.gateway import GatewayClient

log = logging.getLogger("studio")


def create_app(settings: Optional[Settings] = None, *, gateway: Optional[GatewayClient] = None,
               cli: Optional[HermesCli] = None, engine=None, sync_agents: bool = True) -> FastAPI:
    settings = settings or Settings.from_env()
    engine = engine or make_engine(settings.db_path)
    gateway = gateway or GatewayClient(settings.hermes_api_url, settings.hermes_api_key)
    cli = cli or HermesCli(settings.hermes_bin, settings.hermes_home)

    loaded = _modules.discover()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db(engine)
        for m in loaded:
            fn = getattr(m, 'on_startup', None)
            if fn:
                try:
                    await fn(app)
                except Exception as e:
                    log.warning('module %s on_startup failed: %s', m.__name__, e)
        if sync_agents:
            try:
                n = await agents.sync_agents_from_profiles(engine, cli)
                log.info("agents synced from Hermes profiles (+%d)", n)
            except Exception as e:  # never block startup on Hermes being down
                log.warning("agent sync skipped: %s", e)
        if not settings.hermes_api_key:
            log.warning("HERMES_API_KEY / API_SERVER_KEY 未設定，對話功能將無法使用")
        yield
        for m in loaded:
            fn = getattr(m, 'on_shutdown', None)
            if fn:
                try:
                    await fn(app)
                except Exception as e:
                    log.warning('module %s on_shutdown failed: %s', m.__name__, e)

    # Swagger 從 /docs 讓位到 /api-docs：/docs 是 docs 模組（文件＝第一級物件）的 REST 前綴
    app = FastAPI(title="MyHermesCompany", version=__version__, lifespan=lifespan,
                  docs_url="/api-docs", redoc_url="/api-redoc")
    app.state.settings = settings
    app.state.engine = engine
    app.state.gateway = gateway
    app.state.cli = cli
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    install_error_handlers(app)
    for r in (hermes_status.router, auth_api.router, companies.router, agents.router, agent_dossier.router, sessions.router,
              chat_ws.router, kanban.router, workflows.router):
        app.include_router(r)
    for m in loaded:
        r = getattr(m, 'router', None)
        if r is not None:
            app.include_router(r)
    app.state.modules = [m.__name__ for m in loaded]
    return app
