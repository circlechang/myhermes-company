"""平台欄位表。env 名稱來源：Hermes `gateway/config.py` 與 `plugins/platforms/<p>/plugin.yaml`。"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class Field:
    name: str
    label: str
    required: bool = False
    secret: bool = False
    kind: str = "text"  # text | bool | int | url | list
    hint: str = ""
    default: str = ""


@dataclass
class ConfigKey:
    name: str
    label: str
    kind: str = "bool"  # bool | int | text
    default: Any = None
    hint: str = ""


@dataclass
class Platform:
    id: str
    label: str
    description: str
    fields: list[Field]
    config_section: Optional[str] = None
    config_keys: list[ConfigKey] = field(default_factory=list)
    docs_url: str = ""
    plugin: str = ""


_MENTION_KEYS = [
    ConfigKey("require_mention", "群組需 @提及 才回", "bool", True),
    ConfigKey("free_response_channels", "免提及頻道（逗號分隔）", "text", ""),
    ConfigKey("allowed_channels", "允許頻道（逗號分隔）", "text", ""),
]

PLATFORMS: list[Platform] = [
    Platform(
        id="line", label="LINE", plugin="plugins/platforms/line",
        description="LINE Messaging API（webhook 模式，需公開 HTTPS 網址）",
        docs_url="https://developers.line.biz/console/",
        fields=[
            Field("LINE_CHANNEL_ACCESS_TOKEN", "Channel access token", required=True, secret=True),
            Field("LINE_CHANNEL_SECRET", "Channel secret", required=True, secret=True),
            Field("LINE_PORT", "Webhook 埠", kind="int", default="8646", hint="預設 8646"),
            Field("LINE_HOST", "綁定位址", hint="留空＝所有介面"),
            Field("LINE_PUBLIC_URL", "公開 HTTPS 網址", kind="url", hint="例：https://xxx.trycloudflare.com；傳圖片／語音必填"),
            Field("LINE_ALLOWED_USERS", "允許的使用者 ID（U 開頭）", kind="list"),
            Field("LINE_ALLOWED_GROUPS", "允許的群組 ID（C 開頭）", kind="list"),
            Field("LINE_ALLOWED_ROOMS", "允許的聊天室 ID（R 開頭）", kind="list"),
            Field("LINE_ALLOW_ALL_USERS", "允許所有人（測試用）", kind="bool"),
            Field("LINE_HOME_CHANNEL", "預設投遞目標 ID", hint="cron／通知的預設投遞對象"),
        ],
    ),
    Platform(
        id="telegram", label="Telegram", plugin="plugins/platforms/telegram",
        description="Telegram Bot（long polling，不需公開網址）", docs_url="https://t.me/BotFather",
        fields=[
            Field("TELEGRAM_BOT_TOKEN", "Bot token", required=True, secret=True),
            Field("TELEGRAM_ALLOWED_USERS", "允許的使用者 ID", kind="list"),
            Field("TELEGRAM_HOME_CHANNEL", "預設投遞 chat ID"),
            Field("TELEGRAM_HOME_CHANNEL_NAME", "投遞目標顯示名稱"),
            Field("TELEGRAM_REPLY_TO_MODE", "回覆引用模式", hint="off / first / all"),
        ],
        config_section="telegram",
        config_keys=[ConfigKey("reactions", "表情回應", "bool", False), ConfigKey("allowed_chats", "允許的聊天（逗號分隔）", "text", "")],
    ),
    Platform(
        id="discord", label="Discord", plugin="plugins/platforms/discord",
        description="Discord Bot（需 Message Content Intent）", docs_url="https://discord.com/developers/applications",
        fields=[
            Field("DISCORD_BOT_TOKEN", "Bot token", required=True, secret=True),
            Field("DISCORD_ALLOWED_USERS", "允許的使用者 ID", kind="list"),
            Field("DISCORD_ALLOWED_CHANNELS", "允許的頻道 ID", kind="list"),
            Field("DISCORD_HOME_CHANNEL", "預設投遞頻道 ID"),
            Field("DISCORD_HOME_CHANNEL_NAME", "投遞目標顯示名稱"),
        ],
        config_section="discord",
        config_keys=_MENTION_KEYS + [ConfigKey("auto_thread", "自動開討論串", "bool", True), ConfigKey("reactions", "表情回應", "bool", True),
                                     ConfigKey("history_backfill", "回填歷史訊息", "bool", True), ConfigKey("history_backfill_limit", "回填筆數", "int", 50)],
    ),
    Platform(
        id="slack", label="Slack", plugin="plugins/platforms/slack",
        description="Slack App（Socket Mode：需 Bot token ＋ App token）", docs_url="https://api.slack.com/apps",
        fields=[
            Field("SLACK_BOT_TOKEN", "Bot token（xoxb-）", required=True, secret=True),
            Field("SLACK_APP_TOKEN", "App token（xapp-，Socket Mode）", required=True, secret=True),
            Field("SLACK_ALLOWED_CHANNELS", "允許的頻道 ID", kind="list"),
            Field("SLACK_HOME_CHANNEL", "預設投遞頻道 ID"),
            Field("SLACK_HOME_CHANNEL_NAME", "投遞目標顯示名稱"),
            Field("SLACK_ALLOW_ALL_USERS", "允許所有人", kind="bool"),
        ],
        config_section="slack", config_keys=_MENTION_KEYS,
    ),
    Platform(
        id="whatsapp", label="WhatsApp", plugin="plugins/platforms/whatsapp",
        description="WhatsApp（QR 配對的個人號 bridge；Cloud API 另有 WHATSAPP_CLOUD_* 欄位）",
        fields=[
            Field("WHATSAPP_ENABLED", "啟用", required=True, kind="bool", hint="true / false"),
            Field("WHATSAPP_MODE", "模式", hint="baileys（QR 配對）或 cloud"),
            Field("WHATSAPP_ALLOWED_USERS", "允許的號碼", kind="list"),
            Field("WHATSAPP_HOME_CHANNEL", "預設投遞號碼"),
            Field("WHATSAPP_HOME_CHANNEL_NAME", "投遞目標顯示名稱"),
            Field("WHATSAPP_CLOUD_PHONE_NUMBER_ID", "Cloud API Phone number ID"),
            Field("WHATSAPP_CLOUD_ACCESS_TOKEN", "Cloud API access token", secret=True),
            Field("WHATSAPP_CLOUD_VERIFY_TOKEN", "Cloud API verify token", secret=True),
            Field("WHATSAPP_CLOUD_APP_SECRET", "Cloud API app secret", secret=True),
        ],
    ),
    Platform(
        id="matrix", label="Matrix", plugin="plugins/platforms/matrix",
        description="Matrix（Element 等）— access token 或帳密二擇一",
        fields=[
            Field("MATRIX_HOMESERVER", "Homeserver URL", required=True, kind="url"),
            Field("MATRIX_USER_ID", "使用者 ID（@bot:server）"),
            Field("MATRIX_ACCESS_TOKEN", "Access token", secret=True),
            Field("MATRIX_PASSWORD", "密碼（沒有 token 時）", secret=True),
            Field("MATRIX_DEVICE_ID", "Device ID"),
            Field("MATRIX_ALLOWED_USERS", "允許的使用者", kind="list"),
            Field("MATRIX_ALLOWED_ROOMS", "允許的房間", kind="list"),
            Field("MATRIX_HOME_ROOM", "預設投遞房間"),
            Field("MATRIX_E2EE_MODE", "E2EE 模式", hint="off / on"),
        ],
        config_section="matrix",
        config_keys=[ConfigKey("require_mention", "群組需 @提及 才回", "bool", True), ConfigKey("free_response_rooms", "免提及房間", "text", ""),
                     ConfigKey("allowed_rooms", "允許房間", "text", "")],
    ),
    Platform(
        id="feishu", label="Feishu / Lark", plugin="plugins/platforms/feishu",
        description="飛書／Lark 自建應用（WebSocket 長連線，不需公開網址）", docs_url="https://open.feishu.cn/",
        fields=[
            Field("FEISHU_APP_ID", "App ID", required=True),
            Field("FEISHU_APP_SECRET", "App Secret", required=True, secret=True),
            Field("FEISHU_DOMAIN", "站別", hint="feishu（中國站）或 lark（國際站）"),
            Field("FEISHU_CONNECTION_MODE", "連線模式", hint="websocket / webhook"),
            Field("FEISHU_ALLOWED_USERS", "允許的使用者", kind="list"),
            Field("FEISHU_ALLOW_ALL_USERS", "允許所有人", kind="bool"),
            Field("FEISHU_REQUIRE_MENTION", "群組需 @提及", kind="bool"),
            Field("FEISHU_HOME_CHANNEL", "預設投遞 chat ID"),
            Field("FEISHU_HOME_CHANNEL_NAME", "投遞目標顯示名稱"),
        ],
    ),
    Platform(
        id="dingtalk", label="DingTalk 釘釘", plugin="plugins/platforms/dingtalk",
        description="釘釘 Stream Mode 機器人", docs_url="https://open-dev.dingtalk.com",
        fields=[
            Field("DINGTALK_CLIENT_ID", "Client ID（AppKey）", required=True),
            Field("DINGTALK_CLIENT_SECRET", "Client Secret", required=True, secret=True),
            Field("DINGTALK_WEBHOOK_URL", "機器人 Webhook URL（投遞用）", kind="url"),
            Field("DINGTALK_ALLOWED_USERS", "允許的使用者", kind="list"),
            Field("DINGTALK_REQUIRE_MENTION", "群組需 @提及", kind="bool"),
            Field("DINGTALK_HOME_CHANNEL", "預設投遞會話 ID"),
            Field("DINGTALK_HOME_CHANNEL_NAME", "投遞目標顯示名稱"),
        ],
    ),
    Platform(
        id="qqbot", label="QQ Bot", plugin="gateway/platforms/qqbot",
        description="QQ 開放平台機器人", docs_url="https://q.qq.com/",
        fields=[
            Field("QQ_APP_ID", "AppID", required=True),
            Field("QQ_CLIENT_SECRET", "AppSecret", required=True, secret=True),
            Field("QQ_PORTAL_HOST", "Portal host", hint="預設官方"),
        ],
    ),
    Platform(
        id="weixin", label="WeChat 微信", plugin="gateway/platforms/weixin",
        description="微信個人號（iLink bridge，掃碼取得 token）",
        fields=[
            Field("WEIXIN_TOKEN", "Token", required=True, secret=True),
            Field("WEIXIN_ACCOUNT_ID", "Account ID", required=True),
            Field("WEIXIN_BASE_URL", "Base URL", kind="url"),
            Field("WEIXIN_CDN_BASE_URL", "CDN Base URL", kind="url"),
            Field("WEIXIN_ALLOWED_USERS", "允許的使用者", kind="list"),
            Field("WEIXIN_ALLOW_ALL_USERS", "允許所有人", kind="bool"),
            Field("WEIXIN_HOME_CHANNEL", "預設投遞目標"),
        ],
    ),
    Platform(
        id="wecom", label="WeCom 企業微信", plugin="plugins/platforms/wecom",
        description="企業微信智能機器人（WebSocket）；自建應用回呼模式用 WECOM_CALLBACK_*",
        fields=[
            Field("WECOM_BOT_ID", "Bot ID", required=True),
            Field("WECOM_SECRET", "Secret", required=True, secret=True),
            Field("WECOM_WEBSOCKET_URL", "WebSocket URL", kind="url"),
            Field("WECOM_ALLOWED_USERS", "允許的使用者", kind="list"),
            Field("WECOM_HOME_CHANNEL", "預設投遞 chat ID"),
            Field("WECOM_CALLBACK_CORP_ID", "回呼模式 Corp ID"),
            Field("WECOM_CALLBACK_CORP_SECRET", "回呼模式 Corp Secret", secret=True),
            Field("WECOM_CALLBACK_AGENT_ID", "回呼模式 Agent ID"),
            Field("WECOM_CALLBACK_TOKEN", "回呼 Token", secret=True),
            Field("WECOM_CALLBACK_ENCODING_AES_KEY", "回呼 EncodingAESKey", secret=True),
        ],
    ),
]

PLATFORM_IDS = [p.id for p in PLATFORMS]
