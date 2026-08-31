"""把 `hermes-skills/mhc-search` 裝進 Hermes profile 的 skills 目錄。

    python -m studio.modules.search.install mhc-search [--profile NAME] [--hermes-home ~/.hermes] [--url http://127.0.0.1:8700]
或 API `POST /search/install-skill`。

skill 原始碼位置（依序找）：環境變數 `MHC_SKILLS_DIR`、repo 根目錄 `hermes-skills/`。
"""
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path
from typing import Optional

SKILL_NAME = "mhc-search"
# 每個 skill 用哪個 env 變數放 token（mhc-code 的是可寫 token，刻意跟唯讀那把分開）
SKILL_TOKEN_ENV = {"mhc-search": "MHC_SEARCH_TOKEN", "mhc-code": "MHC_CODE_TOKEN"}


def skills_source_dir() -> Path:
    env = os.environ.get("MHC_SKILLS_DIR")
    if env:
        return Path(env).expanduser()
    return Path(__file__).resolve().parents[4] / "hermes-skills"


def target_dir(hermes_home: Path, profile: Optional[str], name: str = SKILL_NAME) -> Path:
    hermes_home = Path(hermes_home).expanduser()
    if profile and profile != "default":
        return hermes_home / "profiles" / profile / "skills" / name
    return hermes_home / "skills" / name


def env_file(hermes_home: Path, profile: Optional[str]) -> Path:
    hermes_home = Path(hermes_home).expanduser()
    if profile and profile != "default":
        return hermes_home / "profiles" / profile / ".env"
    return hermes_home / ".env"


def install_skill(hermes_home: Path, profile: Optional[str] = None, name: str = SKILL_NAME) -> Path:
    src = skills_source_dir() / name
    if not (src / "SKILL.md").is_file():
        raise FileNotFoundError(f"找不到 skill 原始碼：{src}（設 MHC_SKILLS_DIR 指到 hermes-skills/ 目錄）")
    if profile and profile != "default" and not (Path(hermes_home).expanduser() / "profiles" / profile).is_dir():
        raise FileNotFoundError(f"profile 不存在：{profile}")
    dst = target_dir(hermes_home, profile, name)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    return dst


def write_env(hermes_home: Path, profile: Optional[str], token: Optional[str], url: str,
              name: str = SKILL_NAME) -> Path:
    """把 MHC_STUDIO_URL／<skill 的 token 變數> 寫進 profile 的 .env（同名鍵覆寫，其他行保留；值不回顯）。"""
    path = env_file(hermes_home, profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    updates = {"MHC_STUDIO_URL": url}
    if token:
        updates[SKILL_TOKEN_ENV.get(name, "MHC_SEARCH_TOKEN")] = token
    out: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0].strip().removeprefix("export ").strip() if "=" in line else ""
        if key in updates:
            out.append(f"{key}={updates.pop(key)}")
        else:
            out.append(line)
    for k, v in updates.items():
        out.append(f"{k}={v}")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="python -m studio.modules.search.install", description="安裝 MyHermesCompany 的 Hermes skill")
    p.add_argument("name", nargs="?", default=SKILL_NAME)
    p.add_argument("--profile", default="", help="Hermes profile（空＝default，裝到 ~/.hermes/skills/）")
    p.add_argument("--hermes-home", default=os.environ.get("HERMES_HOME", "~/.hermes"))
    p.add_argument("--url", default="", help="順便把 MHC_STUDIO_URL 寫進該 profile 的 .env")
    p.add_argument("--token-stdin", action="store_true", help="從 stdin 讀 token 寫進 .env（token 不進 argv；mhc-code 寫 MHC_CODE_TOKEN）")
    a = p.parse_args(argv)
    dst = install_skill(Path(a.hermes_home), a.profile or None, a.name)
    print(f"installed {a.name} → {dst}")
    if a.url or a.token_stdin:
        import sys
        tok = sys.stdin.readline().strip() if a.token_stdin else None
        path = write_env(Path(a.hermes_home), a.profile or None, tok, a.url or "http://127.0.0.1:8700", name=a.name)
        env_key = SKILL_TOKEN_ENV.get(a.name, "MHC_SEARCH_TOKEN")
        print(f"env written → {path}（MHC_STUDIO_URL{('、' + env_key) if tok else ''}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
