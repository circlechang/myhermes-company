"""MyHermesCompany command line: ``python -m studio`` / ``myhermescompany``（舊別名 ``studio-tw``）.

Commands: start [--port --host --daemon] | stop [--port] | status [--port] | restart [--port --host] | logs [--port]
          | reset-admin | clear-login-locks | version
          | hermes-check [--json --writes --only] | install-skill mhc-search [--profile] | precheck [version] [--json]
          | update [--check --yes --json --no-cache]

State dir (MHC_HOME／STUDIO_HOME, default ~/.myhermescompany/; 舊 ~/.hermes-studio-tw 會自動搬移): studio.pid, logs/studio.log, studio.db.
studio.pid 第一行是 pid，之後是 port=/host=（status/stop/restart 不帶 --port 也知道服務在哪個 port）。
"""
from __future__ import annotations

import argparse
import getpass
import ipaddress
import logging
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from . import __version__

DEFAULT_PASSWORD = "admin"


# ---------- paths ----------

def studio_home() -> Path:
    from .config import data_home

    return data_home()


def apply_home_env() -> None:
    """STUDIO_HOME 有設但 STUDIO_DB 沒設時，DB 也放進 STUDIO_HOME（config.py 只認 STUDIO_DB）。"""
    if os.environ.get("STUDIO_HOME") and not os.environ.get("STUDIO_DB"):
        os.environ["STUDIO_DB"] = str(studio_home() / "studio.db")


def pid_file(home: Optional[Path] = None) -> Path:
    return (home or studio_home()) / "studio.pid"


def log_file(home: Optional[Path] = None) -> Path:
    return (home or studio_home()) / "logs" / "studio.log"


# ---------- pid helpers ----------

def read_pid(path: Path) -> Optional[int]:
    try:
        txt = path.read_text().strip()
    except OSError:
        return None
    first = txt.splitlines()[0].strip() if txt else ""
    if not first.isdigit():
        return None
    return int(first)


def read_meta(path: Path) -> dict[str, str]:
    """pid 檔第二行起的 key=value（port/host）。舊格式只有 pid 就回空 dict。"""
    try:
        lines = path.read_text().splitlines()[1:]
    except OSError:
        return {}
    out: dict[str, str] = {}
    for ln in lines:
        if "=" in ln:
            k, v = ln.split("=", 1)
            out[k.strip()] = v.strip()
    return out


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


def running_pid(path: Path) -> Optional[int]:
    """PID from file if that process is alive; stale files are removed."""
    pid = read_pid(path)
    if pid is None:
        return None
    if pid_alive(pid):
        return pid
    try:
        path.unlink()
    except OSError:
        pass
    return None


