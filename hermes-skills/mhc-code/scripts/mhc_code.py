#!/usr/bin/env python3
"""mhc-code skill 腳本：把工程任務派給 MyHermesCompany 的 coding 員工。只用標準函式庫。

    mhc_code.py agents [--text]
    mhc_code.py run <agent> "<任務>" [--workspace /allowed/path] [--timeout 600] [--text]
    mhc_code.py status <job_id> [--text]
    mhc_code.py diff <job_id> [--text]

token 來源（依序）：MHC_CODE_TOKEN → MHC_SEARCH_TOKEN → $HERMES_HOME/profiles/$HERMES_PROFILE/.env → ~/.hermes/.env。
派工作需要 owner 發的**可寫** token（POST /search/tokens {"can_write": true}）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8700"
POLL_SECONDS = 2.0


def _read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip().removeprefix("export ").strip()] = v.strip().strip('"').strip("'")
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
    for k in ("MHC_STUDIO_URL", "MHC_CODE_TOKEN", "MHC_SEARCH_TOKEN"):
        if os.environ.get(k):
            merged[k] = os.environ[k]
    token = merged.get("MHC_CODE_TOKEN") or merged.get("MHC_SEARCH_TOKEN") or ""
    return merged.get("MHC_STUDIO_URL") or DEFAULT_URL, token


def call(url: str, token: str, path: str, *, params: dict | None = None, body: dict | None = None):
    full = f"{url.rstrip('/')}{path}"
    if params:
        full += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {token}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(full, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        code = ""
        try:
            code = (json.loads(raw).get("error") or {}).get("code", "")
        except Exception:
            pass
        print(f"HTTP {e.code}{(' ' + code) if code else ''}: {raw[:400]}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"連不到 Studio（{url}）：{e.reason}", file=sys.stderr)
        sys.exit(1)


def _fmt_changes(changes: list) -> str:
    if not changes:
        return "（沒有檔案被改動）"
    mine = [c for c in changes if not c.get("preexisting")]
    old = [c for c in changes if c.get("preexisting")]
    lines = [f"  {c['path']}  +{c['added']} -{c['removed']}" for c in mine] or ["  （這次沒有新的檔案改動）"]
    if old:
        lines.append("  ── 以下是開工前工作區就已經有的改動，不是這次做的 ──")
        lines += [f"  {c['path']}  +{c['added']} -{c['removed']}" for c in old]
    return "\n".join(lines)


def print_job(job: dict) -> None:
    print(f"job {job['id']} · {job['agent']}（{job['runtime']}）· {job['status']}")
    print(f"工作目錄：{job['workspace']}")
    if job.get("output"):
        print(f"\n[它說]\n{job['output'][:4000]}")
    if job.get("error"):
        print(f"\n[錯誤]\n{job['error'][:2000]}")
    print(f"\n[檔案改動]\n{_fmt_changes(job.get('changes') or [])}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mhc_code.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("agents")
    a.add_argument("--text", action="store_true")
    r = sub.add_parser("run")
    r.add_argument("agent")
    r.add_argument("task")
    r.add_argument("--workspace", default="")
    r.add_argument("--timeout", type=float, default=600.0)
    r.add_argument("--text", action="store_true")
    s = sub.add_parser("status")
    s.add_argument("job_id")
    s.add_argument("--text", action="store_true")
    d = sub.add_parser("diff")
    d.add_argument("job_id")
    d.add_argument("--text", action="store_true")
    args = ap.parse_args(argv)

    url, token = settings()
    if not token:
        print("no token：請 owner 在 Studio 用 POST /search/tokens {\"can_write\": true} 發可寫 token，"
              "寫進 ~/.hermes/.env 的 MHC_CODE_TOKEN（不要貼到對話）", file=sys.stderr)
        return 2

    if args.cmd == "agents":
        rows = call(url, token, "/coding/staff")
        if args.text:
            if not rows:
                print("目前沒有 coding 員工（可以在 Studio 的 /agents 頁建立）")
            for x in rows:
                flags = []
                if not x["installed"]:
                    flags.append("CLI 未安裝")
                if not x["enabled"]:
                    flags.append("停用中")
                print(f"- {x['name']}（{x['runtime']}）{' ⚠ ' + '／'.join(flags) if flags else ''}\n    {x['workspace']}  id={x['id']}")
        else:
            print(json.dumps(rows, ensure_ascii=False))
        return 0

    if args.cmd == "run":
        payload = {"task": args.task, "workspace": args.workspace,
                   "timeout_seconds": max(30.0, min(args.timeout, 3600.0))}
        payload["agent_id" if args.agent.startswith("ag_") else "agent"] = args.agent
        job = call(url, token, "/coding/jobs", body=payload)
        deadline = time.monotonic() + args.timeout
        while not job.get("done"):
            if time.monotonic() > deadline:
                job["status"] = "timeout_waiting"
                break
            time.sleep(POLL_SECONDS)
            job = call(url, token, f"/coding/jobs/{job['id']}")
        if args.text:
            print_job(job)
            if job["status"] == "timeout_waiting":
                print(f"\n（等超過 {args.timeout:.0f} 秒，任務還在跑；稍後用 status {job['id']} 再查）")
        else:
            print(json.dumps({"job": job["id"], "status": job["status"], "output": job.get("output", ""),
                              "error": job.get("error", ""), "changes": job.get("changes", []),
                              "files": job.get("files", []), "workspace": job.get("workspace", "")},
                             ensure_ascii=False))
        return 0 if job.get("status") == "completed" else 1

    if args.cmd == "status":
        job = call(url, token, f"/coding/jobs/{args.job_id}")
        if args.text:
            print_job(job)
        else:
            print(json.dumps(job, ensure_ascii=False, default=str))
        return 0

    data = call(url, token, f"/coding/jobs/{args.job_id}/diff")
    if args.text:
        print(f"工作目錄：{data['workspace']}")
        print(_fmt_changes(data.get("changes") or []))
        print("\n" + (data.get("diff") or "（沒有 diff）"))
    else:
        print(json.dumps(data, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
