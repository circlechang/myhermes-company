"""一句話建流程（POST /workflows/draft）：請一位 Hermes 員工把老闆的一句話排成 3–6 步的草稿鏈。

只產草稿、不建流程：對話框讓人確認後才走既有的 POST /workflows。
LLM 回什麼都不能信：剝 code fence → 找第一個 {...} → pydantic 驗 → 逐步丟掉不合法的步驟 → 最後再過一次 validate_workflow。
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, ValidationError

from ...hermes.gateway import GatewayClient, GatewayError
from ...models import Agent
from ...workflow_validate import WorkflowValidationError, validate_workflow
from .cron import CronError, parse_cron

DRAFT_TIMEOUT = 180.0  # 秒；排草稿是一次性呼叫，超過就當失敗
MAX_STEPS = 8  # 提示說 3–6，多給一點餘裕再截
NODE_GAP_X = 260
NODE_Y = 120
CHANNEL_LABEL = {"line": "LINE", "file": "檔案", "webhook": "webhook"}


class DraftStep(BaseModel):
    model_config = ConfigDict(extra="ignore")
    kind: Literal["hermes", "gate", "delivery"]
    title: str = ""
    agent_id: Optional[str] = None
    prompt: Optional[str] = None
    channel: Optional[Literal["line", "file", "webhook"]] = None
    to: Optional[str] = None
    path: Optional[str] = None
    url: Optional[str] = None


class DraftSchedule(BaseModel):
    model_config = ConfigDict(extra="ignore")
    cron: str
    label: str = ""


class DraftSpec(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = ""
    steps: list[Any] = []
    schedule: Optional[Any] = None


class DraftFailed(Exception):
    """排不出可用的草稿；message 給人看，excerpt 是 LLM 原文節錄。"""

    def __init__(self, message: str, excerpt: str = ""):
        super().__init__(message)
        self.excerpt = excerpt


# -- prompt ------------------------------------------------------------------
def build_instructions(agents: list[Agent]) -> str:
    roster = "\n".join(
        f"- agent_id={a.id}｜名字：{a.name}｜職稱：{a.title or '—'}｜說明：{a.description or '—'}｜runtime：{a.runtime or 'hermes'}"
        for a in agents)
    return (
        "你是流程規劃助手。老闆會用一句話交代一件事，你要把它排成一條 3–6 步的流程。\n"
        "只輸出一個 JSON 物件，不要 markdown、不要說明文字。\n\n"
        f"公司可用的 AI 員工：\n{roster}\n\n"
        "步驟只有三種 kind：\n"
        "- \"hermes\"＝請員工做：必須有 agent_id（只能用上面清單裡的）和 prompt。prompt 用繁體中文，寫成直接對那位員工交代工作的指令，"
        "要說清楚要做什麼、產出長什麼樣；後面的步驟會拿到前一步的產出。\n"
        "- \"gate\"＝等我看：老闆說「我看／我挑／我確認／我核准」的地方放一個，title 寫「等我看」或「我挑一個」這類短句。\n"
        "- \"delivery\"＝送出去：老闆提到 LINE／檔案／webhook 才放，而且一定是最後一步。channel 只能是 line｜file｜webhook；"
        "line 要有 to（老闆提到的群組或對象名稱）、file 要有 path（例如 output/{run_id}.md）、webhook 要有 url。\n\n"
        "schedule：老闆的話裡有時間才填，例如「每天早上八點」→ {\"cron\": \"0 8 * * *\", \"label\": \"每天 08:00\"}；沒有就 null。\n"
        "name：這條流程的名字，10 字內。\n\n"
        "輸出格式（嚴格 JSON）：\n"
        "{\"name\": str, \"steps\": [{\"kind\": \"hermes\"|\"gate\"|\"delivery\", \"title\": str, \"agent_id\"?: str, \"prompt\"?: str, "
        "\"channel\"?: \"line\"|\"file\"|\"webhook\", \"to\"?: str, \"path\"?: str, \"url\"?: str}], "
        "\"schedule\"?: {\"cron\": str, \"label\": str} | null}"
    )


# -- gateway one-shot --------------------------------------------------------
async def ask_once(gateway: GatewayClient, profile: Optional[str], text: str, instructions: str) -> str:
    """跟 engine._hermes_call 走同一條 gateway 路（start_run → run_events），但不留 session、不記 Message。"""
    run_id = await gateway.start_run(profile, text, instructions=instructions)
    chunks: list[str] = []
    final: Optional[str] = None
    error: Optional[str] = None
    async for ev in gateway.run_events(profile, run_id):
        name = ev.get("event") or ev.get("type") or ""
        if name == "message.delta":
            chunks.append(str(ev.get("delta") or ""))
        elif name == "approval.request":  # 排草稿不該動工具；一律拒絕
            try:
                await gateway.approve(profile, run_id, "deny")
            except GatewayError:
                pass
        elif name == "run.completed":
            final = ev.get("output") if isinstance(ev.get("output"), str) else None
            break
        elif name in ("run.failed", "run.cancelled"):
            error = str(ev.get("error") or name)
            break
    if final is None and error is None and not chunks:
        st = await gateway.run_status(profile, run_id)
        if st.get("status") == "completed":
            final = st.get("output") or ""
        else:
            error = st.get("error") or f"stream closed (status={st.get('status')})"
    if error:
        raise GatewayError(502, error)
    return final if final else "".join(chunks)


# -- parsing -----------------------------------------------------------------
_FENCE = re.compile(r"```[a-zA-Z0-9_-]*\s*\n?|```", re.MULTILINE)


def extract_json_object(raw: str) -> Optional[dict[str, Any]]:
    """剝 code fence，掃第一個括號平衡的 {...}；找不到回 None。"""
    text = _FENCE.sub("", raw or "")
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        obj = json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        break
                    return obj if isinstance(obj, dict) else None
        start = text.find("{", start + 1)
    return None


def _excerpt(raw: str, n: int = 300) -> str:
    s = (raw or "").strip()
    return s if len(s) <= n else s[:n] + "…"


def to_workflow(spec: dict[str, Any], agents: list[Agent], drafter: Agent, text: str) -> dict[str, Any]:
    """草稿 JSON → POST /workflows 吃的形狀。不合法的步驟直接丟，未知 agent_id 退回排草稿的那位員工。"""
    try:
        parsed = DraftSpec.model_validate(spec)
    except ValidationError as e:
        raise DraftFailed(f"草稿格式不對：{e.errors()[0].get('msg', '')}")
    known = {a.id: a for a in agents}
    nodes: list[dict[str, Any]] = []
    steps: list[dict[str, Any]] = []
    for item in parsed.steps[:MAX_STEPS]:
        try:
            st = DraftStep.model_validate(item)
        except ValidationError:
            continue
        i = len(nodes) + 1
        nid = f"s{i}"
        title = (st.title or "").strip()
        node: dict[str, Any] = {"id": nid, "kind": st.kind, "title": title, "position": {"x": 40 + (i - 1) * NODE_GAP_X, "y": NODE_Y}}
        if st.kind == "hermes":
            ag = known.get(st.agent_id or "") or drafter
            prompt = (st.prompt or "").strip() or title
            if not prompt:
                continue
            node.update({"agent_id": ag.id, "prompt": prompt, "title": title or prompt[:20]})
            steps.append({"id": nid, "kind": "hermes", "who": ag.name, "detail": node["title"]})
        elif st.kind == "gate":
            node["title"] = title or "等我看"
            steps.append({"id": nid, "kind": "gate", "who": "你", "detail": node["title"]})
        else:
            ch = st.channel
            if ch == "line" and (st.to or "").strip():
                node.update({"channel": "line", "to": st.to.strip()})
                detail = st.to.strip()
            elif ch == "file":
                node.update({"channel": "file", "path": (st.path or "").strip() or "output/{run_id}.md"})
                detail = node["path"]
            elif ch == "webhook" and str(st.url or "").startswith(("http://", "https://")):
                node.update({"channel": "webhook", "url": st.url.strip()})
                detail = node["url"]
            else:
                continue
            node["title"] = title or f"送到 {CHANNEL_LABEL[ch]}"
            steps.append({"id": nid, "kind": "delivery", "who": f"送到 {CHANNEL_LABEL[ch]}", "detail": detail})
        nodes.append(node)
    if not nodes:
        raise DraftFailed("AI 沒排出任何可用的步驟")
    edges = [{"id": f"{a['id']}-{b['id']}", "source": a["id"], "target": b["id"], "sourceHandle": "output", "targetHandle": "input"}
             for a, b in zip(nodes, nodes[1:])]
    try:
        validate_workflow(nodes, edges)
    except WorkflowValidationError as e:
        raise DraftFailed("草稿沒過驗證：" + "; ".join(e.errors))
    schedule = None
    if isinstance(parsed.schedule, dict):
        try:
            sch = DraftSchedule.model_validate(parsed.schedule)
            parse_cron(sch.cron)
            schedule = {"cron": sch.cron.strip(), "label": sch.label.strip() or sch.cron.strip()}
        except (ValidationError, CronError):
            schedule = None  # cron 壞掉就當沒排程，別擋整份草稿
    name = (parsed.name or "").strip() or text.strip()[:30]
    return {"name": name, "nodes": nodes, "edges": edges, "schedule": schedule, "steps": steps}


async def draft_workflow(gateway: GatewayClient, drafter: Agent, agents: list[Agent], text: str) -> dict[str, Any]:
    instructions = build_instructions(agents)
    try:
        raw = await asyncio.wait_for(ask_once(gateway, drafter.profile or None, f"老闆交代：\n{text.strip()}", instructions), DRAFT_TIMEOUT)
    except asyncio.TimeoutError:
        raise GatewayError(504, "排草稿逾時")
    spec = extract_json_object(raw)
    if spec is None:
        raise DraftFailed("AI 回的不是 JSON", _excerpt(raw))
    try:
        out = to_workflow(spec, agents, drafter, text)
    except DraftFailed as e:
        raise DraftFailed(str(e), _excerpt(raw))
    out.update({"agent_id": drafter.id, "raw": raw})
    return out
