"""套件目錄的載入與驗證（docs/PACKS.md）。

套件＝目錄 `<root>/<name>/`：
  pack.yaml         必填；未知欄位視為錯誤（借 harness 規矩：不忽略）
  stages.yaml       階段定義（資料夾當資料庫＋階段式視圖）
  profiles/<p>/SOUL.md   可選：AI 員工人格，安裝時複製到 ~/.hermes/profiles/<p>/（已存在不覆寫）
  workflows/*.json  匯入格式（POST /workflows/import 的 data）
  skills/<s>/       可選：Hermes skills（安裝時複製到 profile 的 skills/，已存在不覆寫）
  hooks.py          可選：只能 import studio.sdk
"""
from __future__ import annotations

import ast
import importlib.util
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml

PACK_KEYS = {"name", "version", "title", "description", "requires", "workspace_dir", "profiles", "agents", "workflows", "skills", "stages", "hooks"}
STAGE_KEYS = {"id", "title", "description", "agent", "workflow", "outputs", "gate", "prompt", "inputs",
              "criteria", "role", "deliverables", "optional", "default_enabled", "branch", "hint"}
BRANCH_KEYS = {"file", "pattern", "min", "on_fail", "reason_pattern"}
HINT_KEYS = {"file", "pattern"}
STAGES_TOP_KEYS = {"topic_files", "stages"}
AGENT_KEYS = {"profile", "name", "title", "description"}
NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,40}$")
STAGE_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,30}$")
STAGE_STATUSES = ("draft", "running", "review", "done", "failed", "archived", "skipped")


class PackError(ValueError):
    pass


@dataclass
class Stage:
    id: str
    title: str
    agent: str
    workflow: str  # workflows/<file>.json
    outputs: list[str] = field(default_factory=list)
    gate: bool = False
    prompt: str = ""
    description: str = ""
    inputs: list[str] = field(default_factory=list)
    criteria: str = ""          # 判斷條件（給人看，階段卡顯示）
    role: str = ""              # 負責角色（給人看；agent 是機器用的 profile）
    deliverables: list[str] = field(default_factory=list)  # 交付物說明（給人看；outputs 是機器用的路徑）
    optional: bool = False      # 可關閉的階段（主題層級可 skip）
    default_enabled: bool = True
    branch: dict[str, Any] = field(default_factory=dict)  # 條件分支：{file, pattern, min, on_fail, reason_pattern}
    hint: dict[str, Any] = field(default_factory=dict)    # 審核提示：{file, pattern} 從產出抓「建議退回到 X」

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "agent": self.agent, "workflow": self.workflow, "outputs": self.outputs,
                "gate": self.gate, "description": self.description, "inputs": self.inputs, "criteria": self.criteria, "role": self.role,
                "deliverables": self.deliverables, "optional": self.optional, "default_enabled": self.default_enabled,
                "branch": self.branch, "hint": self.hint}


@dataclass
class Pack:
    name: str
    version: str
    path: Path
    title: str = ""
    description: str = ""
    requires: dict[str, Any] = field(default_factory=dict)
    workspace_dir: str = ""
    profiles: list[str] = field(default_factory=list)
    agents: list[dict[str, str]] = field(default_factory=list)
    workflows: list[str] = field(default_factory=list)
    skills: list[str] = field(default_factory=list)
    stages: list[Stage] = field(default_factory=list)
    topic_files: dict[str, str] = field(default_factory=dict)
    hooks_file: Optional[Path] = None

    def stage(self, sid: str) -> Optional[Stage]:
        return next((s for s in self.stages if s.id == sid), None)

    def workflow_data(self, filename: str) -> dict[str, Any]:
        p = self.path / "workflows" / filename
        if not p.is_file():
            raise PackError(f"套件 {self.name} 缺少工作流檔 workflows/{filename}")
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise PackError(f"workflows/{filename} 不是合法 JSON：{e}")

    def soul_path(self, profile: str) -> Optional[Path]:
        p = self.path / "profiles" / profile / "SOUL.md"
        return p if p.is_file() else None

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "version": self.version, "title": self.title or self.name, "description": self.description,
                "requires": self.requires, "workspace_dir": self.workspace_dir or self.name, "profiles": self.profiles, "agents": self.agents,
                "workflows": self.workflows, "skills": self.skills, "stages": [s.to_dict() for s in self.stages],
                "has_hooks": self.hooks_file is not None, "path": str(self.path)}


