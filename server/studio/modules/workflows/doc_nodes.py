"""工作流的「文件模式」節點（`io_mode: doc`）。

一份文件從 A 站傳到 B 站再到 C 站，就是一條工作流。四種操作：

| doc_op    | 吃              | 吐            | 血緣 kind |
|-----------|-----------------|---------------|-----------|
| transform | 1 份 doc        | 新版本／新 doc | derived   |
| fanout    | 1 份 doc 或輸入 | N 份新 doc     | split     |
| select    | N 份 doc        | 1 份（挑一份） | selected  |
| merge     | N 份 doc        | 1 份新 doc     | merged    |

節點輸出的「文字」是給下游文字節點看的摘要；文件本身用 `node_states[n].doc_ids` 傳遞。
跨 run（例如行業套件的每個階段各是一次 run）則用 `doc_glob` 依路徑找回文件。
"""
from __future__ import annotations

import fnmatch
import json
import logging
import re
from pathlib import Path
from typing import Any, Optional

from sqlmodel import Session, select

from ...models import WorkflowApproval
from ..docs import service as svc
from ..docs.models import Doc

log = logging.getLogger("studio.workflows.docs")

MAX_DOC_CHARS = 24_000  # 塞進提示的單份文件上限（再長就截斷並標註）
SELECT_RE = re.compile(r"^\s*選擇[：:]\s*#?\s*(\d+)", re.M)
SELECT_RE_EN = re.compile(r"^\s*(?:choice|pick|select)[：:]\s*#?\s*(\d+)", re.I | re.M)

FANOUT_RULES = (
    "[輸出格式]\n"
    "請輸出 {n} 份**完整**的文件，全部放在**一個** ```doc 圍欄裡，份與份之間用單獨一行 `---doc---` 分隔。\n"
    "每份第一行都要是 `# <這份的標題>`（標題要看得出取向差在哪）。圍欄之外只寫一句你怎麼分這 {n} 個取向。\n"
    "文件本身若含 ``` 程式碼區塊，請把外層圍欄改成四個以上的反引號（````doc）。"
)
ONE_DOC_RULES = (
    "[輸出格式]\n"
    "請在回覆的最後用一個 ```doc 圍欄輸出**完整的新版文件**（不是差異、不是片段），第一行是 `# <標題>`。\n"
    "圍欄之外只寫一句「這一版改了什麼」。文件本身若含 ``` 程式碼區塊，外層請用四個以上的反引號（````doc）。"
)
SELECT_RULES = (
    "[輸出格式]\n"
    "第一行固定寫 `選擇：<編號>`（上面文件的編號），接著用 3–5 行說明為什麼選它、其他份輸在哪。不要輸出文件內容、不要輸出圍欄。"
)


# --------------------------------------------------------------------- 路徑
def render_path(ctx, node: dict[str, Any], template: str, *, index: int = 0, title: str = "") -> str:
    vars_ = {
        "topic_dir": str(ctx.input.get("topic_dir") or "") if isinstance(ctx.input, dict) else "",
        "run_id": ctx.run_id,
        "node_id": str(node.get("id") or ""),
        "stage": str(ctx.input.get("stage") or "") if isinstance(ctx.input, dict) else "",
        "i": str(index),
        "title": svc.slugify(title, "doc"),
    }
    out = template
    for k, v in vars_.items():
        out = out.replace("{" + k + "}", v)
    return out


def workspace_rel(engine, ctx, node: dict[str, Any], template: str, *, index: int = 0, title: str = "") -> str:
    return svc.to_relative(engine.workspace, render_path(ctx, node, template, index=index, title=title))


# --------------------------------------------------------------------- 取得輸入文件
def _doc_view(db: Session, d: Doc) -> dict[str, Any]:
    last = svc.latest(db, d.id)
    content = last.content if last else ""
    truncated = len(content) > MAX_DOC_CHARS
    return {"id": d.id, "title": d.title, "path": d.path, "version": last.version if last else None,
            "content": content, "prompt_content": content[:MAX_DOC_CHARS] + ("\n…（文件過長，已截斷）" if truncated else ""),
            "chars": len(content)}


