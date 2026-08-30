"""Structured condition evaluation for condition / loop nodes."""
from __future__ import annotations

import json
import re
from typing import Any


def json_path_get(data: Any, path: str) -> Any:
    """Tiny json path: `a.b[0].c` or `$.a.b`. Returns None when missing."""
    path = path.strip()
    if path.startswith("$"):
        path = path[1:]
    cur = data
    for token in re.findall(r"[^.\[\]]+|\[\d+\]", path):
        if token.startswith("["):
            idx = int(token[1:-1])
            if isinstance(cur, list) and 0 <= idx < len(cur):
                cur = cur[idx]
            else:
                return None
        else:
            if isinstance(cur, dict) and token in cur:
                cur = cur[token]
            else:
                return None
    return cur


def _extract_json(text: str) -> Any:
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    m = re.search(r"[\[{].*[\]}]", text, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    return None


def evaluate_rule(rule: dict[str, Any], text: str) -> tuple[bool, str]:
    """Return (result, explanation)."""
    op = rule.get("op")
    value = rule.get("value")
    text = text or ""
    if op == "contains":
        ok = str(value) in text
        return ok, f"contains {value!r} → {ok}"
    if op == "not_contains":
        ok = str(value) not in text
        return ok, f"not_contains {value!r} → {ok}"
    if op == "equals":
        ok = text.strip() == str(value).strip()
        return ok, f"equals {value!r} → {ok}"
    if op == "regex":
        try:
            ok = re.search(str(value), text, re.S | re.I) is not None
        except re.error as e:
            return False, f"regex 錯誤: {e}"
        return ok, f"regex /{value}/ → {ok}"
    if op == "min_length":
        n = len(text.strip())
        ok = n >= int(value)
        return ok, f"len={n} ≥ {value} → {ok}"
    if op == "max_length":
        n = len(text.strip())
        ok = n <= int(value)
        return ok, f"len={n} ≤ {value} → {ok}"
    if op == "json_path":
        data = _extract_json(text)
        if data is None:
            return False, "上游輸出不是 JSON"
        got = json_path_get(data, str(rule.get("path") or ""))
        if value in (None, ""):
            ok = got not in (None, "", False, 0, [], {})
            return ok, f"{rule.get('path')} = {got!r} → {ok}"
        got_s = json.dumps(got, ensure_ascii=False) if isinstance(got, (bool, int, float, list, dict)) or got is None else str(got)
        ok = got_s.strip().lower() == str(value).strip().lower()
        return ok, f"{rule.get('path')} = {got!r} == {value!r} → {ok}"
    return False, f"未知運算子 {op}"


def parse_yes_no(text: str) -> bool | None:
    t = (text or "").strip().lower()
    if not t:
        return None
    head = t[:40]
    for token, val in (("yes", True), ("no", False), ("true", True), ("false", False), ("是", True), ("否", False), ("通過", True), ("不通過", False)):
        if head.startswith(token):
            return val
    m = re.search(r"\b(yes|no|true|false)\b", t)
    if m:
        return m.group(1) in ("yes", "true")
    if "是" in head and "不是" not in head and "否" not in head:
        return True
    if "否" in head or "不是" in head:
        return False
    return None
