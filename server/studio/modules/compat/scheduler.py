"""每週自動盯版本：純函式（好測）＋ 背景 loop。

排程規格不用 cron 字串（server 沒裝 croniter）：weekday（0=一 … 6=日）+ hour + minute（本機時區）。
判斷邏輯 `due()`：現在時間已過本週的排定時刻，而且上次跑的時間在那個時刻之前 → 該跑。
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional


def scheduled_slot(now: datetime, weekday: int, hour: int, minute: int) -> datetime:
    """回傳 <= now 的最近一次排定時刻。"""
    days_back = (now.weekday() - weekday) % 7
    slot = (now - timedelta(days=days_back)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    if slot > now:
        slot -= timedelta(days=7)
    return slot


def due(now: datetime, *, enabled: bool, weekday: int, hour: int, minute: int, last_run: Optional[datetime]) -> bool:
    if not enabled:
        return False
    slot = scheduled_slot(now, weekday, hour, minute)
    return last_run is None or last_run < slot


def decide(latest_tag: str, tested_tag: str, *, is_newer) -> str:
    """抓到最新 tag 後要做什麼：'precheck'（比已測版本新）| 'noop'。"""
    if not latest_tag:
        return "noop"
    if not tested_tag or is_newer(latest_tag, tested_tag):
        return "precheck"
    return "noop"