def resolve_inputs(engine, ctx, nid: str, node: dict[str, Any]) -> list[dict[str, Any]]:
    """上游節點的 doc_ids → run input 的 doc_ids → 節點 doc_glob（跨 run 用路徑找回來）。"""
    ids: list[str] = []
    for e in ctx.incoming(nid):
        if not ctx.decisions.get(ctx.edge_key(e)):
            continue
        for did in ctx.states[str(e["source"])].get("doc_ids") or []:
            if did not in ids:
                ids.append(did)
    if not ids and isinstance(ctx.input, dict):
        raw = ctx.input.get("doc_ids") or ([ctx.input["doc_id"]] if ctx.input.get("doc_id") else [])
        ids = [str(x) for x in raw if x]
    with Session(engine.db_engine) as db:
        out: list[dict[str, Any]] = []
        for did in ids:
            d = db.get(Doc, did)
            if d is not None and d.company_id == ctx.company_id:
                out.append(_doc_view(db, d))
        if out:
            return out
        glob = str(node.get("doc_glob") or "")
        if not glob:
            return []
        pattern = svc.to_relative(engine.workspace, render_path(ctx, node, glob))
        matched: dict[str, Doc] = {}
        for d in db.exec(select(Doc).where(Doc.company_id == ctx.company_id)).all():
            if fnmatch.fnmatch(d.path, pattern):
                matched[d.path] = d
        # 工作區裡已經有檔案但還沒收編成文件的，一併收進來（人手動放進來的稿子）
        root = Path(engine.workspace)
        for f in sorted(root.glob(pattern)):
            if not f.is_file():
                continue
            rel = f.relative_to(root).as_posix()
            if rel not in matched:
                matched[rel] = svc.adopt_file(db, engine.workspace, company_id=ctx.company_id, rel_path=rel,
                                              origin="workflow", stage=str(node.get("id") or ""))
        db.commit()
        return [_doc_view(db, matched[k]) for k in sorted(matched)]


# --------------------------------------------------------------------- 提示組裝
def _docs_block(docs: list[dict[str, Any]], *, numbered: bool = False) -> str:
    parts = []
    for i, d in enumerate(docs, start=1):
        head = f"### {i}. {d['title']}" if numbered else f"### {d['title']}"
        parts.append(f"{head}（{d['path']}，v{d['version'] or 0}，{d['chars']} 字）\n"
                     f"----- 文件開始 -----\n{d['prompt_content']}\n----- 文件結束 -----")
    return "\n\n".join(parts)


def _compose(engine, ctx, nid: str, node: dict[str, Any], docs: list[dict[str, Any]], rules: str, *,
             numbered: bool = False) -> str:
    task = str(node.get("prompt") or "")
    body = engine._compose(ctx, nid, node, task)
    if docs:
        label = "[目前文件]" if len(docs) == 1 else f"[上游文件（{len(docs)} 份）]"
        body = f"{label}\n{_docs_block(docs, numbered=numbered)}\n\n{body}"
    return f"{body}\n\n{rules}"


# --------------------------------------------------------------------- 操作
async def run(engine, ctx, nid: str, node: dict[str, Any], instr: str) -> str:
    op = str(node.get("doc_op") or "transform")
    docs = resolve_inputs(engine, ctx, nid, node)
    ctx.states[nid]["input_doc_ids"] = [d["id"] for d in docs]
    if op == "fanout":
        return await _fanout(engine, ctx, nid, node, docs, instr)
    if op == "select":
        return await _select(engine, ctx, nid, node, docs, instr)
    if op == "merge":
        return await _merge(engine, ctx, nid, node, docs, instr)
    return await _transform(engine, ctx, nid, node, docs, instr)


def _one_doc(raw: str) -> str:
    _body, docs, patches = svc.extract_docs(raw)
    if docs:
        return docs[-1]
    if patches:
        raise RuntimeError("doc 節點只接受 ```doc 完整全文，收到的是 doc-patch")
    raise RuntimeError("模型沒有輸出 ```doc 圍欄（需要完整的文件全文）")


def _note(raw: str) -> str:
    body, _docs, _patches = svc.extract_docs(raw)
    return (body or "").strip()


def _record(kind: str, ctx, subject: str, payload: dict[str, Any]) -> None:
    try:
        from ..events import record
        record(kind, "workflow", subject, payload, company_id=ctx.company_id, member_id=ctx.member_id)
    except Exception as e:  # pragma: no cover
        log.debug("doc event skipped: %s", e)


def _stage(node: dict[str, Any], nid: str) -> str:
    return str(node.get("doc_stage") or nid)


def _apply_status(doc, node: dict[str, Any]) -> None:
    """節點可以順手把文件狀態推進（例如 final 站把 spec.md 標成 final）。"""
    from ..docs.models import DOC_STATUSES
    st = str(node.get("doc_status") or "")
    if st in DOC_STATUSES:
        doc.status = st


