"""Minimal 5-field cron (min hour dom month dow) matcher — no third-party dependency.
Supports: * , - / and names are NOT supported (numbers only). dow: 0-6 (0=Sunday, 7 also Sunday)."""
from __future__ import annotations

from datetime import datetime, timedelta

_RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]


class CronError(ValueError):
    pass


def _parse_field(field: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in field.split(","):
        part = part.strip()
        if not part:
            raise CronError(f"空的欄位: {field!r}")
        step = 1
        if "/" in part:
            part, step_s = part.split("/", 1)
            try:
                step = int(step_s)
            except ValueError:
                raise CronError(f"step 不是整數: {step_s!r}")
            if step < 1:
                raise CronError("step 必須 ≥ 1")
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a_s, b_s = part.split("-", 1)
            try:
                a, b = int(a_s), int(b_s)
            except ValueError:
                raise CronError(f"範圍不是整數: {part!r}")
        else:
            try:
                a = b = int(part)
            except ValueError:
                raise CronError(f"不是整數: {part!r}")
            if "/" in field and step > 1:
                b = hi
        if a < lo or b > hi or a > b:
            raise CronError(f"超出範圍 {lo}-{hi}: {part!r}")
        out.update(range(a, b + 1, step))
    return out


def parse_cron(expr: str) -> list[set[int]]:
    fields = expr.split()
    if len(fields) != 5:
        raise CronError("cron 表達式必須是 5 個欄位（分 時 日 月 週）")
    sets = [_parse_field(f, lo, hi) for f, (lo, hi) in zip(fields, _RANGES)]
    if 7 in sets[4]:
        sets[4].add(0)
    return sets


def matches(expr: str, dt: datetime) -> bool:
    m, h, dom, mon, dow = parse_cron(expr)
    return dt.minute in m and dt.hour in h and dt.day in dom and dt.month in mon and (dt.weekday() + 1) % 7 in dow


def next_run(expr: str, after: datetime) -> datetime:
    """First minute strictly after `after` that matches. Searches up to ~2 years."""
    parse_cron(expr)
    t = after.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(366 * 24 * 60 * 2):
        if matches(expr, t):
            return t
        t += timedelta(minutes=1)
    raise CronError("找不到下一次執行時間")
