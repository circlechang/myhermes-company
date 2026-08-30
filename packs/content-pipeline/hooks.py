"""內容生產線的掛鉤：只能 import studio.sdk。"""
from studio import sdk


def on_install(sdk_, ctx):
    sdk.record_event("pack.content-pipeline.ready", "pack", "pack:content-pipeline", {"agents": ctx["installed"].get("agents", {})},
                     company_id=ctx["company_id"])


def on_stage_finished(sdk_, info):
    """選題被封存、或回收數據完成 → 記事件，方便做月報統計「幾題進、幾題封存、哪個形式最好」。"""
    if info["stage"] == "pick" and info["status"] == "archived":
        sdk.record_event("pack.content-pipeline.archived", "pack", f"pack:content-pipeline:{info['topic_id']}", info)
    if info["stage"] == "analytics" and info["status"] == "done":
        sdk.record_event("pack.content-pipeline.topic_done", "pack", f"pack:content-pipeline:{info['topic_id']}", info)
