"""看板：CLI 包裝（假 runner，不開子程序）＋ board/cards 端點。"""
from __future__ import annotations

import json

import pytest

from studio.hermes.cli import CliError
from studio.modules.kanban.cli import KanbanCli, priority_label

TASKS = [
    {"id": "t_aaa111", "title": "A", "status": "todo", "assignee": "default", "priority": 100},
    {"id": "t_bbb222", "title": "B", "status": "blocked", "assignee": "researcher", "priority": 10},
]
DIAG = [{"task_id": "t_bbb222", "title": "B", "status": "blocked", "assignee": "researcher",
         "diagnostics": [{"kind": "stuck_in_blocked", "severity": "warning", "title": "blocked 700h"}]}]


class FakeRunner:
    def __init__(self):
        self.calls: list[tuple[str, ...]] = []
        self.fail_on: set[str] = set()

    async def __call__(self, *args, timeout=30.0):
        self.calls.append(args)
        rest = list(args[1:]) if args and args[0] == "kanban" else list(args)
        if rest[:1] == ["--board"]:
            rest = rest[2:]
        verb = rest[0]
        if verb in self.fail_on:
            raise CliError(f"{verb} failed")
        if verb == "list":
            assignee = args[args.index("--assignee") + 1] if "--assignee" in args else None
            return json.dumps([t for t in TASKS if not assignee or t["assignee"] == assignee])
        if verb == "show":
            return json.dumps({"task": TASKS[0], "comments": [{"author": "u", "body": "hi"}], "events": []})
        if verb == "diagnostics":
            tid = args[args.index("--task") + 1] if "--task" in args else None
            return json.dumps([d for d in DIAG if not tid or d["task_id"] == tid])
        if verb == "attachments":
            return json.dumps([{"id": 1, "filename": "x.txt"}])
        if verb == "create":
            return "Created task t_c0ffee\n"
        if verb == "dispatch":
            return json.dumps({"spawned": 1, "promoted": ["t_aaa111"]})
        if verb == "stats":
            return "todo: 1\nblocked: 1\n"
        return f"ok {args[2] if len(args) > 2 else ''}"


@pytest.fixture
def runner():
    return FakeRunner()


@pytest.fixture
def kc(runner):
    return KanbanCli(runner)


async def test_list_show_diag_args(kc, runner):
    assert [t["id"] for t in await kc.list()] == ["t_aaa111", "t_bbb222"]
    assert runner.calls[-1] == ("kanban", "list", "--json")
    assert [t["id"] for t in await kc.list(assignee="researcher", archived=True, status="blocked")] == ["t_bbb222"]
    assert runner.calls[-1] == ("kanban", "list", "--json", "--status", "blocked", "--assignee", "researcher", "--archived")
    with pytest.raises(CliError):
        await kc.list(status="bogus")
    assert (await kc.show("t_aaa111"))["comments"][0]["body"] == "hi"
    assert runner.calls[-1] == ("kanban", "show", "t_aaa111", "--json")
    assert (await kc.diagnostics(severity="warning"))[0]["task_id"] == "t_bbb222"
    assert runner.calls[-1] == ("kanban", "diagnostics", "--json", "--severity", "warning")
    assert (await kc.stats())["raw"].startswith("todo: 1")


async def test_create_assign_comment_attach(kc, runner):
    out = await kc.create("寫週報", body="內容", assignee="researcher", priority=80, skills=["a", "b"], model="gpt-x", max_runtime="30m")
    assert out["id"] == "t_c0ffee"
    assert runner.calls[-1] == ("kanban", "create", "寫週報", "--json", "--body", "內容", "--assignee", "researcher",
                                "--priority", "80", "--skill", "a", "--skill", "b", "--model", "gpt-x", "--max-runtime", "30m")
    await kc.assign("t_1", "writer")
    assert runner.calls[-1] == ("kanban", "assign", "t_1", "writer")
    await kc.assign("t_1", "")
    assert runner.calls[-1] == ("kanban", "assign", "t_1", "none")
    await kc.comment("t_1", "留言", author="admin")
    assert runner.calls[-1] == ("kanban", "comment", "t_1", "留言", "--author", "admin")
    await kc.attach("t_1", "/tmp/x.txt", name="x.txt", content_type="text/plain", author="admin")
    assert runner.calls[-1] == ("kanban", "attach", "t_1", "/tmp/x.txt", "--name", "x.txt", "--content-type", "text/plain", "--author", "admin")
    assert (await kc.attachments("t_1"))[0]["filename"] == "x.txt"
    await kc.attach_rm("7")
    assert runner.calls[-1] == ("kanban", "attach-rm", "7")


async def test_move_verbs(kc, runner):
    await kc.move("t_1", "done", result="完成了")
    assert runner.calls[-1] == ("kanban", "complete", "t_1", "--result", "完成了")
    await kc.move("t_1", "blocked", reason="等資料")
    assert runner.calls[-1] == ("kanban", "block", "t_1", "等資料")
    await kc.move("t_1", "review")
    assert runner.calls[-1] == ("kanban", "request-review", "t_1")
    await kc.move("t_1", "archived")
    assert runner.calls[-1] == ("kanban", "archive", "t_1")
    await kc.move("t_1", "todo")
    assert runner.calls[-1] == ("kanban", "unblock", "t_1")
    await kc.move("t_1", "ready")
    assert runner.calls[-2:] == [("kanban", "unblock", "t_1"), ("kanban", "promote", "t_1")]
    # 已經是 todo 時 unblock 會失敗，但 promote 成功仍算成功
    runner.fail_on.add("unblock")
    assert (await kc.move("t_1", "ready"))["ok"] is True
    runner.fail_on.add("promote")
    with pytest.raises(CliError):
        await kc.move("t_1", "ready")
    with pytest.raises(CliError):
        await kc.move("t_1", "running")
    with pytest.raises(CliError):
        await kc.move("t_1", "nope")


