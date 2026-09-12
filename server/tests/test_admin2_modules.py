"""Tests for files / skills / memory / journey / theme / logs / admin(terminal, mcp, plugins, version)."""
from __future__ import annotations

import io
import json
import os
import time
from pathlib import Path

import pytest


@pytest.fixture
def seeded(hermes_home: Path):
    """Populate a tmp HERMES_HOME with workspace, skills, memories, logs, config."""
    (hermes_home / "workspace").mkdir()
    (hermes_home / "workspace" / "hello.md").write_text("# hi\nsee [[alpha]] skill and `beta`\n")
    (hermes_home / "workspace" / "sub").mkdir()
    sk = hermes_home / "skills"
    (sk / "alpha").mkdir(parents=True)
    (sk / "alpha" / "SKILL.md").write_text("---\nname: alpha\ndescription: Alpha skill\ntags: [a, x]\n---\n\n# alpha\nuses `beta` too\n")
    (sk / "alpha" / "ref.txt").write_text("attachment")
    (sk / "research" / "beta").mkdir(parents=True)
    (sk / "research" / "beta" / "SKILL.md").write_text("---\nname: beta\ndescription: Beta skill\n---\n\nbody\n")
    ext = hermes_home / "ext-skill"
    ext.mkdir()
    (ext / "SKILL.md").write_text("---\nname: linked\n---\nvia symlink")
    (sk / "linked").symlink_to(ext)
    (hermes_home / "hermes-agent" / "skills" / "builtin-one").mkdir(parents=True)
    (hermes_home / "hermes-agent" / "skills" / "builtin-one" / "SKILL.md").write_text("---\nname: builtin-one\ndescription: builtin\n---\nx")
    (hermes_home / "memories").mkdir()
    (hermes_home / "memories" / "MEMORY.md").write_text("# memory\n- remember to use alpha for research work\n- unrelated note here\n")
    (hermes_home / "memories" / "USER.md").write_text("- user likes [[beta]]\n")
    (hermes_home / "config.yaml").write_text(
        "# keep me\nmodel:\n  default: gpt-default\nskills:\n  disabled:\n    - beta\nmcp_servers:\n  demo:\n    url: https://example.com/mcp\n    headers:\n      Authorization: Bearer supersecret\n    enabled: true\n  local:\n    command: node\n    args: [server.js]\n    env:\n      API_KEY: abc123456\n")
    (hermes_home / "logs").mkdir()
    (hermes_home / "logs" / "gateway.log").write_text(
        "2026-08-29 10:00:00,001 INFO gateway.run: started\n"
        "2026-08-29 10:00:01,002 WARNING gateway.platforms.telegram: reconnect\n"
        "2026-08-29 10:00:02,003 ERROR gateway.run: boom\n"
        'INFO:     127.0.0.1:1234 - "GET /health HTTP/1.1" 200 OK\n')
    (hermes_home / "skill-bundles").mkdir()
    (hermes_home / "skill-bundles" / "pack.yaml").write_text("name: pack\ndescription: d\nskills: [alpha, beta]\n")
    return hermes_home


# -- files --------------------------------------------------------------------

def test_files_roots_and_list(client, auth, seeded):
    r = client.get("/files/roots", headers=auth)
    assert r.status_code == 200
    ids = {x["id"] for x in r.json()}
    assert {"workspace", "profile:default", "profile:researcher", "uploads"} <= ids
    r = client.get("/files/list", params={"path": "workspace"}, headers=auth)
    assert r.status_code == 200, r.text
    names = [e["name"] for e in r.json()["entries"]]
    assert names == ["sub", "hello.md"]  # dirs first
    assert r.json()["parent"] is None
    r = client.get("/files/list", params={"path": "workspace/sub"}, headers=auth)
    assert r.json()["parent"] == "workspace"


