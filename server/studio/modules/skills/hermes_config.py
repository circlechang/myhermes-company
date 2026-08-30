"""Round-trip (comment-preserving) access to a profile's config.yaml."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ruamel.yaml import YAML

from ...hermes.cli import HermesCli



def _yaml_factory() -> YAML:
    # ruamel 的 YAML 實例不是 thread-safe（reader 狀態共用），FastAPI 同步端點跑在 threadpool，
    # 並行請求共用一個實例會炸 IndexError；每次呼叫都建一個新實例（成本極低）。
    y = YAML()
    y.preserve_quotes = True
    y.width = 4096
    return y


def config_path(cli: HermesCli, profile: str) -> Path:
    return cli.profile_dir(profile) / "config.yaml"


def load(cli: HermesCli, profile: str) -> Any:
    p = config_path(cli, profile)
    y = _yaml_factory()
    if not p.exists():
        return y.map()
    with p.open("r", encoding="utf-8") as f:
        return y.load(f) or y.map()


def save(cli: HermesCli, profile: str, data: Any) -> None:
    p = config_path(cli, profile)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".yaml.studio-tmp")
    with tmp.open("w", encoding="utf-8") as f:
        _yaml_factory().dump(data, f)
    tmp.replace(p)


def disabled_skills(cli: HermesCli, profile: str) -> set[str]:
    data = load(cli, profile)
    skills = data.get("skills") if isinstance(data, dict) or hasattr(data, "get") else None
    if not skills or not hasattr(skills, "get"):
        return set()
    raw = skills.get("disabled")
    if raw is None:
        return set()
    if isinstance(raw, str):
        raw = [raw]
    return {str(x).strip() for x in raw if str(x).strip()}


def set_skill_enabled(cli: HermesCli, profile: str, name: str, enabled: bool) -> set[str]:
    data = load(cli, profile)
    if "skills" not in data or data["skills"] is None:
        data["skills"] = {}
    current = disabled_skills(cli, profile)
    if enabled:
        current.discard(name)
    else:
        current.add(name)
    data["skills"]["disabled"] = sorted(current)
    save(cli, profile, data)
    return current


def mcp_servers(cli: HermesCli, profile: str) -> dict[str, Any]:
    data = load(cli, profile)
    raw = data.get("mcp_servers") if hasattr(data, "get") else None
    return dict(raw) if raw else {}
