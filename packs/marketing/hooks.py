"""行銷套件的掛鉤：只能 import studio.sdk。三個掛點都是可選的。"""
from studio import sdk


def on_install(sdk_, ctx):
    """安裝完成：ctx = {company_id, member_id, installed}。"""
    sdk.record_event("pack.marketing.ready", "pack", "pack:marketing", {"agents": ctx["installed"].get("agents", {})}, company_id=ctx["company_id"])


def on_topic_created(sdk_, topic):
    """新主題：topic = {topic_id, title, dir}。"""
    return None


def on_stage_finished(sdk_, info):
    """階段結算：info = {topic_id, stage, status}。成效階段完成時記一筆事件方便做月報。"""
    if info["stage"] == "analytics" and info["status"] == "done":
        sdk.record_event("pack.marketing.topic_done", "pack", f"pack:marketing:{info['topic_id']}", info)
