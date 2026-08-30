"""CLI 入口：`python -m studio.modules.compat hermes-check [--json] [--writes] [--only id,id]`
（也可用 `myhermescompany hermes-check`，cli.py 只是轉呼叫這裡；scripts/hermes-contract.sh 包同一層。）

exit code：0 相容、1 部分相容、2 不相容、3 跑不起來。
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Optional

from ...config import Settings
from ...hermes import contract


def _print_human(rep: dict) -> None:
    h, s = rep["hermes"], rep["summary"]
    verdict = {"compatible": "相容", "partial": "部分相容", "incompatible": "不相容"}.get(s["verdict"], s["verdict"])
    print(f"Hermes {h.get('version') or '?'}（CLI {h.get('cli_version') or '?'}，{h.get('date') or '?'}）  {h.get('api_url')}  home={h.get('home')}")
    print(f"判定：{verdict}   pass {s['pass']} / fail {s['fail']} / skip {s['skip']}（共 {s['total']}，{rep['duration_ms'] / 1000:.1f}s）"
          + ("" if rep["mode"].get("writes") else "   ※ 未含會建資料的 live 呼叫（--writes 開）"))
    for it in rep["items"]:
        mark = {"pass": "✓", "fail": "✗", "skip": "–"}[it["status"]]
        line = f" {mark} [{it['risk']:<6}] {it['id']:<28} {it['label']}"
        if it["status"] != "pass" or it["reason"]:
            line += f"  — {it['reason']}"
        print(line)
    if s["affected_modules"]:
        print("受影響模組：")
        for m in s["affected_modules"]:
            print(f"  - {m['module']}: {', '.join(m['failed'])}")
    if rep.get("cleanups"):
        print("已清理：" + ", ".join(rep["cleanups"]))


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="python -m studio.modules.compat")
    sub = p.add_subparsers(dest="cmd")
    c = sub.add_parser("hermes-check", help="對本機 Hermes 跑接觸面契約測試")
    c.add_argument("--json", action="store_true", help="輸出完整 JSON 報告")
    c.add_argument("--writes", action="store_true", help="允許會建資料的 live 呼叫（建完會清掉：run stop／job delete／task archive）")
    c.add_argument("--only", help="只跑這些 id（逗號分隔）")
    c.add_argument("--home", help="HERMES_HOME（預設 env 或 ~/.hermes）")
    c.add_argument("--api-url", help="gateway URL（預設 HERMES_API_URL 或 http://127.0.0.1:8642）")
    c.add_argument("--bin", help="hermes 執行檔")
    s = sub.add_parser("surface", help="列出接觸面清單")
    s.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    if not args.cmd:
        p.print_help()
        return 3
    if args.cmd == "surface":
        surf = contract.load_surface()
        if args.json:
            print(json.dumps([i.raw for i in surf.items], ensure_ascii=False, indent=1))
        else:
            for i in surf.items:
                print(f"[{i.kind:<8}][{i.risk:<6}] {i.id:<28} {i.label}  → {', '.join(i.affects)}")
        return 0
    settings = Settings.from_env()
    try:
        rep = contract.run(args.home or settings.hermes_home, args.api_url or settings.hermes_api_url, settings.hermes_api_key,
                           hermes_bin=args.bin or settings.hermes_bin, writes=args.writes,
                           only=[x.strip() for x in args.only.split(",")] if args.only else None)
    except Exception as e:  # noqa: BLE001
        print(f"跑不起來：{e}", file=sys.stderr)
        return 3
    if args.json:
        print(json.dumps(rep, ensure_ascii=False, indent=1, default=str))
    else:
        _print_human(rep)
    return {"compatible": 0, "partial": 1, "incompatible": 2}.get(rep["summary"]["verdict"], 3)


if __name__ == "__main__":
    sys.exit(main())
