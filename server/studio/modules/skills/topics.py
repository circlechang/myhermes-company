"""技能的「用途維度」分類。

技能原本的 category 來自目錄結構（內建是 `research`／`creative`…，本機一律 `uncategorized`），
對老闆找東西沒幫助。這裡改用「我拿它來做什麼」當維度。

判斷分兩輪：
1. 先看**名字／目錄／原分類／標籤**——訊號強，幾乎不會誤判。
2. 名字看不出來，才退回去看 description——它最雜（一句「產生報告」就會被拉去文件類），
   所以只當備胎，且只取前 200 字。

沒有網路、沒有 LLM，純函式、可測、可預測。要調整分類就改 TOPIC_RULES 這張表。
"""
from __future__ import annotations

import re
from typing import Any

OTHER = "其他"

# (維度, 說明, 關鍵詞regex)　順序＝優先序，先命中先算，愈專用的放愈前面
TOPIC_RULES: list[tuple[str, str, str]] = [
    ("公司專用", "自家業務（把下面的關鍵詞換成你公司的）", r"""
        packag|heptabase|cubox|lark|feishu|
        acumatica|circular|recycl|carbon|\besg\b
    """),
    ("寫作與內容", "文章、書稿、貼文、改寫", r"""
        ^researcher-|humanizer|writ|copywrit|content-mark|article|blog|essay|rewrit|editor|
        markdown|note-tak|obsidian|social-media|xurl|newsletter|storytell|prompt
    """),
    ("研究與情報", "查資料、競品、專利、法規、市場", r"""
        research|radar|intel|competitor|patent|landscape|citation|arxiv|wiki|scrap|crawl|
        market|demand|opportunit|validation|price-monitor|news|trend
    """),
    ("設計與影音", "圖像、影片、簡報視覺、動畫", r"""
        design|image|video|visual|creative|remotion|manim|p5js|infographic|diagram|gif|
        \bmedia\b|song|music|ascii|shotcraft|hyperframe|youtube|render|photo|icon
    """),
    ("文件與試算表", "Word／Excel／PDF／簡報／雲端文件", r"""
        docx|xlsx|pdf|powerpoint|slide|sheet|spreadsheet|google-workspace|notion|airtable|
        \bbox\b|\bdrive\b|document|\bform\b|\btable\b
    """),
    ("溝通與信件", "Email、訊息、會議紀錄", r"""
        email|\bmail\b|inbox|himalaya|messag|\bchat\b|meeting|teams|slack|\bline\b|
        telegram|whatsapp|calendar|contact
    """),
    ("專案與任務", "任務追蹤、看板、排程、覆盤", r"""
        linear|trello|kanban|\btask|todo|project|issue|jira|sprint|planning|weekly-review|
        action-items|session-librarian|schedul
    """),
    ("開發與除錯", "寫程式、除錯、部署、code review", r"""
        debug|codebase|code-review|requesting-code|simplify-code|sdlc|github|\bgit\b|
        deploy|docker|test-driven|\btdd\b|spike|lint|inspect|node-|python-|skill-authoring|
        dogfood|blocked-page|systematic|develop|devops|\bweb\b|browser|\bapi\b|server|
        database|\bsql\b
    """),
    ("AI 代理與自動化", "叫別的 AI 幫忙、電腦操作", r"""
        autonomous|claude-code|codex|opencode|computer-use|hermes-agent|\bagents?\b|
        \bmcp\b|automation|workflow
    """),
    ("生活與裝置", "手機、地圖、提醒、私人事務", r"""
        \bapple|findmy|\bmaps\b|reminder|health|travel|shopping|recipe|\bhome\b
    """),
]

TOPICS: list[dict[str, str]] = [{"name": n, "hint": h} for n, h, _ in TOPIC_RULES] + [
    {"name": OTHER, "hint": "還沒分到維度的"}
]

_COMPILED = [(name, re.compile(pat, re.X | re.I)) for name, _, pat in TOPIC_RULES]


def classify(skill: dict[str, Any]) -> str:
    """回傳一個維度名稱；兩輪都沒命中就是「其他」。"""
    strong = " ".join(str(skill.get(k) or "") for k in ("name", "dir", "category")).lower()
    strong += " " + " ".join(str(t).lower() for t in (skill.get("tags") or []))
    weak = str(skill.get("description") or "")[:200].lower()
    for hay in (strong, weak):
        for name, rx in _COMPILED:
            if rx.search(hay):
                return name
    return OTHER
