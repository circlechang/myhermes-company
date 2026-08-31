"""docs 模組的核心：檔案同步、版本、diff、血緣、圍欄解析。

設計要點
- **內容的真相在 DB**（`doc_versions` 不可變、版本遞增），最新版同時寫一份到工作區的 `.md`，
  使用者用 Finder／檔案瀏覽器就看得到。
- 外部改了檔案（mtime／內容 hash 對不上最新版）→ `drift=True`，前端可一鍵「把檔案現況存成新版本」。
- 這裡的函式都吃 `engine`／`workspace`，不吃 Request，因為 chat_ws 與工作流引擎都要用。
"""
from __future__ import annotations

import difflib
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Iterable, Optional

from sqlmodel import Session, select

from ...models import now
from .models import Doc, DocLink, DocVersion

log = logging.getLogger("studio.docs")

MAX_DOC_BYTES = 2_000_000

# --- 綁定（讓 chat_ws / workflow engine 不用傳一堆參數） -----------------------
_engine = None
_workspace: Optional[Path] = None


def bind(engine, workspace: Path) -> None:
    global _engine, _workspace
    _engine = engine
    _workspace = Path(workspace)


def bound() -> tuple[Any, Optional[Path]]:
    return _engine, _workspace


class DocError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# --- 路徑 --------------------------------------------------------------------
_SAFE = re.compile(r"[^\w\-. 一-鿿㐀-䶿]")


def slugify(text: str, fallback: str = "doc") -> str:
    s = _SAFE.sub("-", (text or "").strip())
    s = re.sub(r"-{2,}", "-", s).strip("-. ")
    return (s or fallback)[:60]


def default_path(doc_id: str, title: str) -> str:
    return f"docs/{doc_id}_{slugify(title, 'doc')}.md"


def resolve(workspace: Path, rel: str) -> Path:
    """工作區內相對路徑 → 絕對路徑；越界或非 .md 一律拒絕。"""
    rel = (rel or "").strip()
    if not rel:
        raise DocError("bad_path", "path 不可空白")
    if rel.startswith("/") or Path(rel).is_absolute() or ".." in Path(rel).parts:
        raise DocError("bad_path", "path 必須是工作區內的相對路徑")
    if not rel.lower().endswith(".md"):
        raise DocError("bad_path", "文件必須是 .md")
    root = Path(workspace).resolve()
    p = (root / rel).resolve()
    if p != root and root not in p.parents:
        raise DocError("bad_path", "path 越出工作區")
    return p


def to_relative(workspace: Path, path: str) -> str:
    """把絕對路徑（或已經是相對路徑的字串）轉成工作區內相對路徑。"""
    root = Path(workspace).resolve()
    p = Path(path).expanduser()
    if p.is_absolute():
        try:
            return p.resolve().relative_to(root).as_posix()
        except ValueError:
            raise DocError("bad_path", f"{path} 不在工作區 {root} 內")
    return p.as_posix()


