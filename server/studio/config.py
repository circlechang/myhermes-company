"""Runtime settings, all overridable by environment variables (see docs/API.md)."""
from __future__ import annotations

import logging
import os
import secrets
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


def _read_env_file(path: Path) -> dict[str, str]:
    """Minimal KEY=VALUE parser for ~/.hermes/.env (values never logged)."""
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        if k.startswith("export "):
            k = k[len("export "):].strip()
        v = v.strip().strip('"').strip("'")
        out[k] = v
    return out


log = logging.getLogger("studio.config")

DEFAULT_HOME = Path("~/.myhermescompany")
LEGACY_HOME = Path("~/.hermes-studio-tw")


def data_home() -> Path:
    """資料目錄：MHC_HOME／STUDIO_HOME（MHC 優先，套件載入時已同步）＞ ~/.myhermescompany。

    用預設目錄時，若舊的 ~/.hermes-studio-tw 存在而新目錄不存在，自動 rename 搬過去並記 log。
    """
    env = os.environ.get("MHC_HOME") or os.environ.get("STUDIO_HOME")
    if env:
        return Path(env).expanduser()
    home = DEFAULT_HOME.expanduser()
    migrate_legacy_home(home)
    return home


def migrate_legacy_home(new: Path, old: Optional[Path] = None) -> bool:
    old = (old or LEGACY_HOME).expanduser()
    if new.exists() or not old.is_dir():
        return False
    try:
        shutil.move(str(old), str(new))
    except OSError as e:
        log.warning("舊資料目錄 %s 搬到 %s 失敗：%s（繼續用新目錄）", old, new, e)
        return False
    log.warning("已把舊資料目錄 %s 搬到 %s", old, new)
    print(f"已把舊資料目錄 {old} 搬到 {new}", flush=True)
    return True


@dataclass
class Settings:
    port: int = 8700
    host: str = "127.0.0.1"
    db_path: Path = field(default_factory=lambda: DEFAULT_HOME.expanduser() / "studio.db")
    secret: str = ""
    hermes_api_url: str = "http://127.0.0.1:8642"
    hermes_api_key: str = ""
    hermes_home: Path = field(default_factory=lambda: Path("~/.hermes").expanduser())
    hermes_bin: str = "hermes"
    token_ttl_seconds: int = 7 * 24 * 3600
    login_max_failures: int = 5  # 連續失敗幾次鎖定
    login_lock_seconds: int = 15 * 60  # 鎖多久

    @classmethod
    def from_env(cls) -> "Settings":
        s = cls()
        s.port = int(os.environ.get("STUDIO_PORT", s.port))
        s.host = os.environ.get("STUDIO_HOST", s.host)
        s.login_max_failures = int(os.environ.get("STUDIO_LOGIN_MAX_FAILURES", s.login_max_failures))
        s.login_lock_seconds = int(os.environ.get("STUDIO_LOGIN_LOCK_SECONDS", s.login_lock_seconds))
        s.db_path = Path(os.environ["STUDIO_DB"]).expanduser() if os.environ.get("STUDIO_DB") else data_home() / "studio.db"
        s.hermes_home = Path(os.environ.get("HERMES_HOME", str(s.hermes_home))).expanduser()
        s.hermes_api_url = os.environ.get("HERMES_API_URL", s.hermes_api_url).rstrip("/")
        env_file = _read_env_file(s.hermes_home / ".env")
        s.hermes_api_key = os.environ.get("HERMES_API_KEY") or env_file.get("API_SERVER_KEY", "")
        s.hermes_bin = os.environ.get("HERMES_BIN") or _find_hermes_bin()
        s.secret = os.environ.get("STUDIO_SECRET") or _load_or_create_secret(s.db_path.parent)
        return s


def _find_hermes_bin() -> str:
    for cand in (Path("~/.local/bin/hermes").expanduser(), Path("/usr/local/bin/hermes")):
        if cand.exists():
            return str(cand)
    return "hermes"


def _load_or_create_secret(dir_: Path) -> str:
    """Persist a random JWT secret next to the DB so tokens survive restarts."""
    try:
        dir_.mkdir(parents=True, exist_ok=True)
        f = dir_ / "secret.key"
        if f.exists():
            return f.read_text().strip()
        val = secrets.token_urlsafe(48)
        f.write_text(val)
        try:
            f.chmod(0o600)
        except OSError:
            pass
        return val
    except OSError:
        return secrets.token_urlsafe(48)
