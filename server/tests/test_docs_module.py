"""docs 模組：文件 CRUD／版本／diff／revert／血緣／漂移／權限，以及對話綁文件的圍欄流程。

工作流的四種 doc 節點在 test_docs_workflow.py。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio.modules.docs import service as svc


# --------------------------------------------------------------- 純函式（圍欄／patch）
def test_extract_docs_strips_fence_and_keeps_summary():
    raw = "把第二節補上驗收條件。\n\n```doc\n# 規格\n## 二、驗收\nA1 …\n```"
    body, docs, patches = svc.extract_docs(raw)
    assert body == "把第二節補上驗收條件。"
    assert docs == ["# 規格\n## 二、驗收\nA1 …"]
    assert patches == []


def test_extract_docs_handles_nested_code_fence_with_four_backticks():
    raw = "改了範例。\n\n````doc\n# 規格\n\n```python\nprint(1)\n```\n````"
    body, docs, _ = svc.extract_docs(raw)
    assert body == "改了範例。"
    assert "```python" in docs[0] and docs[0].startswith("# 規格")


def test_extract_docs_splits_multi_with_marker():
    raw = "三個取向。\n\n```doc\n# A\n一\n---doc---\n# B\n二\n---doc---\n# C\n三\n```"
    _body, docs, _ = svc.extract_docs(raw)
    assert [d.splitlines()[0] for d in docs] == ["# A", "# B", "# C"]


def test_apply_patch_relocates_when_line_numbers_are_wrong():
    base = "\n".join(f"line {i}" for i in range(1, 11))
    patch = "@@ -1,3 +1,3 @@\n line 4\n-line 5\n+LINE FIVE\n line 6"
    out = svc.apply_patch(base, patch)
    assert out.splitlines()[4] == "LINE FIVE"
    assert out.splitlines()[3] == "line 4" and out.splitlines()[5] == "line 6"


def test_apply_patch_rejects_bad_context():
    with pytest.raises(svc.DocError):
        svc.apply_patch("a\nb\nc", "@@ -1,2 +1,2 @@\n zzz\n-yyy\n+xxx")


def test_resolve_rejects_traversal_and_non_md(tmp_path):
    with pytest.raises(svc.DocError):
        svc.resolve(tmp_path, "../evil.md")
    with pytest.raises(svc.DocError):
        svc.resolve(tmp_path, "notes.txt")
    assert svc.resolve(tmp_path, "docs/a.md") == (tmp_path / "docs/a.md")


# --------------------------------------------------------------- REST
def mk(client, auth, **body):
    r = client.post("/docs", json={"title": "規格", **body}, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_writes_html_to_workspace_and_starts_with_no_version(client, auth, app):
    """預設格式是 HTML：文件要能直接預覽，不用先在腦內把 markdown 轉成畫面。"""
    d = mk(client, auth, title="登入規格")
    assert d["latest_version"] is None and d["versions"] == 0
    p = Path(d["abs_path"])
    assert p.is_file() and p.read_text() == ""
    assert d["path"].startswith("docs/") and d["path"].endswith(".html")
    assert d["format"] == "html"
    assert d["status"] == "draft" and d["origin"] == "chat" and d["drift"] is False


def test_markdown_docs_still_supported_explicitly(client, auth):
    """既有的 .md 文件不能被硬轉成 html——明寫 format 或明寫 .md 路徑都要留在 markdown。"""
    by_format = client.post("/docs", json={"title": "舊規格", "format": "md"}, headers=auth).json()
    assert by_format["format"] == "md" and by_format["path"].endswith(".md")
    # 路徑副檔名優先於 format 參數：明寫 .md 就是 md，不會被預設值蓋掉
    by_path = client.post("/docs", json={"title": "手寫路徑", "path": "docs/manual.md"}, headers=auth).json()
    assert by_path["format"] == "md" and by_path["path"] == "docs/manual.md"
    assert client.post("/docs", json={"title": "壞格式", "format": "pdf"}, headers=auth).status_code == 400


def test_path_rejects_extensions_outside_the_whitelist(client, auth):
    for bad in ("docs/x.txt", "docs/x.js", "../escape.html"):
        r = client.post("/docs", json={"title": "壞路徑", "path": bad}, headers=auth)
        assert r.status_code == 400, f"{bad} 應該被擋下"


def test_version_increments_and_file_follows(client, auth):
    d = mk(client, auth)
    v1 = client.post(f"/docs/{d['id']}/versions", json={"content": "# 大綱\n一、背景", "summary": "先列大綱"}, headers=auth).json()
    assert v1["version"] == 1 and v1["same"] is False and v1["summary"] == "先列大綱"
    v2 = client.post(f"/docs/{d['id']}/versions", json={"content": "# 大綱\n一、背景\n二、驗收條件", "summary": "補驗收"}, headers=auth).json()
    assert v2["version"] == 2 and v2["diff_stat"] == {"added": 1, "removed": 0}
    assert Path(d["abs_path"]).read_text().endswith("二、驗收條件")
    # 內容沒變不新增版本
    same = client.post(f"/docs/{d['id']}/versions", json={"content": "# 大綱\n一、背景\n二、驗收條件"}, headers=auth).json()
    assert same["same"] is True and same["version"] == 2
    assert [v["version"] for v in client.get(f"/docs/{d['id']}/versions", headers=auth).json()] == [2, 1]


def test_diff_between_versions_and_against_file(client, auth):
    d = mk(client, auth)
    client.post(f"/docs/{d['id']}/versions", json={"content": "a\nb\n"}, headers=auth)
    client.post(f"/docs/{d['id']}/versions", json={"content": "a\nB\nc\n"}, headers=auth)
    r = client.get(f"/docs/{d['id']}/diff", headers=auth).json()
    assert r["from"] == 1 and r["to"] == 2 and r["added"] == 2 and r["removed"] == 1
    assert "-b" in r["diff"] and "+B" in r["diff"]
    Path(d["abs_path"]).write_text("a\nB\nc\nd\n")
    cur = client.get(f"/docs/{d['id']}/diff?b=-1", headers=auth).json()
    assert cur["to"] is None and "+d" in cur["diff"]


def test_drift_detection_and_snapshot(client, auth):
    d = mk(client, auth)
    client.post(f"/docs/{d['id']}/versions", json={"content": "原始"}, headers=auth)
    assert client.get(f"/docs/{d['id']}", headers=auth).json()["drift"] is False
    Path(d["abs_path"]).write_text("有人用 Finder 改過")
    got = client.get(f"/docs/{d['id']}", headers=auth).json()
    assert got["drift"] is True and got["content"] == "原始" and got["file_content"] == "有人用 Finder 改過"
    snap = client.post(f"/docs/{d['id']}/snapshot", json={"summary": "把檔案現況存成新版本"}, headers=auth).json()
    assert snap["version"] == 2 and snap["same"] is False
    assert client.get(f"/docs/{d['id']}", headers=auth).json()["drift"] is False


def test_revert_creates_new_version(client, auth):
    d = mk(client, auth)
    client.post(f"/docs/{d['id']}/versions", json={"content": "第一版"}, headers=auth)
    client.post(f"/docs/{d['id']}/versions", json={"content": "第二版"}, headers=auth)
    r = client.post(f"/docs/{d['id']}/revert", json={"version": 1}, headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == 3 and body["reverted_to"] == 1
    assert client.get(f"/docs/{d['id']}", headers=auth).json()["content"] == "第一版"
    assert Path(d["abs_path"]).read_text() == "第一版"
    assert client.post(f"/docs/{d['id']}/revert", json={"version": 99}, headers=auth).status_code == 404


def test_fork_and_lineage(client, auth):
    root = mk(client, auth, title="母規格", content="# 母\n")
    kids = [client.post(f"/docs/{root['id']}/fork", json={"title": f"取向 {i}", "kind": "split"}, headers=auth).json()
            for i in range(1, 4)]
    grand = client.post(f"/docs/{kids[0]['id']}/fork", json={"title": "補完", "kind": "derived"}, headers=auth).json()
    lin = client.get(f"/docs/{root['id']}/lineage", headers=auth).json()
    assert lin["root"] == root["id"]
    assert len(lin["nodes"]) == 5
    kinds = sorted(e["kind"] for e in lin["edges"])
    assert kinds == ["derived", "split", "split", "split"]
    assert next(n for n in lin["nodes"] if n["id"] == root["id"])["is_root"] is True
    # 從孫節點往上也看得到母規格
    up = client.get(f"/docs/{grand['id']}/lineage", headers=auth).json()
    assert root["id"] in [n["id"] for n in up["nodes"]]


def test_list_filters_and_patch(client, auth):
    a = mk(client, auth, title="甲", stage="intake", origin="pack")
    mk(client, auth, title="乙", stage="review", origin="chat")
    assert [d["title"] for d in client.get("/docs?stage=intake", headers=auth).json()] == ["甲"]
    assert [d["title"] for d in client.get("/docs?origin=chat", headers=auth).json()] == ["乙"]
    assert [d["title"] for d in client.get("/docs?q=乙", headers=auth).json()] == ["乙"]
    r = client.patch(f"/docs/{a['id']}", json={"status": "final", "title": "甲（定稿）"}, headers=auth).json()
    assert r["status"] == "final" and r["title"] == "甲（定稿）"
    assert client.patch(f"/docs/{a['id']}", json={"status": "nope"}, headers=auth).status_code == 400
    assert [d["title"] for d in client.get("/docs?status=final", headers=auth).json()] == ["甲（定稿）"]


def test_patch_path_moves_the_md_file(client, auth):
    d = mk(client, auth, content="內容")
    old = Path(d["abs_path"])
    moved = client.patch(f"/docs/{d['id']}", json={"path": "docs/moved/here.md"}, headers=auth).json()
    assert moved["path"] == "docs/moved/here.md"
    assert Path(moved["abs_path"]).read_text() == "內容" and not old.exists()


def test_rename_moves_the_file_with_the_title(client, auth):
    """改標題＝改名字：工作區檔名跟著換，內容與 doc id 不變。"""
    d = mk(client, auth, title="舊名字", content="內容")
    old = Path(d["abs_path"])
    assert "舊名字" in old.name and old.exists()
    r = client.patch(f"/docs/{d['id']}", json={"title": "新名字"}, headers=auth).json()
    assert r["title"] == "新名字" and r["id"] == d["id"]
    new_file = Path(r["abs_path"])
    assert "新名字" in new_file.name and new_file.read_text() == "內容"
    assert not old.exists()                      # 舊檔不留下來變孤兒
    assert client.patch(f"/docs/{d['id']}", json={"title": "   "}, headers=auth).status_code == 400


def test_rename_leaves_custom_paths_alone(client, auth):
    """自己指定過路徑的文件，改標題不要雞婆去搬檔案。"""
    d = mk(client, auth, title="甲", content="內容")
    moved = client.patch(f"/docs/{d['id']}", json={"path": "docs/我自己取的.md"}, headers=auth).json()
    r = client.patch(f"/docs/{d['id']}", json={"title": "乙"}, headers=auth).json()
    assert r["title"] == "乙" and r["path"] == moved["path"] == "docs/我自己取的.md"
    assert Path(r["abs_path"]).read_text() == "內容"


def test_rename_into_a_taken_filename_still_renames(client, auth):
    """兩份文件撞到同一個檔名時，標題照改、檔案不動，不要整個 409 擋掉改名。"""
    a = mk(client, auth, title="甲", content="A")
    b = mk(client, auth, title="乙", content="B")
    # 檔名帶 doc id，本來就不會撞；手動把 b 搬到「a 改名後會用到的」路徑上製造衝突
    import studio.modules.docs.service as svc
    target = svc.default_path(a["id"], "丙", "html")
    client.patch(f"/docs/{b['id']}", json={"path": target}, headers=auth)
    r = client.patch(f"/docs/{a['id']}", json={"title": "丙"}, headers=auth)
    assert r.status_code == 200 and r.json()["title"] == "丙"
    assert r.json()["path"] == a["path"]          # 檔案留在原地
    assert Path(r.json()["abs_path"]).read_text() == "A"
    # 明講的 path 撞名還是要擋
    assert client.patch(f"/docs/{a['id']}", json={"path": target}, headers=auth).status_code == 409


def test_permissions_company_isolation_and_admin_delete(client, auth, app):
    """別家公司的文件一律 404；刪除要 owner/admin。"""
    d = mk(client, auth, content="機密")
    # 另一家公司的成員
    from sqlmodel import Session
    from studio.auth import hash_password
    from studio.models import Company, Member
    with Session(app.state.engine) as db:
        co = Company(name="別家")
        db.add(co)
        db.flush()
        db.add(Member(company_id=co.id, username="other", password_hash=hash_password("pw123456"), role="owner"))
        db.commit()
    tok = client.post("/auth/login", json={"username": "other", "password": "pw123456"}).json()["token"]
    other = {"Authorization": f"Bearer {tok}"}
    assert client.get(f"/docs/{d['id']}", headers=other).status_code == 404
    assert client.get(f"/docs/{d['id']}/versions", headers=other).status_code == 404
    assert client.patch(f"/docs/{d['id']}", json={"title": "駭"}, headers=other).status_code == 404
    assert client.delete(f"/docs/{d['id']}", headers=other).status_code == 404
    assert client.get("/docs", headers=other).json() == []
    # 一般成員不能刪
    client.post("/members", json={"username": "u1", "password": "pw123456", "role": "member"}, headers=auth)
    mtok = client.post("/auth/login", json={"username": "u1", "password": "pw123456"}).json()["token"]
    assert client.delete(f"/docs/{d['id']}", headers={"Authorization": f"Bearer {mtok}"}).status_code == 403
    assert client.delete(f"/docs/{d['id']}", headers=auth).status_code == 204
    assert client.get(f"/docs/{d['id']}", headers=auth).status_code == 404


def test_bad_path_rejected(client, auth):
    assert client.post("/docs", json={"title": "壞", "path": "../out.md"}, headers=auth).status_code == 400
    assert client.post("/docs", json={"title": "壞", "path": "a.txt"}, headers=auth).status_code == 400


# --------------------------------------------------------------- 對話綁文件
def _agent(client, auth, profile="researcher"):
    return next(a["id"] for a in client.get("/agents", headers=auth).json() if a["profile"] == profile)


def _collect(ws, until=("run.completed", "run.failed", "run.cancelled")):
    """doc.updated / doc.patch_failed 在 run.completed 之前送出，所以一路收到終局事件就好。"""
    out = []
    while True:
        ev = json.loads(ws.receive_text())
        out.append(ev)
        if ev["type"] in until:
            return out


def test_session_binds_doc_and_ai_output_becomes_a_version(client, auth, token):
    """fake gateway 會把輸入原樣 echo 回來，所以把 ```doc 圍欄放在使用者訊息裡就能走完整條路徑。"""
    d = mk(client, auth, title="登入規格")
    s = client.post("/sessions", json={"agent_id": _agent(client, auth), "doc_id": d["id"]}, headers=auth).json()
    assert s["doc_id"] == d["id"]
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"],
                                 "input": "先列大綱。\n```doc\n# 登入規格\n一、背景\n二、驗收條件\n```"}))
        evs = _collect(ws)
    updated = [e for e in evs if e["type"] == "doc.updated"]
    assert updated and updated[0]["version"] == 1 and updated[0]["doc_id"] == d["id"]
    # 訊息本文不含整份文件，只留摘要
    completed = next(e for e in evs if e["type"] == "run.completed")
    assert "```doc" not in completed["output"] and "二、驗收條件" not in completed["output"]
    msgs = client.get(f"/sessions/{s['id']}/messages", headers=auth).json()
    assert "二、驗收條件" not in msgs[-1]["content"]
    got = client.get(f"/docs/{d['id']}", headers=auth).json()
    assert got["latest_version"] == 1 and "二、驗收條件" in got["content"]
    assert Path(got["abs_path"]).read_text().startswith("# 登入規格")


