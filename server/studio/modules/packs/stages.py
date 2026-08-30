"""資料夾當資料庫＋階段式推進（借 dsh-oil-creator 的做法）。

一個「主題」＝工作區下一個資料夾 `<workspace>/<pack.workspace_dir>/<YYYYMMDD>_<slug>/`，
裡面的 md／assets 就是產出，`status.json` 是各階段狀態：

  draft ──run──▶ running ──完成──▶ review（gate 階段）──approve──▶ done
                   │                    │
                   └──失敗──▶ failed     └──reject（帶意見）──▶ draft
  非 gate 階段：running ──完成──▶ done；done/failed 都可再 run（回 running）
  條件分支（stage.branch）：running ──完成但分數未達門檻──▶ archived（主題記 archived_reason；archived 可再 run）
  可關閉階段（stage.optional）：draft/done/failed/archived ──skip──▶ skipped ──unskip──▶ draft；skipped 視同 done 放行下一階段
  退回到指定節點（reject to=N）：N 及其後所有 done/review/failed/archived ──rollback──▶ draft，退回意見掛在 N

階段推進＝跑該階段的工作流（sdk.run_workflow），input.text 是渲染過的提示（含資料夾絕對路徑），
AI 員工用 Hermes 的檔案工具直接讀寫資料夾；本模組不碰 LLM 輸出，只看檔案與 run 狀態。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .loader import Pack, Stage

log = logging.getLogger("studio.packs.stages")

STATUS_FILE = "status.json"
TRANSITIONS: dict[tuple[str, str], str] = {
    ("draft", "run"): "running", ("done", "run"): "running", ("failed", "run"): "running", ("review", "run"): "running",
    ("running", "finish_gate"): "review", ("running", "finish"): "done", ("running", "fail"): "failed", ("running", "stop"): "failed",
    ("review", "approve"): "done", ("review", "reject"): "draft",
    ("running", "archive"): "archived", ("archived", "run"): "running",
    ("draft", "skip"): "skipped", ("done", "skip"): "skipped", ("failed", "skip"): "skipped", ("archived", "skip"): "skipped",
    ("skipped", "unskip"): "draft",
    ("done", "rollback"): "draft", ("review", "rollback"): "draft", ("failed", "rollback"): "draft", ("archived", "rollback"): "draft",
}
PASSTHROUGH = ("done", "skipped")  # 這兩種狀態放行下一階段


class StageError(ValueError):
    def __init__(self, code: str, message: str, status: int = 409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def transition(state: str, event: str) -> str:
    nxt = TRANSITIONS.get((state, event))
    if nxt is None:
        raise StageError("bad_transition", f"階段狀態 {state} 不能做 {event}")
    return nxt


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify(title: str, fallback: str = "topic") -> str:
    s = unicodedata.normalize("NFKC", title).strip()
    s = re.sub(r"[\s/\\:*?\"<>|]+", "-", s)
    s = re.sub(r"[^\w\-一-鿿㐀-䶿]", "", s)
    s = re.sub(r"-{2,}", "-", s).strip("-_")
    return (s or fallback)[:40]


def safe_rel(topic_dir: Path, rel: str) -> Path:
    """資料夾內相對路徑 → 絕對路徑；越界一律拒絕。"""
    if not rel or rel.startswith("/") or Path(rel).is_absolute():
        raise StageError("bad_path", "路徑必須是資料夾內的相對路徑", 400)
    p = (topic_dir / rel).resolve()
    root = topic_dir.resolve()
    if p != root and root not in p.parents:
        raise StageError("bad_path", "路徑越出主題資料夾", 400)
    return p


class TopicStore:
    def __init__(self, pack: Pack, workspace: Path):
        self.pack = pack
        self.root = workspace / (pack.workspace_dir or pack.name)

    # ----------------------------------------------------------- 主題
    def topic_dir(self, topic_id: str) -> Path:
        if not re.match(r"^[0-9]{8}_[^/\\]+$", topic_id) or ".." in topic_id:
            raise StageError("not_found", f"主題 {topic_id} 不存在", 404)
        d = self.root / topic_id
        if not (d / STATUS_FILE).is_file():
            raise StageError("not_found", f"主題 {topic_id} 不存在", 404)
        return d

    def list_topics(self) -> list[dict[str, Any]]:
        if not self.root.is_dir():
            return []
        out = []
        for d in sorted(self.root.iterdir(), reverse=True):
            if d.is_dir() and (d / STATUS_FILE).is_file():
                try:
                    st = self.read_status(d)
                except (OSError, json.JSONDecodeError):
                    continue
                out.append(self._summary(st))
        return out

    def _summary(self, st: dict[str, Any]) -> dict[str, Any]:
        stages = st.get("stages") or {}
        current = next((s.id for s in self.pack.stages if stages.get(s.id, {}).get("status") not in PASSTHROUGH), None)
        return {"id": st["id"], "title": st.get("title") or st["id"], "created_at": st.get("created_at"), "updated_at": st.get("updated_at"),
                "current_stage": current, "stages": {k: v.get("status") for k, v in stages.items()},
                "lights": [stages.get(s.id, {}).get("status", "draft") for s in self.pack.stages],
                "archived": bool(st.get("archived")), "archived_reason": st.get("archived_reason") or ""}

    def create_topic(self, title: str, *, slug: str = "", notes: str = "", member_id: str = "") -> dict[str, Any]:
        title = (title or "").strip()
        if not title:
            raise StageError("bad_request", "title 不可空白", 400)
        self.root.mkdir(parents=True, exist_ok=True)
        base = f"{datetime.now().strftime('%Y%m%d')}_{slugify(slug or title)}"
        tid, n = base, 1
        while (self.root / tid).exists():
            n += 1
            tid = f"{base}-{n}"
        d = self.root / tid
        d.mkdir(parents=True)
        vars_ = {"title": title, "topic_id": tid, "topic_dir": str(d), "notes": notes, "created_at": _now()}
        for rel, tpl in self.pack.topic_files.items():
            p = d / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(_render(tpl, vars_), encoding="utf-8")
        for s in self.pack.stages:
            for o in s.outputs:
                (d / o).parent.mkdir(parents=True, exist_ok=True)
        st = {"id": tid, "title": title, "notes": notes, "created_by": member_id, "created_at": vars_["created_at"], "updated_at": vars_["created_at"],
              "archived": False, "archived_reason": "",
              "stages": {s.id: {"status": "skipped" if (s.optional and not s.default_enabled) else "draft", "run_id": None, "session_id": None,
                                "updated_at": None, "feedback": "", "history": []}
                         for s in self.pack.stages}}
        self.write_status(d, st)
        return st

    def read_status(self, d: Path) -> dict[str, Any]:
        return json.loads((d / STATUS_FILE).read_text(encoding="utf-8"))

    def write_status(self, d: Path, st: dict[str, Any]) -> None:
        st["updated_at"] = _now()
        tmp = d / (STATUS_FILE + ".tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(d / STATUS_FILE)

    def detail(self, topic_id: str) -> dict[str, Any]:
        d = self.topic_dir(topic_id)
        st = self.read_status(d)
        stages = []
        for s in self.pack.stages:
            ss = st["stages"].setdefault(s.id, {"status": "draft"})
            files = []
            for o in s.outputs:
                p = d / o
                if p.is_dir():
                    for f in sorted(p.rglob("*")):
                        if f.is_file():
                            files.append(self._file_info(d, f))
                elif p.is_file():
                    files.append(self._file_info(d, p))
                else:
                    files.append({"path": o, "exists": False, "size": 0, "mtime": None})
            idx = [x.id for x in self.pack.stages].index(s.id)
            stages.append({**s.to_dict(), **ss, "files": files, "can_run": _can_run(self.pack, st, s), "can_approve": ss.get("status") == "review",
                           "enabled": ss.get("status") != "skipped", "can_toggle": s.optional and ss.get("status") != "running",
                           "rollback_targets": [x.id for x in self.pack.stages[: idx + 1] if st["stages"].get(x.id, {}).get("status") != "skipped"]})
        return {**self._summary(st), "notes": st.get("notes", ""), "dir": str(d), "stage_list": stages,
                "files": [self._file_info(d, f) for f in sorted(d.rglob("*")) if f.is_file() and f.name != STATUS_FILE]}

    def _file_info(self, d: Path, f: Path) -> dict[str, Any]:
        stt = f.stat()
        return {"path": f.relative_to(d).as_posix(), "exists": True, "size": stt.st_size,
                "mtime": datetime.fromtimestamp(stt.st_mtime, tz=timezone.utc).replace(microsecond=0).isoformat()}

    def read_file(self, topic_id: str, rel: str) -> dict[str, Any]:
        d = self.topic_dir(topic_id)
        p = safe_rel(d, rel)
        if not p.is_file():
            raise StageError("not_found", f"檔案 {rel} 不存在", 404)
        if p.stat().st_size > 2_000_000:
            raise StageError("too_large", "檔案超過 2MB，請直接開資料夾", 413)
        try:
            content = p.read_text(encoding="utf-8")
            binary = False
        except UnicodeDecodeError:
            content, binary = "", True
        return {"path": rel, "content": content, "binary": binary, "size": p.stat().st_size}

    def write_file(self, topic_id: str, rel: str, content: str) -> dict[str, Any]:
        d = self.topic_dir(topic_id)
        if rel == STATUS_FILE:
            raise StageError("bad_path", "status.json 由系統維護", 400)
        p = safe_rel(d, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return self._file_info(d, p)

    # ----------------------------------------------------------- 階段
    def stage_of(self, sid: str) -> Stage:
        s = self.pack.stage(sid)
        if s is None:
            raise StageError("not_found", f"階段 {sid} 不存在", 404)
        return s

    def render_prompt(self, topic_id: str, stage: Stage) -> str:
        d = self.topic_dir(topic_id)
        st = self.read_status(d)
        ss = st["stages"].get(stage.id, {})
        vars_ = {"title": st.get("title", topic_id), "topic_id": topic_id, "topic_dir": str(d.resolve()), "notes": st.get("notes", ""),
                 "feedback": ss.get("feedback") or "", "outputs": "\n".join(f"- {d.resolve() / o}" for o in stage.outputs),
                 "inputs": "\n".join(f"- {d.resolve() / i}" for i in stage.inputs), "stage": stage.id, "stage_title": stage.title,
                 "workspace_dir": str(self.root.resolve()),
                 "skipped_stages": ", ".join(k for k, v in st["stages"].items() if v.get("status") == "skipped") or "（無）"}
        text = _render(stage.prompt, vars_) if stage.prompt else f"主題資料夾：{d.resolve()}\n請完成階段「{stage.title}」，產出：\n{vars_['outputs']}"
        if ss.get("feedback"):
            text += f"\n\n[退回意見]\n{ss['feedback']}"
        return text

    def apply(self, topic_id: str, sid: str, event: str, **fields: Any) -> dict[str, Any]:
        """套用狀態機事件並寫回 status.json；回該階段的新狀態。"""
        d = self.topic_dir(topic_id)
        st = self.read_status(d)
        ss = st["stages"].setdefault(sid, {"status": "draft", "history": []})
        new = transition(ss.get("status", "draft"), event)
        ss.setdefault("history", []).append({"at": _now(), "from": ss.get("status"), "event": event, "to": new,
                                             **{k: v for k, v in fields.items() if k in ("run_id", "comment", "member_id", "rollback_to")}})
        ss["history"] = ss["history"][-50:]
        ss["status"] = new
        ss["updated_at"] = _now()
        for k, v in fields.items():
            if k != "member_id":
                ss[k] = v
        if event == "approve":
            ss["feedback"] = ""
        self.write_status(d, st)
        return ss

    def apply_field(self, topic_id: str, sid: str, **fields: Any) -> None:
        """不動狀態機，只補欄位（session_id、inbox_item_id…）。"""
        d = self.topic_dir(topic_id)
        st = self.read_status(d)
        st["stages"].setdefault(sid, {}).update(fields)
        self.write_status(d, st)


    # ----------------------------------------------------------- 退回到指定節點／可關閉階段／條件分支
    def reject_to(self, topic_id: str, sid: str, to: str, comment: str, member_id: str = "") -> dict[str, Any]:
        """審核中的 sid 退回到 to（to 必須在 sid 之前或等於 sid）：sid 先 reject，to..末尾所有已完成的階段 rollback 成 draft，
        退回意見掛在 to（重跑時提示尾巴帶 [退回意見]）。回 sid 的新狀態。"""
        ids = [s.id for s in self.pack.stages]
        if to not in ids:
            raise StageError("not_found", f"階段 {to} 不存在", 404)
        if ids.index(to) > ids.index(sid):
            raise StageError("bad_request", f"只能退回到 {sid} 之前（含）的階段", 400)
        d = self.topic_dir(topic_id)
        target_status = self.read_status(d)["stages"].get(to, {}).get("status")
        if target_status == "skipped":
            raise StageError("bad_request", f"階段 {to} 已關閉，不能退回到它", 400)
        note = comment if to == sid else f"退回到「{self.stage_of(to).title}」：{comment}"
        cur = self.apply(topic_id, sid, "reject", feedback=note if to == sid else "", comment=note, member_id=member_id, rollback_to=to)
        for other in ids[ids.index(to):]:
            if other == sid:
                continue
            st = self.read_status(d)
            os_ = st["stages"].get(other, {})
            if os_.get("status") in ("done", "review", "failed", "archived"):
                self.apply(topic_id, other, "rollback", feedback=comment if other == to else "", comment=f"因 {sid} 退回到 {to} 而重置",
                           member_id=member_id, missing_outputs=[], error="")
        if to != sid:
            self.apply_field(topic_id, to, feedback=comment)
        return cur

    def set_enabled(self, topic_id: str, sid: str, enabled: bool, member_id: str = "") -> dict[str, Any]:
        stage = self.stage_of(sid)
        if not stage.optional:
            raise StageError("bad_request", f"階段 {sid} 不是可關閉的階段", 400)
        d = self.topic_dir(topic_id)
        ss = self.read_status(d)["stages"].get(sid, {})
        if enabled and ss.get("status") == "skipped":
            return self.apply(topic_id, sid, "unskip", member_id=member_id)
        if not enabled and ss.get("status") != "skipped":
            return self.apply(topic_id, sid, "skip", member_id=member_id)
        return ss

    def evaluate_branch(self, topic_id: str, stage: Stage) -> Optional[dict[str, Any]]:
        """讀 stage.branch 指定的產出檔，抓分數與門檻比較。回 {passed, score, min, reason, note}；沒設 branch 回 None。"""
        if not stage.branch:
            return None
        d = self.topic_dir(topic_id)
        b = stage.branch
        p = d / str(b["file"])
        res: dict[str, Any] = {"passed": None, "score": None, "min": float(b.get("min", 0)), "reason": "", "note": ""}
        if not p.is_file():
            res["note"] = f"找不到 {b['file']}，無法判斷分數，照一般流程推進"
            return res
        text = p.read_text(encoding="utf-8", errors="ignore")
        m = re.search(str(b["pattern"]), text, re.M)
        if not m:
            res["note"] = f"{b['file']} 裡找不到符合 pattern 的分數，照一般流程推進"
            return res
        try:
            res["score"] = float(m.group(1))
        except (IndexError, ValueError):
            res["note"] = "pattern 抓到的不是數字，照一般流程推進"
            return res
        res["passed"] = res["score"] >= res["min"]
        if b.get("reason_pattern"):
            rm = re.search(str(b["reason_pattern"]), text, re.M)
            res["reason"] = rm.group(1).strip() if rm else ""
        if not res["passed"] and not res["reason"]:
            res["reason"] = f"總分 {res['score']:g} 未達門檻 {res['min']:g}"
        return res

    def review_hint(self, topic_id: str, stage: Stage) -> str:
        if not stage.hint:
            return ""
        p = self.topic_dir(topic_id) / str(stage.hint["file"])
        if not p.is_file():
            return ""
        m = re.search(str(stage.hint["pattern"]), p.read_text(encoding="utf-8", errors="ignore"), re.M)
        return m.group(1).strip() if m else ""

    def set_topic_fields(self, topic_id: str, **fields: Any) -> None:
        d = self.topic_dir(topic_id)
        st = self.read_status(d)
        st.update(fields)
        self.write_status(d, st)


def _can_run(pack: Pack, st: dict[str, Any], stage: Stage) -> bool:
    ss = st["stages"].get(stage.id, {})
    if ss.get("status") in ("running", "skipped"):
        return False
    idx = [s.id for s in pack.stages].index(stage.id)
    for prev in pack.stages[:idx]:
        if st["stages"].get(prev.id, {}).get("status") not in PASSTHROUGH:
            return False
    return True


def _render(tpl: str, vars_: dict[str, Any]) -> str:
    def rep(m: re.Match) -> str:
        return str(vars_.get(m.group(1), m.group(0)))
    return re.sub(r"\{([a-z_]+)\}", rep, tpl)


# --------------------------------------------------------------- 執行與監看
async def start_stage(store: TopicStore, topic_id: str, sid: str, *, workflow_id: str, company_id: str, member_id: str, force: bool = False,
                      on_finish=None) -> dict[str, Any]:
    from ... import sdk

    stage = store.stage_of(sid)
    d = store.topic_dir(topic_id)
    st = store.read_status(d)
    if not force and not _can_run(store.pack, st, stage):
        raise StageError("not_ready", "前面的階段還沒完成（或本階段執行中）")
    text = store.render_prompt(topic_id, stage)
    inp = {"text": text, "pack": store.pack.name, "topic_id": topic_id, "topic_dir": str(d.resolve()), "stage": sid,
           "outputs": [str(d.resolve() / o) for o in stage.outputs]}
    res = await sdk.run_workflow(workflow_id, company_id=company_id, member_id=member_id, input=inp, trigger=f"pack:{store.pack.name}")
    ss = store.apply(topic_id, sid, "run", run_id=res["run_id"], session_id=None, error="", member_id=member_id)
    sdk.record_event("pack.stage.run", "pack", f"pack:{store.pack.name}:{topic_id}:{sid}",
                     {"run_id": res["run_id"], "workflow_id": workflow_id, "topic": topic_id, "stage": sid}, member_id=member_id,
                     agent=stage.agent, company_id=company_id)
    asyncio.create_task(watch_run(store, topic_id, sid, res["run_id"], company_id=company_id, on_finish=on_finish))
    return {"run_id": res["run_id"], "stage": ss}


TERMINAL = {"completed", "failed", "stopped", "timeout", "budget_exceeded"}


def run_state(run_id: str) -> Optional[dict[str, Any]]:
    """從 DB 讀 run 狀態（引擎記憶體較新就用記憶體）。回 {status, session_id, error} 或 None。"""
    from sqlmodel import Session

    from ... import sdk
    from ...models import WorkflowRun

    st = sdk._state()
    eng = getattr(st, "workflow_engine", None)
    live = eng.snapshot_of(run_id) if eng else None
    with Session(st.engine) as db:
        r = db.get(WorkflowRun, run_id)
        if r is None:
            return None
        status = live["status"] if live else r.status
        states = live["node_states"] if live else json.loads(r.node_states_json or "{}")
        error = (live["error"] if live else r.error) or ""
    sid = next((v.get("session_id") for v in states.values() if v.get("session_id")), None)
    if status not in TERMINAL and status not in ("running", "waiting_approval", "pending"):
        status = "failed"
    return {"status": status, "session_id": sid, "error": error}


def settle(store: TopicStore, topic_id: str, sid: str, rs: dict[str, Any], *, company_id: str, on_finish=None) -> Optional[dict[str, Any]]:
    """run 結束 → 依 gate 推進狀態、記事件、gate 階段塞收件匣。已不是 running 就不動。"""
    from ... import sdk

    stage = store.stage_of(sid)
    d = store.topic_dir(topic_id)
    st = store.read_status(d)
    ss = st["stages"].get(sid, {})
    if ss.get("status") != "running":
        return None
    if rs["status"] == "completed":
        missing = [o for o in stage.outputs if not (d / o).exists() or ((d / o).is_dir() and not any((d / o).iterdir()))]
        ev = "finish_gate" if stage.gate else "finish"
        br = store.evaluate_branch(topic_id, stage)
        extra: dict[str, Any] = {}
        if br is not None:
            extra["branch_result"] = br
            if br["passed"] is False:
                ev = "archive"
                extra["archived_reason"] = br["reason"]
        if stage.hint:
            extra["review_hint"] = store.review_hint(topic_id, stage) if ev == "finish_gate" else ""
        new = store.apply(topic_id, sid, ev, session_id=rs.get("session_id"), error="", missing_outputs=missing, **extra)
        if br is not None:
            store.set_topic_fields(topic_id, archived=(ev == "archive"), archived_reason=br["reason"] if ev == "archive" else "")
    else:
        new = store.apply(topic_id, sid, "fail", session_id=rs.get("session_id"), error=rs.get("error") or rs["status"])
    subject = f"pack:{store.pack.name}:{topic_id}:{sid}"
    sdk.record_event("pack.stage.finished", "pack", subject, {"run_id": rs.get("run_id") or ss.get("run_id"), "status": new["status"],
                                                             "missing_outputs": new.get("missing_outputs", [])},
                     agent=stage.agent, company_id=company_id)
    if new["status"] == "review":
        title = f"{store.pack.title or store.pack.name}｜{st.get('title', topic_id)}：{stage.title} 待核准"
        detail = "產出：" + ", ".join(stage.outputs)
        if new.get("missing_outputs"):
            detail += "；缺少：" + ", ".join(new["missing_outputs"])
        if new.get("branch_result") and new["branch_result"].get("score") is not None:
            brr = new["branch_result"]
            detail += f"；分數 {brr['score']:g}／門檻 {brr['min']:g}"
        if new.get("review_hint"):
            detail += f"；AI 建議：退回到 {new['review_hint']}"
        it = sdk.add_inbox_item(company_id, "pack_stage_review", title, detail, ref=subject,
                                link=f"/packs/{store.pack.name}?topic={topic_id}&stage={sid}", agent=stage.agent)
        if it is not None:
            store.apply_field(topic_id, sid, inbox_item_id=it.id)
    if on_finish:
        try:
            on_finish(topic_id, sid, new["status"])
        except Exception as e:  # hooks 壞了不影響流程
            log.warning("pack %s on_stage_finished hook failed: %s", store.pack.name, e)
    return new


async def watch_run(store: TopicStore, topic_id: str, sid: str, run_id: str, *, company_id: str, on_finish=None,
                    interval: float = 0.5, max_seconds: float = 4 * 3600) -> None:
    waited = 0.0
    while waited < max_seconds:
        await asyncio.sleep(interval)
        waited += interval
        try:
            rs = run_state(run_id)
        except Exception as e:  # pragma: no cover
            log.warning("watch_run %s: %s", run_id, e)
            continue
        if rs is None:
            rs = {"status": "failed", "session_id": None, "error": "run 不存在"}
        if rs["status"] in TERMINAL:
            rs["run_id"] = run_id
            try:
                settle(store, topic_id, sid, rs, company_id=company_id, on_finish=on_finish)
            except Exception as e:
                log.warning("settle %s/%s failed: %s", topic_id, sid, e)
            return
    log.warning("watch_run %s timed out after %ss", run_id, max_seconds)


def refresh(store: TopicStore, topic_id: str, *, company_id: str, on_finish=None) -> None:
    """讀取時補刀：running 但 run 已結束（例如 watcher 因重啟消失）就結算。"""
    d = store.topic_dir(topic_id)
    st = store.read_status(d)
    for sid, ss in st["stages"].items():
        if ss.get("status") == "running" and ss.get("run_id"):
            try:
                rs = run_state(ss["run_id"])
            except Exception:
                continue
            if rs is None:
                rs = {"status": "failed", "session_id": None, "error": "run 不存在"}
            if rs["status"] in TERMINAL:
                rs["run_id"] = ss["run_id"]
                settle(store, topic_id, sid, rs, company_id=company_id, on_finish=on_finish)
            elif rs.get("session_id") and not ss.get("session_id"):
                store.apply_field(topic_id, sid, session_id=rs["session_id"])


def resolve_stage_error(e: StageError):
    from ...errors import ApiError
    return ApiError(e.status, e.code, e.message)