def _yaml(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        raise PackError(f"{path.name} 不是合法 YAML：{e}")
    if not isinstance(data, dict):
        raise PackError(f"{path.name} 頂層必須是物件")
    return data


def _strlist(v: Any, where: str) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
        raise PackError(f"{where} 必須是字串陣列")
    return v


def load_pack(path: Path) -> Pack:
    path = Path(path)
    meta_file = path / "pack.yaml"
    if not meta_file.is_file():
        raise PackError(f"{path} 缺少 pack.yaml")
    meta = _yaml(meta_file)
    unknown = set(meta) - PACK_KEYS
    if unknown:
        raise PackError(f"pack.yaml 有未知欄位：{', '.join(sorted(unknown))}")
    name = str(meta.get("name") or "")
    if not NAME_RE.match(name):
        raise PackError(f"pack.yaml name 不合法：{name!r}（小寫英數、-、_）")
    if name != path.name:
        raise PackError(f"pack.yaml name={name} 與目錄名 {path.name} 不一致")
    version = str(meta.get("version") or "")
    if not version:
        raise PackError("pack.yaml 缺少 version")
    requires = meta.get("requires") or {}
    if not isinstance(requires, dict):
        raise PackError("requires 必須是物件")
    agents_raw = meta.get("agents") or []
    if not isinstance(agents_raw, list):
        raise PackError("agents 必須是陣列")
    agents: list[dict[str, str]] = []
    for i, a in enumerate(agents_raw):
        if not isinstance(a, dict) or not a.get("profile"):
            raise PackError(f"agents[{i}] 缺少 profile")
        if set(a) - AGENT_KEYS:
            raise PackError(f"agents[{i}] 有未知欄位：{', '.join(sorted(set(a) - AGENT_KEYS))}")
        agents.append({k: str(a.get(k) or "") for k in AGENT_KEYS})
    profiles = _strlist(meta.get("profiles"), "profiles")
    for a in agents:
        if a["profile"] not in profiles:
            profiles.append(a["profile"])
    workflows = _strlist(meta.get("workflows"), "workflows")
    for w in workflows:
        if not (path / "workflows" / w).is_file():
            raise PackError(f"workflows/{w} 不存在")
    skills = _strlist(meta.get("skills"), "skills")
    for s in skills:
        if not (path / "skills" / s).is_dir():
            raise PackError(f"skills/{s} 不存在")
    pack = Pack(name=name, version=version, path=path, title=str(meta.get("title") or ""), description=str(meta.get("description") or ""),
                requires=requires, workspace_dir=str(meta.get("workspace_dir") or ""), profiles=profiles, agents=agents,
                workflows=workflows, skills=skills)
    stages_file = path / str(meta.get("stages") or "stages.yaml")
    if stages_file.is_file():
        pack.stages, pack.topic_files = _load_stages(stages_file, pack)
    elif meta.get("stages"):
        raise PackError(f"{meta['stages']} 不存在")
    hooks_name = meta.get("hooks")
    if hooks_name:
        hf = path / str(hooks_name)
        if not hf.is_file():
            raise PackError(f"{hooks_name} 不存在")
        check_hooks_imports(hf)
        pack.hooks_file = hf
    return pack


def _load_stages(file: Path, pack: Pack) -> tuple[list[Stage], dict[str, str]]:
    data = _yaml(file)
    unknown = set(data) - STAGES_TOP_KEYS
    if unknown:
        raise PackError(f"stages.yaml 有未知欄位：{', '.join(sorted(unknown))}")
    topic_files = data.get("topic_files") or {}
    if not isinstance(topic_files, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in topic_files.items()):
        raise PackError("stages.yaml topic_files 必須是 {檔名: 內容}")
    for k in topic_files:
        _safe_rel(k)
    raw = data.get("stages") or []
    if not isinstance(raw, list) or not raw:
        raise PackError("stages.yaml 至少要有 1 個階段")
    out: list[Stage] = []
    seen: set[str] = set()
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            raise PackError(f"stages[{i}] 必須是物件")
        unknown = set(s) - STAGE_KEYS
        if unknown:
            raise PackError(f"stages[{i}] 有未知欄位：{', '.join(sorted(unknown))}")
        sid = str(s.get("id") or "")
        if not STAGE_ID_RE.match(sid):
            raise PackError(f"stages[{i}] id 不合法：{sid!r}")
        if sid in seen:
            raise PackError(f"階段 id 重複：{sid}")
        seen.add(sid)
        wf = str(s.get("workflow") or "")
        if not wf:
            raise PackError(f"階段 {sid} 缺少 workflow")
        if wf not in pack.workflows:
            raise PackError(f"階段 {sid} 的 workflow {wf} 沒列在 pack.yaml workflows")
        agent = str(s.get("agent") or "")
        if agent and agent not in pack.profiles:
            raise PackError(f"階段 {sid} 的 agent {agent} 沒列在 pack.yaml profiles/agents")
        outputs = _strlist(s.get("outputs"), f"階段 {sid} outputs")
        for o in outputs:
            _safe_rel(o)
        branch = s.get("branch") or {}
        if branch:
            if not isinstance(branch, dict) or set(branch) - BRANCH_KEYS or not branch.get("file") or not branch.get("pattern"):
                raise PackError(f"階段 {sid} 的 branch 必須是 {{file, pattern, min, on_fail?, reason_pattern?}}")
            _safe_rel(str(branch["file"]))
            try:
                re.compile(str(branch["pattern"]))
                float(branch.get("min", 0))
            except (re.error, ValueError) as e:
                raise PackError(f"階段 {sid} 的 branch 不合法：{e}")
            if str(branch.get("on_fail") or "archived") != "archived":
                raise PackError(f"階段 {sid} 的 branch.on_fail 目前只支援 archived")
        hint = s.get("hint") or {}
        if hint:
            if not isinstance(hint, dict) or set(hint) - HINT_KEYS or not hint.get("file") or not hint.get("pattern"):
                raise PackError(f"階段 {sid} 的 hint 必須是 {{file, pattern}}")
            _safe_rel(str(hint["file"]))
        out.append(Stage(id=sid, title=str(s.get("title") or sid), agent=agent, workflow=wf, outputs=outputs, gate=bool(s.get("gate", False)),
                         prompt=str(s.get("prompt") or ""), description=str(s.get("description") or ""),
                         inputs=_strlist(s.get("inputs"), f"階段 {sid} inputs"), criteria=str(s.get("criteria") or ""),
                         role=str(s.get("role") or ""), deliverables=_strlist(s.get("deliverables"), f"階段 {sid} deliverables"),
                         optional=bool(s.get("optional", False)), default_enabled=bool(s.get("default_enabled", True)),
                         branch=dict(branch), hint=dict(hint)))
    return out, topic_files


def _safe_rel(rel: str) -> str:
    p = Path(rel)
    if p.is_absolute() or ".." in p.parts or not rel or rel.startswith("/"):
        raise PackError(f"路徑 {rel!r} 必須是資料夾內的相對路徑")
    return rel


def check_hooks_imports(hf: Path) -> None:
    """hooks.py 只能 import studio.sdk（與標準庫／第三方）；碰核心其他模組一律拒絕載入。"""
    try:
        tree = ast.parse(hf.read_text(encoding="utf-8"), filename=str(hf))
    except SyntaxError as e:
        raise PackError(f"hooks.py 語法錯誤：{e}")
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if node.level:  # 相對匯入
                raise PackError("hooks.py 不可用相對匯入")
            names = [f"{mod}.{a.name}" for a in node.names]
            if mod.startswith("studio.sdk") or mod == "studio.sdk":
                names = [mod]  # from studio.sdk import x → 允許
        for n in names:
            if n == "studio" or (n.startswith("studio.") and n != "studio.sdk"):
                raise PackError(f"hooks.py 只能 import studio.sdk，不可 import {n}")


def load_hooks(pack: Pack):
    """動態載入 hooks.py 成模組（每次呼叫重新載入，方便開發）。沒有 hooks 回 None。"""
    if pack.hooks_file is None:
        return None
    check_hooks_imports(pack.hooks_file)
    spec = importlib.util.spec_from_file_location(f"mhc_pack_hooks_{pack.name}", pack.hooks_file)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise PackError("hooks.py 無法載入")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def repo_packs_dir() -> Path:
    return Path(__file__).resolve().parents[4] / "packs"


def pack_roots(data_home: Optional[Path] = None) -> list[Path]:
    """搜尋順序：MHC_PACKS_DIR（可多個，: 分隔）→ <資料目錄>/packs → repo 根 packs/。"""
    roots: list[Path] = []
    for raw in (os.environ.get("MHC_PACKS_DIR") or "").split(os.pathsep):
        if raw.strip():
            roots.append(Path(raw).expanduser())
    if data_home is not None:
        roots.append(Path(data_home) / "packs")
    roots.append(repo_packs_dir())
    seen: set[Path] = set()
    out: list[Path] = []
    for r in roots:
        rr = r.resolve() if r.exists() else r
        if rr not in seen:
            seen.add(rr)
            out.append(r)
    return out


def discover(roots: list[Path]) -> tuple[dict[str, Pack], dict[str, str]]:
    """回 (可用套件 {name: Pack}, 載入失敗 {目錄名: 原因})。同名先找到的優先。"""
    packs: dict[str, Pack] = {}
    errors: dict[str, str] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for d in sorted(root.iterdir()):
            if not d.is_dir() or d.name.startswith((".", "_")) or not (d / "pack.yaml").is_file():
                continue
            if d.name in packs:
                continue
            try:
                packs[d.name] = load_pack(d)
            except PackError as e:
                errors[d.name] = str(e)
    return packs, errors