def test_doc_context_is_sent_to_the_model(client, auth, token, gw_state):
    d = mk(client, auth, title="登入規格", content="# 登入規格\n一、背景")
    s = client.post("/sessions", json={"agent_id": _agent(client, auth), "doc_id": d["id"]}, headers=auth).json()
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "看一下"}))
        evs = _collect(ws)
    body = gw_state.runs[evs[0]["run_id"]]["body"]
    assert "[目前文件]" in body["instructions"]
    assert "一、背景" in body["instructions"] and "```doc" in body["instructions"]


def test_doc_patch_is_applied(client, auth, token):
    d = mk(client, auth, title="規格", content="a\nb\nc")
    s = client.post("/sessions", json={"agent_id": _agent(client, auth), "doc_id": d["id"]}, headers=auth).json()
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"],
                                 "input": "只改中間一行。\n```doc-patch\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n```"}))
        evs = _collect(ws)
    assert [e for e in evs if e["type"] == "doc.updated"]
    assert client.get(f"/docs/{d['id']}", headers=auth).json()["content"] == "a\nB\nc"


def test_unappliable_patch_asks_for_full_text(client, auth, token):
    d = mk(client, auth, title="規格", content="a\nb\nc")
    s = client.post("/sessions", json={"agent_id": _agent(client, auth), "doc_id": d["id"]}, headers=auth).json()
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"],
                                 "input": "壞掉的 diff。\n```doc-patch\n@@ -1,2 +1,2 @@\n zzz\n-yyy\n+xxx\n```"}))
        evs = _collect(ws)
        failed = [e for e in evs if e["type"] == "doc.patch_failed"]
        assert failed and "對不上" in failed[0]["reason"]
        _collect(ws)  # 後端自動再跑一輪，請模型重出全文
    msgs = client.get(f"/sessions/{s['id']}/messages", headers=auth).json()
    assert any("完整的新版文件" in m["content"] for m in msgs if m["role"] == "user")
    assert client.get(f"/docs/{d['id']}", headers=auth).json()["latest_version"] == 1  # 沒有被壞 patch 汙染


