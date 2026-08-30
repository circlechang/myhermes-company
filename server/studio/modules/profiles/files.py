"""~/.hermes 檔案層的小工具（其他模組共用）：

- `.env` 讀寫：只改對應 key、保留其他行與註解（channels / models 共用）
- `config.yaml` 讀寫：ruamel.yaml round-trip，保留註解與排版
- profile 目錄解析：default 就是 HERMES_HOME 本身，其他在 profiles/<name>/
"""
from __future__ import annotations

import io
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable, Optional

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap

ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


# -- profile paths ---------------------------------------------------------
def profile_dir(home: Path, profile: str) -> Path:
    return home if profile in ("", "default") else home / "profiles" / profile


def list_profile_names(home: Path) -> list[str]:
    names = ["default"]
    d = home / "profiles"
    if d.is_dir():
        for p in sorted(d.iterdir()):
            if p.is_dir() and not p.name.startswith(".") and p.name != "default":
                names.append(p.name)
    return names


def validate_profile_name(name: str) -> str:
    name = (name or "").strip()
    if not PROFILE_NAME_RE.match(name):
        raise ValueError("profile 名稱只能用小寫英數、'-'、'_'，1~64 字")
    return name


# -- .env ------------------------------------------------------------------
def _atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        try:
            os.chmod(tmp, mode)
        except OSError:
            pass
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _split_env_line(line: str) -> Optional[tuple[str, str]]:
    s = line.strip()
    if not s or s.startswith("#") or "=" not in s:
        return None
    k, v = s.split("=", 1)
    k = k.strip()
    if k.startswith("export "):
        k = k[7:].strip()
    if not ENV_KEY_RE.match(k):
        return None
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return k, v


def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        kv = _split_env_line(line)
        if kv:
            out[kv[0]] = kv[1]
    return out


def env_keys_present(path: Path) -> set[str]:
    """哪些 key「存在且非空」——已設定／未設定偵測只看這個，不回傳值。"""
    return {k for k, v in read_env(path).items() if v != ""}


def _quote(v: str) -> str:
    if v == "" or re.search(r"[\s#'\"\\$]", v):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return v


def write_env(path: Path, updates: dict[str, Optional[str]]) -> dict[str, str]:
    """只改 updates 內的 key：value=None → 移除該行；其他行原樣保留。
    回傳 {key: 'set'|'removed'|'unchanged'}。"""
    for k in updates:
        if not ENV_KEY_RE.match(k):
            raise ValueError(f"不合法的環境變數名稱: {k}")
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines() if path.exists() else []
    result: dict[str, str] = {}
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        kv = _split_env_line(line)
        if kv and kv[0] in updates:
            k = kv[0]
            if k in seen:  # duplicate line → drop
                continue
            seen.add(k)
            new = updates[k]
            if new is None:
                result[k] = "removed"
                continue
            if new == kv[1]:
                result[k] = "unchanged"
                out.append(line)
            else:
                result[k] = "set"
                out.append(f"{k}={_quote(new)}")
            continue
        out.append(line)
    for k, new in updates.items():
        if k in seen:
            continue
        if new is None:
            result[k] = "unchanged"
            continue
        if out and out[-1].strip() != "":
            pass
        out.append(f"{k}={_quote(new)}")
        result[k] = "set"
    _atomic_write(path, "\n".join(out) + ("\n" if out else ""))
    return result


# -- config.yaml (ruamel round-trip) ----------------------------------------
def _yaml() -> YAML:
    y = YAML()
    y.preserve_quotes = True
    y.width = 4096
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def load_yaml(path: Path) -> CommentedMap:
    if not path.exists():
        return CommentedMap()
    data = _yaml().load(path.read_text(encoding="utf-8"))
    return data if isinstance(data, CommentedMap) else CommentedMap()


def dump_yaml(path: Path, data: Any) -> None:
    buf = io.StringIO()
    _yaml().dump(data, buf)
    _atomic_write(path, buf.getvalue(), mode=0o600)


def plain(data: Any) -> Any:
    """CommentedMap → 純 dict/list（給 JSON 回應）。"""
    if isinstance(data, dict):
        return {str(k): plain(v) for k, v in data.items()}
    if isinstance(data, (list, tuple)):
        return [plain(v) for v in data]
    return data


def get_path(data: Any, dotted: str, default: Any = None) -> Any:
    cur = data
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur


def set_path(data: CommentedMap, dotted: str, value: Any) -> None:
    parts = dotted.split(".")
    cur = data
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = CommentedMap()
            cur[part] = nxt
        cur = nxt
    cur[parts[-1]] = value


def unset_path(data: CommentedMap, dotted: str) -> bool:
    parts = dotted.split(".")
    cur = data
    for part in parts[:-1]:
        cur = cur.get(part) if isinstance(cur, dict) else None
        if cur is None:
            return False
    if isinstance(cur, dict) and parts[-1] in cur:
        del cur[parts[-1]]
        return True
    return False


def merge_into(data: CommentedMap, patch: dict) -> None:
    """深度合併 patch 到 data（保留既有註解）；patch 值為 None → 刪 key。"""
    for k, v in patch.items():
        if v is None:
            data.pop(k, None)
        elif isinstance(v, dict) and isinstance(data.get(k), dict):
            merge_into(data[k], v)
        else:
            data[k] = v


def update_yaml(path: Path, patch: dict) -> dict:
    data = load_yaml(path)
    merge_into(data, patch)
    dump_yaml(path, data)
    return plain(data)


def redact(obj: Any, keys: Iterable[str] = ("token", "secret", "key", "password", "api_key")) -> Any:
    """把看起來像密鑰的欄位遮掉（config.yaml 回前端前用）。"""
    kl = tuple(keys)
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            ks = str(k).lower()
            if isinstance(v, str) and v and any(s in ks for s in kl) and not ks.endswith(("_env", "_file", "_cmd", "_path")):
                out[str(k)] = "***"
            else:
                out[str(k)] = redact(v, kl)
        return out
    if isinstance(obj, list):
        return [redact(v, kl) for v in obj]
    return obj
