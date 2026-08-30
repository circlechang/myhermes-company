"""WebSocket hub for /ws/workflows: broadcast run events to connected members of the same company."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("studio.workflows.hub")


class WorkflowHub:
    def __init__(self):
        self._conns: dict[WebSocket, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket, company_id: str) -> None:
        async with self._lock:
            self._conns[ws] = {"company_id": company_id, "runs": None}

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self._conns.pop(ws, None)

    async def subscribe(self, ws: WebSocket, run_ids: list[str] | None) -> None:
        async with self._lock:
            if ws in self._conns:
                self._conns[ws]["runs"] = set(run_ids) if run_ids else None

    async def broadcast(self, company_id: str, event: dict[str, Any]) -> None:
        payload = json.dumps(event, ensure_ascii=False, default=str)
        run_id = event.get("run_id")
        dead: list[WebSocket] = []
        for ws, info in list(self._conns.items()):
            if info["company_id"] != company_id:
                continue
            if info["runs"] is not None and run_id not in info["runs"]:
                continue
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.remove(ws)

    @property
    def size(self) -> int:
        return len(self._conns)