async def test_dispatch_and_board_option(runner):
    kc = KanbanCli(runner, board="proj")
    out = await kc.dispatch(dry_run=True, max_spawn=2)
    assert out["spawned"] == 1
    assert runner.calls[-1] == ("kanban", "--board", "proj", "dispatch", "--json", "--dry-run", "--max", "2")


def test_priority_label():
    assert [priority_label(v) for v in (0, 10, 50, 80, 100, None, "x")] == ["low", "low", "medium", "high", "urgent", "low", "medium"]


# -- endpoints ----------------------------------------------------------------
@pytest.fixture
def api_runner(client):
    r = FakeRunner()
    client.app.state.cli._run = r
    return r


def test_board_endpoint_profile_filter_and_diagnostics(client, auth, api_runner):
    b = client.get("/kanban/board", headers=auth).json()
    assert [t["id"] for t in b["tasks"]] == ["t_aaa111", "t_bbb222"]
    assert b["tasks"][0]["priority_label"] == "urgent" and b["tasks"][1]["tags"] == []
    assert b["tasks"][1]["diagnostics"][0]["kind"] == "stuck_in_blocked"
    assert "researcher" in b["profiles"] and "done" in b["statuses"]
    b = client.get("/kanban/board?assignee=researcher&archived=true", headers=auth).json()
    assert [t["id"] for t in b["tasks"]] == ["t_bbb222"] and b["assignee"] == "researcher"
    assert api_runner.calls[-2][1:] == ("list", "--json", "--assignee", "researcher", "--archived")


def test_card_lifecycle_endpoints(client, auth, api_runner):
    r = client.post("/kanban/cards", json={"title": "測試卡", "priority": "high", "tags": ["a", "b"], "assignee": "researcher"}, headers=auth)
    assert r.status_code == 201 and r.json()["id"] == "t_c0ffee" and r.json()["tags"] == ["a", "b"]
    assert "--priority" in api_runner.calls[-1] and api_runner.calls[-1][api_runner.calls[-1].index("--priority") + 1] == "80"
    assert client.post("/kanban/cards", json={"title": "x", "priority": "bogus"}, headers=auth).status_code == 400

    # tags 存在 Studio 端，board 會合併
    client.put("/kanban/cards/t_aaa111/tags", json={"tags": ["急件", " x "]}, headers=auth)
    b = client.get("/kanban/board", headers=auth).json()
    assert b["tasks"][0]["tags"] == ["x", "急件"]
    card = client.get("/kanban/cards/t_aaa111", headers=auth).json()
    assert card["task"]["tags"] == ["x", "急件"] and card["comments"][0]["body"] == "hi"
    assert card["task"]["diagnostics"] == [] and api_runner.calls[-1][1:] == ("diagnostics", "--json", "--task", "t_aaa111")
    diag_card = client.get("/kanban/cards/t_bbb222", headers=auth).json()  # fake show 回 TASKS[0]，但診斷依 task_id 查
    assert diag_card["task"]["diagnostics"][0]["kind"] == "stuck_in_blocked"

    assert client.post("/kanban/cards/t_aaa111/move", json={"status": "review"}, headers=auth).status_code == 200
    assert api_runner.calls[-1][1:] == ("request-review", "t_aaa111")
    assert client.post("/kanban/cards/t_aaa111/move", json={"status": "bogus"}, headers=auth).status_code == 400
    assert client.post("/kanban/cards/t_aaa111/assign", json={"profile": "writer"}, headers=auth).status_code == 200
    r = client.post("/kanban/cards/t_aaa111/comments", json={"text": "留言"}, headers=auth)
    assert r.status_code == 201 and api_runner.calls[-1][1:] == ("comment", "t_aaa111", "留言", "--author", "admin")
    r = client.post("/kanban/cards/t_aaa111/attachments", files={"file": ("note.txt", b"hello", "text/plain")}, headers=auth)
    assert r.status_code == 201
    call = api_runner.calls[-1]
    assert call[1] == "attach" and call[3].endswith("/note.txt") and "--content-type" in call
    assert client.get("/kanban/cards/t_aaa111/attachments", headers=auth).json()[0]["id"] == 1
    assert client.delete("/kanban/cards/t_aaa111/attachments/1", headers=auth).status_code == 200
    assert client.post("/kanban/cards/t_aaa111/archive", headers=auth).status_code == 200
    assert api_runner.calls[-1][1:] == ("archive", "t_aaa111")
    assert client.post("/kanban/cards/t_aaa111/edit", json={"result": "補結果"}, headers=auth).status_code == 200
    assert api_runner.calls[-1][1:] == ("edit", "t_aaa111", "--result", "補結果")


def test_dispatch_endpoint_assigns_then_dispatches(client, auth, api_runner):
    r = client.post("/kanban/cards/t_aaa111/dispatch", json={"profile": "writer", "max_spawn": 1}, headers=auth)
    assert r.status_code == 200, r.text
    verbs = [c[1] for c in api_runner.calls]
    assert verbs == ["assign", "unblock", "promote", "dispatch"]
    assert r.json()["dispatch"]["spawned"] == 1
    assert client.get("/kanban/diagnostics", headers=auth).json()[0]["task_id"] == "t_bbb222"
    assert client.get("/kanban/stats", headers=auth).json()["raw"].startswith("todo")


def test_cli_error_becomes_502(client, auth, api_runner):
    api_runner.fail_on.add("list")
    r = client.get("/kanban/board", headers=auth)
    assert r.status_code == 502 and r.json()["error"]["code"] == "hermes_cli_error"
