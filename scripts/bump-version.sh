#!/usr/bin/env bash
# 把版號寫進三個宣告處，讓 wheel／API／前端一致。
# 用法：scripts/bump-version.sh 0.2.0   （不帶 v 前綴）
set -euo pipefail
V="${1:?用法: scripts/bump-version.sh X.Y.Z}"
V="${V#v}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]] || { echo "版號格式不對: $V"; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 - "$ROOT" "$V" <<'PY'
import pathlib, re, sys
root, v = pathlib.Path(sys.argv[1]), sys.argv[2]
targets = [
    (root/'server/pyproject.toml', r'(?m)^version\s*=\s*"[^"]+"', f'version = "{v}"'),
    (root/'server/studio/__init__.py', r'(?m)^__version__\s*=\s*"[^"]+"', f'__version__ = "{v}"'),
    (root/'web/package.json', r'("version"\s*:\s*)"[^"]+"', rf'\g<1>"{v}"'),
]
for p, pat, rep in targets:
    s = p.read_text()
    new, n = re.subn(pat, rep, s, count=1)
    if n != 1:
        sys.exit(f'!! {p} 找不到版號欄位')
    p.write_text(new)
    print(f'  {p.relative_to(root)} -> {v}')
PY
echo "版號已同步為 $V"
