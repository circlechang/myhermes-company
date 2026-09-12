"""新 Bot 的 .env 清掉「不能共用」的憑證。

Hermes 的 `profile create --clone-from default` 會整份複製 `.env`，包含 Telegram／WhatsApp 這類
**平台身分**。一組 bot token 只能被一個 profile 用，gateway 啟動時發現重複會拒絕啟動那個 profile 的
adapter（log：`Profile 'default' and 'X' both configure telegram with the same credential`），
而且等於把你的通訊帳號金鑰複製了好幾份放在磁碟上。

所以建 Bot 時把這些鍵拿掉。模型金鑰、API_SERVER_KEY（gateway 要靠它服務這個 profile）、
一般工具金鑰都保留——那是「這個 Bot 會做什麼」的一部分。
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path

log = logging.getLogger("studio.groupchat.profile_env")

# 前綴命中就拿掉（平台身分／中繼身分；一組憑證只能一個 profile 用）
DROP_PREFIXES = (
    "TELEGRAM_", "WHATSAPP_", "DISCORD_", "SLACK_", "SIGNAL_", "MATRIX_", "LINE_",
    "EMAIL_", "IMAP_", "SMTP_", "GATEWAY_RELAY_", "TWILIO_",
)
# 這些一定要留（留給 gateway 與模型呼叫用）
KEEP = ("API_SERVER_KEY",)
HEADER = "# MyHermesCompany：這個 Bot 的設定檔是從來源 clone 的，已移除不能共用的平台憑證\n" \
         "# （Telegram／WhatsApp 等：一組憑證只能一個 profile 用）。要讓它自己上某個平台，單獨填在這裡。\n"


def should_drop(key: str) -> bool:
    if key in KEEP:
        return False
    return any(key.startswith(p) for p in DROP_PREFIXES)


def scrub_text(text: str) -> tuple[str, list[str]]:
    """回 (新內容, 被拿掉的鍵名)。只動整行 `KEY=...`，註解與其他行原樣保留。"""
    out: list[str] = []
    dropped: list[str] = []
    for line in text.splitlines(keepends=True):
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if m and should_drop(m.group(1)):
            dropped.append(m.group(1))
            continue
        out.append(line)
    body = "".join(out)
    if dropped and not body.startswith("# MyHermesCompany"):
        body = HEADER + body
    return body, dropped


def scrub_file(env_path: Path) -> list[str]:
    """就地清掉；有改才留一份 `.env.bak-<時間>`。回被拿掉的鍵名。"""
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError:
        return []
    body, dropped = scrub_text(text)
    if not dropped:
        return []
    try:
        bak = env_path.with_name(f".env.bak-{datetime.now():%Y%m%d-%H%M%S}")
        bak.write_text(text, encoding="utf-8")
        bak.chmod(0o600)
        env_path.write_text(body, encoding="utf-8")
        env_path.chmod(0o600)
    except OSError as e:
        log.warning("清 %s 失敗：%s", env_path, e)
        return []
    log.info("%s：移除 %d 個不能共用的平台憑證（%s）", env_path.parent.name, len(dropped), ", ".join(sorted(set(dropped))))
    return dropped
