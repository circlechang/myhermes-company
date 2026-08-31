#!/usr/bin/env python3
"""脫離式更新器：等舊伺服器退場 → pip 裝新 wheel → 起新版；裝失敗就用舊版起回來。

**這支刻意寫成「只用標準函式庫、不 import studio」的單檔腳本。**
`/admin/update/start` 在 spawn 之前會把這個檔案複製到
``<MHC_HOME>/updates/<job>/updater.py`` 再用 ``sys.executable`` 執行，
所以等一下 pip 把 ``studio`` 套件整個換掉時，正在跑的更新器不會被扯到。

流程（每一步都寫進 ``<MHC_HOME>/update-status.json``）：

1. ``installing`` 之前先等父程序（舊 server pid）退出：輪詢最多 60 秒，
   逾時就自己送一次 SIGTERM，再等 30 秒；還在就 SIGKILL。
2. ``<python> -m pip install --upgrade <wheel>``；venv 沒有 pip（uv 建的）時
   退回 ``uv pip install --python <python> --upgrade <wheel>``。
3. 成功 → ``<python> -m studio start --daemon --port <port> --host <host>``（新版）。
   pip 失敗 → **一樣把服務起回來**（pip 的 upgrade 失敗不會動到已安裝版本，舊版仍可用），
   狀態記 ``failed`` 並附上原因。

測試用的注入點（env，值是 JSON 陣列）：
``MHC_UPDATER_PIP``   取代 pip 指令（wheel 路徑會被接在最後）
``MHC_UPDATER_START`` 取代啟動指令（原樣執行）
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

WAIT_EXIT_SECONDS = 60.0
WAIT_AFTER_TERM_SECONDS = 30.0
PIP_TIMEOUT = 900.0
START_TIMEOUT = 180.0


# ---------------------------------------------------------------- 小工具

def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def log(msg: str) -> None:
    print(f"[{_now()}] {msg}", flush=True)


def write_status(path: Path, **fields: Any) -> dict[str, Any]:
    """把 fields 併進 update-status.json（原子寫：先寫 .tmp 再 os.replace）。"""
    data: dict[str, Any] = {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data.update({k: v for k, v in fields.items() if v is not None})
    data["updated_at"] = _now()
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as e:
        log(f"寫不了狀態檔 {path}：{e}")
    return data


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for_exit(pid: int, timeout: float = WAIT_EXIT_SECONDS) -> bool:
    """等 pid 消失。逾時回 False（呼叫端自己決定要不要送訊號）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.2)
    return not pid_alive(pid)


def ensure_gone(pid: int) -> bool:
    """先禮（等）後兵（SIGTERM → SIGKILL）。回傳最後是不是真的沒了。"""
    if pid <= 0:
        return True
    if wait_for_exit(pid, WAIT_EXIT_SECONDS):
        log(f"舊伺服器 pid {pid} 已退場")
        return True
    log(f"等了 {WAIT_EXIT_SECONDS:.0f} 秒 pid {pid} 還在，送 SIGTERM")
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError as e:
        log(f"送 SIGTERM 失敗（可能已經沒了）：{e}")
    if wait_for_exit(pid, WAIT_AFTER_TERM_SECONDS):
        return True
    log(f"還在，送 SIGKILL 給 pid {pid}")
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    return wait_for_exit(pid, 10.0)


def _env_argv(name: str) -> Optional[list[str]]:
    raw = os.environ.get(name, "")
    if not raw:
        return None
    try:
        v = json.loads(raw)
    except ValueError:
        return None
    return [str(x) for x in v] if isinstance(v, list) and v else None


def run(argv: list[str], timeout: float, cwd: Optional[str] = None) -> tuple[int, str]:
    log("$ " + " ".join(argv))
    try:
        p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    except FileNotFoundError as e:
        return 127, f"找不到執行檔：{e}"
    except subprocess.TimeoutExpired:
        return 124, f"逾時（{timeout:.0f}s）"
    out = (p.stdout or "") + (p.stderr or "")
    if out.strip():
        print(out.rstrip(), flush=True)
    return p.returncode, out