def _set_state(ctx, nid: str, docs: list[dict[str, Any]]) -> None:
    ctx.states[nid]["doc_ids"] = [d["doc_id"] for d in docs]
    ctx.states[nid]["docs"] = docs


async def _transform(engine, ctx, nid: str, node: dict[str, Any], docs: list[dict[str, Any]], instr: str) -> str:
    text = _compose(engine, ctx, nid, node, docs[:1], ONE_DOC_RULES)
    raw = await engine._hermes_call(ctx, nid, node, text, instr)
    content = _one_doc(raw)
    summary = _note(raw) or "更新文件"
    new_doc = bool(node.get("doc_new")) or not docs
    with Session(engine.db_engine) as db:
        if new_doc:
            rel = (workspace_rel(engine, ctx, node, str(node["doc_path"]), title=svc.first_heading(content))
                   if node.get("doc_path") else "")
            existing = svc.by_path(db, ctx.company_id, rel) if rel else None
            parent = docs[0]["id"] if docs else ""
            if existing is not None:
                doc = existing
                v, _ = svc.add_version(db, engine.workspace, doc, content, author_kind="agent",
                                       author_id=str(node.get("agent") or ""), summary=summary, run_id=ctx.run_id)
            else:
                doc, v = svc.create_doc(db, engine.workspace, company_id=ctx.company_id,
                                        title=svc.first_heading(content) or str(node.get("title") or "文件"),
                                        path=rel, content=content, stage=_stage(node, nid), parent_doc_id=parent, origin="workflow",
                                        meta={"run_id": ctx.run_id, "node_id": nid}, author_kind="agent",
                                        author_id=str(node.get("agent") or ""), summary=summary, run_id=ctx.run_id)
            if parent:
                svc.link(db, parent, doc.id, "derived", company_id=ctx.company_id, run_id=ctx.run_id, node_id=nid)
        else:
            doc = db.get(Doc, docs[0]["id"])
            v, _ = svc.add_version(db, engine.workspace, doc, content, author_kind="agent",
                                   author_id=str(node.get("agent") or ""), summary=summary, run_id=ctx.run_id)
        doc.stage = _stage(node, nid)
        _apply_status(doc, node)
        db.add(doc)
        db.commit()
        out = [{"doc_id": doc.id, "title": doc.title, "path": doc.path, "version": v.version,
                "added": v.added, "removed": v.removed, "chars": len(content)}]
    _set_state(ctx, nid, out)
    _record("doc.updated", ctx, f"doc:{out[0]['doc_id']}", {**out[0], "run_id": ctx.run_id, "node_id": nid})
    return f"{summary}\n\n[文件] {out[0]['title']} → v{out[0]['version']}（{out[0]['chars']} 字，+{out[0]['added']}/−{out[0]['removed']}）\n{out[0]['path']}"


async def _fanout(engine, ctx, nid: str, node: dict[str, Any], docs: list[dict[str, Any]], instr: str) -> str:
    n = max(2, min(int(node.get("fanout_count") or 3), 20))
    text = _compose(engine, ctx, nid, node, docs[:1], FANOUT_RULES.format(n=n))
    raw = await engine._hermes_call(ctx, nid, node, text, instr)
    _body, parts, _p = svc.extract_docs(raw)
    parts = [p for p in parts if p.strip()]
    if not parts:
        raise RuntimeError("模型沒有輸出 ```doc 圍欄（fanout 需要多份文件，用 ---doc--- 分隔）")
    if len(parts) < n:
        ctx.states[nid]["note"] = f"要求 {n} 份，模型只給了 {len(parts)} 份"
    parent = docs[0]["id"] if docs else ""
    pattern = str(node.get("doc_path_pattern") or "")
    out: list[dict[str, Any]] = []
    with Session(engine.db_engine) as db:
        for i, content in enumerate(parts[:n], start=1):
            title = svc.first_heading(content) or f"{node.get('title') or '草稿'} {i}"
            rel = workspace_rel(engine, ctx, node, pattern, index=i, title=title) if pattern else ""
            existing = svc.by_path(db, ctx.company_id, rel) if rel else None
            if existing is not None:
                doc = existing
                v, _ = svc.add_version(db, engine.workspace, doc, content, author_kind="agent",
                                       author_id=str(node.get("agent") or ""), summary=f"fanout {i}/{len(parts)}",
                                       run_id=ctx.run_id, force=False)
                doc.title = title[:200]
            else:
                doc, v = svc.create_doc(db, engine.workspace, company_id=ctx.company_id, title=title, path=rel,
                                        content=content, stage=_stage(node, nid), parent_doc_id=parent, origin="workflow",
                                        meta={"run_id": ctx.run_id, "node_id": nid, "fanout_index": i},
                                        author_kind="agent", author_id=str(node.get("agent") or ""),
                                        summary=f"fanout {i}/{len(parts)}", run_id=ctx.run_id)
            doc.stage = _stage(node, nid)
            _apply_status(doc, node)
            db.add(doc)
            if parent:
                svc.link(db, parent, doc.id, "split", company_id=ctx.company_id, run_id=ctx.run_id, node_id=nid)
            out.append({"doc_id": doc.id, "title": doc.title, "path": doc.path, "version": v.version,
                        "added": v.added, "removed": v.removed, "chars": len(content)})
        db.commit()
    _set_state(ctx, nid, out)
    _record("doc.split", ctx, f"doc:{parent or nid}", {"run_id": ctx.run_id, "node_id": nid,
                                                       "children": [d["doc_id"] for d in out], "count": len(out)})
    lines = "\n".join(f"{i}. {d['title']}（{d['chars']} 字）{d['path']}" for i, d in enumerate(out, start=1))
    return f"產出 {len(out)} 份文件：\n{lines}"


