"""`myhermescompany update` 與站內新版提示（studio/update.py ＋ /version、/version/studio）。"""
from __future__ import annotations

import re
import json
import urllib.error

import pytest

from studio import __version__ as CURRENT
from studio import update as up

REPO = "circlechang/myhermes-company"


@pytest.fixture(autouse=True)
def _clean_cache(monkeypatch):
    up.cache_clear()
    monkeypatch.delenv("MHC_UPDATE_CHECK", raising=False)
    monkeypatch.delenv("STUDIO_UPDATE_CHECK", raising=False)
    yield
    up.cache_clear()



# 假的「最新版」要永遠比目前版號新，否則每次 bump 版號測試就會壞。
def _next_version(v: str) -> str:
    parts = [int(x) for x in re.findall(r"\d+", v)[:3]] or [0, 0, 0]
    while len(parts) < 3:
        parts.append(0)
    parts[1] += 1
    parts[2] = 0
    return ".".join(str(x) for x in parts)


NEWER = _next_version(CURRENT)
NEWER_TAG = f"v{NEWER}"

API_JSON = {
    "tag_name": NEWER_TAG,
    "html_url": f"https://github.com/{REPO}/releases/tag/{NEWER_TAG}",
    "published_at": "2026-09-01T00:00:00Z",
    "body": "新增 update 子命令\n修好一堆版面問題\n" + ("細節 " * 300),
    "assets": [
        {"name": "notes.txt", "browser_download_url": "https://x/notes.txt"},
        {"name": f"myhermescompany-{NEWER}-py3-none-any.whl", "browser_download_url": "https://x/w.whl"},
    ],
}


# ------------------------------------------------------------------ 版號比對

@pytest.mark.parametrize(
    "cur, latest, expect",
    [
        ("0.1.0", "v0.2.0", True),      # 有新版
        ("0.1.0", "v0.1.0", False),     # 同版
        ("0.1.0", "0.1.0", False),      # 沒有 v 前綴也一樣
        ("0.2.0", "v0.1.9", False),     # 本機比較新（開發中）
        ("0.1.0", "v0.1.1", True),
        ("0.1.0", "v1.0.0", True),
        ("0.9.0", "v0.10.0", True),     # 數字比較不是字串比較
        ("0.1", "v0.1.0", False),       # 位數不同要補 0
        ("0.1.0", "nightly", None),     # 版號解析不出來 → 不確定
        ("", "v0.2.0", None),
    ],
)
def test_is_newer(cur, latest, expect):
    assert up.is_newer(cur, latest) is expect


def test_version_key():
    assert up.version_key("v1.2.3") == (1, 2, 3)
    assert up.version_key("V1.2.3-rc1") == (1, 2, 3)
    assert up.version_key("latest") is None


# ------------------------------------------------------------------ 解析

def test_parse_release_json_picks_the_wheel():
    rel = up.parse_release_json(API_JSON)
    assert rel and rel.tag == NEWER_TAG and rel.version == NEWER
    assert rel.wheel() == {"name": f"myhermescompany-{NEWER}-py3-none-any.whl", "url": "https://x/w.whl"}
    assert rel.source == "api"


def test_parse_release_json_without_assets():
    rel = up.parse_release_json({"tag_name": "v0.3.0"})
    assert rel and rel.wheel() is None


def test_parse_release_json_needs_a_tag():
    assert up.parse_release_json({"body": "x"}) is None


def test_notes_summary_is_trimmed():
    rel = up.parse_release_json(API_JSON)
    s = rel.notes_summary()
    assert s.startswith("新增 update 子命令") and len(s) <= 401 and s.endswith("…")


def test_parse_redirect_location():
    rel = up.parse_redirect_location(f"https://github.com/{REPO}/releases/tag/v0.4.1")
    assert rel and rel.tag == "v0.4.1" and rel.source == "redirect" and rel.wheel() is None
    assert up.parse_redirect_location("https://github.com/login") is None
    assert up.parse_redirect_location("") is None


# ------------------------------------------------------------------ 抓取（含 rate limit 退路）

def test_fetch_latest_uses_api(monkeypatch):
    calls = []

    def fake_get(url, timeout, redirect=True):
        calls.append(url)
        return 200, {}, json.dumps(API_JSON).encode()

    monkeypatch.setattr(up, "_get", fake_get)
    rel = up.fetch_latest(REPO)
    assert rel and rel.tag == NEWER_TAG
    assert calls == [f"https://api.github.com/repos/{REPO}/releases/latest"]