@pytest.mark.parametrize("bad", ["workspace/../config.yaml", "workspace/sub/../../.env", "workspace//../x"])
def test_files_path_traversal_blocked(client, auth, seeded, bad):
    r = client.get("/files/read", params={"path": bad}, headers=auth)
    assert r.status_code in (400, 404), r.text
    assert r.json()["error"]["code"] in ("path_traversal", "not_found")
    r = client.put("/files/write", json={"path": bad, "content": "x"}, headers=auth)
    assert r.status_code in (400, 404)
    assert not (seeded / "config.yaml").read_text().startswith("x")


def test_files_symlink_escape_blocked(client, auth, seeded, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("s")
    (seeded / "workspace" / "link").symlink_to(outside)
    r = client.get("/files/list", params={"path": "workspace/link"}, headers=auth)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "path_traversal"


def test_files_unknown_root(client, auth, seeded):
    r = client.get("/files/list", params={"path": "etc/passwd"}, headers=auth)
    assert r.status_code == 404
    r = client.get("/files/list", params={"path": "/etc"}, headers=auth)
    assert r.status_code == 404


def test_files_crud_roundtrip(client, auth, seeded):
    # write / read
    r = client.put("/files/write", json={"path": "workspace/sub/note.txt", "content": "hello"}, headers=auth)
    assert r.status_code == 200, r.text
    r = client.get("/files/read", params={"path": "workspace/sub/note.txt"}, headers=auth)
    assert r.json()["content"] == "hello" and r.json()["binary"] is False
    # mkdir / rename / copy / move / delete
    assert client.post("/files/mkdir", json={"path": "workspace/d1"}, headers=auth).status_code == 200
    assert client.post("/files/mkdir", json={"path": "workspace/d1"}, headers=auth).status_code == 409
    r = client.post("/files/rename", json={"path": "workspace/sub/note.txt", "new_name": "n2.txt"}, headers=auth)
    assert r.status_code == 200 and r.json()["path"] == "workspace/sub/n2.txt"
    assert client.post("/files/rename", json={"path": "workspace/sub/n2.txt", "new_name": "../x"}, headers=auth).status_code == 400
    r = client.post("/files/copy", json={"path": "workspace/sub/n2.txt", "dest": "workspace/d1"}, headers=auth)
    assert r.status_code == 200 and (seeded / "workspace/d1/n2.txt").exists()
    r = client.post("/files/move", json={"path": "workspace/d1/n2.txt", "dest": "workspace"}, headers=auth)
    assert r.status_code == 200 and (seeded / "workspace/n2.txt").exists()
    r = client.post("/files/move", json={"path": "workspace/d1", "dest": "workspace/d1"}, headers=auth)
    assert r.status_code == 400
    assert client.delete("/files", params={"path": "workspace/n2.txt"}, headers=auth).status_code == 200
    assert not (seeded / "workspace/n2.txt").exists()
    assert client.delete("/files", params={"path": "workspace"}, headers=auth).status_code == 400


def test_files_upload_download_attach(client, auth, seeded):
    r = client.post("/files/upload", params={"path": "uploads"}, files={"file": ("a.bin", b"\x00\x01binary", "application/octet-stream")}, headers=auth)
    assert r.status_code == 200, r.text
    vpath = r.json()["path"]
    r = client.get("/files/read", params={"path": vpath}, headers=auth)
    assert r.json()["binary"] is True and r.json()["content"] is None
    r = client.get("/files/download", params={"path": vpath}, headers=auth)
    assert r.status_code == 200 and r.content == b"\x00\x01binary"
    r = client.post("/files/attach", json={"path": vpath}, headers=auth)
    assert r.json()["uri"] == f"workspace://{vpath}"
    r = client.post("/files/upload", params={"path": "uploads/../../x"}, files={"file": ("a", b"1")}, headers=auth)
    assert r.status_code == 400


def test_files_profile_root_member_readonly(client, auth, seeded):
    r = client.post("/members", json={"username": "bob", "password": "bobpass1", "role": "member"}, headers=auth)
    assert r.status_code in (200, 201), r.text
    tok = client.post("/auth/login", json={"username": "bob", "password": "bobpass1"}).json()["token"]
    h = {"Authorization": f"Bearer {tok}"}
    assert client.get("/files/read", params={"path": "profile:default/SOUL.md"}, headers=h).status_code == 200
    r = client.put("/files/write", json={"path": "profile:default/SOUL.md", "content": "x"}, headers=h)
    assert r.status_code == 403
    assert client.put("/files/write", json={"path": "workspace/ok.txt", "content": "x"}, headers=h).status_code == 200


# -- skills -------------------------------------------------------------------

def test_skills_list_search_toggle(client, auth, seeded):
    r = client.get("/skills", headers=auth)
    assert r.status_code == 200, r.text
    items = {s["name"]: s for s in r.json()["items"]}
    assert items["alpha"]["enabled"] and items["alpha"]["category"] == "uncategorized" and items["alpha"]["source"] == "local"
    assert items["beta"]["enabled"] is False and items["beta"]["category"] == "research"
    assert items["builtin-one"]["source"] == "builtin"
    assert items["linked"]["source"] == "local"  # symlinked skill dirs are followed
    assert {c["name"] for c in r.json()["categories"]} == {"uncategorized", "research"}
    assert [s["name"] for s in client.get("/skills", params={"q": "beta"}, headers=auth).json()["items"]] == ["beta"]
    assert [s["name"] for s in client.get("/skills", params={"category": "research"}, headers=auth).json()["items"]] == ["beta"]
    # toggle keeps comments in config.yaml
    r = client.post("/skills/beta/toggle", json={"enabled": True}, headers=auth)
    assert r.status_code == 200 and r.json()["enabled"] is True
    cfg = (seeded / "config.yaml").read_text()
    assert cfg.startswith("# keep me") and "- beta" not in cfg
    r = client.post("/skills/alpha/toggle", json={"enabled": False}, headers=auth)
    assert "- alpha" in (seeded / "config.yaml").read_text()
    assert client.post("/skills/nope/toggle", json={"enabled": False}, headers=auth).status_code == 404
    assert client.get("/skills", params={"profile": "zzz"}, headers=auth).status_code == 404


def test_skill_detail_files_write_note(client, auth, seeded):
    r = client.get("/skills/alpha", headers=auth)
    assert r.status_code == 200
    assert r.json()["frontmatter"]["name"] == "alpha"
    assert {f["rel"] for f in r.json()["attachments"]} == {"SKILL.md", "ref.txt"}
    r = client.get("/skills/alpha/file", params={"rel": "ref.txt"}, headers=auth)
    assert r.json()["content"] == "attachment"
    assert client.get("/skills/alpha/file", params={"rel": "../../config.yaml"}, headers=auth).status_code == 400
    # create new skill under a category
    r = client.put("/skills/gamma", json={"content": "# gamma\nhello", "category": "research"}, headers=auth)
    assert r.status_code == 200, r.text
    p = seeded / "skills" / "research" / "gamma" / "SKILL.md"
    assert p.exists() and p.read_text().startswith("---\nname: gamma")
    assert r.json()["category"] == "research"
    assert client.put("/skills/../evil", json={"content": "x"}, headers=auth).status_code in (400, 404, 405)
    # edit existing
    r = client.put("/skills/alpha", json={"content": "---\nname: alpha\ndescription: New\n---\nbody"}, headers=auth)
    assert r.json()["description"] == "New"
    # notes
    assert client.get("/skills/alpha/note", headers=auth).json()["content"] == ""
    r = client.put("/skills/alpha/note", json={"content": "my note"}, headers=auth)
    assert r.json()["content"] == "my note"
    assert client.get("/skills/alpha/note", headers=auth).json()["content"] == "my note"


def test_skills_bundles_and_usage(client, auth, seeded, app):
    r = client.get("/skills/bundles", headers=auth)
    assert r.json()[0]["name"] == "pack" and r.json()[0]["skills"] == ["alpha", "beta"]
    calls = []

    async def fake_run(*args, timeout=30.0):
        calls.append(args)
        return "ok"
    app.state.fake_cli._run = fake_run
    r = client.post("/skills/bundles", json={"name": "b2", "skills": ["alpha"], "description": "d"}, headers=auth)
    assert r.status_code == 200 and calls[-1][:3] == ("bundles", "create", "b2") and "--skill" in calls[-1]
    assert client.delete("/skills/bundles/b2", headers=auth).status_code == 200
    assert calls[-1] == ("bundles", "delete", "b2")
    r = client.get("/skills/usage", headers=auth)
    assert r.status_code == 200 and "alpha" in r.json()["counts"]


# -- memory -------------------------------------------------------------------

def test_memory_files_read_write(client, auth, seeded):
    r = client.get("/memory/files", headers=auth)
    assert {f["name"] for f in r.json()["files"]} == {"MEMORY.md", "USER.md"}
    r = client.get("/memory/file", params={"name": "MEMORY.md"}, headers=auth)
    assert "remember" in r.json()["content"]
    r = client.put("/memory/file", json={"name": "MEMORY.md", "content": "- new\n"}, headers=auth)
    assert r.status_code == 200 and (seeded / "memories/MEMORY.md").read_text() == "- new\n"
    assert client.get("/memory/file", params={"name": "../config.yaml"}, headers=auth).status_code == 400
    assert client.put("/memory/file", json={"name": "..", "content": "x"}, headers=auth).status_code == 400
    assert client.delete("/memory/file", params={"name": "MEMORY.md"}, headers=auth).status_code == 400
    assert client.get("/memory/files", params={"profile": "researcher"}, headers=auth).json()["files"] == []
    assert client.get("/memory/status", headers=auth).json()["ok"] is False  # FakeCli


# -- journey ------------------------------------------------------------------

def test_journey_graph(client, auth, seeded):
    r = client.get("/journey/graph", headers=auth)
    assert r.status_code == 200, r.text
    g = r.json()
    ids = {n["id"] for n in g["nodes"]}
    assert {"skill:alpha", "skill:beta", "memory:MEMORY.md", "memory:USER.md"} <= ids
    assert any(n["kind"] == "memory_entry" for n in g["nodes"])
    pairs = {(e["source"], e["target"], e["kind"]) for e in g["edges"]}
    assert ("skill:alpha", "skill:beta", "code") in pairs
    assert ("memory:USER.md", "skill:beta", "wikilink") in pairs
    assert any(s == "memory:MEMORY.md" and t == "skill:alpha" for s, t, _ in pairs)
    assert g["stats"]["nodes"] == len(g["nodes"]) and g["time_range"][1] >= g["time_range"][0] > 0
    r = client.get("/journey/graph", params={"entries": 0}, headers=auth)
    assert not any(n["kind"] == "memory_entry" for n in r.json()["nodes"])
    r = client.get("/journey/graph", params={"merge_hermes": 1}, headers=auth)
    assert r.status_code == 200 and "hermes_error" in r.json()["stats"]


# -- theme --------------------------------------------------------------------

def test_theme_prefs_and_background(client, auth):
    r = client.get("/theme", headers=auth)
    assert r.json()["settings"]["mode"] == "system" and r.json()["has_background"] is False
    r = client.put("/theme", json={"settings": {"mode": "dark", "font_size": 99, "primary": "#ff0000"}}, headers=auth)
    assert r.json()["settings"]["mode"] == "dark" and r.json()["settings"]["font_size"] == 20
    assert client.put("/theme", json={"settings": {"mode": "blue"}}, headers=auth).status_code == 400
    assert client.put("/theme", json={"settings": {"primary": "url(javascript:1)"}}, headers=auth).status_code == 400
    assert client.get("/theme/background", headers=auth).status_code == 404
    r = client.post("/theme/background", files={"file": ("bg.png", b"\x89PNG fake", "image/png")}, headers=auth)
    assert r.status_code == 200 and r.json()["has_background"] is True
    r = client.get("/theme/background", headers=auth)
    assert r.status_code == 200 and r.content.startswith(b"\x89PNG")
    assert client.post("/theme/background", files={"file": ("x.txt", b"1", "text/plain")}, headers=auth).status_code == 400
    assert client.delete("/theme/background", headers=auth).json()["has_background"] is False
    assert client.delete("/theme", headers=auth).json()["settings"]["mode"] == "system"


# -- logs ---------------------------------------------------------------------

def test_logs_list_read_filter(client, auth, seeded):
    r = client.get("/logs/files", headers=auth)
    ids = {f["id"] for f in r.json()}
    assert "hermes/gateway.log" in ids and "studio/studio.log" in ids
    r = client.get("/logs/read", params={"file": "hermes/gateway.log"}, headers=auth)
    assert r.status_code == 200 and len(r.json()["entries"]) == 4
    e = r.json()["entries"]
    assert e[0]["level"] == "INFO" and e[0]["component"] == "gateway.run" and e[0]["ts"].startswith("2026-08-29")
    assert e[3]["http"] == {"method": "GET", "path": "/health", "status": 200}
    r = client.get("/logs/read", params={"file": "hermes/gateway.log", "level": "WARNING"}, headers=auth)
    assert [x["level"] for x in r.json()["entries"]] == ["WARNING", "ERROR"]
    r = client.get("/logs/read", params={"file": "hermes/gateway.log", "q": "boom"}, headers=auth)
    assert len(r.json()["entries"]) == 1
    r = client.get("/logs/read", params={"file": "hermes/gateway.log", "http_only": 1}, headers=auth)
    assert len(r.json()["entries"]) == 1
    assert client.get("/logs/read", params={"file": "hermes/../config.yaml"}, headers=auth).status_code == 400
    assert client.get("/logs/read", params={"file": "other/x.log"}, headers=auth).status_code == 404
    assert client.get("/logs/read", params={"file": "hermes/gateway.log", "level": "NOPE"}, headers=auth).status_code == 400
    r = client.get("/logs/read", params={"file": "studio/studio.log"}, headers=auth)
    assert r.status_code == 200 and any("studio log file" in x["raw"] for x in r.json()["entries"])


def test_logs_ws_tail(client, token, seeded):
    path = seeded / "logs" / "gateway.log"
    with client.websocket_connect(f"/ws/logs?token={token}&file=hermes/gateway.log&level=WARNING") as ws:
        assert ws.receive_json()["type"] == "ready"
        with path.open("a") as f:
            f.write("2026-08-29 11:00:00,000 INFO x: ignored\n2026-08-29 11:00:01,000 ERROR x: tailed\n")
        msg = ws.receive_json()
        assert msg["type"] == "line" and msg["entry"]["msg"] == "tailed"
    with client.websocket_connect("/ws/logs?token=bad&file=hermes/gateway.log") as ws:
        assert ws.receive_json()["type"] == "error"


# -- admin: mcp / plugins / version / terminal -------------------------------

def test_mcp_list_masks_secrets_and_cli_ops(client, auth, seeded, app):
    r = client.get("/mcp/servers", headers=auth)
    assert r.status_code == 200, r.text
    s = {x["name"]: x for x in r.json()["servers"]}
    assert s["demo"]["transport"] == "http" and "supersecret" not in json.dumps(r.json())
    assert s["local"]["transport"] == "stdio" and s["local"]["args"] == ["server.js"] and "abc123456" not in json.dumps(r.json())
    calls = []

    async def fake_run(*args, timeout=30.0):
        calls.append(args)
        return "done"
    app.state.fake_cli._run = fake_run
    r = client.post("/mcp/servers", json={"name": "n1", "url": "https://x/mcp", "auth": "oauth", "profile": "researcher"}, headers=auth)
    assert r.status_code == 200 and calls[-1] == ("-p", "researcher", "mcp", "add", "n1", "--url", "https://x/mcp", "--auth", "oauth")
    r = client.post("/mcp/servers", json={"name": "n2", "command": "npx", "args": ["-y", "srv"], "env": {"A": "1"}}, headers=auth)
    assert calls[-1] == ("mcp", "add", "n2", "--command", "npx", "--env", "A=1", "--args", "-y", "srv")
    assert client.post("/mcp/servers", json={"name": "n3"}, headers=auth).status_code == 400
    assert client.post("/mcp/servers", json={"name": "../n", "url": "u"}, headers=auth).status_code == 400
    assert client.delete("/mcp/servers/n1", headers=auth).status_code == 200 and calls[-1] == ("mcp", "remove", "n1")
    assert client.post("/mcp/servers/n1/test", headers=auth).json()["ok"] is True


def test_plugins_list_toggle(client, auth, app):
    async def fake_run(*args, timeout=30.0):
        if args[:2] == ("plugins", "list"):
            return 'noise\n[{"name": "p1", "status": "enabled", "version": "1"}, {"name": "p2", "status": "not enabled"}]'
        return "ok " + " ".join(args)
    app.state.fake_cli._run = fake_run
    r = client.get("/plugins", headers=auth)
    assert [(x["name"], x["enabled"]) for x in r.json()] == [("p1", True), ("p2", False)]
    assert client.post("/plugins/p2/enable", headers=auth).json()["output"] == "ok plugins enable p2"
    assert client.post("/plugins/p2/nuke", headers=auth).status_code == 400


def test_version_parse_and_endpoint(client, auth, app, monkeypatch):
    from studio.modules.admin import parse_version
    v = parse_version("Hermes Agent v0.20.5 (2026.8.19) · upstream 9f90cd43\nPython: 3.11.15\nUpdate available: 1498 commits behind")
    assert v["version"] == "0.20.5" and v["date"] == "2026.8.19" and v["upstream"] == "9f90cd43" and v["behind"] == 1498

    async def fake_run(*args, timeout=30.0):
        return "Hermes Agent v0.20.5 (2026.8.19)"
    app.state.fake_cli._run = fake_run
    monkeypatch.setenv("STUDIO_UPDATE_CHECK", "0")
    r = client.get("/version", headers=auth)
    assert r.status_code == 200
    assert r.json()["hermes"]["version"] == "0.20.5" and r.json()["studio"]["version"] and r.json()["update_check_enabled"] is False


def test_terminal_requires_admin_and_runs_echo(client, token, auth, seeded, monkeypatch):
    pytest.importorskip("ptyprocess")
    monkeypatch.setenv("STUDIO_TERMINAL_CMD", "/bin/sh")
    r = client.get("/terminal/cwds", headers=auth)
    assert any(c["id"] == "profile:researcher" for c in r.json())
    with client.websocket_connect(f"/ws/terminal?token={token}&cwd=workspace") as ws:
        ready = ws.receive_json()
        assert ready["type"] == "ready" and ready["cwd"].endswith("workspace")
        ws.send_text("echo ok-$((1+1))\n")
        out = ""
        for _ in range(40):
            out += ws.receive_text()
            if "ok-2" in out:
                break
        assert "ok-2" in out
        ws.send_text(json.dumps({"type": "resize", "cols": 80, "rows": 20}))
        ws.send_text("exit\n")
    # member forbidden
    client.post("/members", json={"username": "m1", "password": "m1pass123", "role": "member"}, headers=auth)
    tok = client.post("/auth/login", json={"username": "m1", "password": "m1pass123"}).json()["token"]
    with client.websocket_connect(f"/ws/terminal?token={tok}") as ws:
        assert ws.receive_json()["code"] == "forbidden"


def test_hermes_config_load_is_thread_safe(tmp_path, monkeypatch):
    """回歸：module 級 ruamel 實例在 threadpool 並行 load 會 IndexError（/skills/usage 500）。"""
    from concurrent.futures import ThreadPoolExecutor
    from studio.hermes.cli import HermesCli
    from studio.modules.skills import hermes_config

    home = tmp_path / "hermes"
    (home / "profiles" / "p1").mkdir(parents=True)
    body = "# comment\nskills:\n  disabled:\n" + "".join(f"    - skill-{i}\n" for i in range(400)) + "mcp_servers: {}\n"
    (home / "profiles" / "p1" / "config.yaml").write_text(body)
    cli = HermesCli(hermes_bin="hermes", hermes_home=home)

    def go(_):
        return len(hermes_config.disabled_skills(cli, "p1"))

    with ThreadPoolExecutor(max_workers=16) as ex:
        results = list(ex.map(go, range(64)))
    assert results == [400] * 64


def test_journey_mention_scan_is_case_insensitive_and_word_bounded(tmp_path):
    """回歸：mention 邊改成單一 alternation regex 後，大小寫混合的 skill 名稱仍要配到，且不越過字界。"""
    from studio.hermes.cli import HermesCli
    from studio.modules.journey import build_graph

    home = tmp_path / "hermes"
    sk = home / "skills"
    for name, body in {
        "Mixed-Case": "---\nname: Mixed-Case\n---\nnothing here",
        "caller-one": "---\nname: caller-one\n---\nplease use mixed-case for this",
        "caller-two": "---\nname: caller-two\n---\nthis says mixed-cases (plural, no match) and Mixed-Case-extra",
    }.items():
        (sk / name).mkdir(parents=True)
        (sk / name / "SKILL.md").write_text(body)
    cli = HermesCli(hermes_bin="hermes", hermes_home=home)
    g = build_graph(cli, "default", include_entries=False)
    mentions = {(e["source"], e["target"]) for e in g["edges"] if e["kind"] == "mention"}
    assert ("skill:caller-one", "skill:Mixed-Case") in mentions
    assert ("skill:caller-two", "skill:Mixed-Case") not in mentions


# -- skills: 用途維度與最近使用 -------------------------------------------------

def test_skill_topics_classification():
    """分類是純函式：先看名字，名字看不出來才看描述。"""
    from studio.modules.skills.topics import OTHER, classify

    def c(name, category="uncategorized", description="", tags=()):
        return classify({"name": name, "dir": name, "category": category, "description": description, "tags": list(tags)})

    assert c("packaging-spec-radar") == "公司專用"
    assert c("researcher-writes") == "寫作與內容"
    assert c("patent-landscape-research") == "研究與情報"
    assert c("minimax-image-to-video") == "設計與影音"
    assert c("xlsx", category="productivity") == "文件與試算表"
    assert c("email-inbox-triage", category="email") == "溝通與信件"
    assert c("linear") == "專案與任務"          # 不可以被「line」規則搶走
    assert c("test-driven-development", category="software-development") == "開發與除錯"  # 不是「drive」
    assert c("claude-code", category="autonomous-ai-agents") == "AI 代理與自動化"
    assert c("findmy", category="apple") == "生活與裝置"
    # 名字看不出來 → 退回描述
    assert c("zzz-thing", description="Monitor competitor news") == "研究與情報"
    assert c("zzz-thing") == OTHER


def test_skills_topic_filter_and_last_used(client, auth, seeded, app):
    from sqlmodel import Session as SqlSession

    from studio.models import Message

    r = client.get("/skills", headers=auth)
    items = {s["name"]: s for s in r.json()["items"]}
    assert items["beta"]["topic"] == "研究與情報"          # category=research
    topics = {t["name"]: t for t in r.json()["topics"]}
    assert topics["研究與情報"]["count"] == 1 and topics["研究與情報"]["hint"]
    assert [s["name"] for s in client.get("/skills", params={"topic": "研究與情報"}, headers=auth).json()["items"]] == ["beta"]
    assert client.get("/skills", params={"topic": "沒有這個維度"}, headers=auth).json()["items"] == []

    # 用過一次 alpha → usage 要同時給次數與最後使用時間
    with SqlSession(app.state.engine) as db:
        db.add(Message(session_id="s_test", role="tool", tool_name="skill", tool_args='{"name": "alpha"}'))
        db.commit()
    u = client.get("/skills/usage", headers=auth).json()
    assert u["counts"]["alpha"] == 1
    assert u["last_used"]["alpha"] > 0
    assert u["recent"][0][0] == "alpha"
    assert "beta" not in u["last_used"]