def _option_rows(docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"doc_id": d["id"], "title": d["title"], "path": d["path"], "version": d["version"], "chars": d["chars"],
             "excerpt": (d["content"] or "")[:600]} for d in docs]


async def _select(engine, ctx, nid: str, node: dict[str, Any], docs: list[dict[str, Any]], instr: str) -> str:
    if not docs:
        raise RuntimeError("select 節點沒有可選的文件（上游沒有 doc，也沒設 doc_glob）")
    by = str(node.get("select_by") or "ai")
    reason = ""
    if by == "human":
        options = _option_rows(docs)
        payload = "請選一份帶到下一站：\n\n" + "\n\n".join(
            f"{i}. {o['title']}（{o['chars']} 字）\n{o['excerpt'][:300]}" for i, o in enumerate(options, start=1))
        with Session(engine.db_engine) as db:
            a = WorkflowApproval(company_id=ctx.company_id, run_id=ctx.run_id, workflow_id=ctx.workflow_id,
                                 workflow_name=ctx.workflow_name, node_id=nid,
                                 node_title=f"{node.get('title') or nid}（選一份文件）", payload=payload,
                                 kind="doc_select", options_json=json.dumps(options, ensure_ascii=False))
            db.add(a)
            db.commit()
            db.refresh(a)
            approval_id = a.id
        decision, comment = await engine._wait_human(ctx, nid, approval_id, payload=payload, kind="doc_select")
        if decision != "approve":
            raise RuntimeError(f"人退回選題：{comment or '無說明'}")
        chosen_id = ctx.approval_choices.get(nid) or ""
        chosen = next((d for d in docs if d["id"] == chosen_id), None) or docs[0]
        reason = comment or "（人工挑選）"
    else:
        criteria = str(node.get("criteria") or node.get("select_criteria") or "")
        task = str(node.get("prompt") or "從上面的文件挑一份最值得往下做的。")
        crit = f"\n\n[評分準則]\n{criteria}" if criteria else ""
        node2 = dict(node, prompt=task + crit)
        text = _compose(engine, ctx, nid, node2, docs, SELECT_RULES, numbered=True)
        raw = await engine._hermes_call(ctx, nid, node2, text, instr)
        m = SELECT_RE.search(raw) or SELECT_RE_EN.search(raw)
        if m is None:
            raise RuntimeError(f"AI 沒有回「選擇：<編號>」：{raw[:120]!r}")
        idx = int(m.group(1))
        if idx < 1 or idx > len(docs):
            raise RuntimeError(f"AI 選了不存在的編號 {idx}（共 {len(docs)} 份）")
        chosen = docs[idx - 1]
        reason = _note(raw)
    with Session(engine.db_engine) as db:
        src = db.get(Doc, chosen["id"])
        meta = src.meta()
        meta.update({"selected_by": by, "select_reason": reason[:2000], "selected_at_run": ctx.run_id})
        src.meta_json = json.dumps(meta, ensure_ascii=False)
        db.add(src)
        doc, version, added, removed = src, chosen["version"], 0, 0
        # 有 doc_path 就把選中的內容落到固定路徑（下游／下一個階段才找得到）
        if node.get("doc_path"):
            rel = workspace_rel(engine, ctx, node, str(node["doc_path"]), title=src.title)
            target = svc.by_path(db, ctx.company_id, rel)
            if target is None:
                target, v = svc.create_doc(db, engine.workspace, company_id=ctx.company_id, title=src.title, path=rel,
                                           content=chosen["content"], stage=_stage(node, nid), parent_doc_id=src.id, origin="workflow",
                                           meta={"run_id": ctx.run_id, "node_id": nid, "selected_from": src.id},
                                           author_kind="human" if by == "human" else "agent",
                                           author_id=str(node.get("agent") or ""), summary=f"選中：{src.title}",
                                           run_id=ctx.run_id)
            elif target.id != src.id:
                v, _ = svc.add_version(db, engine.workspace, target, chosen["content"],
                                       author_kind="human" if by == "human" else "agent",
                                       author_id=str(node.get("agent") or ""), summary=f"選中：{src.title}",
                                       run_id=ctx.run_id)
            else:
                v = svc.latest(db, target.id)
            svc.link(db, src.id, target.id, "selected", company_id=ctx.company_id, run_id=ctx.run_id, node_id=nid)
            doc, version, added, removed = target, (v.version if v else None), (v.added if v else 0), (v.removed if v else 0)
        elif src.parent_doc_id:
            svc.link(db, src.parent_doc_id, src.id, "selected", company_id=ctx.company_id, run_id=ctx.run_id, node_id=nid)
        doc.stage = _stage(node, nid)
        _apply_status(doc, node)
        db.add(doc)
        db.commit()
        out = [{"doc_id": doc.id, "title": doc.title, "path": doc.path, "version": version,
                "added": added, "removed": removed, "chars": chosen["chars"]}]
    _set_state(ctx, nid, out)
    ctx.states[nid]["select_reason"] = reason
    _record("doc.selected", ctx, f"doc:{out[0]['doc_id']}",
            {"run_id": ctx.run_id, "node_id": nid, "by": by, "reason": reason[:500],
             "candidates": [d["id"] for d in docs]})
    return f"選擇：{out[0]['title']}\n{reason}\n\n[文件] {out[0]['path']}"


