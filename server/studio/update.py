"""自我更新：查公開 repo 的最新 release、比版號、下載 wheel。

分成三層，方便測：
- 純函式（`version_key`／`is_newer`／`parse_release_json`／`parse_redirect_location`）不碰網路
- `fetch_latest`（同步，urllib，給 CLI）與 `fetch_latest_async`（httpx，給 /version 端點）
- 快取 6 小時，避免每次開管理頁都打 GitHub

匿名打 `https://api.github.com/repos/<repo>/releases/latest`；403（rate limit）時退回
`https://github.com/<repo>/releases/latest` 的 302 Location 解析 tag——
做法與 `studio/modules/admin/__init__.py` 的 `_github_latest` 一致。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

USER_AGENT = "myhermescompany"
CACHE_TTL = 6 * 3600  # 6 小時


def public_repo() -> str:
    return os.environ.get("MHC_PUBLIC_REPO", "circlechang/myhermes-company")


def update_check_enabled() -> bool:
    """MHC_UPDATE_CHECK=0 關閉；沿用既有的 STUDIO_UPDATE_CHECK 當別名。"""
    off = ("0", "false", "no", "off")
    return (os.environ.get("MHC_UPDATE_CHECK", "1") not in off
            and os.environ.get("STUDIO_UPDATE_CHECK", "1") not in off)


# ------------------------------------------------------------------ 版號比對

def normalize(tag: str) -> str:
    return (tag or "").strip().lstrip("vV")


def version_key(v: str) -> Optional[tuple[int, ...]]:
    """`v0.2.10` → (0, 2, 10)。解析不出來回 None（呼叫端要當「不確定」處理）。"""
    nums = re.findall(r"\d+", normalize(v))
    if not nums:
        return None
    return tuple(int(x) for x in nums[:3])


def is_newer(current: str, latest: str) -> Optional[bool]:
    """latest 比 current 新嗎？任一邊解析不出來回 None。"""
    a, b = version_key(current), version_key(latest)
    if a is None or b is None:
        return None
    a += (0,) * (3 - len(a))
    b += (0,) * (3 - len(b))
    return b > a


# ------------------------------------------------------------------ release

@dataclass
class Release:
    tag: str
    url: str = ""
    notes: str = ""
    published_at: str = ""
    assets: list[dict[str, str]] = field(default_factory=list)
    source: str = "api"  # api | redirect

    @property
    def version(self) -> str:
        return normalize(self.tag)

    def wheel(self) -> Optional[dict[str, str]]:
        for a in self.assets:
            if a.get("name", "").endswith(".whl"):
                return a
        return None

    def notes_summary(self, limit: int = 400, lines: int = 8) -> str:
        body = (self.notes or "").strip()
        if not body:
            return ""
        out = "\n".join(body.splitlines()[:lines])
        return out[:limit] + ("…" if len(out) > limit else "")

    def to_dict(self) -> dict[str, Any]:
        w = self.wheel()
        return {"tag": self.tag, "version": self.version, "url": self.url,
                "published_at": self.published_at, "source": self.source,
                "wheel": w.get("name") if w else None,
                "notes": self.notes_summary()}


def parse_release_json(j: dict[str, Any]) -> Optional[Release]:
    tag = j.get("tag_name") or j.get("name") or ""
    if not tag:
        return None
    assets = []
    for a in j.get("assets") or []:
        name, url = a.get("name"), a.get("browser_download_url")
        if name and url:
            assets.append({"name": name, "url": url})
    return Release(tag=tag, url=j.get("html_url") or "", notes=j.get("body") or "",
                   published_at=j.get("published_at") or "", assets=assets, source="api")


def parse_redirect_location(location: str, repo: str = "") -> Optional[Release]:
    """rate limit 時的退路：`.../releases/tag/v0.2.0` → Release(tag='v0.2.0')。"""
    m = re.search(r"/tag/([^/?#]+)", location or "")
    if not m:
        return None
    return Release(tag=m.group(1), url=location, source="redirect")


# ------------------------------------------------------------------ 抓取

_cache: dict[str, tuple[float, Optional[Release]]] = {}


def cache_clear() -> None:
    _cache.clear()


def _cached(repo: str) -> tuple[bool, Optional[Release]]:
    hit = _cache.get(repo)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return True, hit[1]
    return False, None


def _store(repo: str, rel: Optional[Release]) -> Optional[Release]:
    _cache[repo] = (time.time(), rel)
    return rel


def _get(url: str, timeout: float, redirect: bool = True) -> tuple[int, dict[str, str], bytes]:
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **kw):  # noqa: D401
            return None

    opener = urllib.request.build_opener(*([] if redirect else [_NoRedirect]))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "application/vnd.github+json"})
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:  # 403／404／302（不跟隨時也走這裡）
        return e.code, dict(e.headers or {}), e.read() if e.fp else b""


def fetch_latest(repo: Optional[str] = None, timeout: float = 8.0,
                 use_cache: bool = True) -> Optional[Release]:
    """同步版（CLI 用）。抓不到回 None，不丟例外。"""
    repo = repo or public_repo()
    if use_cache:
        ok, rel = _cached(repo)
        if ok:
            return rel
    try:
        status, _, body = _get(f"https://api.github.com/repos/{repo}/releases/latest", timeout)
        if status == 200:
            return _store(repo, parse_release_json(json.loads(body.decode("utf-8"))))
        # 403 rate limit／其他：退回人看的 releases/latest 重導向
        status, headers, _ = _get(f"https://github.com/{repo}/releases/latest", timeout, redirect=False)
        loc = headers.get("Location") or headers.get("location") or ""
        return _store(repo, parse_redirect_location(loc, repo))
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return _store(repo, None)


async def fetch_latest_async(repo: Optional[str] = None, timeout: float = 6.0,
                             use_cache: bool = True) -> Optional[Release]:
    """非同步版（/version 端點用）。"""
    import httpx

    repo = repo or public_repo()
    if use_cache:
        ok, rel = _cached(repo)
        if ok:
            return rel
    try:
        async with httpx.AsyncClient(timeout=timeout, headers={"User-Agent": USER_AGENT}) as c:
            r = await c.get(f"https://api.github.com/repos/{repo}/releases/latest")
            if r.status_code == 200:
                return _store(repo, parse_release_json(r.json()))
            r = await c.get(f"https://github.com/{repo}/releases/latest", follow_redirects=False)
            return _store(repo, parse_redirect_location(r.headers.get("location", ""), repo))
    except (httpx.HTTPError, ValueError):
        return _store(repo, None)


# ------------------------------------------------------------------ 狀態摘要

def status(current: str, repo: Optional[str] = None, rel: Optional[Release] = None,
           checked: bool = True) -> dict[str, Any]:
    """給 CLI --json 與 /version 端點共用的一份結構。"""
    repo = repo or public_repo()
    out: dict[str, Any] = {"repo": repo, "current": normalize(current),
                           "check_enabled": update_check_enabled(),
                           "latest": None, "update_available": None, "release": None}
    if not checked or rel is None:
        return out
    out["latest"] = rel.version
    out["update_available"] = is_newer(current, rel.tag)
    out["release"] = rel.to_dict()
    return out


def download(url: str, name: str, dest_dir: str, timeout: float = 120.0) -> str:
    """下載到 dest_dir，**保留原檔名**——pip 會拒絕被改名的 wheel。"""
    import pathlib

    # 檔名直接來自 GitHub 的 asset name，當成不可信輸入：只收「乾淨的單一檔名」。
    if (not name or name != os.path.basename(name) or name in (".", "..")
            or "/" in name or "\\" in name or name.startswith(".")):
        raise ValueError(f"wheel 檔名不合法：{name!r}")
    target = pathlib.Path(dest_dir) / name
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                               "Accept": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(target, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    return str(target)