def test_fetch_latest_falls_back_to_redirect_on_403(monkeypatch):
    """403 rate limit → 退回 releases/latest 的 302 Location。"""
    calls = []

    def fake_get(url, timeout, redirect=True):
        calls.append((url, redirect))
        if url.startswith("https://api.github.com"):
            return 403, {}, b'{"message": "API rate limit exceeded"}'
        return 302, {"Location": f"https://github.com/{REPO}/releases/tag/v0.5.0"}, b""

    monkeypatch.setattr(up, "_get", fake_get)
    rel = up.fetch_latest(REPO)
    assert rel and rel.tag == "v0.5.0" and rel.source == "redirect"
    assert calls[0][1] is True and calls[1][1] is False  # 退路不跟隨重導向


def test_fetch_latest_falls_back_on_404_too(monkeypatch):
    def fake_get(url, timeout, redirect=True):
        if url.startswith("https://api.github.com"):
            return 404, {}, b'{"message": "Not Found"}'
        return 302, {"location": f"https://github.com/{REPO}/releases/tag/v0.6.0"}, b""

    monkeypatch.setattr(up, "_get", fake_get)
    assert up.fetch_latest(REPO).tag == "v0.6.0"


def test_fetch_latest_returns_none_when_offline(monkeypatch):
    def boom(url, timeout, redirect=True):
        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr(up, "_get", boom)
    assert up.fetch_latest(REPO) is None


def test_fetch_latest_returns_none_when_no_release_anywhere(monkeypatch):
    def fake_get(url, timeout, redirect=True):
        if url.startswith("https://api.github.com"):
            return 404, {}, b"{}"
        return 404, {}, b""

    monkeypatch.setattr(up, "_get", fake_get)
    assert up.fetch_latest(REPO) is None


def test_fetch_latest_caches_for_six_hours(monkeypatch):
    n = {"calls": 0}

    def fake_get(url, timeout, redirect=True):
        n["calls"] += 1
        return 200, {}, json.dumps(API_JSON).encode()

    monkeypatch.setattr(up, "_get", fake_get)
    assert up.fetch_latest(REPO).tag == NEWER_TAG
    assert up.fetch_latest(REPO).tag == NEWER_TAG
    assert n["calls"] == 1
    assert up.CACHE_TTL == 6 * 3600
    up.fetch_latest(REPO, use_cache=False)
    assert n["calls"] == 2


def test_failed_fetch_is_also_cached(monkeypatch):
    """抓不到也要快取，不然每次開頁都去撞牆。"""
    n = {"calls": 0}

    def boom(url, timeout, redirect=True):
        n["calls"] += 1
        raise urllib.error.URLError("down")

    monkeypatch.setattr(up, "_get", boom)
    assert up.fetch_latest(REPO) is None
    assert up.fetch_latest(REPO) is None
    assert n["calls"] == 1


# ------------------------------------------------------------------ 開關與 status

@pytest.mark.parametrize("var", ["MHC_UPDATE_CHECK", "STUDIO_UPDATE_CHECK"])
@pytest.mark.parametrize("val", ["0", "false", "no", "off"])
def test_update_check_can_be_disabled(monkeypatch, var, val):
    monkeypatch.setenv(var, val)
    assert up.update_check_enabled() is False


def test_update_check_on_by_default():
    assert up.update_check_enabled() is True


def test_status_shape():
    rel = up.parse_release_json(API_JSON)
    st = up.status("0.1.0", REPO, rel)
    assert st["current"] == "0.1.0" and st["latest"] == NEWER and st["update_available"] is True
    assert st["release"]["wheel"].endswith(".whl") and st["repo"] == REPO
    st_none = up.status("0.1.0", REPO, None)
    assert st_none["latest"] is None and st_none["update_available"] is None


def test_download_keeps_the_original_filename(monkeypatch, tmp_path):
    """pip 會拒絕被改名的 wheel，所以檔名一定要原封不動。"""
    class FakeResp:
        def __init__(self):
            self.done = False

        def read(self, _n):
            if self.done:
                return b""
            self.done = True
            return b"PK\x03\x04wheel"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(up.urllib.request, "urlopen", lambda *a, **k: FakeResp())
    path = up.download("https://x/whatever", "myhermescompany-0.2.0-py3-none-any.whl", str(tmp_path))
    assert path.endswith("/myhermescompany-0.2.0-py3-none-any.whl")
    assert (tmp_path / "myhermescompany-0.2.0-py3-none-any.whl").read_bytes() == b"PK\x03\x04wheel"


