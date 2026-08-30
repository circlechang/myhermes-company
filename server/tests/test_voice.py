"""語音：capabilities 偵測、transcribe（假 whisper 子程序）、speak（假 edge-tts）。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from studio.modules.voice import api as voice


@pytest.fixture
def no_engines(monkeypatch):
    monkeypatch.setattr(voice, "detect_whisper", lambda: None)
    monkeypatch.setattr(voice, "detect_edge_tts", lambda: False)


def test_capabilities_and_501_when_missing(client, auth, no_engines):
    caps = client.get("/voice/capabilities", headers=auth).json()
    assert caps["stt"]["available"] is False and caps["tts"]["available"] is False and caps["browser_first"]
    r = client.post("/voice/transcribe", files={"file": ("a.webm", b"xx", "audio/webm")}, headers=auth)
    assert r.status_code == 501 and r.json()["error"]["code"] == "stt_unavailable"
    r = client.post("/voice/speak", json={"text": "你好"}, headers=auth)
    assert r.status_code == 501 and r.json()["error"]["code"] == "tts_unavailable"
    assert client.get("/voice/voices", headers=auth).status_code == 501


def test_transcribe_with_fake_whisper(client, auth, monkeypatch, tmp_path):
    model = tmp_path / "ggml-base.bin"
    model.write_bytes(b"m")
    monkeypatch.setattr(voice, "detect_whisper", lambda: {"bin": "/fake/whisper-cli", "model": str(model)})
    monkeypatch.setattr(voice, "have_ffmpeg", lambda: "/fake/ffmpeg")
    calls = []

    async def fake_run(*args, timeout=120.0):
        calls.append(args)
        if args[0] == "/fake/ffmpeg":
            Path(args[-1]).write_bytes(b"RIFF")
            return 0, "", ""
        out = Path(args[args.index("-of") + 1]).with_suffix(".json")
        out.write_text(json.dumps({"result": {"language": "zh"}, "transcription": [
            {"timestamps": {"from": "00:00:00,000", "to": "00:00:01,000"}, "text": " 你好"},
            {"timestamps": {"from": "00:00:01,000", "to": "00:00:02,000"}, "text": "世界"}]}))
        return 0, "", ""

    monkeypatch.setattr(voice, "run_cmd", fake_run)
    caps = client.get("/voice/capabilities", headers=auth).json()
    assert caps["stt"] == {"available": True, "engine": "whisper.cpp", "model": "ggml-base.bin", "needs_ffmpeg": False}
    r = client.post("/voice/transcribe", files={"file": ("a.webm", b"xx", "audio/webm")}, data={"language": "zh"}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "你好世界" and len(r.json()["segments"]) == 2 and r.json()["language"] == "zh"
    assert calls[0][0] == "/fake/ffmpeg" and "-ar" in calls[0]
    w = calls[1]
    assert w[0] == "/fake/whisper-cli" and w[w.index("-m") + 1] == str(model) and w[w.index("-l") + 1] == "zh" and "-oj" in w

    async def failing(*args, timeout=120.0):
        return 1, "", "bad file"
    monkeypatch.setattr(voice, "run_cmd", failing)
    r = client.post("/voice/transcribe", files={"file": ("a.webm", b"xx", "audio/webm")}, headers=auth)
    assert r.status_code == 400 and "ffmpeg" in r.json()["error"]["message"]


def test_speak_with_fake_edge_tts(client, auth, monkeypatch):
    monkeypatch.setattr(voice, "detect_edge_tts", lambda: True)
    seen = {}

    async def fake_synth(text, voice_name, rate, volume):
        seen.update(text=text, voice=voice_name, rate=rate)
        return b"ID3fake-mp3"

    monkeypatch.setattr(voice, "synth", fake_synth)
    r = client.post("/voice/speak", json={"text": "  測試朗讀 ", "rate": "+10%"}, headers=auth)
    assert r.status_code == 200 and r.headers["content-type"].startswith("audio/mpeg") and r.content == b"ID3fake-mp3"
    assert seen == {"text": "測試朗讀", "voice": voice.DEFAULT_VOICE, "rate": "+10%"}
    assert client.post("/voice/speak", json={"text": "  "}, headers=auth).status_code == 400

    async def boom(*a):
        raise RuntimeError("network")
    monkeypatch.setattr(voice, "synth", boom)
    r = client.post("/voice/speak", json={"text": "x"}, headers=auth)
    assert r.status_code == 502 and r.json()["error"]["code"] == "tts_failed"
