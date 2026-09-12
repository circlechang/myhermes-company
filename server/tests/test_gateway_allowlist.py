"""gateway.multiplex_profile_allowlist 的純文字改寫：保留註解與其他設定、備份、驗證後才算數。"""
from __future__ import annotations

import yaml

from studio.hermes import allowlist as A

BLOCK = """# 開頭註解
gateway:
  enabled: true   # 行內註解
  multiplex_profiles: true
  multiplex_profile_allowlist:
    - default
    - researcher
  timeout: 30
streaming:
  enabled: false
"""


def test_block_list_insert_keeps_comments_and_order():
    out, st = A.edit_text(BLOCK, "bot-1")
    assert st == "added"
    assert "# 開頭註解" in out and "enabled: true   # 行內註解" in out
    assert out.splitlines()[7] == "    - bot-1"  # 接在最後一項後面
    assert yaml.safe_load(out)["gateway"]["multiplex_profile_allowlist"] == ["default", "researcher", "bot-1"]
    assert yaml.safe_load(out)["gateway"]["timeout"] == 30


def test_already_there_and_remove():
    assert A.edit_text(BLOCK, "researcher")[1] == "already"
    out, st = A.edit_text(BLOCK, "researcher", remove=True)
    assert st == "removed" and yaml.safe_load(out)["gateway"]["multiplex_profile_allowlist"] == ["default"]


def test_flow_style_and_empty_list():
    flow = "gateway:\n  multiplex_profiles: true\n  multiplex_profile_allowlist: [default, researcher]\n"
    out, st = A.edit_text(flow, "bot-2")
    assert st == "added" and yaml.safe_load(out)["gateway"]["multiplex_profile_allowlist"] == ["default", "researcher", "bot-2"]
    empty = "gateway:\n  multiplex_profiles: true\n  multiplex_profile_allowlist: []\n"
    out, st = A.edit_text(empty, "bot-3")
    assert st == "added" and yaml.safe_load(out)["gateway"]["multiplex_profile_allowlist"] == ["bot-3"]


def test_open_and_off_and_missing_are_left_alone():
    open_cfg = "gateway:\n  multiplex_profiles: true\n"  # 沒設名單＝全開
    assert A.edit_text(open_cfg, "x") == (open_cfg, "open")
    off = "gateway:\n  multiplex_profiles: false\n  multiplex_profile_allowlist:\n    - default\n"
    assert A.edit_text(off, "x") == (off, "off")
    weird = "gateway:\n  multiplex_profiles: true\n  multiplex_profile_allowlist: 'not-a-list'\n"
    assert A.edit_text(weird, "x")[1] == "missing"


def test_apply_writes_backup_and_verifies(tmp_path):
    p = tmp_path / "config.yaml"
    p.write_text(BLOCK, encoding="utf-8")
    assert A.apply(p, "bot-9") == "added"
    baks = list(tmp_path.glob("config.yaml.bak-*"))
    assert len(baks) == 1 and baks[0].read_text(encoding="utf-8") == BLOCK
    assert "bot-9" in yaml.safe_load(p.read_text(encoding="utf-8"))["gateway"]["multiplex_profile_allowlist"]
    assert A.apply(p, "bot-9") == "already" and len(list(tmp_path.glob("config.yaml.bak-*"))) == 1
    assert A.apply(tmp_path / "nope.yaml", "x") == "missing"


def test_is_served():
    cfg = yaml.safe_load(BLOCK)
    assert A.is_served(cfg, "researcher") and not A.is_served(cfg, "bot-1")
    assert A.is_served({"gateway": {"multiplex_profiles": True}}, "any")
    assert not A.is_served({"gateway": {"multiplex_profiles": False}}, "researcher")