def test_download_rejects_path_traversal_in_the_asset_name(tmp_path):
    with pytest.raises(ValueError):
        up.download("https://x/y", "../../evil.whl", str(tmp_path))


# ------------------------------------------------------------------ CLI

def _run_cli(argv):
    from studio import cli
    ns = cli.build_parser().parse_args(argv)
    return ns.fn(ns)


def test_cli_check_says_up_to_date(monkeypatch, capsys):
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: up.Release(tag=f"v{CURRENT}"))
    assert _run_cli(["update", "--check"]) == 0
    assert f"已是最新版 v{CURRENT}" in capsys.readouterr().out


def test_cli_check_json_is_machine_readable(monkeypatch, capsys):
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: up.parse_release_json(API_JSON))
    assert _run_cli(["update", "--check", "--json"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["current"] == CURRENT and data["latest"] == NEWER
    assert data["update_available"] is True
    assert data["release"]["wheel"].endswith(".whl")


def test_cli_check_does_not_install(monkeypatch, capsys):
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: up.parse_release_json(API_JSON))
    monkeypatch.setattr("studio.cli._pip_install", lambda w: pytest.fail("--check 不該安裝"))
    assert _run_cli(["update", "--check"]) == 0
    assert f"有新版 {NEWER_TAG}" in capsys.readouterr().out


def test_cli_reports_when_github_is_unreachable(monkeypatch, capsys):
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: None)
    assert _run_cli(["update", "--check"]) == 1
    assert "查不到" in capsys.readouterr().err


def test_cli_unreachable_json_carries_the_error(monkeypatch, capsys):
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: None)
    assert _run_cli(["update", "--check", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["error"]


def test_cli_asks_before_installing(monkeypatch, capsys):
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: up.parse_release_json(API_JSON))
    monkeypatch.setattr("builtins.input", lambda _p="": "n")
    monkeypatch.setattr("studio.cli._pip_install", lambda w: pytest.fail("使用者說 n 卻還是裝了"))
    assert _run_cli(["update"]) == 2
    assert "取消" in capsys.readouterr().out


def test_cli_installs_then_restarts_with_yes(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: up.parse_release_json(API_JSON))
    monkeypatch.setattr(up, "download", lambda url, name, d, **k: str(tmp_path / name))
    seen = {}
    monkeypatch.setattr("studio.cli._pip_install", lambda w: (seen.setdefault("wheel", w), (0, "ok"))[1])
    monkeypatch.setattr("studio.cli.running_pid", lambda pf: 4242)
    monkeypatch.setattr("studio.cli.recorded_port", lambda pf=None: 8712)
    monkeypatch.setattr("studio.cli.read_meta", lambda pf: {"host": "127.0.0.1"})
    monkeypatch.setattr("studio.cli.cmd_restart", lambda a: seen.setdefault("restart", (a.port, a.host)) and 0 or 0)
    assert _run_cli(["update", "--yes"]) == 0
    assert seen["wheel"].endswith(f"myhermescompany-{NEWER}-py3-none-any.whl")
    assert seen["restart"] == (8712, "127.0.0.1")


def test_cli_keeps_the_old_version_when_pip_fails(monkeypatch, capsys, tmp_path):
    """pip 的 upgrade 失敗不會動到已安裝版本；CLI 也不可以往下重啟。"""
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: up.parse_release_json(API_JSON))
    monkeypatch.setattr(up, "download", lambda url, name, d, **k: str(tmp_path / name))
    monkeypatch.setattr("studio.cli._pip_install", lambda w: (1, "ERROR: could not build wheel"))
    monkeypatch.setattr("studio.cli.cmd_restart", lambda a: pytest.fail("安裝失敗不該重啟"))
    assert _run_cli(["update", "--yes"]) == 1
    err = capsys.readouterr().err
    assert "安裝失敗" in err and CURRENT in err
    from studio import __version__ as still
    assert still == CURRENT


def test_cli_stops_when_release_has_no_wheel(monkeypatch, capsys):
    monkeypatch.setattr(up, "fetch_latest", lambda *a, **k: up.Release(tag="v9.9.9", url="https://x"))
    monkeypatch.setattr("studio.cli._pip_install", lambda w: pytest.fail("沒有 wheel 卻還是裝了"))
    assert _run_cli(["update", "--yes"]) == 1
    assert "沒有附 wheel" in capsys.readouterr().err