def write_pid(path: Path, pid: int, port: Optional[int] = None, host: Optional[str] = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    extra = "".join(f"{k}={v}\n" for k, v in (("port", port), ("host", host)) if v)
    path.write_text(f"{pid}\n{extra}")


def stop_pid(pid: int, timeout: float = 10.0) -> bool:
    """SIGTERM, wait, then SIGKILL. Returns True when the process is gone."""
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = time.time() + timeout
    while time.time() < deadline:
        _reap(pid)
        if not pid_alive(pid):
            return True
        time.sleep(0.1)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    time.sleep(0.2)
    _reap(pid)
    return not pid_alive(pid)


def _reap(pid: int) -> None:
    """If ``pid`` is our own child, collect it so it does not linger as a zombie."""
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


def wait_ready(base_url: str, timeout: float = 10.0) -> bool:
    import urllib.request

    host = base_url.replace("0.0.0.0", "127.0.0.1")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(host + "/health", timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


# ---------- security preflight ----------

def is_loopback(host: str) -> bool:
    if host in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def admin_uses_default_password(engine) -> bool:
    from sqlmodel import Session, select

    from .auth import verify_password
    from .models import Member

    with Session(engine) as s:
        for m in s.exec(select(Member).where(Member.role == "owner")):
            if verify_password(DEFAULT_PASSWORD, m.password_hash):
                return True
    return False


def set_admin_password(engine, password: str, username: str = "admin") -> int:
    """Set password for ``username`` (all companies). Returns number of members updated."""
    from sqlmodel import Session, select

    from .auth import hash_password
    from .models import Member

    n = 0
    with Session(engine) as s:
        for m in s.exec(select(Member).where(Member.username == username)):
            m.password_hash = hash_password(password)
            s.add(m)
            n += 1
        s.commit()
    return n


def preflight(settings, engine) -> list[str]:
    """Return list of fatal problems for a non-loopback bind (empty = OK)."""
    from .db import init_db

    init_db(engine)
    env_pw = os.environ.get("STUDIO_ADMIN_PASSWORD")
    if env_pw:
        if len(env_pw) < 8:
            return ["STUDIO_ADMIN_PASSWORD 至少 8 個字元"]
        set_admin_password(engine, env_pw)
    problems: list[str] = []
    if is_loopback(settings.host):
        return problems
    if not os.environ.get("STUDIO_SECRET"):
        problems.append("非 loopback 綁定必須設定 STUDIO_SECRET（例如 `openssl rand -hex 32`）")
    if admin_uses_default_password(engine):
        problems.append("admin 密碼仍是預設值：先執行 `myhermescompany reset-admin` 或設定 STUDIO_ADMIN_PASSWORD")
    return problems


# ---------- serve ----------

def serve(host: Optional[str], port: Optional[int]) -> int:
    import uvicorn

    from .app import create_app
    from .config import Settings
    from .db import make_engine
    from .static import install_static

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env()
    if host:
        settings.host = host
    if port:
        settings.port = port
    engine = make_engine(settings.db_path)
    problems = preflight(settings, engine)
    if problems:
        for p in problems:
            print(f"拒絕啟動：{p}", file=sys.stderr)
        return 2
    app = create_app(settings, engine=engine)
    mounted = install_static(app)
    write_pid(pid_file(), os.getpid(), settings.port, settings.host)
    print(f"MyHermesCompany v{__version__} http://{settings.host}:{settings.port}  "
          f"(web: {'內建' if mounted else '未內建，只有 API'})", flush=True)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")
    return 0


def cmd_start(args) -> int:
    home = studio_home()
    pf = pid_file(home)
    pid = running_pid(pf)
    if pid:
        print(f"已在執行中（pid {pid}）", file=sys.stderr)
        return 1
    if not args.daemon:
        try:
            return serve(args.host, args.port)
        finally:
            if read_pid(pf) == os.getpid():
                pf.unlink(missing_ok=True)
    lf = log_file(home)
    lf.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "studio", "start"]
    if args.host:
        cmd += ["--host", args.host]
    if args.port:
        cmd += ["--port", str(args.port)]
    with open(lf, "ab") as out:
        proc = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                start_new_session=True, cwd=str(home))
    # child writes the pid file only after preflight passes; wait for it (max 15s)
    for _ in range(150):
        time.sleep(0.1)
        rc = proc.poll()
        if rc is not None:
            print(f"啟動失敗（exit {rc}），見 {lf}", file=sys.stderr)
            return rc or 1
        if read_pid(pf) == proc.pid:
            url = f"http://{args.host or os.environ.get('STUDIO_HOST') or '127.0.0.1'}:" \
                  f"{args.port or os.environ.get('STUDIO_PORT') or 8700}"
            if not wait_ready(url):
                print(f"pid {proc.pid} 起來了但 /health 還沒回應，見 {lf}", file=sys.stderr)
            print(f"已在背景啟動 pid {proc.pid}，{url}，log: {lf}")
            return 0
    print(f"啟動逾時（pid {proc.pid} 還沒回報），見 {lf}", file=sys.stderr)
    return 1


def _arg(args, name: str):
    return getattr(args, name, None) if args is not None else None


def recorded_port(pf: Optional[Path] = None) -> Optional[int]:
    v = read_meta(pf or pid_file()).get("port")
    return int(v) if v and v.isdigit() else None


def effective_port(args, pf: Optional[Path] = None) -> int:
    """--port ＞ pid 檔記錄 ＞ STUDIO_PORT ＞ 8700。"""
    return int(_arg(args, "port") or recorded_port(pf) or os.environ.get("STUDIO_PORT") or 8700)


def effective_host(args, pf: Optional[Path] = None) -> str:
    return str(_arg(args, "host") or read_meta(pf or pid_file()).get("host") or os.environ.get("STUDIO_HOST") or "127.0.0.1")


def _port_mismatch(args, pf: Path) -> Optional[str]:
    want, have = _arg(args, "port"), recorded_port(pf)
    if want and have and int(want) != have:
        return f"注意：--port {want} 與執行中的服務（port {have}）不同；此 STUDIO_HOME 只有一個服務，仍以 pid 檔為準"
    return None


def cmd_stop(args=None) -> int:
    pf = pid_file()
    pid = running_pid(pf)
    if not pid:
        print("沒有在執行")
        return 0
    warn = _port_mismatch(args, pf)
    if warn:
        print(warn, file=sys.stderr)
    ok = stop_pid(pid)
    pf.unlink(missing_ok=True)
    print("已停止" if ok else f"停不掉 pid {pid}")
    return 0 if ok else 1


