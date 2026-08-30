#!/usr/bin/env bash
# 一條龍：build web → 落到 server/studio/web_dist/ → build wheel（含 web_dist）
# 用法：scripts/build-all.sh [--skip-web]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" != "--skip-web" ]]; then
  echo "== web: npm ci + build (outDir=server/studio/web_dist)"
  (cd web && npm ci --no-audit --no-fund && npm run build)
fi
test -f server/studio/web_dist/index.html || { echo "web_dist/index.html 不存在"; exit 1; }

echo "== server: build wheel"
PY="${PYTHON:-$ROOT/server/.venv/bin/python}"
[[ -x "$PY" ]] || PY="$(command -v python3)"
rm -rf server/dist server/build
"$PY" -m pip install -q --disable-pip-version-check build >/dev/null
(cd server && "$PY" -m build --wheel --outdir dist)
WHEEL="$(ls server/dist/*.whl | head -1)"
echo "== wheel: $WHEEL"
"$PY" - "$WHEEL" <<'PYEOF'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
assert any(n.endswith("studio/web_dist/index.html") for n in names), "wheel 沒有包進 web_dist"
print(f"   web_dist files in wheel: {sum('web_dist/' in n for n in names)}")
PYEOF
echo "== done"