async def _merge(engine, ctx, nid: str, node: dict[str, Any], docs: list[dict[str, Any]], instr: str) -> str:
    if not docs:
        raise RuntimeError("merge 節點沒有上游文件")
    text = _compose(engine, ctx, nid, node, docs, ONE_DOC_RULES, numbered=True)
    raw = await engine._hermes_call(ctx, nid, node, text, instr)
    content = _one_doc(raw)
    summary = _note(raw) or f"合併 {len(docs)} 份文件"
    title = svc.first_heading(content) or str(node.get("title") or "合併文件")
    rel = workspace_rel(engine, ctx, node, str(node["doc_path"]), title=title) if node.get("doc_path") else ""
    with Session(engine.db_engine) as db:
        existing = svc.by_path(db, ctx.company_id, rel) if rel else None
        if existing is not None:
            doc = existing
            v, _ = svc.add_version(db, engine.workspace, doc, content, author_kind="agent",
                                   author_id=str(node.get("agent") or ""), summary=summary, run_id=ctx.run_id)
        else:
            doc, v = svc.create_doc(db, engine.workspace, company_id=ctx.company_id, title=title, path=rel,
                                    content=content, stage=_stage(node, nid), parent_doc_id=docs[0]["id"], origin="workflow",
                                    meta={"run_id": ctx.run_id, "node_id": nid, "merged_from": [d["id"] for d in docs]},
                                    author_kind="agent", author_id=str(node.get("agent") or ""), summary=summary,
                                    run_id=ctx.run_id)
        for d in docs:
            svc.link(db, d["id"], doc.id, "merged", company_id=ctx.company_id, run_id=ctx.run_id, node_id=nid)
        doc.stage = _stage(node, nid)
        _apply_status(doc, node)
        db.add(doc)
        db.commit()
        out = [{"doc_id": doc.id, "title": doc.title, "path": doc.path, "version": v.version,
                "added": v.added, "removed": v.removed, "chars": len(content)}]
    _set_state(ctx, nid, out)
    _record("doc.merged", ctx, f"doc:{out[0]['doc_id']}",
            {"run_id": ctx.run_id, "node_id": nid, "sources": [d["id"] for d in docs]})
    return f"{summary}\n\n[文件] {out[0]['title']} → v{out[0]['version']}（{out[0]['chars']} 字）\n{out[0]['path']}"