def sha(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


# --- 檔案同步 ----------------------------------------------------------------
def write_file(workspace: Path, doc: Doc, content: str) -> None:
    p = resolve(workspace, doc.path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    try:
        doc.file_mtime = p.stat().st_mtime
    except OSError:  # pragma: no cover
        doc.file_mtime = 0.0
    doc.file_hash = sha(content)


def read_file(workspace: Path, doc: Doc) -> Optional[str]:
    try:
        p = resolve(workspace, doc.path)
    except DocError:
        return None
    if not p.is_file():
        return None
    if p.stat().st_size > MAX_DOC_BYTES:
        raise DocError("too_large", "檔案超過 2MB", 413)
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def drift(workspace: Path, doc: Doc, latest_content: Optional[str]) -> bool:
    """檔案內容與最新版本不同（有人從 Finder／編輯器改過）就是漂移。"""
    disk = read_file(workspace, doc)
    if disk is None:
        return latest_content not in (None, "")
    return disk != (latest_content or "")


# --- 版本 --------------------------------------------------------------------
def latest(db: Session, doc_id: str) -> Optional[DocVersion]:
    return db.exec(select(DocVersion).where(DocVersion.doc_id == doc_id).order_by(DocVersion.version.desc())).first()


def version_at(db: Session, doc_id: str, version: int) -> Optional[DocVersion]:
    return db.exec(select(DocVersion).where(DocVersion.doc_id == doc_id, DocVersion.version == version)).first()


def diff_stat(old: str, new: str) -> tuple[int, int]:
    lines = list(difflib.unified_diff((old or "").splitlines(), (new or "").splitlines(), lineterm=""))
    return (sum(1 for l in lines if l.startswith("+") and not l.startswith("+++")),
            sum(1 for l in lines if l.startswith("-") and not l.startswith("---")))


def unified(a_text: str, b_text: str, a_label: str, b_label: str) -> dict[str, Any]:
    lines = list(difflib.unified_diff((a_text or "").splitlines(), (b_text or "").splitlines(),
                                      fromfile=a_label, tofile=b_label, lineterm=""))
    return {"diff": "\n".join(lines),
            "added": sum(1 for l in lines if l.startswith("+") and not l.startswith("+++")),
            "removed": sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))}


def add_version(db: Session, workspace: Path, doc: Doc, content: str, *, author_kind: str = "agent", author_id: str = "",
                summary: str = "", session_id: str = "", run_id: str = "", force: bool = False) -> tuple[DocVersion, bool]:
    """寫一個新版本（同時寫回 .md）。內容與最新版相同且 force=False → 回 (最新版, False)。"""
    if len(content.encode("utf-8")) > MAX_DOC_BYTES:
        raise DocError("too_large", "文件超過 2MB", 413)
    last = latest(db, doc.id)
    if last is not None and last.content == content and not force:
        # 內容一樣但檔案漂移過 → 把檔案寫回來，版本不動
        if drift(workspace, doc, last.content):
            write_file(workspace, doc, content)
            db.add(doc)
        return last, False
    added, removed = diff_stat(last.content if last else "", content)
    v = DocVersion(doc_id=doc.id, version=(last.version + 1 if last else 1), content=content,
                   author_kind=author_kind if author_kind in ("human", "agent") else "agent", author_id=author_id,
                   summary=(summary or "")[:500], added=added, removed=removed, session_id=session_id, run_id=run_id)
    db.add(v)
    write_file(workspace, doc, content)
    doc.updated_at = now()
    db.add(doc)
    return v, True


# --- 文件 --------------------------------------------------------------------
def create_doc(db: Session, workspace: Path, *, company_id: str, title: str, path: str = "", content: Optional[str] = None,
               status: str = "draft", stage: str = "", owner_agent_id: str = "", parent_doc_id: str = "",
               origin: str = "chat", meta: Optional[dict] = None, created_by: str = "",
               author_kind: str = "human", author_id: str = "", summary: str = "", session_id: str = "",
               run_id: str = "") -> tuple[Doc, Optional[DocVersion]]:
    """建立文件。`content=None` → 先建空檔、0 個版本（AI 的第一份輸出才是版本 1）。"""
    title = (title or "").strip() or "未命名文件"
    doc = Doc(company_id=company_id, title=title[:200], status=status, stage=stage, owner_agent_id=owner_agent_id,
              parent_doc_id=parent_doc_id, origin=origin, meta_json=json.dumps(meta or {}, ensure_ascii=False),
              created_by=created_by)
    db.add(doc)
    db.flush()  # 拿 id 做預設路徑
    doc.path = to_relative(workspace, path) if path else default_path(doc.id, title)
    resolve(workspace, doc.path)  # 驗證
    v: Optional[DocVersion] = None
    if content is None:
        write_file(workspace, doc, "")
    else:
        v, _ = add_version(db, workspace, doc, content, author_kind=author_kind, author_id=author_id, summary=summary,
                           session_id=session_id, run_id=run_id)
    db.add(doc)
    return doc, v


def get_doc(db: Session, company_id: str, doc_id: str) -> Doc:
    d = db.get(Doc, doc_id)
    if d is None or d.company_id != company_id:
        raise DocError("not_found", "doc not found", 404)
    return d