def test_unbound_session_is_unaffected(client, auth, token):
    """沒綁文件的對話：圍欄照原樣留在訊息裡，不會建任何文件。"""
    s = client.post("/sessions", json={"agent_id": _agent(client, auth)}, headers=auth).json()
    with client.websocket_connect(f"/ws/chat?token={token}") as ws:
        ws.receive_text()
        ws.send_text(json.dumps({"type": "run", "session_id": s["id"], "input": "```doc\n# 不該被收\n```"}))
        evs = _collect(ws)
    assert not [e for e in evs if e["type"].startswith("doc.")]
    assert "```doc" in next(e for e in evs if e["type"] == "run.completed")["output"]
    assert client.get("/docs", headers=auth).json() == []


def test_patch_session_binds_and_unbinds(client, auth):
    d = mk(client, auth)
    s = client.post("/sessions", json={"agent_id": _agent(client, auth)}, headers=auth).json()
    assert client.patch(f"/sessions/{s['id']}", json={"doc_id": d["id"]}, headers=auth).json()["doc_id"] == d["id"]
    assert client.patch(f"/sessions/{s['id']}", json={"doc_id": ""}, headers=auth).json()["doc_id"] == ""
    assert client.patch(f"/sessions/{s['id']}", json={"doc_id": "doc_nope"}, headers=auth).status_code == 404
