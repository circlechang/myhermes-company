"""側欄「一句話標題＋一行結果」：auto_title 純函式與 result_for 規則的單測。"""
from studio.api.sessions import TITLE_CHARS, apply_auto_title, auto_title, is_default_title, result_for
from studio.models import ChatSession


def test_auto_title_cuts_cjk_by_characters_at_30():
    text = "請" * 45
    t = auto_title(text)
    assert len(t) == TITLE_CHARS and t.endswith("…") and t[:29] == "請" * 29
    # 剛好 30 字不加省略號
    assert auto_title("字" * 30) == "字" * 30


def test_auto_title_takes_first_non_empty_line_and_collapses_whitespace():
    assert auto_title("\n\n   幫我看一下  \t這份規格書 \n第二行不要") == "幫我看一下 這份規格書"


def test_auto_title_strips_markdown_and_slash_commands():
    assert auto_title("## **重點**：`本週` 熱點") == "重點：本週 熱點"
    assert auto_title("- 列出三個熱點") == "列出三個熱點"
    assert auto_title("/model gpt-5 幫我看") == "gpt-5 幫我看"
    assert auto_title("/help") == "help"


def test_auto_title_empty_leaves_nothing():
    assert auto_title("") == ""
    assert auto_title("   \n\n  ") == ""
    assert auto_title("###") == ""


def test_apply_auto_title_only_on_default_title_and_never_for_workflow():
    s = ChatSession(company_id="c", member_id="m", agent_id="a", title="與 小編 的對話")
    assert apply_auto_title(s, "小編", "幫我寫貼文") is True and s.title == "幫我寫貼文"
    # 第二句不再改
    assert apply_auto_title(s, "小編", "再改一版") is False and s.title == "幫我寫貼文"
    # 人改過的標題不動
    human = ChatSession(company_id="c", member_id="m", agent_id="a", title="Q3 董事會")
    assert apply_auto_title(human, "小編", "幫我寫貼文") is False and human.title == "Q3 董事會"
    # 任何 agent 名字的預設標題都算預設（regex 後援）；空標題也算
    assert is_default_title("與 別人的員工 的對話") and is_default_title("") and not is_default_title("與你的對話")
    wf = ChatSession(company_id="c", member_id="m", agent_id="a", title="", source="workflow")
    assert apply_auto_title(wf, "小編", "節點輸入") is False and wf.title == ""
    # 訊息只有 markdown 記號 → 標題保留
    empty = ChatSession(company_id="c", member_id="m", agent_id="a", title="與 小編 的對話")
    assert apply_auto_title(empty, "小編", "###") is False and empty.title == "與 小編 的對話"


def test_result_for_priority_failed_doc_assistant_empty():
    s = ChatSession(company_id="c", member_id="m", agent_id="a", run_status="completed", last_run_id="r2")
    assert result_for(s, None, None) == ""
    assert result_for(s, ("# 本週三個熱點\n1. PPWR", "r2"), None) == "本週三個熱點"
    assert result_for(s, ("**好的**，`已完成`", "r2"), None) == "好的，已完成"
    assert result_for(s, ("長" * 100, "r2"), None).endswith("…")
    # 文件模式且這個對話寫出過版本 → 文件優先於回覆本文
    s.doc_id = "doc1"
    assert result_for(s, ("回覆本文", "r2"), 3) == "文件已更新到 v3"
    # 失敗：只引用這次 run 的片段；上一輪的回覆不拿來冒充錯誤
    s.run_status = "failed"
    assert result_for(s, ("片段輸出", "r2"), 3) == "失敗：片段輸出"
    assert result_for(s, ("上一輪的回覆", "r1"), 3) == "失敗"
    assert result_for(s, None, None) == "失敗"