def by_path(db: Session, company_id: str, rel_path: str) -> Optional[Doc]:
    return db.exec(select(Doc).where(Doc.company_id == company_id, Doc.path == rel_path)).first()


def adopt_file(db: Session, workspace: Path, *, company_id: str, rel_path: str, title: str = "", origin: str = "workflow",
               stage: str = "", parent_doc_id: str = "") -> Doc:
    """工作區裡已經有這個 .md 但還沒有 doc 列 → 收編成文件（版本 1＝檔案現況）。已存在就直接回。"""
    existing = by_path(db, company_id, rel_path)
    if existing is not None:
        return existing
    p = resolve(workspace, rel_path)
    content = p.read_text(encoding="utf-8") if p.is_file() else ""
    doc, _ = create_doc(db, workspace, company_id=company_id, title=title or first_heading(content) or Path(rel_path).stem,
                        path=rel_path, content=content, origin=origin, stage=stage, parent_doc_id=parent_doc_id,
                        author_kind="human", summary="收編工作區既有檔案")
    return doc


def first_heading(text: str) -> str:
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith("#"):
            return s.lstrip("#").strip()[:120]
        if s:
            return s[:120]
    return ""


def public(db: Session, workspace: Path, doc: Doc, *, content: bool = False) -> dict[str, Any]:
    last = latest(db, doc.id)
    n = db.exec(select(DocVersion).where(DocVersion.doc_id == doc.id)).all()
    extra: dict[str, Any] = {
        "latest_version": last.version if last else None,
        "versions": len(n),
        "latest": last.meta() if last else None,
        "drift": drift(workspace, doc, last.content if last else ""),
        "abs_path": str(resolve(workspace, doc.path)) if doc.path else "",
    }
    if content:
        extra["content"] = last.content if last else ""
        extra["file_content"] = read_file(workspace, doc)
    return doc.to_dict(**extra)


# --- 血緣 --------------------------------------------------------------------
def link(db: Session, from_doc_id: str, to_doc_id: str, kind: str, *, company_id: str = "", run_id: str = "",
         node_id: str = "") -> Optional[DocLink]:
    if not from_doc_id or not to_doc_id or from_doc_id == to_doc_id:
        return None
    ex = db.exec(select(DocLink).where(DocLink.from_doc_id == from_doc_id, DocLink.to_doc_id == to_doc_id,
                                       DocLink.kind == kind)).first()
    if ex is not None:
        return ex
    l = DocLink(company_id=company_id, from_doc_id=from_doc_id, to_doc_id=to_doc_id, kind=kind, run_id=run_id, node_id=node_id)
    db.add(l)
    return l


