"""P. 語音：/voice/capabilities、/voice/transcribe（whisper.cpp / faster-whisper）、/voice/speak（edge-tts）。

瀏覽器端優先用 Web Speech API / speechSynthesis；這裡是後備。
偵測函式做成模組層級變數，測試可直接替換。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from ...auth import Principal, current_principal
from ...errors import ApiError, bad_request

log = logging.getLogger("studio.voice")
router = APIRouter(prefix="/voice", tags=["voice"])

DEFAULT_VOICE = "zh-TW-HsiaoChenNeural"
MODEL_CANDIDATES = (
    "~/.myhermescompany/whisper/ggml-base.bin",
    "~/.myhermescompany/whisper/ggml-small.bin",
    "~/Library/Application Support/MacWhisper/models/ggml-model-whisper-base.bin",
    "~/Library/Application Support/MacWhisper/models/ggml-model-whisper-small.bin",
    "~/Library/Application Support/Recordly/whisper/ggml-small.bin",
    "~/Downloads/whisper-models/ggml-large-v3-turbo.bin",
)


def find_whisper() -> Optional[dict[str, str]]:
    """回傳 {'bin','model'} 或 None。優先 env STUDIO_WHISPER_BIN / STUDIO_WHISPER_MODEL。"""
    bin_ = os.environ.get("STUDIO_WHISPER_BIN") or shutil.which("whisper-cli") or shutil.which("whisper-cpp") or shutil.which("main")
    if not bin_ or not Path(bin_).exists():
        return None
    model = os.environ.get("STUDIO_WHISPER_MODEL")
    if model and Path(model).expanduser().exists():
        return {"bin": bin_, "model": str(Path(model).expanduser())}
    for c in MODEL_CANDIDATES:
        pth = Path(c).expanduser()
        if pth.exists():
            return {"bin": bin_, "model": str(pth)}
    return None


def have_edge_tts() -> bool:
    try:
        import edge_tts  # noqa: F401
        return True
    except Exception:
        return False


def have_ffmpeg() -> Optional[str]:
    return shutil.which("ffmpeg")


# 測試可替換
detect_whisper: Callable[[], Optional[dict[str, str]]] = find_whisper
detect_edge_tts: Callable[[], bool] = have_edge_tts


async def _exec(*args: str, timeout: float = 120.0) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise ApiError(504, "timeout", f"{args[0]} timed out")
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


run_cmd = _exec  # 測試可替換


async def synth_edge_tts(text: str, voice: str, rate: str, volume: str) -> bytes:
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate, volume=volume)
    chunks: list[bytes] = []
    async for ch in comm.stream():
        if ch.get("type") == "audio" and ch.get("data"):
            chunks.append(ch["data"])
    return b"".join(chunks)


synth: Callable[..., Any] = synth_edge_tts  # 測試可替換


@router.get("/capabilities")
def capabilities(p: Principal = Depends(current_principal)):
    w = detect_whisper()
    tts = detect_edge_tts()
    return {
        "stt": {"available": bool(w), "engine": "whisper.cpp" if w else None,
                "model": Path(w["model"]).name if w else None, "needs_ffmpeg": bool(w) and not have_ffmpeg()},
        "tts": {"available": tts, "engine": "edge-tts" if tts else None, "default_voice": DEFAULT_VOICE},
        "browser_first": True,
    }


@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form("zh"), p: Principal = Depends(current_principal)):
    w = detect_whisper()
    if not w:
        raise ApiError(501, "stt_unavailable", "本機沒有 whisper-cli 或模型檔；請用瀏覽器語音輸入")
    tmp = Path(tempfile.mkdtemp(prefix="studio-voice-"))
    try:
        src = tmp / (Path(file.filename or "audio").name or "audio")
        with src.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        wav = tmp / "in.wav"
        ff = have_ffmpeg()
        if ff:
            code, _, err = await run_cmd(ff, "-y", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(wav))
            if code != 0:
                raise ApiError(400, "bad_audio", f"ffmpeg 轉檔失敗：{err.strip()[:300]}")
        else:
            if src.suffix.lower() != ".wav":
                raise ApiError(501, "stt_unavailable", "沒有 ffmpeg，只能接受 16kHz WAV")
            wav = src
        out_base = tmp / "out"
        lang = language.strip() or "auto"
        code, stdout, err = await run_cmd(w["bin"], "-m", w["model"], "-f", str(wav), "-l", lang, "-oj", "-of", str(out_base), "-np", "-nt")
        if code != 0:
            raise ApiError(502, "stt_failed", f"whisper 失敗：{err.strip()[:300]}")
        jf = out_base.with_suffix(".json")
        text = ""
        segments: list[dict[str, Any]] = []
        if jf.exists():
            data = json.loads(jf.read_text(encoding="utf-8"))
            for s in data.get("transcription") or []:
                seg_text = (s.get("text") or "").strip()
                segments.append({"text": seg_text, "from": (s.get("timestamps") or {}).get("from"), "to": (s.get("timestamps") or {}).get("to")})
            text = "".join(s["text"] for s in segments).strip()
            lang = (data.get("result") or {}).get("language") or lang
        if not text:
            text = stdout.strip()
        return {"text": text, "language": lang, "segments": segments, "engine": "whisper.cpp", "model": Path(w["model"]).name}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class SpeakBody(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    rate: str = "+0%"
    volume: str = "+0%"


@router.post("/speak")
async def speak(body: SpeakBody, p: Principal = Depends(current_principal)):
    if not detect_edge_tts():
        raise ApiError(501, "tts_unavailable", "伺服器沒有 edge-tts（pip install edge-tts）；請用瀏覽器朗讀")
    text = body.text.strip()
    if not text:
        raise bad_request("text 不可為空")
    if len(text) > 5000:
        raise bad_request("text 太長（上限 5000 字）")
    try:
        audio = await synth(text, body.voice or DEFAULT_VOICE, body.rate, body.volume)
    except Exception as e:
        raise ApiError(502, "tts_failed", f"edge-tts 失敗：{e}")
    if not audio:
        raise ApiError(502, "tts_failed", "edge-tts 沒有回傳音訊")
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})


_voices_cache: list[dict[str, str]] = []


@router.get("/voices")
async def voices(locale: str = "zh", p: Principal = Depends(current_principal)):
    if not detect_edge_tts():
        raise ApiError(501, "tts_unavailable", "伺服器沒有 edge-tts")
    global _voices_cache
    if not _voices_cache:
        try:
            import edge_tts
            vs = await edge_tts.list_voices()
            _voices_cache = [{"name": v["ShortName"], "gender": v.get("Gender", ""), "locale": v.get("Locale", "")} for v in vs]
        except Exception as e:
            raise ApiError(502, "tts_failed", f"取得聲音清單失敗：{e}")
    return [v for v in _voices_cache if not locale or v["locale"].lower().startswith(locale.lower())]
