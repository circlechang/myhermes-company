"""統一檔案預覽模組。

聊天面板、檔案瀏覽器、工作流節點輸出以前各自渲染、能力不一致；
這個模組把「檔案 → 可呈現結構」收斂成一支 API，前端也只留一個元件。

- `GET  /preview?path=&kind=auto`  結構化預覽（路徑可為絕對路徑或檔案瀏覽器虛擬路徑）
- `POST /preview/inline`           非檔案的純文字內容（工作流節點輸出等）
- `GET  /preview/raw[/<檔名>]?path=&token=` 原檔位元組（`<img>`／`<object>` 用，故接受 `?token=`）

回應形狀（欄位視 kind 出現）::

    {kind, title, path, size, mtime, mime, meta, warnings[],
     text?, html?, rows?, sheets?, pages?, url, download_url, too_large?, error?}

安全：路徑白名單與防穿越集中在 `paths.resolve_preview_path`，
不在白名單內一律 404（不透露檔案是否存在）；HTML 一律以 `text/plain` 送出，
不讓 agent 產出的 HTML 在本站 origin 執行。
"""
from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session

from ...auth import Principal, current_principal, get_db
from ..chat.files import principal_header_or_query
from . import render as _render
from .paths import resolve_preview_path

log = logging.getLogger("studio.modules.preview")

router = APIRouter(tags=["preview"])


def _q(s: str) -> str:
    return quote(s, safe="")


def raw_url(path: str) -> str:
    """尾巴補上檔名，瀏覽器的 PDF 檢視器標題／另存新檔預設名才會對（不參與路徑解析）。"""
    name = _q(path.rstrip("/").split("/")[-1] or "file")
    return f"/preview/raw/{name}?path={_q(path)}"


@router.get("/preview")
def preview(request: Request, path: str, kind: str = "auto",
            p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    real = resolve_preview_path(request, db, p, path)
    out = _render.render(real, kind)
    out["source_path"] = path
    out["url"] = raw_url(path)
    out["download_url"] = raw_url(path) + "&download=true"
    return out


class InlineBody(BaseModel):
    text: str = ""
    kind: str = "auto"
    title: str = ""
    language: str = ""


@router.post("/preview/inline")
def preview_inline(body: InlineBody, p: Principal = Depends(current_principal)):
    return _render.render_inline(body.text, body.kind, body.title, body.language)


@router.get("/preview/raw")
@router.get("/preview/raw/{name}")
def preview_raw(request: Request, path: str, download: bool = False, name: str = "",
                p: Principal = Depends(principal_header_or_query), db: Session = Depends(get_db)):
    """`name` 只是給瀏覽器看的檔名尾巴（PDF 檢視器標題／另存新檔預設名），不參與路徑解析。"""
    real = resolve_preview_path(request, db, p, path)
    import mimetypes

    mime = mimetypes.guess_type(real.name)[0] or "application/octet-stream"
    if mime in ("text/html", "application/xhtml+xml", "image/svg+xml"):
        # 絕不讓 agent 產出的 HTML/SVG 在本站 origin 執行
        mime = "text/plain; charset=utf-8"
    disposition = "attachment" if download else "inline"
    headers = {
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{_q(real.name)}",
        "X-Content-Type-Options": "nosniff",
    }
    return FileResponse(str(real), media_type=mime, headers=headers)


__all__ = ["router", "raw_url"]
