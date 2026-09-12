"""Hermes gateway 的 multiplex 允許名單（`~/.hermes/config.yaml` 的 `gateway.multiplex_profile_allowlist`）。

為什麼要動它：gateway 每次請求都會重看磁碟上有哪些 profile，但**允許名單只在 gateway 啟動時讀進記憶體**。
名單是明列時，新建的 Bot 不在裡面 → `/p/<新 profile>/` 回 404「Unknown or unconfigured profile」，
要等 `hermes gateway restart` 才會服務它（在那之前 Studio 會先借 default 通道跑，見 groupchat.service.start_run_for）。

原則：
- 用純文字改寫，保留原檔的註解、縮排與其他設定；動手前先備份成 `config.yaml.bak-<時間>`。
- 寫完重新解析，確認「只有這份名單多了一個名字」，否則還原備份。
- 名單本來就是 null（代表全開）或 multiplex 關閉時，不動檔案。
"""
from __future__ import annotations

import logging
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import yaml

log = logging.getLogger("studio.hermes.allowlist")

KEY = "multiplex_profile_allowlist"
# 結果：added=有改檔｜already=名單裡已經有｜open=名單是 null（全開，不用加）｜off=multiplex 沒開｜missing=找不到這個設定
Status = str


def state_of(cfg: dict[str, Any]) -> tuple[bool, Optional[list[str]]]:
    """(multiplex 有沒有開, 名單)；名單是 None 代表「沒設＝全開」。值不是清單時也回 None（edit_text 會另外擋）。"""
    gw = cfg.get("gateway") if isinstance(cfg.get("gateway"), dict) else {}
    allow = gw.get(KEY)
    return bool(gw.get("multiplex_profiles")), (list(allow) if isinstance(allow, list) else None)


def _bad_value(cfg: dict[str, Any]) -> bool:
    """名單這個 key 有寫、但不是清單也不是 null（例如寫成字串）→ 不要碰這個檔。"""
    gw = cfg.get("gateway") if isinstance(cfg.get("gateway"), dict) else {}
    return KEY in gw and gw[KEY] is not None and not isinstance(gw[KEY], list)


def _flow_items(raw: str) -> Optional[list[str]]:
    """`[a, b]` 這種行內寫法 → ['a','b']；不是行內寫法回 None。"""
    raw = raw.strip()
    if not (raw.startswith("[") and raw.endswith("]")):
        return None
    inner = raw[1:-1].strip()
    return [x.strip().strip("'\"") for x in inner.split(",") if x.strip()] if inner else []


def edit_text(text: str, name: str, *, remove: bool = False) -> tuple[str, Status]:
    """回 (新內容, 狀態)。純文字處理，不重寫整個 YAML。"""
    try:
        cfg = yaml.safe_load(text) or {}
    except yaml.YAMLError:
        return text, "missing"
    cfg = cfg if isinstance(cfg, dict) else {}
    if _bad_value(cfg):
        return text, "missing"
    multiplex, allow = state_of(cfg)
    if not multiplex:
        return text, "off"
    if allow is None:
        return text, "open"  # 名單沒設＝服務所有 profile，不用加
    if not remove and name in allow:
        return text, "already"
    if remove and name not in allow:
        return text, "already"

    lines = text.splitlines(keepends=True)
    head = re.compile(r"^(\s*)" + KEY + r":[ \t]*(.*?)\s*$")
    idx = [i for i, ln in enumerate(lines) if head.match(ln)]
    if len(idx) != 1:
        return text, "missing"
    i = idx[0]
    m = head.match(lines[i])
    indent, rest = m.group(1), m.group(2)

    flow = _flow_items(rest)
    if flow is not None:  # [a, b] 寫法
        items = [x for x in flow if x != name] if remove else flow + [name]
        lines[i] = f"{indent}{KEY}: [{', '.join(items)}]\n"
        return "".join(lines), "removed" if remove else "added"
    if rest and not rest.startswith("#"):
        return text, "missing"  # 有值但不是清單（例如字串）：不碰

    # 區塊寫法：底下連續的「- 名字」行
    item = re.compile(r"^(\s*)-\s*(.+?)\s*$")
    j, last, item_indent = i + 1, i, indent + "  "
    while j < len(lines):
        mm = item.match(lines[j])
        if mm and len(mm.group(1)) > len(indent):
            item_indent = mm.group(1)
            if remove and mm.group(2).strip().strip("'\"") == name:
                del lines[j]
                return "".join(lines), "removed"
            last = j
            j += 1
            continue
        if lines[j].strip() == "" or lines[j].lstrip().startswith("#"):
            j += 1
            continue
        break
    if remove:
        return text, "already"
    lines.insert(last + 1, f"{item_indent}- {name}\n")
    return "".join(lines), "added"


def _same_except_allowlist(before: Any, after: Any, name: str, *, remove: bool) -> bool:
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    b_ok, b_list = state_of(before)
    a_ok, a_list = state_of(after)
    if b_ok != a_ok or b_list is None or a_list is None:
        return False
    want = [x for x in b_list if x != name] if remove else b_list + [name]
    if a_list != want:
        return False
    strip = lambda d: {k: (({kk: vv for kk, vv in v.items() if kk != KEY}) if k == "gateway" and isinstance(v, dict) else v)
                       for k, v in d.items()}
    return strip(before) == strip(after)


def apply(config_path: Path, name: str, *, remove: bool = False) -> Status:
    """改 `~/.hermes/config.yaml`。有改檔才留備份；改完驗證，不對就還原。"""
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError as e:
        log.warning("讀不到 %s：%s", config_path, e)
        return "missing"
    new_text, status = edit_text(text, name, remove=remove)
    if status not in ("added", "removed"):
        return status
    backup = config_path.with_name(f"{config_path.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
    try:
        shutil.copy2(config_path, backup)
        config_path.write_text(new_text, encoding="utf-8")
        before, after = yaml.safe_load(text) or {}, yaml.safe_load(new_text) or {}
        if not _same_except_allowlist(before, after, name, remove=remove):
            shutil.copy2(backup, config_path)
            log.error("改 %s 後驗證不過，已還原（備份 %s）", config_path, backup.name)
            return "missing"
    except (OSError, yaml.YAMLError) as e:
        log.error("改 %s 失敗：%s", config_path, e)
        try:
            if backup.exists():
                shutil.copy2(backup, config_path)
        except OSError:
            pass
        return "missing"
    log.info("%s：%s %s（備份 %s）", config_path.name, "移除" if remove else "加入", name, backup.name)
    return status


def is_served(cfg: dict[str, Any], name: str) -> bool:
    """這個 profile 現在的設定下會不會被 gateway 服務（仍需重啟才生效）。"""
    multiplex, allow = state_of(cfg)
    if not multiplex:
        return name == "default"
    return allow is None or name in allow
