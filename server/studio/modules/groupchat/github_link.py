"""每個 Bot 綁自己的 GitHub 帳號。

為什麼要這樣做：Hermes 把 `GH_TOKEN`／`GITHUB_TOKEN` 列為一律剝除，終端機裡的 `gh`／`git`
拿不到我們給的 token，所以不能靠「在 Bot 的 .env 填 token」分帳號。能分的地方是 **gh 自己的設定目錄**
（`GH_CONFIG_DIR`）：一個目錄一個登入狀態。

所以這裡做三件事，讓使用者只需要貼一行指令：
1. 幫這個 Bot 開一個專屬目錄 `~/.gh-accounts/<slug>/`，裡面放兩個小包裝指令 `bin/gh`、`bin/git`
   （自動帶上 GH_CONFIG_DIR 再叫真正的 gh／git）。
2. 給使用者一行 `gh auth login` 指令（互動授權只能本人做，我們不代登）。
3. 登入後按「檢查」，我們跑 `gh auth status` 把帳號名記下來，並把「一律用這個包裝指令」寫進
   這個 Bot 的角色設定（groupchat.service 組 instructions 時帶上）。
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("studio.groupchat.github")

ROOT = Path.home() / ".gh-accounts"
_WRAPPER = """#!/bin/sh
# 由 MyHermesCompany 產生：固定用這個 Bot 專屬的 GitHub 帳號（gh 設定目錄）。
# 手動改這個檔沒關係，但下次在介面按「重新建立」會被覆蓋。
export GH_CONFIG_DIR="{dir}"
exec "{real}" "$@"
"""


def slug_of(profile: str, agent_id: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]+", "-", profile or agent_id).strip("-").lower()
    return s or "bot"


def dir_for(slug: str) -> Path:
    return ROOT / slug


def _which(name: str) -> Optional[str]:
    return shutil.which(name)


def ensure_dir(slug: str) -> dict[str, Any]:
    """建目錄與包裝指令。回這個 Bot 要用的路徑與登入指令。"""
    d = dir_for(slug)
    (d / "bin").mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    made = []
    for name in ("gh", "git"):
        real = _which(name)
        if not real:
            continue
        p = d / "bin" / name
        p.write_text(_WRAPPER.format(dir=d, real=real), encoding="utf-8")
        p.chmod(0o755)
        made.append(str(p))
    return {"dir": str(d), "bin": str(d / "bin"), "wrappers": made,
            "login_cmd": f'GH_CONFIG_DIR="{d}" gh auth login'}


async def _run(cmd: list[str], env_dir: Optional[str] = None, timeout: float = 30.0) -> tuple[int, str]:
    env = dict(os.environ)
    if env_dir:
        env["GH_CONFIG_DIR"] = env_dir
    env.pop("GH_TOKEN", None)  # 不要讓機器層級的 token 蓋過目錄裡的登入
    env.pop("GITHUB_TOKEN", None)
    try:
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT, env=env)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        return proc.returncode or 0, out.decode("utf-8", "replace")
    except FileNotFoundError:
        return 127, "找不到 gh 指令（GitHub CLI 沒安裝？）"
    except asyncio.TimeoutError:
        return 124, "gh 沒有在時限內回應"


_ACCOUNT_RE = re.compile(r"Logged in to ([\w.-]+) account ([\w.-]+)")


async def status(dir_path: Optional[str]) -> dict[str, Any]:
    """查某個 gh 設定目錄（或系統預設）現在登入哪個帳號。**不會印出 token。**"""
    gh = _which("gh")
    if not gh:
        return {"ready": False, "account": "", "host": "", "message": "這台機器沒有安裝 GitHub CLI（gh）。"}
    code, out = await _run([gh, "auth", "status"], dir_path)
    out = re.sub(r"(?i)(token:?\s*)\S+", r"\1（略）", out)
    m = _ACCOUNT_RE.search(out)
    if m:
        return {"ready": True, "host": m.group(1), "account": m.group(2), "message": ""}
    return {"ready": False, "account": "", "host": "",
            "message": "還沒登入。把下面那行指令貼到終端機跑一次（會開瀏覽器授權），完成後再按「檢查」。"
                       if code != 0 else out.strip()[:300]}


def persona_line(dir_path: str, account: str) -> str:
    """寫進 Bot 角色設定的一句話：所有 gh／git 都走包裝指令。"""
    b = Path(dir_path) / "bin"
    return (f"[GitHub 帳號] 你在這台機器上的 GitHub 身分是 {account or '（專屬帳號）'}。"
            f"任何 gh 或 git 指令一律用 {b}/gh 與 {b}/git（不要用系統預設的 gh／git，那是別的帳號）。"
            f"需要在某個資料夾操作時，先 cd 進去再用這兩個路徑。")