def cmd_status(args=None) -> int:
    pf = pid_file()
    pid = running_pid(pf)
    if pid:
        warn = _port_mismatch(args, pf)
        if warn:
            print(warn, file=sys.stderr)
        port, host = effective_port(args, pf), effective_host(args, pf)
        url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"
        healthy = wait_ready(url, timeout=2.0)
        print(f"running pid={pid} port={port} host={host} health={'ok' if healthy else 'no-response'} home={studio_home()}")
        return 0
    print("stopped")
    return 3


def cmd_restart(args) -> int:
    pf = pid_file()
    if not _arg(args, "port"):
        args.port = recorded_port(pf)  # 沒帶 --port 就沿用原本的 port
    if not _arg(args, "host"):
        args.host = read_meta(pf).get("host") or None
    cmd_stop(args)
    args.daemon = True
    return cmd_start(args)


def cmd_logs(args) -> int:
    lf = log_file()
    if not lf.exists():
        print(f"沒有 log：{lf}")
        return 1
    if args.follow:
        os.execvp("tail", ["tail", "-n", str(args.lines), "-f", str(lf)])
    lines = lf.read_text(errors="replace").splitlines()[-args.lines:]
    print("\n".join(lines))
    return 0


def cmd_reset_admin(args) -> int:
    from .config import Settings
    from .db import init_db, make_engine

    pw = args.password or os.environ.get("STUDIO_ADMIN_PASSWORD")
    if not pw:
        pw = getpass.getpass("新的 admin 密碼: ")
        if pw != getpass.getpass("再輸入一次: "):
            print("兩次不一致", file=sys.stderr)
            return 1
    if len(pw) < 8:
        print("密碼至少 8 個字元", file=sys.stderr)
        return 1
    settings = Settings.from_env()
    engine = make_engine(settings.db_path)
    init_db(engine)
    n = set_admin_password(engine, pw, args.username)
    print(f"已更新 {n} 個帳號「{args.username}」的密碼")
    return 0 if n else 1


def cmd_clear_login_locks(args) -> int:
    """清掉登入失敗鎖定（全部或指定帳號）。直接操作 DB，伺服器不用重啟。"""
    from sqlmodel import Session

    from .api.auth_api import clear_locks
    from .config import Settings
    from .db import init_db, make_engine

    settings = Settings.from_env()
    engine = make_engine(settings.db_path)
    init_db(engine)
    with Session(engine) as db:
        keys = [f"u:{args.username.strip().lower()}"] if getattr(args, "username", None) else None
        n = clear_locks(db, keys)
    print(f"已清除 {n} 筆登入鎖定" + (f"（帳號 {args.username}）" if getattr(args, "username", None) else "（全部，含 IP）"))
    return 0


# ---------- Hermes 相容性／skill 安裝（round3 接進 cli.py） ----------

def cmd_hermes_check(args) -> int:
    """對本機 Hermes 跑接觸面契約測試（實體在 studio.modules.compat.__main__；exit 0 相容／1 部分／2 不相容／3 跑不起來）。"""
    from .modules.compat.__main__ import main as compat_main

    argv = ["hermes-check"]
    if args.json:
        argv.append("--json")
    if args.writes:
        argv.append("--writes")
    if args.only:
        argv += ["--only", args.only]
    return compat_main(argv)


def cmd_install_skill(args) -> int:
    """把 hermes-skills/<name> 裝進 Hermes profile（實體在 studio.modules.search.install）。"""
    from .modules.search.install import main as install_main

    argv = [args.name]
    if args.profile:
        argv += ["--profile", args.profile]
    if args.hermes_home:
        argv += ["--hermes-home", args.hermes_home]
    if args.url:
        argv += ["--url", args.url]
    if args.token_stdin:
        argv.append("--token-stdin")
    return install_main(argv)


