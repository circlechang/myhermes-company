"""契約測試執行器：對一個 Hermes（gateway URL + HERMES_HOME + hermes 執行檔）跑 surface.yaml 的每一項。

設計原則
- 唯讀優先：endpoint 預設用「route probe」（假 id／空 body → 結構化 JSON 錯誤）驗路由存在；
  只有 `writes=True`（正式環境 --writes）或 `sandbox=True`（預檢）才做會建資料的 live 呼叫，並在結束時清掉。
- 絕不動使用者資料：cleanup 只清自己建的（run stop、job delete、task archive）。
- 每項獨立 try/except，一項炸掉不影響其他項。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx
import yaml

from .report import build_report
from .surface import Surface, SurfaceItem, load_surface

log = logging.getLogger("studio.contract")

SSE_TIMEOUT = 25.0


@dataclass
class Context:
    hermes_home: Path
    api_url: str
    api_key: str
    hermes_bin: Optional[str] = None
    sandbox: bool = False          # 預檢沙盒：檔案缺就 skip、live 呼叫全開
    writes: bool = False           # 正式環境是否允許會建資料的 live 呼叫
    profile: str = ""              # /p/{profile} 用；空＝自動挑
    env: dict[str, str] = field(default_factory=dict)  # 子程序額外環境變數
    cli_timeout: float = 40.0
    http_timeout: float = 30.0  # 與 GatewayClient 一致；busy 時 ReadTimeout 會重試一次
    values: dict[str, Any] = field(default_factory=dict)  # provides/needs 共享
    cleanups: list[tuple[str, Any]] = field(default_factory=list)

    @property
    def allow_writes(self) -> bool:
        return self.sandbox or self.writes


@dataclass
class Result:
    id: str
    status: str  # pass | fail | skip
    reason: str = ""
    ms: int = 0
    detail: dict[str, Any] = field(default_factory=dict)


class CheckFail(Exception):
    pass


class CheckSkip(Exception):
    pass


# ---------------------------------------------------------------- helpers
def _sub_path(path: str, ctx: Context) -> str:
    def repl(m: re.Match) -> str:
        k = m.group(1)
        if k == "profile":
            return ctx.profile or "default"
        if k in ctx.values:
            return str(ctx.values[k])
        raise CheckSkip(f"前置值 {k} 不存在（前一項可能失敗或被跳過）")
    return re.sub(r"\{(\w+)\}", repl, path)


def _json_or_none(r: httpx.Response) -> Any:
    try:
        return r.json()
    except Exception:
        return None


def _is_error_json(data: Any) -> bool:
    return isinstance(data, dict) and ("error" in data or "message" in data or "detail" in data)


def _check_keys(data: Any, expect: dict[str, Any]) -> None:
    if not isinstance(data, dict):
        if expect.get("keys") or expect.get("keys_any"):
            raise CheckFail(f"回應不是 JSON 物件：{type(data).__name__}")
        return
    for k in expect.get("keys") or []:
        if k not in data:
            raise CheckFail(f"回應缺欄位 {k}（有：{', '.join(list(data)[:8])}）")
    ka = expect.get("keys_any") or []
    if ka and not any(k in data for k in ka):
        raise CheckFail(f"回應缺欄位 {' 或 '.join(ka)}（有：{', '.join(list(data)[:8])}）")
    for list_key, item_keys in (expect.get("list_item_keys") or {}).items():
        items = data.get(list_key)
        if not isinstance(items, list):
            raise CheckFail(f"{list_key} 不是陣列")
        for it in items[:20]:
            if isinstance(it, dict):
                missing = [k for k in item_keys if k not in it]
                if missing:
                    raise CheckFail(f"{list_key}[] 缺欄位 {', '.join(missing)}")
    code = expect.get("error_code")
    if code:
        err = data.get("error")
        got = err.get("code") if isinstance(err, dict) else None
        if got != code:
            raise CheckFail(f"error.code 應為 {code}，得到 {got!r}")


# ---------------------------------------------------------------- endpoint
async def _http(ctx: Context, method: str, path: str, *, body: Any = None, query: Optional[dict] = None,
                auth: str = "ok") -> httpx.Response:
    key = "contract-wrong-key-0123456789" if auth == "wrong" else ctx.api_key
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    kw: dict[str, Any] = {}
    if query:
        kw["params"] = query
    if body is not None and method in ("POST", "PATCH", "PUT"):
        kw["json"] = body
    async with httpx.AsyncClient(base_url=ctx.api_url, headers=headers, timeout=ctx.http_timeout) as c:
        for attempt in (1, 2):
            try:
                return await c.request(method, path, **kw)
            except (httpx.ReadTimeout, httpx.ConnectError):
                if attempt == 2:
                    raise
                await asyncio.sleep(3.0)  # gateway 忙（剛重啟／其他 profile 在跑）時再試一次
        raise AssertionError("unreachable")


async def _sse_probe(ctx: Context, path: str, expect: dict[str, Any]) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {ctx.api_key}"}
    terminal = set(expect.get("sse_terminal") or [])
    key_any = expect.get("sse_event_key_any") or ["event", "type"]
    seen: list[str] = []
    started = time.time()
    async with httpx.AsyncClient(base_url=ctx.api_url, headers=headers, timeout=httpx.Timeout(SSE_TIMEOUT, connect=10.0)) as c:
        async with c.stream("GET", path) as r:
            if r.status_code not in (expect.get("status") or [200]):
                raise CheckFail(f"HTTP {r.status_code}")
            data_lines: list[str] = []
            try:
                async for raw in r.aiter_lines():
                    line = raw.rstrip("\r")
                    if line == "":
                        if data_lines:
                            payload = "\n".join(data_lines)
                            data_lines = []
                            try:
                                ev = json.loads(payload)
                            except json.JSONDecodeError:
                                raise CheckFail(f"SSE data 不是 JSON：{payload[:80]!r}")
                            name = next((str(ev[k]) for k in key_any if isinstance(ev, dict) and ev.get(k)), "")
                            if not name:
                                raise CheckFail(f"SSE 事件缺 {' / '.join(key_any)} 欄位：{list(ev)[:6] if isinstance(ev, dict) else ev}")
                            seen.append(name)
                            if name in terminal:
                                break
                        continue
                    if line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                    if time.time() - started > SSE_TIMEOUT:
                        break
            except httpx.ReadTimeout:
                pass
    if not seen:
        raise CheckFail("SSE 沒有收到任何事件")
    if terminal and not (set(seen) & terminal):
        raise CheckFail(f"{SSE_TIMEOUT:.0f} 秒內沒收到終止事件（收到：{', '.join(seen[:8])}）")
    return {"events": seen[:20]}


async def check_endpoint(item: SurfaceItem, ctx: Context) -> Result:
    g = item.get
    probe = g("probe", "live")
    method = str(g("method")).upper()
    live_allowed = ctx.allow_writes or not g("writes")
    do_live = probe == "live" and live_allowed
    detail: dict[str, Any] = {}

    if probe == "live" and not live_allowed:
        # 正式環境不寫資料：退回 route probe（若有定義），否則 skip
        if g("route_expect"):
            do_live = False
        else:
            return Result(item.id, "skip", "會建立資料的呼叫；正式環境加 --writes 才跑")

    if do_live:
        path = _sub_path(str(g("path")), ctx)
        expect = g("expect") or {}
        if g("sse"):
            detail = await _sse_probe(ctx, path, expect)
            return Result(item.id, "pass", "", detail=detail)
        r = await _http(ctx, method, path, body=g("body"), query=g("query"), auth=g("auth", "ok"))
        data = _json_or_none(r)
        detail = {"http": r.status_code}
        if r.status_code not in (expect.get("status") or [200]):
            msg = (data.get("error") if isinstance(data, dict) else None) or r.text[:160]
            raise CheckFail(f"HTTP {r.status_code}：{msg}")
        if isinstance(data, dict) and isinstance(data.get("error"), dict) and not expect.get("error_code"):
            raise CheckFail(f"回 {r.status_code} 但 body 是錯誤：{data['error'].get('message')}")
        _check_keys(data, expect)
        if g("then"):
            r2 = await _http(ctx, method, _sub_path(str(g("then")), ctx), body=g("body"))
            if r2.status_code not in (expect.get("status") or [200]):
                raise CheckFail(f"第二步 {g('then')} HTTP {r2.status_code}")
        prov = g("provides")
        if prov and isinstance(data, dict):
            val = None
            if prov == "run_id":
                val = data.get("run_id") or data.get("id")
            elif prov == "job_id":
                j = data.get("job") if isinstance(data.get("job"), dict) else data
                val = j.get("id") or j.get("job_id")
            if not val:
                raise CheckFail(f"回應裡找不到 {prov}")
            ctx.values[prov] = val
            if g("cleanup"):
                ctx.cleanups.append((str(g("cleanup")), val))
        if g("consumes"):
            consumed = ctx.values.pop(str(g("consumes")), None)
            ctx.cleanups = [c for c in ctx.cleanups if c[1] != consumed]
        return Result(item.id, "pass", "", detail=detail)

    # route probe
    path = str(g("route_path") or g("path"))
    if "{" in path:
        path = re.sub(r"\{\w+\}", "run_contract_bogus", path)
    body = g("route_body") if g("route_body") is not None else g("body")
    rexp = g("route_expect") or {}
    r = await _http(ctx, method, path, body=body if body is not None else {})
    data = _json_or_none(r)
    detail = {"http": r.status_code, "mode": "route"}
    if 200 <= r.status_code < 300 and isinstance(data, (dict, list)):
        return Result(item.id, "pass", "路由存在（回 2xx JSON）", detail=detail)
    if r.status_code not in (rexp.get("status") or [400, 404]):
        raise CheckFail(f"HTTP {r.status_code}（預期 {rexp.get('status')}）：{r.text[:120]}")
    if rexp.get("error_json") and not _is_error_json(data):
        raise CheckFail(f"路由回 {r.status_code} 但不是結構化 JSON 錯誤（像是整條路由不存在）：{r.text[:100]!r}")
    return Result(item.id, "pass", "路由存在（未寫資料）", detail=detail)


async def run_cleanups(ctx: Context) -> list[str]:
    notes: list[str] = []
    for kind, val in reversed(ctx.cleanups):
        try:
            if kind == "stop_run":
                await _http(ctx, "POST", f"/v1/runs/{val}/stop", body={})
            elif kind == "delete_job":
                await _http(ctx, "DELETE", f"/api/jobs/{val}")
            elif kind == "archive_task":
                await _cli(ctx, ["kanban", "archive", str(val)])
            notes.append(f"{kind}:{val}")
        except Exception as e:  # cleanup 失敗只記錄
            notes.append(f"{kind}:{val} failed: {e}")
    ctx.cleanups.clear()
    return notes


# ---------------------------------------------------------------- cli
async def _cli(ctx: Context, argv: list[str], timeout: Optional[float] = None) -> tuple[int, str, str]:
    if not ctx.hermes_bin:
        raise CheckSkip("沒有 hermes 執行檔")
    env = {**os.environ, "HERMES_HOME": str(ctx.hermes_home), "NO_COLOR": "1", "TERM": "dumb", **ctx.env}
    try:
        proc = await asyncio.create_subprocess_exec(ctx.hermes_bin, *argv, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL, env=env)
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout or ctx.cli_timeout)
    except FileNotFoundError:
        raise CheckFail(f"hermes 執行檔不存在：{ctx.hermes_bin}")
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        raise CheckFail(f"hermes {' '.join(argv)} 逾時")
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _strip(s: str) -> str:
    return _ANSI.sub("", s)


def _parse_output(raw: str, parse: str) -> Any:
    raw = _strip(raw).strip()
    if parse == "json":
        return json.loads(raw or "null")
    if parse == "json_first_bracket":
        m = re.search(r"[\[{].*[\]}]", raw, re.S)
        if not m:
            raise CheckFail("輸出裡找不到 JSON")
        return json.loads(m.group(0))
    return raw


def _help_text(ctx: Context, argv: list[str]) -> Any:
    return _cli(ctx, [*argv, "--help"], timeout=ctx.cli_timeout)


async def check_cli(item: SurfaceItem, ctx: Context) -> Result:
    g = item.get
    probe = g("probe", "run")
    argv = [str(a) for a in (g("argv") or [])]
    detail: dict[str, Any] = {"argv": argv}

    if probe == "help":
        rc, out, err = await _help_text(ctx, argv)
        text = _strip(out + err)
        if rc != 0 and "usage" not in text.lower():
            raise CheckFail(f"`hermes {' '.join(argv)} --help` 失敗：{text.strip()[:160]}")
        missing: list[str] = []
        for f in g("flags") or []:
            if str(f) not in text:
                missing.append(str(f))
        subs = g("subcommands") or []
        for s in subs:
            if not re.search(rf"(?<![\w-]){re.escape(str(s))}(?![\w-])", text):
                missing.append(f"子命令 {s}")
        for sub, flags in (g("subcommand_flags") or {}).items():
            rc2, o2, e2 = await _help_text(ctx, [*argv, str(sub)])
            t2 = _strip(o2 + e2)
            for f in flags:
                if str(f) not in t2:
                    missing.append(f"{sub} {f}")
        if missing:
            raise CheckFail("help 裡找不到：" + "、".join(missing))
        # optional live（會寫資料）
        if g("live_argv") and ctx.allow_writes:
            rc3, o3, e3 = await _cli(ctx, [str(a) for a in g("live_argv")])
            if rc3 != 0:
                raise CheckFail(f"live 執行失敗：{_strip(e3 or o3).strip()[:160]}")
            lx = g("live_expect") or {}
            val = None
            if g("live_parse") == "json":
                try:
                    data = _parse_output(o3, "json")
                    if isinstance(data, dict):
                        val = data.get("id") or (data.get("task") or {}).get("id")
                except Exception:
                    data = None
            if not val and lx.get("id_regex"):
                m = re.search(lx["id_regex"], _strip(o3))
                val = m.group(0) if m else None
            if lx.get("id_regex") and not val:
                raise CheckFail(f"live 輸出找不到 id（{lx['id_regex']}）：{_strip(o3)[:120]!r}")
            if g("provides") and val:
                ctx.values[str(g("provides"))] = val
                if g("cleanup"):
                    ctx.cleanups.append((str(g("cleanup")), val))
            detail["live"] = True
            return Result(item.id, "pass", "help＋live 都通過", detail=detail)
        return Result(item.id, "pass", "子命令與旗標存在" + ("（live 未跑，加 --writes）" if g("live_argv") else ""), detail=detail)

    if probe == "live" and not ctx.allow_writes:
        return Result(item.id, "skip", "會寫資料；正式環境加 --writes 才跑", detail=detail)

    rc, out, err = await _cli(ctx, argv)
    if rc != 0 and not g("allow_nonzero"):
        raise CheckFail(f"exit {rc}：{_strip(err or out).strip()[:160]}")
    parse = g("parse", "text")
    if parse == "regex":
        text = _strip(out + "\n" + err)
        if not re.search(str(g("pattern")), text, re.M):
            raise CheckFail(f"輸出不符合 pattern：{text.strip()[:120]!r}")
        return Result(item.id, "pass", "", detail=detail)
    if parse in ("json", "json_first_bracket"):
        try:
            data = _parse_output(out, parse)
        except (json.JSONDecodeError, CheckFail) as e:
            raise CheckFail(f"輸出不是 JSON：{_strip(out).strip()[:120]!r}（{e}）")
        exp = g("expect") or {}
        t = exp.get("type")
        if t == "list" and not isinstance(data, list):
            raise CheckFail(f"預期陣列，得到 {type(data).__name__}")
        if t == "dict" and not isinstance(data, dict):
            raise CheckFail(f"預期物件，得到 {type(data).__name__}")
        if t == "list_or_dict" and not isinstance(data, (list, dict)):
            raise CheckFail(f"預期陣列或物件，得到 {type(data).__name__}")
        if isinstance(data, dict):
            for k in exp.get("dict_keys") or []:
                if k not in data:
                    raise CheckFail(f"缺欄位 {k}")
            ka = exp.get("dict_keys_any") or []
            if ka and not any(k in data for k in ka):
                raise CheckFail(f"缺欄位 {' 或 '.join(ka)}")
        detail["items"] = len(data) if isinstance(data, list) else None
        return Result(item.id, "pass", "", detail=detail)
    # text
    if not _strip(out).strip():
        raise CheckFail("沒有輸出")
    return Result(item.id, "pass", "", detail=detail)


# ---------------------------------------------------------------- files / db
def _home_path(item: SurfaceItem, ctx: Context) -> Path:
    return ctx.hermes_home / str(item.get("path"))


def check_file(item: SurfaceItem, ctx: Context) -> Result:
    g = item.get
    p = _home_path(item, ctx)
    fmt = g("format", "file")
    if not p.exists():
        if g("optional") or ctx.sandbox:
            return Result(item.id, "skip", f"{p.name} 不存在" + ("（沙盒是全新 HERMES_HOME）" if ctx.sandbox else "（optional）"))
        raise CheckFail(f"{p} 不存在")
    detail: dict[str, Any] = {"path": str(p)}
    if fmt in ("dir", "skills_dir"):
        if not p.is_dir():
            raise CheckFail(f"{p} 不是目錄")
        if fmt == "skills_dir":
            found = list(p.rglob("SKILL.md"))[:50]
            detail["skills"] = len(found)
            if found:
                fm = _frontmatter(found[0])
                if "name" not in fm:
                    raise CheckFail(f"{found[0].relative_to(p)} frontmatter 缺 name")
        layout = g("profile_layout") or []
        if layout:
            subs = [d for d in p.iterdir() if d.is_dir() and not d.name.startswith(".")]
            detail["profiles"] = len(subs)
            if subs:
                missing = [f for f in layout if not (subs[0] / f).exists()]
                if missing:
                    raise CheckFail(f"profile {subs[0].name} 缺 {', '.join(missing)}")
        return Result(item.id, "pass", "", detail=detail)
    if not p.is_file():
        raise CheckFail(f"{p} 不是檔案")
    if fmt == "env":
        keys = _env_keys(p)
        missing = [k for k in (g("keys") or []) if k not in keys]
        if missing:
            raise CheckFail(f".env 缺 {', '.join(missing)}")
        detail["keys"] = len(keys)
    elif fmt == "yaml":
        try:
            data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        except Exception as e:
            raise CheckFail(f"YAML 解析失敗：{e}")
        if not isinstance(data, dict):
            raise CheckFail("YAML 頂層不是物件")
        ka = g("keys_any") or []
        if ka and not any(k in data for k in ka):
            raise CheckFail(f"缺欄位 {' / '.join(ka)}（有：{', '.join(list(data)[:8])}）")
        detail["keys"] = list(data)[:12]
    elif fmt == "json":
        try:
            data = json.loads(p.read_text(encoding="utf-8") or "{}")
        except Exception as e:
            raise CheckFail(f"JSON 解析失敗：{e}")
        ka = g("keys_any") or []
        if isinstance(data, dict) and ka and not any(k in data for k in ka):
            raise CheckFail(f"缺欄位 {' / '.join(ka)}")
    return Result(item.id, "pass", "", detail=detail)


def _env_keys(p: Path) -> set[str]:
    keys: set[str] = set()
    for line in p.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k = line.split("=", 1)[0].strip()
        if k.startswith("export "):
            k = k[7:].strip()
        keys.add(k)
    return keys


def _frontmatter(p: Path) -> dict[str, Any]:
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    try:
        data = yaml.safe_load(text[3:end]) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def check_db(item: SurfaceItem, ctx: Context) -> Result:
    g = item.get
    p = _home_path(item, ctx)
    if not p.exists():
        if g("optional") or ctx.sandbox:
            return Result(item.id, "skip", f"{p.name} 不存在")
        raise CheckFail(f"{p} 不存在")
    table = str(g("table"))
    try:
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=5)
        try:
            cols = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
        finally:
            con.close()
    except sqlite3.Error as e:
        raise CheckFail(f"開 {p.name} 失敗：{e}")
    if not cols:
        raise CheckFail(f"表 {table} 不存在")
    missing = [c for c in (g("columns") or []) if c not in cols]
    if missing:
        raise CheckFail(f"{table} 缺欄位 {', '.join(missing)}")
    opt_missing = [c for c in (g("columns_optional") or []) if c not in cols]
    detail = {"columns": len(cols), "optional_missing": opt_missing}
    return Result(item.id, "pass", f"選配欄位缺 {', '.join(opt_missing)}" if opt_missing else "", detail=detail)


# ---------------------------------------------------------------- driver
async def _detect_version(ctx: Context) -> dict[str, Any]:
    info: dict[str, Any] = {"version": "", "date": "", "cli_version": ""}
    try:
        r = await _http(ctx, "GET", "/v1/health")
        d = _json_or_none(r) or {}
        info["version"] = str(d.get("version") or "")
    except Exception:
        pass
    if ctx.hermes_bin:
        try:
            rc, out, err = await _cli(ctx, ["--version"], timeout=30)
            text = _strip(out + err)
            m = re.search(r"v?(\d+\.\d+\.\d+)", text)
            info["cli_version"] = m.group(1) if m else ""
            m = re.search(r"\((\d{4}\.\d{1,2}\.\d{1,2})\)", text)
            info["date"] = m.group(1) if m else ""
        except Exception:
            pass
    return info


def _pick_profile(ctx: Context) -> str:
    if ctx.profile:
        return ctx.profile
    d = ctx.hermes_home / "profiles"
    if d.is_dir():
        for p in sorted(d.iterdir()):
            if p.is_dir() and not p.name.startswith(".") and p.name != "default":
                return p.name
    return "default"


async def run_async(hermes_home: Path | str, api_url: str, api_key: str, *, hermes_bin: Optional[str] = None,
                    sandbox: bool = False, writes: bool = False, profile: str = "", env: Optional[dict[str, str]] = None,
                    surface: Optional[Surface] = None, only: Optional[list[str]] = None,
                    progress=None) -> dict[str, Any]:
    """對真的 Hermes 跑契約測試，回 JSON 報告（dict）。progress(item_id, result) 可選。"""
    surface = surface or load_surface()
    ctx = Context(hermes_home=Path(hermes_home).expanduser(), api_url=api_url.rstrip("/"), api_key=api_key,
                  hermes_bin=hermes_bin, sandbox=sandbox, writes=writes, profile=profile, env=env or {})
    ctx.profile = _pick_profile(ctx)
    started = time.time()
    version = await _detect_version(ctx)
    results: list[Result] = []
    for item in surface.items:
        if only and item.id not in only:
            continue
        t0 = time.time()
        try:
            if item.kind == "endpoint":
                res = await check_endpoint(item, ctx)
            elif item.kind == "cli":
                res = await check_cli(item, ctx)
            elif item.kind == "file":
                res = check_file(item, ctx)
            elif item.kind == "db":
                res = check_db(item, ctx)
            else:
                res = Result(item.id, "skip", f"未知 kind {item.kind}")
        except CheckSkip as e:
            res = Result(item.id, "skip", str(e))
        except CheckFail as e:
            res = Result(item.id, "fail", str(e))
        except httpx.HTTPError as e:
            res = Result(item.id, "fail", f"連不到 gateway：{e.__class__.__name__}: {e}")
        except Exception as e:  # noqa: BLE001
            log.exception("contract item %s crashed", item.id)
            res = Result(item.id, "fail", f"{e.__class__.__name__}: {e}")
        res.ms = int((time.time() - t0) * 1000)
        results.append(res)
        if progress:
            try:
                progress(item.id, res)
            except Exception:
                pass
    cleanup_notes = await run_cleanups(ctx)
    return build_report(surface, results, hermes={"version": version["version"], "cli_version": version["cli_version"],
                                                   "date": version["date"], "api_url": ctx.api_url,
                                                   "home": str(ctx.hermes_home), "bin": ctx.hermes_bin or "",
                                                   "profile": ctx.profile},
                        mode={"sandbox": sandbox, "writes": ctx.allow_writes}, started=started,
                        cleanups=cleanup_notes)


def run(hermes_home: Path | str, api_url: str, api_key: str, **kw) -> dict[str, Any]:
    """同步版（CLI／腳本用）。在已有 event loop 的地方請用 run_async。"""
    return asyncio.run(run_async(hermes_home, api_url, api_key, **kw))
