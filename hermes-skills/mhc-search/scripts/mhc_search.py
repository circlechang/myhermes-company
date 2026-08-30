#!/usr/bin/env python3
"""mhc-search skill 腳本：打 MyHermesCompany Studio 唯讀 API。只用標準函式庫。

    mhc_search.py search "文案" [--scope all] [--since 7d] [--until 2026-09-01] [--agent researcher] [--limit 20] [--text]
    mhc_search.py events [--kind approval.*] [--subject run:wr_x] [--source workflow] [--agent researcher] [--since 3d] [--limit 50] [--text]
    mhc_search.py chain <event_id> [--depth 10] [--text]

token 來源（依序）：環境變數 MHC_SEARCH_TOKEN → $HERMES_HOME/profiles/$HERMES_PROFILE/.env → ~/.hermes/.env。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8700"


def _read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip().removeprefix("export ").strip()
            out[k] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def settings() -> tuple[str, str]:
    home = Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser()
    profile = os.environ.get("HERMES_PROFILE", "")
    merged: dict[str, str] = {}
    for p in (home / ".env", home / "profiles" / profile / ".env" if profile else None):
        if p is not None:
            merged.update(_read_env(p))
    for k in ("MHC_STUDIO_URL", "MHC_SEARCH_TOKEN"):
        if os.environ.get(k):
            merged[k] = os.environ[k]
    return merged.get("MHC_STUDIO_URL") or DEFAULT_URL, merged.get("MHC_SEARCH_TOKEN") or ""


def rel_time(s: str | None) -> str | None:
    if not s:
        return None
    m = re.fullmatch(r"(\d+)([hdw])", s.strip())
    if not m:
        return s
    n, unit = int(m.group(1)), m.group(2)
    delta = {"h": timedelta(hours=n), "d": timedelta(days=n), "w": timedelta(weeks=n)}[unit]
    return (datetime.now(timezone.utc).replace(tzinfo=None) - delta).replace(microsecond=0).isoformat()


def call(url: str, token: str, path: str, params: dict) -> dict:
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    req = urllib.request.Request(f"{url.rstrip('/')}{path}?{qs}", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")
        print(f"HTTP {e.code}: {body[:300]}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"連不到 Studio（{url}）：{e.reason}", file=sys.stderr)
        sys.exit(1)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mhc_search.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("search")
    s.add_argument("q")
    s.add_argument("--scope", default="all")
    s.add_argument("--since")
    s.add_argument("--until")
    s.add_argument("--agent")
    s.add_argument("--limit", type=int, default=20)
    s.add_argument("--text", action="store_true")
    e = sub.add_parser("events")
    e.add_argument("--kind")
    e.add_argument("--subject")
    e.add_argument("--source")
    e.add_argument("--agent")
    e.add_argument("--since")
    e.add_argument("--until")
    e.add_argument("--q")
    e.add_argument("--limit", type=int, default=50)
    e.add_argument("--text", action="store_true")
    c = sub.add_parser("chain")
    c.add_argument("event_id")
    c.add_argument("--depth", type=int, default=10)
    c.add_argument("--text", action="store_true")
    a = ap.parse_args(argv)

    url, token = settings()
    if not token:
        print("no token：請 owner 在 Studio 用 POST /search/tokens 發唯讀 token，寫進 ~/.hermes/.env 的 MHC_SEARCH_TOKEN（不要貼到對話）", file=sys.stderr)
        return 2

    if a.cmd == "search":
        data = call(url, token, "/search", {"q": a.q, "scope": a.scope, "from": rel_time(a.since), "to": a.until, "agent": a.agent, "limit": a.limit})
        if a.text:
            print(f"「{a.q}」共 {data.get('total', 0)} 筆（scope={','.join(data.get('scopes', []))}）")
            for it in data.get("items", []):
                print(f"- [{it['scope']}] {it.get('ts', '')[:19]} {it.get('title', '')} {('@' + it['agent']) if it.get('agent') else ''}\n    {it.get('snippet', '')}\n    → {it.get('link', '')}")
        else:
            print(json.dumps({"total": data.get("total", 0), "items": data.get("items", [])}, ensure_ascii=False))
    elif a.cmd == "events":
        data = call(url, token, "/events", {"kind": a.kind, "subject": a.subject, "source": a.source, "agent": a.agent,
                                            "since": rel_time(a.since), "until": a.until, "q": a.q, "limit": a.limit})
        if a.text:
            print(f"共 {data.get('total', 0)} 筆")
            for ev in data.get("items", []):
                print(f"- #{ev.get('seq')} {str(ev.get('ts', ''))[:19]} {ev['kind']} {ev.get('subject', '')} {ev.get('decision', '')} id={ev['id']}")
        else:
            print(json.dumps(data, ensure_ascii=False, default=str))
    else:
        data = call(url, token, f"/events/{urllib.parse.quote(a.event_id)}/chain", {"depth": a.depth})
        if a.text:
            ev = data["event"]
            print(f"事件 #{ev.get('seq')} {ev['kind']} {ev.get('subject', '')}")
            for u in data.get("upstream", []):
                print(f"  ← #{u.get('seq')} {u['kind']} {u.get('subject', '')} ({str(u.get('ts', ''))[:19]})")
            for d in data.get("downstream", []):
                print(f"  → #{d.get('seq')} {d['kind']} {d.get('subject', '')} ({str(d.get('ts', ''))[:19]})")
        else:
            print(json.dumps(data, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
