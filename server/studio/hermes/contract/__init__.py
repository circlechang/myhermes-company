"""Hermes 接觸面契約（contract）：Studio 碰到 Hermes 的每一個點都列在 surface.yaml，
`run()` 對一個真的 Hermes（正式的 ~/.hermes 或預檢用的暫存 HERMES_HOME）逐項驗證，
產出 JSON 報告：每項 pass / fail / skip ＋ 原因 ＋ 受影響的 Studio 模組。

用法：
    from studio.hermes import contract
    report = contract.run(hermes_home, api_url, key)                 # 同步（CLI 用）
    report = await contract.run_async(hermes_home, api_url, key)     # 在 FastAPI 內
    contract.capabilities(report)                                    # 模組 → 可用／不可用

分級（risk）：low＝公開 gateway API；medium＝CLI --json；high＝表格解析、內部檔案／DB 欄位。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Optional

from .surface import Surface, SurfaceItem, load_surface, surface_path
from .checks import Context, run_async, run
from .report import capabilities, summarize, verdict_of, affected_modules

__all__ = [
    "Surface", "SurfaceItem", "load_surface", "surface_path", "Context",
    "run", "run_async", "capabilities", "summarize", "verdict_of", "affected_modules",
]