# ---------------------------------------------------------------- 安裝

def has_pip(python: str) -> bool:
    try:
        return subprocess.run([python, "-m", "pip", "--version"],
                              capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def install_argv(python: str, wheel: str) -> Optional[list[str]]:
    """pip 優先；venv 沒有 pip（uv 建的）就退回 uv。都沒有回 None。"""
    override = _env_argv("MHC_UPDATER_PIP")
    if override:
        return override + [wheel]
    if has_pip(python):
        return [python, "-m", "pip", "install", "--upgrade", wheel]
    uv = shutil.which("uv")
    if uv:
        return [uv, "pip", "install", "--python", python, "--upgrade", wheel]
    return None


def install(python: str, wheel: str) -> tuple[bool, str]:
    argv = install_argv(python, wheel)
    if argv is None:
        return False, f"{python} 沒有 pip，PATH 上也找不到 uv，無法安裝"
    code, out = run(argv, PIP_TIMEOUT)
    if code == 0:
        return True, out[-2000:]
    return False, f"安裝失敗（exit {code}）：\n{out[-2000:]}"


# ---------------------------------------------------------------- 啟動

def start_argv(python: str, port: Optional[int], host: str) -> list[str]:
    override = _env_argv("MHC_UPDATER_START")
    if override:
        return override
    argv = [python, "-m", "studio", "start", "--daemon"]
    if port:
        argv += ["--port", str(port)]
    if host:
        argv += ["--host", host]
    return argv


def start_server(python: str, home: Path, port: Optional[int], host: str) -> tuple[bool, str]:
    code, out = run(start_argv(python, port, host), START_TIMEOUT, cwd=str(home))
    return code == 0, out[-2000:]


# ---------------------------------------------------------------- main

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mhc-updater", description="MyHermesCompany 脫離式更新器")
    p.add_argument("--home", required=True, help="MHC_HOME")
    p.add_argument("--wheel", required=True, help="已下載並驗證過的 wheel 路徑")
    p.add_argument("--status", default="", help="狀態檔（預設 <home>/update-status.json）")
    p.add_argument("--pid", type=int, default=0, help="舊伺服器 pid，等它退場")
    p.add_argument("--port", type=int, default=0)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--job", default="")
    p.add_argument("--from", dest="from_version", default="")
    p.add_argument("--to", dest="to_version", default="")
    p.add_argument("--python", default="", help="要裝進哪個 python（預設 sys.executable）")
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    home = Path(args.home).expanduser()
    status = Path(args.status) if args.status else home / "update-status.json"
    python = args.python or sys.executable
    common = {"job_id": args.job or None, "from": args.from_version or None,
              "to": args.to_version or None}

    log(f"更新器啟動：job={args.job} {args.from_version} → {args.to_version}")
    log(f"  wheel={args.wheel}  python={python}  home={home}")

    if args.pid and not ensure_gone(args.pid):
        write_status(status, phase="failed", error=f"舊伺服器 pid {args.pid} 停不掉，沒有動安裝",
                     finished_at=_now(), **common)
        log("舊伺服器停不掉，放棄（沒有動到安裝）")
        return 1

    write_status(status, phase="installing", error="", **common)
    ok, detail = install(python, args.wheel)

    if ok:
        write_status(status, phase="restarting", **common)
    else:
        log("安裝失敗，改用舊版把服務起回來")
        write_status(status, phase="restarting", error=detail, install_failed=True, **common)

    started, out = start_server(python, home, args.port or None, args.host)
    if not started:
        write_status(status, phase="failed", finished_at=_now(),
                     error=((detail + "\n") if not ok else "") + f"重啟失敗：\n{out}", **common)
        log("重啟失敗")
        return 1
    if not ok:
        write_status(status, phase="failed", finished_at=_now(), restarted_old=True,
                     error=detail, **common)
        log("已用舊版重新啟動；安裝失敗的原因寫在狀態檔")
        return 1

    write_status(status, phase="done", finished_at=_now(), error="", **common)
    log(f"完成：已更新到 {args.to_version or '新版'} 並重新啟動")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