def cmd_precheck(args) -> int:
    """升級預檢：在暫存目錄裝指定版本的 Hermes、起沙盒 gateway 跑契約測試（同步、印進度）。
    exit 0 相容／1 部分／2 不相容／3 跑不起來。"""
    import asyncio
    import json as _json
    import uuid

    from .modules.compat import precheck as pc
    from .modules.compat.__main__ import _print_human

    job = pc.PrecheckJob(id=f"pc_{uuid.uuid4().hex[:10]}", want=args.version or "latest")
    last = {"n": 0}

    def on_update(j: pc.PrecheckJob) -> None:
        if args.json:
            return
        for step in j.progress[last["n"]:]:
            print(f"[{step['step']}] {step['msg']}".rstrip(), file=sys.stderr)
        last["n"] = len(j.progress)

    root = os.environ.get("STUDIO_PRECHECK_DIR")
    asyncio.run(pc.run_precheck(job, workdir_root=Path(root) if root else None,
                                keep=os.environ.get("STUDIO_PRECHECK_KEEP") == "1", on_update=on_update))
    on_update(job)
    if args.json:
        print(_json.dumps(job.to_dict(), ensure_ascii=False, indent=1, default=str))
    elif job.report:
        print(f"預檢 {job.tag or job.want}（{job.status}）")
        _print_human(job.report)
    else:
        print(f"預檢失敗（{job.status}）：{job.error}", file=sys.stderr)
        if job.log_path:
            print(f"log：{job.log_path}", file=sys.stderr)
    if not job.report:
        return 3
    return {"compatible": 0, "partial": 1, "incompatible": 2}.get(job.report["summary"]["verdict"], 3)


def cmd_version(_args) -> int:
    print(f"myhermescompany {__version__}")
    return 0


# ---------- 自我更新 ----------

def _pip_install(wheel: str) -> tuple[int, str]:
    """用「正在跑的這個 python」所屬環境裝，不要猜 venv。
    pip 的 upgrade 是先下載＋建好才換掉舊版，失敗時已安裝的版本原封不動。"""
    proc = subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", wheel],
                          capture_output=True, text=True)
    return proc.returncode, (proc.stdout + proc.stderr)


