"""升級預檢：在暫存目錄 clone 指定版本的 hermes-agent、裝進暫存 venv、用暫存 HERMES_HOME＋另一個 port
起它的 gateway api_server，跑契約測試，最後全部清掉。**絕不碰使用者的 ~/.hermes。**

Hermes 事實（0.20.5，讀 gateway/config.py 與 gateway/platforms/api_server.py 確認）：
- HERMES_HOME 環境變數決定資料目錄；API_SERVER_KEY（>=16 字）存在就會啟用 api_server；
  API_SERVER_PORT / API_SERVER_HOST 指定埠與位址（預設 127.0.0.1:8642）。
- `hermes gateway run` 偵測到 launchd 已有 gateway 會拒絕啟動，要加 `--force`。
- 沒有 provider 也能起 gateway；/v1/runs 會回 run_id 然後 run 失敗，契約測試已把這視為正常。
- GitHub tag 命名是 vYYYY.M.D（例：0.20.5 = v2026.8.19）。
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from ...hermes import contract

log = logging.getLogger("studio.compat.precheck")

REPO_URL = os.environ.get("STUDIO_HERMES_REPO", "https://github.com/NousResearch/hermes-agent")
# api_server adapter 需要 aiohttp（pyproject 的 [sms]/[messaging] extra 才裝）；基本安裝沒有它 gateway 會印
# "No adapter available for api_server"。可用 STUDIO_PRECHECK_EXTRA_PKGS 覆蓋（空白分隔）。
EXTRA_PKGS = (os.environ.get("STUDIO_PRECHECK_EXTRA_PKGS") or "aiohttp").split()
TAG_RE = re.compile(r"^v(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$")


# ---------------------------------------------------------------- tags
def tag_key(tag: str) -> tuple[int, ...]:
    m = TAG_RE.match(tag)
    if not m:
        return (0,)
    return tuple(int(x or 0) for x in m.groups())


def parse_ls_remote(text: str) -> list[str]:
    """`git ls-remote --tags` 輸出 → 版本 tag 清單（去掉 ^{}）。"""
    tags: list[str] = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2 or not parts[1].startswith("refs/tags/"):
            continue
        name = parts[1][len("refs/tags/"):]
        if name.endswith("^{}"):
            continue
        if TAG_RE.match(name):
            tags.append(name)
    return sorted(set(tags), key=tag_key)


def resolve_tag(tags: list[str], want: str) -> Optional[str]:
    """want = 'latest' | 'vYYYY.M.D' | 'YYYY.M.D' | 'X.Y.Z'（後者需在 tags 內有同名）。"""
    want = (want or "latest").strip()
    if not tags:
        return None
    if want == "latest":
        return tags[-1]
    if want in tags:
        return want
    if not want.startswith("v") and f"v{want}" in tags:
        return f"v{want}"
    return None


def date_to_tag(date: str) -> str:
    """hermes --version 的 (YYYY.M.D) → tag 名。"""
    return f"v{date}" if date and not date.startswith("v") else date


def is_newer(tag: str, than: str) -> bool:
    return tag_key(tag) > tag_key(than)


async def fetch_remote_tags(timeout: float = 30.0) -> list[str]:
    """先用 git ls-remote（沒有 rate limit），失敗再退 GitHub API。"""
    try:
        proc = await asyncio.create_subprocess_exec("git", "ls-remote", "--tags", REPO_URL,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        if proc.returncode == 0:
            tags = parse_ls_remote(out.decode("utf-8", "replace"))
            if tags:
                return tags
    except Exception as e:  # noqa: BLE001
        log.info("git ls-remote failed: %s", e)
    repo = REPO_URL.replace("https://github.com/", "")
    try:
        async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": "myhermescompany"}) as c:
            r = await c.get(f"https://api.github.com/repos/{repo}/tags?per_page=50")
            if r.status_code == 200:
                names = [t.get("name", "") for t in r.json() if isinstance(t, dict)]
                return sorted({n for n in names if TAG_RE.match(n)}, key=tag_key)
    except Exception as e:  # noqa: BLE001
        log.info("github tags api failed: %s", e)
    return []


# ---------------------------------------------------------------- job
@dataclass
class PrecheckJob:
    id: str
    want: str
    status: str = "queued"  # queued|resolving|cloning|installing|starting|testing|cleanup|done|failed|timeout
    tag: str = ""
    version: str = ""
    progress: list[dict[str, Any]] = field(default_factory=list)
    report: Optional[dict[str, Any]] = None
    error: str = ""
    log_path: str = ""
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds"))
    finished_at: str = ""
    workdir: str = ""

    def step(self, status: str, msg: str = "") -> None:
        self.status = status
        self.progress.append({"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "step": status, "msg": msg})
        log.info("precheck %s: %s %s", self.id, status, msg)

    def to_dict(self, with_report: bool = True) -> dict[str, Any]:
        d = {"id": self.id, "want": self.want, "status": self.status, "tag": self.tag, "version": self.version,
             "progress": self.progress, "error": self.error, "log_path": self.log_path,
             "started_at": self.started_at, "finished_at": self.finished_at,
             "summary": (self.report or {}).get("summary") if self.report else None}
        if with_report:
            d["report"] = self.report
        return d


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _run_cmd(args: list[str], *, cwd: Optional[Path], log_fh, timeout: float, env: Optional[dict] = None) -> int:
    log_fh.write(f"\n$ {' '.join(args)}\n")
    log_fh.flush()
    proc = await asyncio.create_subprocess_exec(*args, cwd=str(cwd) if cwd else None, stdout=log_fh, stderr=subprocess.STDOUT,
                                                stdin=asyncio.subprocess.DEVNULL, env=env)
    try:
        return await asyncio.wait_for(proc.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise


def _pyproject_version(src: Path) -> str:
    try:
        m = re.search(r'^version\s*=\s*"([^"]+)"', (src / "pyproject.toml").read_text(encoding="utf-8"), re.M)
        return m.group(1) if m else ""
    except OSError:
        return ""


async def run_precheck(job: PrecheckJob, *, workdir_root: Optional[Path] = None, keep: bool = False,
                       total_timeout: float = 15 * 60, on_update: Optional[Callable[[PrecheckJob], None]] = None) -> PrecheckJob:
    """整條預檢流程。任何一步失敗都會清掉暫存目錄（keep=True 除外）並把原因寫進 job.error。"""
    deadline = time.time() + total_timeout
    root = Path(workdir_root or tempfile.gettempdir()) / "mhc-precheck"
    root.mkdir(parents=True, exist_ok=True)
    workdir = Path(tempfile.mkdtemp(prefix=f"{job.id}-", dir=root))
    job.workdir = str(workdir)
    src, venv, home = workdir / "src", workdir / "venv", workdir / "home"
    home.mkdir()
    log_path = workdir / "precheck.log"
    job.log_path = str(log_path)
    gw_proc: Optional[asyncio.subprocess.Process] = None
    log_fh = open(log_path, "a", encoding="utf-8")

    def notify() -> None:
        if on_update:
            try:
                on_update(job)
            except Exception:
                pass

    def remaining() -> float:
        left = deadline - time.time()
        if left <= 0:
            raise asyncio.TimeoutError()
        return left

    try:
        job.step("resolving", f"查 {REPO_URL} 的 tag")
        notify()
        tags = await fetch_remote_tags()
        tag = resolve_tag(tags, job.want)
        if not tag:
            raise RuntimeError(f"找不到版本 {job.want!r}（最近的 tag：{', '.join(tags[-5:]) or '無法取得'}）")
        job.tag = tag

        job.step("cloning", f"git clone --depth 1 --branch {tag}")
        notify()
        rc = await _run_cmd(["git", "clone", "--depth", "1", "--branch", tag, "--quiet", REPO_URL, str(src)],
                            cwd=None, log_fh=log_fh, timeout=min(remaining(), 600))
        if rc != 0:
            raise RuntimeError(f"git clone 失敗（exit {rc}），見 log")
        job.version = _pyproject_version(src)

        job.step("installing", "建立暫存 venv 並安裝（uv 優先，退 pip）")
        notify()
        uv = shutil.which("uv")
        py_hint = os.environ.get("STUDIO_PRECHECK_PYTHON", "3.12")
        if uv:
            rc = await _run_cmd([uv, "venv", str(venv), "--python", py_hint, "-q"], cwd=src, log_fh=log_fh, timeout=min(remaining(), 300))
            if rc != 0:  # 沒有指定版本的 python 就讓 uv 自己挑
                rc = await _run_cmd([uv, "venv", str(venv), "-q"], cwd=src, log_fh=log_fh, timeout=min(remaining(), 300))
            if rc == 0:
                rc = await _run_cmd([uv, "pip", "install", "--python", str(venv / "bin" / "python"), "-q", "-e", ".", *EXTRA_PKGS],
                                    cwd=src, log_fh=log_fh, timeout=min(remaining(), 900))
        else:
            rc = await _run_cmd([sys.executable, "-m", "venv", str(venv)], cwd=src, log_fh=log_fh, timeout=min(remaining(), 300))
            if rc == 0:
                rc = await _run_cmd([str(venv / "bin" / "python"), "-m", "pip", "install", "-q", "-e", ".", *EXTRA_PKGS],
                                    cwd=src, log_fh=log_fh, timeout=min(remaining(), 900))
        if rc != 0:
            raise RuntimeError(f"安裝失敗（exit {rc}），見 log")
        hermes_bin = venv / "bin" / "hermes"
        if not hermes_bin.exists():
            raise RuntimeError("安裝後找不到 venv/bin/hermes")

        port = _free_port()
        key = "mhc-precheck-" + secrets.token_hex(16)
        env = {**os.environ, "HERMES_HOME": str(home), "API_SERVER_KEY": key, "API_SERVER_PORT": str(port),
               "API_SERVER_HOST": "127.0.0.1", "NO_COLOR": "1", "TERM": "dumb"}
        for k in ("HERMES_PROFILE", "VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME"):
            env.pop(k, None)
        env["PATH"] = f"{venv / 'bin'}{os.pathsep}{env.get('PATH', '')}"
        job.step("starting", f"hermes gateway run（HERMES_HOME={home.name}，port {port}）")
        notify()
        log_fh.write(f"\n$ hermes gateway run --force  (HERMES_HOME={home}, port={port})\n")
        log_fh.flush()
        gw_proc = await asyncio.create_subprocess_exec(str(hermes_bin), "gateway", "run", "--force", env=env, cwd=str(home),
                                                       stdout=log_fh, stderr=subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL,
                                                       start_new_session=True)
        api_url = f"http://127.0.0.1:{port}"
        ready = False
        t0 = time.time()
        async with httpx.AsyncClient(timeout=2.0) as c:
            while time.time() - t0 < min(120, remaining()):
                if gw_proc.returncode is not None:
                    break
                try:
                    r = await c.get(f"{api_url}/v1/health")
                    if r.status_code == 200:
                        ready = True
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(1.0)
        if not ready:
            raise RuntimeError("沙盒 gateway 沒有在 120 秒內回應 /v1/health（可能是 `gateway run --force` 旗標變了），見 log")

        job.step("testing", "跑契約測試（sandbox 模式）")
        notify()
        report = await asyncio.wait_for(
            contract.run_async(home, api_url, key, hermes_bin=str(hermes_bin), sandbox=True, profile="default",
                               env={"API_SERVER_KEY": key, "API_SERVER_PORT": str(port)}),
            timeout=remaining())
        report["precheck"] = {"tag": tag, "version": job.version, "workdir": str(workdir), "port": port}
        job.report = report
        job.step("done", f"{report['summary']['verdict']}：pass {report['summary']['pass']} / fail {report['summary']['fail']} / skip {report['summary']['skip']}")
    except asyncio.TimeoutError:
        job.error = f"超過 {int(total_timeout // 60)} 分鐘上限，未驗完；log：{log_path}"
        job.step("timeout", job.error)
    except Exception as e:  # noqa: BLE001
        job.error = str(e)
        job.step("failed", job.error)
        log.warning("precheck %s failed: %s", job.id, e)
    finally:
        job.finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if gw_proc is not None and gw_proc.returncode is None:
            try:
                os.killpg(gw_proc.pid, 15)
                await asyncio.wait_for(gw_proc.wait(), timeout=10)
            except Exception:
                try:
                    os.killpg(gw_proc.pid, 9)
                except Exception:
                    pass
        log_fh.close()
        if not keep and not job.error:
            shutil.rmtree(workdir, ignore_errors=True)
            job.workdir = ""
            job.log_path = ""
        elif not keep and job.error:
            # 失敗時保留 log 給人看，其他（src/venv/home）清掉
            for sub in (src, venv, home):
                shutil.rmtree(sub, ignore_errors=True)
        notify()
    return job
