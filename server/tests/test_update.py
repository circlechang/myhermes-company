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