def cmd_update(args) -> int:
    """檢查公開 repo 有沒有新版；有就下載 wheel、pip 升級、重啟。

    exit 0＝已是最新／檢查完成／升級成功；1＝抓不到或升級失敗；2＝使用者取消。
    """
    import json as _json
    import tempfile

    from . import update as up

    as_json = bool(getattr(args, "json", False))
    repo = getattr(args, "repo", "") or up.public_repo()
    rel = up.fetch_latest(repo, use_cache=not getattr(args, "no_cache", False))

    if rel is None:
        st = up.status(__version__, repo, None)
        st["error"] = "查不到最新版（GitHub 沒回應或還沒有 release）"
        if as_json:
            print(_json.dumps(st, ensure_ascii=False, indent=1))
        else:
            print(f"查不到 {repo} 的最新版；目前 v{__version__}", file=sys.stderr)
        return 1

    st = up.status(__version__, repo, rel)
    newer = st["update_available"]

    if as_json:
        print(_json.dumps(st, ensure_ascii=False, indent=1))
    elif newer is False:
        print(f"已是最新版 v{__version__}")
    elif newer is None:
        print(f"版號比不出來（目前 v{__version__}，最新 {rel.tag}）", file=sys.stderr)
    else:
        print(f"有新版 {rel.tag}（目前 v{__version__}）")
        if rel.url:
            print(f"  {rel.url}")
        summary = rel.notes_summary()
        if summary:
            print("\n" + "\n".join("  " + ln for ln in summary.splitlines()) + "\n")

    if getattr(args, "check", False):
        return 0
    if newer is not True:
        return 0 if newer is False else 1

    if not getattr(args, "yes", False):
        try:
            ans = input(f"要現在更新到 {rel.tag} 嗎？[y/N] ").strip().lower()
        except EOFError:
            ans = ""
        if ans not in ("y", "yes"):
            print("取消，沒有動到目前的版本")
            return 2

    asset = rel.wheel()
    if not asset:
        print(f"release {rel.tag} 沒有附 wheel，請看 {rel.url or repo} 手動更新", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="mhc-update-") as tmp:
        print(f"下載 {asset['name']} …")
        try:
            wheel = up.download(asset["url"], asset["name"], tmp)
        except Exception as e:  # noqa: BLE001 — 下載失敗不該讓 CLI 噴 traceback
            print(f"下載失敗：{e}", file=sys.stderr)
            return 1
        print(f"安裝（{sys.executable} -m pip install --upgrade）…")
        code, out = _pip_install(wheel)
        if code != 0:
            print(out[-2000:], file=sys.stderr)
            print(f"安裝失敗；目前版本 v{__version__} 仍可用（pip 升級失敗不會動到已安裝版本）", file=sys.stderr)
            return 1

    print(f"已安裝 {rel.tag}，重新啟動服務…")
    pf = pid_file()
    if not running_pid(pf):
        print("服務原本就沒在跑；下次 `myhermescompany start` 就是新版")
        return 0
    args.port = recorded_port(pf)
    args.host = read_meta(pf).get("host") or None
    args.daemon = True
    return cmd_restart(args)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="myhermescompany", description="MyHermesCompany — 每個人都有一間 AI 公司")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("start", help="啟動伺服器")
    s.add_argument("--port", type=int)
    s.add_argument("--host")
    s.add_argument("--daemon", "-d", action="store_true", help="背景執行，pid/log 寫到 STUDIO_HOME")
    s.set_defaults(fn=cmd_start)
    st = sub.add_parser("stop", help="停止背景伺服器")
    st.add_argument("--port", type=int, help="與 start 一致；只用來核對 pid 檔記錄的 port")
    st.set_defaults(fn=cmd_stop)
    ss = sub.add_parser("status", help="顯示狀態（exit 0 執行中／3 已停）")
    ss.add_argument("--port", type=int, help="健康檢查用的 port（預設讀 pid 檔）")
    ss.add_argument("--host")
    ss.set_defaults(fn=cmd_status)
    r = sub.add_parser("restart", help="重啟（背景）；不帶 --port 就沿用 pid 檔記錄的 port")
    r.add_argument("--port", type=int)
    r.add_argument("--host")
    r.set_defaults(fn=cmd_restart)
    lg = sub.add_parser("logs", help="看 log")
    lg.add_argument("-n", "--lines", type=int, default=100)
    lg.add_argument("-f", "--follow", action="store_true")
    lg.add_argument("--port", type=int, help="與 start 一致（log 檔在 STUDIO_HOME，port 只做核對）")
    lg.set_defaults(fn=cmd_logs)
    ra = sub.add_parser("reset-admin", help="重設 admin 密碼")
    ra.add_argument("--password")
    ra.add_argument("--username", default="admin")
    ra.set_defaults(fn=cmd_reset_admin)
    cl = sub.add_parser("clear-login-locks", help="清除登入失敗鎖定（預設全部；--username 只清該帳號）")
    cl.add_argument("--username")
    cl.set_defaults(fn=cmd_clear_login_locks)
    hc = sub.add_parser("hermes-check", help="對本機 Hermes 跑接觸面契約測試（exit 0 相容／1 部分／2 不相容／3 跑不起來）")
    hc.add_argument("--json", action="store_true", help="輸出完整 JSON 報告")
    hc.add_argument("--writes", action="store_true", help="允許會建資料的 live 呼叫（建完會清掉）")
    hc.add_argument("--only", help="只跑這些 id（逗號分隔）")
    hc.set_defaults(fn=cmd_hermes_check)
    isk = sub.add_parser("install-skill", help="把 MyHermesCompany 的 Hermes skill 裝進 profile（例：install-skill mhc-search --profile researcher）")
    isk.add_argument("name", nargs="?", default="mhc-search")
    isk.add_argument("--profile", default="", help="Hermes profile（空＝default，裝到 ~/.hermes/skills/）")
    isk.add_argument("--hermes-home", default="", help="HERMES_HOME（預設 env 或 ~/.hermes）")
    isk.add_argument("--url", default="", help="順便把 MHC_STUDIO_URL 寫進該 profile 的 .env")
    isk.add_argument("--token-stdin", action="store_true", help="從 stdin 讀 MHC_SEARCH_TOKEN 寫進 .env")
    isk.set_defaults(fn=cmd_install_skill)
    pcm = sub.add_parser("precheck", help="升級預檢：沙盒安裝指定版本 Hermes 跑契約測試（預設 latest；約 1 分鐘）")
    pcm.add_argument("version", nargs="?", default="latest", help="latest 或 tag（例 v2026.8.27）")
    pcm.add_argument("--json", action="store_true")
    pcm.set_defaults(fn=cmd_precheck)
    sub.add_parser("version").set_defaults(fn=cmd_version)
    ud = sub.add_parser("update", help="檢查並更新到公開 repo 的最新 release（--check 只檢查）")
    ud.add_argument("--check", action="store_true", help="只檢查不安裝（給排程用）")
    ud.add_argument("--yes", "-y", action="store_true", help="不詢問，直接安裝")
    ud.add_argument("--json", action="store_true", help="機器可讀輸出")
    ud.add_argument("--no-cache", action="store_true", help="忽略 6 小時快取，直接打 GitHub")
    ud.add_argument("--repo", default="", help="覆寫來源 repo（預設 MHC_PUBLIC_REPO）")
    ud.add_argument("--port", type=int, help=argparse.SUPPRESS)
    ud.add_argument("--host", help=argparse.SUPPRESS)
    ud.set_defaults(fn=cmd_update)
    return p


def main(argv: Optional[list[str]] = None) -> None:
    apply_home_env()
    p = build_parser()
    args = p.parse_args(argv)
    if not args.cmd:  # bare `python -m studio` keeps the old behaviour: foreground start
        args = p.parse_args(["start"])
    sys.exit(args.fn(args))