def lineage(db: Session, workspace: Path, company_id: str, doc_id: str, *, depth: int = 6) -> dict[str, Any]:
    """往上（誰生了它）＋往下（它生了誰）的血緣樹，回 {root, nodes, edges}。"""
    root = get_doc(db, company_id, doc_id)
    seen: dict[str, Doc] = {root.id: root}
    edges: list[dict[str, Any]] = []
    edge_ids: set[str] = set()

    def add_edges(rows: Iterable[DocLink]) -> list[str]:
        out: list[str] = []
        for l in rows:
            if l.id not in edge_ids:
                edge_ids.add(l.id)
                edges.append(l.to_dict())
            other = l.from_doc_id if l.to_doc_id in seen else l.to_doc_id
            out.append(other)
        return out

    frontier = [root.id]
    for _ in range(max(1, depth)):
        if not frontier:
            break
        ups = db.exec(select(DocLink).where(DocLink.to_doc_id.in_(frontier))).all()
        downs = db.exec(select(DocLink).where(DocLink.from_doc_id.in_(frontier))).all()
        cand = set(add_edges(ups)) | set(add_edges(downs))
        # parent_doc_id 也算一條隱含的血緣（沒有明確 link 時）
        for did in list(frontier):
            d = seen.get(did) or db.get(Doc, did)
            if d is not None and d.parent_doc_id and d.parent_doc_id not in seen:
                cand.add(d.parent_doc_id)
        frontier = []
        for cid in cand:
            if cid in seen:
                continue
            d = db.get(Doc, cid)
            if d is None or d.company_id != company_id:
                continue
            seen[cid] = d
            frontier.append(cid)
    nodes = []
    for d in seen.values():
        last = latest(db, d.id)
        nodes.append({"id": d.id, "title": d.title, "status": d.status, "stage": d.stage, "origin": d.origin,
                      "path": d.path, "latest_version": last.version if last else None,
                      "chars": len(last.content) if last else 0, "is_root": d.id == root.id,
                      "parent_doc_id": d.parent_doc_id, "created_at": d.created_at})
    # parent_doc_id 補成邊（沒有明確 link 的情況）
    have = {(e["from_doc_id"], e["to_doc_id"]) for e in edges}
    for d in seen.values():
        if d.parent_doc_id and d.parent_doc_id in seen and (d.parent_doc_id, d.id) not in have:
            edges.append({"id": f"implicit:{d.parent_doc_id}:{d.id}", "from_doc_id": d.parent_doc_id, "to_doc_id": d.id,
                          "kind": "derived", "run_id": "", "node_id": "", "created_at": d.created_at})
    nodes.sort(key=lambda n: (n["created_at"] or now()))
    return {"root": root.id, "nodes": nodes, "edges": edges}


# --- ```doc 圍欄解析 ---------------------------------------------------------
FENCE_OPEN = re.compile(r"^(?P<ticks>`{3,})[ \t]*(?P<tag>doc-patch|doc)[ \t]*$", re.I)
SPLIT_MARK = re.compile(r"^-{2,}\s*doc\s*-{2,}\s*$", re.I)


class DocBlock:
    def __init__(self, tag: str, body: str, start: int, end: int):
        self.tag = tag.lower()  # doc | doc-patch
        self.body = body
        self.start = start  # 行索引（含）
        self.end = end  # 行索引（含，指 closing fence 那行；沒閉合＝最後一行）


def find_doc_blocks(text: str) -> list[DocBlock]:
    """掃出 ```doc / ```doc-patch 圍欄（CommonMark 規則：閉合的反引號數要 ≥ 開頭）。"""
    lines = (text or "").splitlines()
    out: list[DocBlock] = []
    i = 0
    while i < len(lines):
        m = FENCE_OPEN.match(lines[i])
        if not m:
            i += 1
            continue
        ticks = len(m.group("ticks"))
        close = re.compile(r"^`{" + str(ticks) + r",}[ \t]*$")
        j = i + 1
        body: list[str] = []
        while j < len(lines) and not close.match(lines[j]):
            body.append(lines[j])
            j += 1
        out.append(DocBlock(m.group("tag"), "\n".join(body), i, min(j, len(lines) - 1) if lines else i))
        i = j + 1
    return out


def strip_blocks(text: str, blocks: list[DocBlock]) -> str:
    """把圍欄整段從訊息本文抽掉（對話裡不重複貼整份文件）。"""
    if not blocks:
        return text
    lines = (text or "").splitlines()
    drop: set[int] = set()
    for b in blocks:
        for k in range(b.start, b.end + 1):
            drop.add(k)
    return "\n".join(l for i, l in enumerate(lines) if i not in drop).strip()


def split_multi(body: str) -> list[str]:
    """一個圍欄裡用 `---doc---` 分隔多份文件（fanout 用）。"""
    parts: list[str] = []
    cur: list[str] = []
    for line in body.splitlines():
        if SPLIT_MARK.match(line):
            parts.append("\n".join(cur).strip())
            cur = []
        else:
            cur.append(line)
    parts.append("\n".join(cur).strip())
    return [p for p in parts if p]


def extract_docs(text: str) -> tuple[str, list[str], list[str]]:
    """回 (抽掉圍欄的訊息本文, ```doc 的內容清單（已依 ---doc--- 拆開）, ```doc-patch 的內容清單)。"""
    blocks = find_doc_blocks(text)
    if not blocks:
        return (text or "").strip(), [], []
    docs: list[str] = []
    patches: list[str] = []
    for b in blocks:
        if b.tag == "doc-patch":
            patches.append(b.body)
        else:
            docs.extend(split_multi(b.body))
    return strip_blocks(text, blocks), docs, patches


