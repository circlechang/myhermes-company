#!/usr/bin/env bash
# Hermes 接觸面契約測試：myhermescompany hermes-check 的 shell 包裝。
# 用法：scripts/hermes-contract.sh [--json] [--writes] [--only id,id]
# exit：0 相容、1 部分相容、2 不相容、3 跑不起來
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="${STUDIO_PYTHON:-$ROOT/server/.venv/bin/python}"
[ -x "$PY" ] || PY=python3
cd "$ROOT/server"
exec "$PY" -m studio.modules.compat hermes-check "$@"
