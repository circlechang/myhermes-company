"""站內一鍵更新（owner 限定）：`POST /admin/update/start`、`GET /admin/update/status`。

安全順序刻意是「先下載再動手」：

1. **擋掉不該更新的環境**：`pip install -e` 的開發安裝直接 409，叫人 git pull。
2. **下載＋驗證**（`downloading`）：檔名要是合法 wheel、發行名要是 myhermescompany、
   版號要跟 release 對得上、檔案要是能通過 CRC 的 zip、裡面要有 `studio/`、
   dist-info 的 `Version:` 也要對、大小在合理範圍。
   **這一段任何一項不過就直接回錯，完全不碰現有安裝。**
3. **脫離的更新器**：把 `studio/updater.py` 複製一份到 job 目錄，用 `start_new_session=True`
   spawn 出去（stdout/stderr → `<MHC_HOME>/logs/update-<ts>.log`），API 立刻回 `{job_id,...}`。
4. **回應送出後才自己退場**：`call_later` 送 SIGTERM 給自己，走 uvicorn 的優雅關機
   →`lifespan` 的 `on_shutdown` → 工作流 `park()`（等待中的閘門不會被標成取消）。

進度一律寫檔（`<MHC_HOME>/update-status.json`），不放記憶體：伺服器中途會被換掉，
記憶體狀態一定會不見；前端重新整理後還要看得到。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ... import __version__ as STUDIO_VERSION
from ... import updater as updater_mod
from ... import update as studio_update
from ...auth import Principal, current_principal
from ...config import data_home
from ...errors import ApiError

router = APIRouter(tags=["admin"])

DIST_NAME = "myhermescompany"
MIN_WHEEL_BYTES = 10 * 1024
MAX_WHEEL_BYTES = 200 * 1024 * 1024
SHUTDOWN_DELAY = float(os.environ.get("MHC_UPDATE_SHUTDOWN_DELAY", "1.0"))

# PEP 427：{dist}-{ver}(-{build})?-{py}-{abi}-{plat}.whl
WHEEL_RE = re.compile(
    r"^(?P<dist>[A-Za-z0-9][A-Za-z0-9._]*)-(?P<ver>[0-9][A-Za-z0-9._+!]*)"
    r"(?:-(?P<build>[0-9][A-Za-z0-9._]*))?"
    r"-(?P<py>[A-Za-z0-9._]+)-(?P<abi>[A-Za-z0-9._]+)-(?P<plat>[A-Za-z0-9._]+)\.whl$")


# ------------------------------------------------------------------ 小工具

def _norm_dist(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).strip().lower()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def require_owner(p: Principal) -> None:
    if p.role != "owner":
        raise ApiError(403, "forbidden", "一鍵更新僅 owner 可用")


def home_dir() -> Path:
    return data_home()


def status_file(home: Optional[Path] = None) -> Path:
    return (home or home_dir()) / "update-status.json"


def read_status(home: Optional[Path] = None) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(status_file(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_status(home: Optional[Path], **fields: Any) -> dict[str, Any]:
    """與 updater.write_status 同一份實作（合併＋原子寫），避免兩邊格式漂移。"""
    return updater_mod.write_status(status_file(home), **fields)


# ------------------------------------------------------------------ 安裝型態

def editable_reason() -> Optional[str]:
    """這是不是 `pip install -e` / 直接從原始碼跑？是的話回一句人看得懂的理由。

    三道都查，因為單一來源都會漏：
    1. `direct_url.json` 的 `dir_info.editable`（pip 官方標記；但 cwd 有 egg-info 時會被蓋掉）
    2. 套件檔案不在 site-packages／dist-packages 底下（＝直接從原始碼樹 import）
    3. 套件根目錄旁邊就有 pyproject.toml（原始碼 checkout）
    """
    try:
        import importlib.metadata as md

        raw = md.distribution(DIST_NAME).read_text("direct_url.json")
        if raw:
            info = json.loads(raw)
            if (info.get("dir_info") or {}).get("editable"):
                return f"可編輯安裝（pip install -e {info.get('url', '')}）"
    except Exception:  # noqa: BLE001 — 查不到就往下用檔案結構判斷
        pass
    try:
        pkg = Path(__file__).resolve().parents[2]      # …/studio
        root = pkg.parent                              # 裝好是 site-packages；開發是 server/
        if not any(part in ("site-packages", "dist-packages") for part in root.parts):
            return f"套件不在 site-packages 底下，看起來是直接跑原始碼（{pkg}）"
        if (root / "pyproject.toml").exists():
            return f"直接從原始碼目錄執行（{root}）"
    except Exception:  # noqa: BLE001
        pass
    return None


def install_info() -> dict[str, Any]:
    reason = editable_reason()
    return {"editable": reason is not None, "editable_reason": reason,
            "install_hint": "這是開發安裝，請用 git pull 後重啟" if reason else None}


# ------------------------------------------------------------------ wheel 驗證

def check_wheel_name(name: str, expect_version: str) -> tuple[str, str]:
    """檔名來自 GitHub，是不可信輸入。回 (dist_token, version)；不合法就丟 ApiError。"""
    if not name or name != os.path.basename(name) or name.startswith(".") \
            or "/" in name or "\\" in name or name in (".", ".."):
        raise ApiError(422, "bad_wheel", f"wheel 檔名不合法：{name!r}")
    m = WHEEL_RE.match(name)
    if not m:
        raise ApiError(422, "bad_wheel", f"不是合法的 wheel 檔名：{name!r}")
    if _norm_dist(m.group("dist")) != DIST_NAME:
        raise ApiError(422, "bad_wheel", f"wheel 不是 {DIST_NAME}：{name!r}")
    if m.group("ver") != expect_version:
        raise ApiError(422, "bad_wheel",
                       f"wheel 版號 {m.group('ver')} 與 release {expect_version} 不符")
    return m.group("dist"), m.group("ver")


def _metadata_version(zf: zipfile.ZipFile, dist_token: str, version: str) -> Optional[str]:
    want = f"{dist_token}-{version}.dist-info/METADATA"
    if want not in zf.namelist():
        return None
    for line in zf.read(want).decode("utf-8", "replace").splitlines():
        if line.lower().startswith("version:"):
            return line.split(":", 1)[1].strip()
    return None


def verify_wheel(path: Path, dist_token: str, version: str) -> int:
    """檔案落地後的第二道：大小 → 是 zip → CRC → 內容物 → dist-info 版號。回檔案大小。"""
    try:
        size = path.stat().st_size
    except OSError as e:
        raise ApiError(502, "download_failed", f"下載後讀不到檔案：{e}")
    if size < MIN_WHEEL_BYTES:
        raise ApiError(422, "bad_wheel", f"wheel 太小（{size} bytes），像是下載到錯誤頁")
    if size > MAX_WHEEL_BYTES:
        raise ApiError(422, "bad_wheel", f"wheel 太大（{size} bytes），超過 {MAX_WHEEL_BYTES} 上限")
    if not zipfile.is_zipfile(path):
        raise ApiError(422, "bad_wheel", "下載到的檔案不是合法的 zip（wheel）")
    try:
        with zipfile.ZipFile(path) as zf:
            broken = zf.testzip()
            if broken:
                raise ApiError(422, "bad_wheel", f"wheel 內容毀損（CRC 不符）：{broken}")
            names = zf.namelist()
            if not any(n.startswith("studio/") for n in names):
                raise ApiError(422, "bad_wheel", "wheel 裡沒有 studio/ 套件，不是這個產品的 wheel")
            meta = _metadata_version(zf, dist_token, version)
    except zipfile.BadZipFile as e:
        raise ApiError(422, "bad_wheel", f"wheel 讀不開：{e}")
    if meta is None:
        raise ApiError(422, "bad_wheel", f"wheel 缺少 {dist_token}-{version}.dist-info/METADATA")
    if meta != version:
        raise ApiError(422, "bad_wheel", f"wheel 內部版號 {meta} 與檔名 {version} 不符")
    return size


# ------------------------------------------------------------------ job 目錄

def jobs_dir(home: Path) -> Path:
    return home / "updates"


def prune_jobs(home: Path, keep: int = 3) -> None:
    root = jobs_dir(home)
    try:
        dirs = sorted((d for d in root.iterdir() if d.is_dir()), key=lambda d: d.stat().st_mtime)
    except OSError:
        return
    for d in dirs[:-keep] if keep else dirs:
        shutil.rmtree(d, ignore_errors=True)


def _server_port_host(request: Request, home: Path) -> tuple[Optional[int], str]:
    """重啟要用「現在真的在跑的」port/host：先讀 pid 檔，讀不到才退回 settings。"""
    from ...cli import pid_file, read_meta

    meta = read_meta(pid_file(home))
    st = getattr(request.app.state, "settings", None)
    port = meta.get("port")
    host = meta.get("host")
    return (int(port) if port and port.isdigit() else (getattr(st, "port", None) or None),
            host or getattr(st, "host", "") or "127.0.0.1")


# ------------------------------------------------------------------ 退場

def _request_shutdown(delay: float = SHUTDOWN_DELAY) -> None:
    """回應送出去之後才停：延遲送 SIGTERM 給自己，走 uvicorn 的優雅關機。

    測試會把整個函式換掉——不然 pytest 自己會被 SIGTERM 掉。
    """
    def _fire() -> None:
        os.kill(os.getpid(), signal.SIGTERM)

    try:
        asyncio.get_running_loop().call_later(delay, _fire)
    except RuntimeError:  # 沒有 event loop（同步情境）
        _fire()


# ------------------------------------------------------------------ 端點

class UpdateStart(BaseModel):
    to: Optional[str] = None  # 前端把畫面上看到的版本帶回來；跟 release 不符就拒絕


@router.get("/admin/update/status")
def update_status(request: Request, p: Principal = Depends(current_principal)):
    """讀 update-status.json——伺服器被換掉過也還在，重新整理後仍看得到進度。"""
    require_owner(p)
    home = home_dir()
    return {"job": read_status(home), "current": STUDIO_VERSION,
            "status_file": str(status_file(home)), **install_info()}


@router.post("/admin/update/start")
async def update_start(body: UpdateStart, request: Request,
                       p: Principal = Depends(current_principal)):
    require_owner(p)
    info = install_info()
    if info["editable"]:
        raise ApiError(409, "editable_install",
                       f"{info['install_hint']}（偵測到：{info['editable_reason']}）")

    running = read_status()
    if running and running.get("phase") in ("downloading", "installing", "restarting"):
        started = running.get("started_at") or ""
        raise ApiError(409, "busy", f"已經有一個更新在進行中（{running.get('job_id')}，{started}）")

    if not studio_update.update_check_enabled():
        raise ApiError(409, "update_check_disabled", "更新檢查已關閉（MHC_UPDATE_CHECK=0）")

    rel = await studio_update.fetch_latest_async(use_cache=False)
    if rel is None:
        raise ApiError(502, "update_check_failed", "查不到最新版（GitHub 沒回應或還沒有 release）")
    if studio_update.is_newer(STUDIO_VERSION, rel.tag) is not True:
        raise ApiError(409, "up_to_date", f"目前 v{STUDIO_VERSION} 已經不比 {rel.tag} 舊，沒有要更新的")
    if body.to and studio_update.normalize(body.to) != rel.version:
        raise ApiError(409, "version_mismatch",
                       f"你看到的是 v{studio_update.normalize(body.to)}，但現在的最新版是 {rel.tag}，請重新整理再試")
    asset = rel.wheel()
    if not asset:
        raise ApiError(422, "no_wheel", f"release {rel.tag} 沒有附 wheel，請改用 CLI 或手動更新")

    dist_token, version = check_wheel_name(asset["name"], rel.version)

    home = home_dir()
    job_id = f"up_{uuid.uuid4().hex[:10]}"
    job_dir = jobs_dir(home) / job_id
    log_path = home / "logs" / f"update-{time.strftime('%Y%m%d-%H%M%S')}.log"
    common = {"job_id": job_id, "from": STUDIO_VERSION, "to": rel.version,
              "log": str(log_path), "started_at": _now()}
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        log_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise ApiError(500, "io_error", f"建不了工作目錄：{e}")

    write_status(home, phase="downloading", error="", finished_at="", **common)

    # ---- 下載＋驗證：到這裡為止都還沒動到現有安裝，失敗就純粹回錯 ----
    try:
        wheel_path = await asyncio.to_thread(
            studio_update.download, asset["url"], asset["name"], str(job_dir))
        size = await asyncio.to_thread(verify_wheel, Path(wheel_path), dist_token, version)
    except ApiError as e:
        write_status(home, phase="failed", error=e.message, finished_at=_now(), **common)
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as e:  # noqa: BLE001 — 網路／磁碟問題都算下載失敗
        msg = f"下載失敗：{e}"
        write_status(home, phase="failed", error=msg, finished_at=_now(), **common)
        shutil.rmtree(job_dir, ignore_errors=True)
        raise ApiError(502, "download_failed", msg)

    # ---- 複製一份更新器出去（等一下 pip 會把 studio 套件整個換掉）----
    script = job_dir / "updater.py"
    try:
        shutil.copyfile(updater_mod.__file__, script)
    except OSError as e:
        write_status(home, phase="failed", error=f"複製更新器失敗：{e}", finished_at=_now(), **common)
        raise ApiError(500, "io_error", f"複製更新器失敗：{e}")

    port, host = _server_port_host(request, home)
    argv = [sys.executable, str(script), "--home", str(home), "--wheel", wheel_path,
            "--status", str(status_file(home)), "--pid", str(os.getpid()),
            "--job", job_id, "--from", STUDIO_VERSION, "--to", rel.version,
            "--python", sys.executable, "--host", host]
    if port:
        argv += ["--port", str(port)]

    env = dict(os.environ)
    env["MHC_HOME"] = str(home)
    env.setdefault("STUDIO_HOME", str(home))
    db = getattr(getattr(request.app.state, "settings", None), "db_path", None)
    if db:
        env["STUDIO_DB"] = str(db)

    try:
        log_fh = open(log_path, "ab")
    except OSError as e:
        raise ApiError(500, "io_error", f"開不了 log：{e}")
    try:
        subprocess.Popen(argv, stdout=log_fh, stderr=subprocess.STDOUT,
                         stdin=subprocess.DEVNULL, start_new_session=True,
                         cwd=str(home), env=env)
    except OSError as e:
        write_status(home, phase="failed", error=f"啟動更新器失敗：{e}", finished_at=_now(), **common)
        raise ApiError(500, "spawn_failed", f"啟動更新器失敗：{e}")
    finally:
        log_fh.close()

    prune_jobs(home)
    _request_shutdown()
    return {"job_id": job_id, "status": "starting", "phase": "downloading",
            "log": str(log_path), "from": STUDIO_VERSION, "to": rel.version,
            "wheel": asset["name"], "wheel_size": size,
            "restart": {"port": port, "host": host}}