# --- unified diff 套用（```doc-patch） ---------------------------------------
HUNK = re.compile(r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@")


def apply_patch(base: str, patch: str) -> str:
    """套 unified diff。行號對不上時用上下文重新定位；套不上丟 DocError（呼叫端請模型重出全文）。"""
    lines = (base or "").split("\n")
    plines = (patch or "").split("\n")
    out: list[str] = []
    cursor = 0  # base 已消化到第幾行
    i = 0
    applied = 0
    while i < len(plines):
        line = plines[i]
        if line.startswith(("--- ", "+++ ", "diff ", "index ")):
            i += 1
            continue
        m = HUNK.match(line)
        if not m:
            i += 1
            continue
        i += 1
        old: list[str] = []
        new: list[str] = []
        while i < len(plines) and not HUNK.match(plines[i]):
            pl = plines[i]
            if pl.startswith("\\"):  # \ No newline at end of file
                i += 1
                continue
            tag, rest = (pl[0], pl[1:]) if pl else (" ", "")
            if tag == "-":
                old.append(rest)
            elif tag == "+":
                new.append(rest)
            elif tag in (" ", ""):
                old.append(rest)
                new.append(rest)
            else:  # 不像 diff 的行：整個 patch 視為壞掉
                raise DocError("bad_patch", f"無法解析的 diff 行：{pl[:60]!r}")
            i += 1
        start = int(m.group(1)) - 1
        idx = _locate(lines, old, max(start, cursor), cursor)
        if idx is None:
            raise DocError("bad_patch", "diff 的上下文對不上目前文件")
        out.extend(lines[cursor:idx])
        out.extend(new)
        cursor = idx + len(old)
        applied += 1
    if not applied:
        raise DocError("bad_patch", "看不到任何 @@ hunk")
    out.extend(lines[cursor:])
    return "\n".join(out)


def _locate(lines: list[str], old: list[str], hint: int, floor: int) -> Optional[int]:
    if not old:
        return min(max(hint, floor), len(lines))
    for cand in _candidates(hint, floor, len(lines) - len(old)):
        if lines[cand:cand + len(old)] == old:
            return cand
    return None


def _candidates(hint: int, floor: int, top: int):
    hint = max(floor, min(hint, max(top, floor)))
    yield hint
    for d in range(1, max(top - floor, 0) + 1):
        if hint - d >= floor:
            yield hint - d
        if hint + d <= top:
            yield hint + d


# --- 給模型看的文件脈絡 ------------------------------------------------------
DOC_RULES = (
    "[文件更新規則]\n"
    "1. 這一輪如果需要改文件，就在回覆的**最後**用一個 ```doc 圍欄輸出**完整的新版文件**（不是差異、不是片段）。\n"
    "2. 文件本身如果含有 ``` 程式碼區塊，請改用四個以上的反引號包住（````doc）。\n"
    "3. 文件很長、只動一小段時，可以改用 ```doc-patch 圍欄輸出 unified diff（要有 @@ 行與足夠上下文）；"
    "套不上我會請你重出全文。\n"
    "4. 圍欄**之外**只寫一句「這一版改了什麼」，不要把文件內容再貼一次。\n"
    "5. 這一輪不需要改文件時，不要輸出任何圍欄。\n"
    "6. **不要用檔案工具去讀寫這份文件**：上面的全文就是最新版，你的圍欄輸出我會直接存成新版本並寫回檔案。"
)


def doc_context(title: str, path: str, version: Optional[int], content: str) -> str:
    v = f"v{version}" if version else "（尚無版本）"
    return (f"[目前文件]\n標題：{title}\n路徑：{path}\n版本：{v}\n"
            f"----- 文件開始 -----\n{content}\n----- 文件結束 -----\n\n{DOC_RULES}")