def test_cli_pip_uses_the_running_interpreter():
    import inspect

    from studio import cli
    src = inspect.getsource(cli._pip_install)
    assert "sys.executable" in src and "--upgrade" in src


# ------------------------------------------------------------------ 站內端點

def _patch_async(monkeypatch, rel):
    async def fake(*a, **k):
        return rel
    monkeypatch.setattr(up, "fetch_latest_async", fake)


def test_version_endpoint_carries_studio_update_fields(client, auth, app, monkeypatch):
    async def fake_run(*args, timeout=30.0):
        return "Hermes Agent v0.20.5 (2026.8.19)"
    app.state.fake_cli._run = fake_run
    _patch_async(monkeypatch, up.parse_release_json(API_JSON))
    monkeypatch.setattr(up, "is_newer", lambda cur, tag: True)
    d = client.get("/version", headers=auth).json()
    assert d["studio_latest"] == NEWER and d["studio_update_available"] is True
    assert d["studio_release"]["tag"] == NEWER_TAG
    assert d["studio_update_cmd"] == "myhermescompany update"
    assert d["studio_repo"]


def test_version_studio_endpoint_does_not_call_hermes(client, auth, app, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("/version/studio 不該呼叫 hermes CLI")
    app.state.fake_cli._run = boom
    _patch_async(monkeypatch, up.parse_release_json(API_JSON))
    r = client.get("/version/studio", headers=auth)
    assert r.status_code == 200
    d = r.json()
    assert d["studio"]["version"] and d["studio_latest"] == NEWER


def test_version_studio_says_up_to_date(client, auth, monkeypatch):
    _patch_async(monkeypatch, up.Release(tag=f"v{CURRENT}"))
    d = client.get("/version/studio", headers=auth).json()
    assert d["studio_update_available"] is False


def test_version_studio_survives_github_being_down(client, auth, monkeypatch):
    _patch_async(monkeypatch, None)
    d = client.get("/version/studio", headers=auth).json()
    assert d["studio_latest"] is None and d["studio_update_available"] is None


def test_studio_update_check_can_be_turned_off(client, auth, monkeypatch):
    monkeypatch.setenv("MHC_UPDATE_CHECK", "0")

    async def fake(*a, **k):
        raise AssertionError("關掉了還去打 GitHub")
    monkeypatch.setattr(up, "fetch_latest_async", fake)
    d = client.get("/version/studio", headers=auth).json()
    assert d["studio_update_check_enabled"] is False and d["studio_latest"] is None


def test_version_studio_requires_auth(client):
    assert client.get("/version/studio").status_code in (401, 403)


# ------------------------------------------------------------------ 站內一鍵更新
#
# 分成三段：wheel 驗證（純函式，不碰網路）／端點（要擋掉可編輯安裝、下載失敗不動安裝）／
# 更新器（真的 spawn 一支 python 出去跑，用假的 pip 腳本模擬失敗）。

import os
import re as _re
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from studio import updater
from studio.errors import ApiError
from studio.modules.admin import selfupdate as su

WHEEL_NAME = f"myhermescompany-{NEWER}-py3-none-any.whl"


def _make_wheel(path: Path, *, version: str = NEWER, dist: str = "myhermescompany",
                meta_version: str = "", with_studio: bool = True) -> Path:
    """做一顆長得像真 wheel 的最小 zip（塞夠大，才不會撞到「太小」那道防線）。"""
    with zipfile.ZipFile(path, "w") as z:
        if with_studio:
            z.writestr("studio/__init__.py", f'__version__ = "{version}"\n')
        z.writestr(f"{dist}-{version}.dist-info/METADATA",
                   f"Metadata-Version: 2.1\nName: {dist}\nVersion: {meta_version or version}\n")
        z.writestr(f"{dist}-{version}.dist-info/WHEEL", "Wheel-Version: 1.0\n")
        z.writestr(f"{dist}-{version}.dist-info/RECORD", "".join(f"pad-{i}\n" for i in range(4000)))
    return path


# ---- wheel 名稱 ----

@pytest.mark.parametrize("name", [
    WHEEL_NAME,
    f"MyHermesCompany-{NEWER}-py3-none-any.whl",  # 大小寫正規化後同名
])
def test_check_wheel_name_accepts_ours(name):
    dist, ver = su.check_wheel_name(name, NEWER)
    assert ver == NEWER and su._norm_dist(dist) == "myhermescompany"


@pytest.mark.parametrize("name", [
    "../../etc/passwd",                      # 路徑穿越
    "/tmp/evil.whl",
    ".hidden.whl",
    "myhermescompany-9.9.9-py3-none-any.whl",  # 版本不符
    "requests-2.32.0-py3-none-any.whl",        # 不是我們的套件
    "myhermescompany-0.2.0.tar.gz",            # 不是 wheel
    "",
])
def test_check_wheel_name_rejects(name):
    with pytest.raises(ApiError) as e:
        su.check_wheel_name(name, NEWER)
    assert e.value.status in (400, 422)


# ---- wheel 內容 ----

def test_verify_wheel_accepts_a_real_looking_wheel(tmp_path):
    w = _make_wheel(tmp_path / WHEEL_NAME)
    assert su.verify_wheel(w, "myhermescompany", NEWER) == w.stat().st_size


def test_verify_wheel_rejects_a_broken_zip(tmp_path):
    w = tmp_path / WHEEL_NAME
    w.write_bytes(b"<html>404 Not Found</html>" * 2000)  # 夠大但不是 zip
    with pytest.raises(ApiError) as e:
        su.verify_wheel(w, "myhermescompany", NEWER)
    assert e.value.code == "bad_wheel" and "zip" in e.value.message


def test_verify_wheel_rejects_a_tiny_file(tmp_path):
    w = tmp_path / WHEEL_NAME
    w.write_bytes(b"PK")
    with pytest.raises(ApiError):
        su.verify_wheel(w, "myhermescompany", NEWER)


def test_verify_wheel_rejects_wrong_inner_version(tmp_path):
    w = _make_wheel(tmp_path / WHEEL_NAME, meta_version="9.9.9")
    with pytest.raises(ApiError) as e:
        su.verify_wheel(w, "myhermescompany", NEWER)
    assert "內部版號" in e.value.message


def test_verify_wheel_rejects_someone_elses_package(tmp_path):
    w = _make_wheel(tmp_path / WHEEL_NAME, with_studio=False)
    with pytest.raises(ApiError) as e:
        su.verify_wheel(w, "myhermescompany", NEWER)
    assert "studio/" in e.value.message


def test_verify_wheel_rejects_crc_corruption(tmp_path):
    w = _make_wheel(tmp_path / WHEEL_NAME)
    raw = bytearray(w.read_bytes())
    raw[len(raw) // 2] ^= 0xFF  # 翻一個 byte，CRC 就對不上
    w.write_bytes(bytes(raw))
    with pytest.raises(ApiError) as e:
        su.verify_wheel(w, "myhermescompany", NEWER)
    assert e.value.code == "bad_wheel"


# ---- 狀態檔 ----

def test_status_file_roundtrip_and_merge(tmp_path):
    su.write_status(tmp_path, job_id="up_1", phase="downloading", **{"from": "0.1.0", "to": NEWER})
    su.write_status(tmp_path, phase="installing")
    st = su.read_status(tmp_path)
    assert st["job_id"] == "up_1" and st["phase"] == "installing" and st["to"] == NEWER
    assert st["updated_at"]


def test_status_file_missing_or_garbage_reads_as_none(tmp_path):
    assert su.read_status(tmp_path) is None
    (tmp_path / "update-status.json").write_text("{ not json")
    assert su.read_status(tmp_path) is None


def test_status_write_is_atomic_no_tmp_left(tmp_path):
    su.write_status(tmp_path, phase="done")
    assert not list(tmp_path.glob("*.tmp"))


# ---- 端點 ----

@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    (h / "logs").mkdir(parents=True)
    monkeypatch.setattr(su, "home_dir", lambda: h)
    monkeypatch.setattr(su, "_request_shutdown", lambda *a, **k: None)  # 別把 pytest 自己 SIGTERM 掉
    return h


def _not_editable(monkeypatch):
    monkeypatch.setattr(su, "editable_reason", lambda: None)


def test_update_start_blocked_on_editable_install(client, auth, home, monkeypatch):
    monkeypatch.setattr(su, "editable_reason", lambda: "可編輯安裝（pip install -e /repo）")
    r = client.post("/admin/update/start", json={}, headers=auth)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "editable_install"
    assert "git pull" in r.json()["error"]["message"]
    assert su.read_status(home) is None  # 完全沒動，連狀態檔都不寫


def test_version_studio_reports_editable_install(client, auth, monkeypatch):
    _patch_async(monkeypatch, up.parse_release_json(API_JSON))
    monkeypatch.setattr(su, "editable_reason", lambda: "可編輯安裝（pip install -e /repo）")
    d = client.get("/version/studio", headers=auth).json()
    assert d["studio_editable_install"] is True and "-e" in d["studio_editable_reason"]


def test_update_status_endpoint_reads_the_file(client, auth, home, monkeypatch):
    _not_editable(monkeypatch)
    su.write_status(home, job_id="up_x", phase="restarting", **{"from": "0.1.0", "to": NEWER})
    d = client.get("/admin/update/status", headers=auth).json()
    assert d["job"]["phase"] == "restarting" and d["job"]["job_id"] == "up_x"
    assert d["current"] and d["editable"] is False


def test_update_status_requires_owner(client, app, home, monkeypatch):
    _not_editable(monkeypatch)
    from sqlmodel import Session, select

    from studio.auth import hash_password
    from studio.models import Member

    with Session(app.state.engine) as db:
        owner = db.exec(select(Member).where(Member.role == "owner")).first()
        m = Member(company_id=owner.company_id, username="bob", password_hash=hash_password("password123"),
                   role="member", display_name="Bob")
        db.add(m)
        db.commit()
    tok = client.post("/auth/login", json={"username": "bob", "password": "password123"}).json()["token"]
    r = client.get("/admin/update/status", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 403


def test_update_start_rejects_when_already_up_to_date(client, auth, home, monkeypatch):
    _not_editable(monkeypatch)
    _patch_async(monkeypatch, up.Release(tag=f"v{CURRENT}"))
    r = client.post("/admin/update/start", json={}, headers=auth)
    assert r.status_code == 409 and r.json()["error"]["code"] == "up_to_date"


def test_update_start_rejects_version_mismatch(client, auth, home, monkeypatch):
    _not_editable(monkeypatch)
    _patch_async(monkeypatch, up.parse_release_json(API_JSON))
    r = client.post("/admin/update/start", json={"to": "9.9.9"}, headers=auth)
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_mismatch"


def test_update_start_rejects_release_without_wheel(client, auth, home, monkeypatch):
    _not_editable(monkeypatch)
    _patch_async(monkeypatch, up.Release(tag=NEWER_TAG))
    r = client.post("/admin/update/start", json={}, headers=auth)
    assert r.status_code == 422 and r.json()["error"]["code"] == "no_wheel"


def test_update_start_rejects_a_renamed_wheel_without_downloading(client, auth, home, monkeypatch):
    """檔名被動過手腳 → 連下載都不該發生。"""
    _not_editable(monkeypatch)
    rel = up.Release(tag=NEWER_TAG, assets=[{"name": "../../evil.whl", "url": "https://x/w.whl"}])
    _patch_async(monkeypatch, rel)

    def boom(*a, **k):
        raise AssertionError("檔名不合法時不該下載")

    monkeypatch.setattr(up, "download", boom)
    r = client.post("/admin/update/start", json={}, headers=auth)
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_wheel"


def test_update_start_bad_zip_fails_without_spawning_anything(client, auth, home, monkeypatch):
    """下載得到但不是合法 wheel：回錯、狀態記 failed、不 spawn 更新器、暫存清掉。"""
    _not_editable(monkeypatch)
    _patch_async(monkeypatch, up.parse_release_json(API_JSON))

    def fake_download(url, name, dest_dir, timeout=120.0):
        p = Path(dest_dir) / name
        p.write_bytes(b"<html>rate limited</html>" * 2000)
        return str(p)

    monkeypatch.setattr(up, "download", fake_download)

    def boom(*a, **k):
        raise AssertionError("驗證沒過就不該 spawn 更新器")

    monkeypatch.setattr(su.subprocess, "Popen", boom)
    r = client.post("/admin/update/start", json={}, headers=auth)
    assert r.status_code == 422 and r.json()["error"]["code"] == "bad_wheel"
    st = su.read_status(home)
    assert st["phase"] == "failed" and st["to"] == NEWER
    assert not list((home / "updates").glob("*/*"))  # job 目錄已清掉


def test_update_start_download_error_does_not_touch_the_install(client, auth, home, monkeypatch):
    _not_editable(monkeypatch)
    _patch_async(monkeypatch, up.parse_release_json(API_JSON))

    def fake_download(*a, **k):
        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr(up, "download", fake_download)
    monkeypatch.setattr(su.subprocess, "Popen",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("不該 spawn")))
    r = client.post("/admin/update/start", json={}, headers=auth)
    assert r.status_code == 502 and r.json()["error"]["code"] == "download_failed"
    assert su.read_status(home)["phase"] == "failed"


def test_update_start_happy_path_spawns_a_detached_updater(client, auth, home, monkeypatch):
    _not_editable(monkeypatch)
    _patch_async(monkeypatch, up.parse_release_json(API_JSON))
    monkeypatch.setattr(up, "download",
                        lambda url, name, dest, timeout=120.0: str(_make_wheel(Path(dest) / name)))
    seen: dict = {}

    class FakePopen:
        def __init__(self, argv, **kw):
            seen["argv"], seen["kw"] = argv, kw

    monkeypatch.setattr(su.subprocess, "Popen", FakePopen)
    shut = []
    monkeypatch.setattr(su, "_request_shutdown", lambda *a, **k: shut.append(1))

    r = client.post("/admin/update/start", json={"to": NEWER}, headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "starting" and body["job_id"].startswith("up_")
    assert body["to"] == NEWER and body["from"] == CURRENT and body["log"].endswith(".log")

    # 脫離：新 session、不繼承 stdin、log 導到檔案
    assert seen["kw"]["start_new_session"] is True
    assert seen["kw"]["stdin"] == subprocess.DEVNULL
    argv = seen["argv"]
    assert argv[0] == sys.executable and argv[1].endswith("updater.py")
    assert Path(argv[1]).exists(), "更新器要先被複製出來，pip 換掉套件才扯不到它"
    assert f"--pid" in argv and str(os.getpid()) in argv
    assert su.read_status(home)["phase"] == "downloading"
    assert shut == [1], "回應送出後要安排自己退場"


def test_update_start_refuses_a_second_job_while_one_is_running(client, auth, home, monkeypatch):
    _not_editable(monkeypatch)
    su.write_status(home, job_id="up_old", phase="installing")
    _patch_async(monkeypatch, up.parse_release_json(API_JSON))
    r = client.post("/admin/update/start", json={}, headers=auth)
    assert r.status_code == 409 and r.json()["error"]["code"] == "busy"


# ---- 更新器（真的跑一支 python 出去） ----

def _run_updater(home: Path, wheel: Path, env_extra: dict, pid: int = 0) -> subprocess.CompletedProcess:
    env = dict(os.environ, **env_extra)
    return subprocess.run(
        [sys.executable, updater.__file__, "--home", str(home), "--wheel", str(wheel),
         "--pid", str(pid), "--job", "up_test", "--from", "0.1.0", "--to", NEWER,
         "--python", sys.executable],
        capture_output=True, text=True, timeout=120, env=env)


def _fake_script(path: Path, code: int, msg: str) -> Path:
    path.write_text(f"import sys\nsys.stderr.write({msg!r})\nsys.exit({code})\n")
    return path


def test_updater_installs_then_starts(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    wheel = _make_wheel(tmp_path / WHEEL_NAME)
    pip_ok = _fake_script(tmp_path / "pip_ok.py", 0, "Successfully installed\n")
    start_ok = _fake_script(tmp_path / "start_ok.py", 0, "started\n")
    p = _run_updater(home, wheel, {
        "MHC_UPDATER_PIP": json.dumps([sys.executable, str(pip_ok)]),
        "MHC_UPDATER_START": json.dumps([sys.executable, str(start_ok)]),
    })
    assert p.returncode == 0, p.stdout + p.stderr
    st = json.loads((home / "update-status.json").read_text())
    assert st["phase"] == "done" and st["to"] == NEWER and st["finished_at"]


def test_updater_restarts_the_old_version_when_pip_fails(tmp_path):
    """pip 升級失敗不會動到已安裝版本 → 一定要把舊版起回來，並在狀態檔說明原因。"""
    home = tmp_path / "home"
    home.mkdir()
    wheel = _make_wheel(tmp_path / WHEEL_NAME)
    pip_bad = _fake_script(tmp_path / "pip_bad.py", 1, "ERROR: 沒有磁碟空間了\n")
    started = tmp_path / "started.flag"
    start_ok = tmp_path / "start_ok.py"
    start_ok.write_text(f"open({str(started)!r}, 'w').write('x')\n")
    p = _run_updater(home, wheel, {
        "MHC_UPDATER_PIP": json.dumps([sys.executable, str(pip_bad)]),
        "MHC_UPDATER_START": json.dumps([sys.executable, str(start_ok)]),
    })
    assert p.returncode == 1
    assert started.exists(), "pip 失敗也要把服務起回來"
    st = json.loads((home / "update-status.json").read_text())
    assert st["phase"] == "failed" and st["restarted_old"] is True
    assert "沒有磁碟空間" in st["error"]


def test_updater_reports_failure_when_restart_also_fails(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    wheel = _make_wheel(tmp_path / WHEEL_NAME)
    pip_ok = _fake_script(tmp_path / "pip_ok.py", 0, "ok\n")
    start_bad = _fake_script(tmp_path / "start_bad.py", 2, "port 已被占用\n")
    p = _run_updater(home, wheel, {
        "MHC_UPDATER_PIP": json.dumps([sys.executable, str(pip_ok)]),
        "MHC_UPDATER_START": json.dumps([sys.executable, str(start_bad)]),
    })
    assert p.returncode == 1
    st = json.loads((home / "update-status.json").read_text())
    assert st["phase"] == "failed" and "重啟失敗" in st["error"]


def test_updater_waits_for_the_old_server_to_exit(tmp_path):
    """更新器要等父程序真的退場才動 pip——不然會裝到一半被舊程序的檔案鎖住。"""
    home = tmp_path / "home"
    home.mkdir()
    wheel = _make_wheel(tmp_path / WHEEL_NAME)
    # 孫程序：中間那層馬上退場，孫子被 init 收養，退出時會被正常回收（不會留成 zombie
    # 讓 os.kill(pid, 0) 誤判成「還活著」）——這也才貼近真實情況：更新器不是伺服器的父程序。
    spawner = subprocess.Popen(
        [sys.executable, "-c",
         "import subprocess,sys;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(3)']);"
         "print(p.pid,flush=True)"],
        stdout=subprocess.PIPE, text=True)
    victim_pid = int(spawner.stdout.readline().strip())
    spawner.wait()
    stamp = tmp_path / "pip_ran_at.txt"
    pip_script = tmp_path / "pip.py"
    pip_script.write_text(f"import time\nopen({str(stamp)!r},'w').write(str(time.time()))\n")
    start_ok = _fake_script(tmp_path / "start_ok.py", 0, "ok\n")
    t0 = time.time()
    p = _run_updater(home, wheel, {
        "MHC_UPDATER_PIP": json.dumps([sys.executable, str(pip_script)]),
        "MHC_UPDATER_START": json.dumps([sys.executable, str(start_ok)]),
    }, pid=victim_pid)
    assert p.returncode == 0, p.stdout + p.stderr
    assert float(stamp.read_text()) - t0 >= 2.5, "pip 不該在舊伺服器還活著時就跑"


def test_updater_status_survives_a_restart_of_the_reader(tmp_path):
    """狀態放檔案不是記憶體：換一個程序去讀，一樣讀得到。"""
    home = tmp_path / "home"
    home.mkdir()
    updater.write_status(home / "update-status.json", job_id="up_z", phase="restarting")
    out = subprocess.run([sys.executable, "-c",
                          f"import json;print(json.load(open({str(home / 'update-status.json')!r}))['phase'])"],
                         capture_output=True, text=True)
    assert out.stdout.strip() == "restarting"


def test_updater_falls_back_to_uv_when_pip_is_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(updater, "has_pip", lambda py: False)
    monkeypatch.setattr(updater.shutil, "which", lambda name: "/opt/uv" if name == "uv" else None)
    argv = updater.install_argv("/venv/bin/python", "/tmp/x.whl")
    assert argv == ["/opt/uv", "pip", "install", "--python", "/venv/bin/python", "--upgrade", "/tmp/x.whl"]


def test_updater_uses_pip_of_the_given_interpreter(monkeypatch):
    monkeypatch.setattr(updater, "has_pip", lambda py: True)
    assert updater.install_argv("/venv/bin/python", "/tmp/x.whl") == \
        ["/venv/bin/python", "-m", "pip", "install", "--upgrade", "/tmp/x.whl"]


def test_updater_is_importable_without_the_studio_package(tmp_path):
    """更新器被複製出去單獨跑，所以不能相依 studio（pip 正在把它換掉）。"""
    copy = tmp_path / "updater.py"
    copy.write_text(Path(updater.__file__).read_text())
    p = subprocess.run([sys.executable, str(copy), "--help"], capture_output=True, text=True,
                       cwd=str(tmp_path), env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"})
    assert p.returncode == 0 and "mhc-updater" in p.stdout
    src = Path(updater.__file__).read_text()
    assert not _re.search(r"^\s*(from|import)\s+studio\b", src, _re.M), "更新器不可以 import studio"
