"""
VoiceForge — shared GPU backend (contract v2).

ONE server used by every provider:
  * Colab / Kaggle  — the notebook downloads this file from GitHub raw
  * Modal           — modal/voiceforge_modal.py imports it

Keeping a single implementation is the point: duplicated server logic between
notebooks and Modal is how the two drift apart and start failing differently.

Contract
--------
GET    /health              -> {ok, provider, gpu, models[], voices_cached[], busy, version}
PUT    /voices/{voice_id}   -> {audio_url, transcript, language} downloads + caches a reference
POST   /generate            -> one chunk of speech; 409 voice_not_cached if unknown
POST   /clone               -> legacy multipart clone (kept for the old studio path)
POST   /jobs                -> 202, renders a whole script in a background worker

Every call except /health requires the X-Backend-Secret header.
"""

from __future__ import annotations

import base64
import io
import os
import threading
import time
import traceback
import urllib.request
from typing import Any, Dict, List, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

VERSION = "2.0.0"

# Tuned defaults — these are load-bearing, see .claude_context.md. Chunking and
# normalization happen in the web app (lib/chunker.ts + lib/normalize.ts) so the
# API and the studio produce identical audio; the backend never re-chunks.
DEFAULT_EXAGGERATION = 0.4
DEFAULT_CFG = 0.5
DEFAULT_TEMPERATURE = 0.7
SENTENCE_GAP_SEC = 0.35
PARAGRAPH_GAP_SEC = 0.7
PEAK_DBFS = -1.0

VOICES_DIR = os.environ.get("VOICEFORGE_VOICES_DIR", "/tmp/voiceforge/voices")
os.makedirs(VOICES_DIR, exist_ok=True)

MODELS: Dict[str, Any] = {}
VOICES: Dict[str, Dict[str, str]] = {}
_GPU_LOCK = threading.Lock()  # one generation at a time: a single GPU
_BUSY = False


# ---------------------------------------------------------------------------
# model loading
# ---------------------------------------------------------------------------

def load_models(load_qwen: bool = False) -> List[str]:
    """Load Chatterbox Multilingual (23 languages, incl. English and Hindi)."""
    device = "cuda" if torch.cuda.is_available() else "cpu"
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    MODELS["chatterbox"] = ChatterboxMultilingualTTS.from_pretrained(device=device)
    print("chatterbox (multilingual) ready", flush=True)

    # Qwen3 pins a conflicting transformers version, so it stays opt-in.
    if load_qwen:
        try:
            from qwen_tts import Qwen3TTSModel

            MODELS["qwen3"] = Qwen3TTSModel.from_pretrained(
                "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
                device_map=device,
                dtype=torch.float16,
                attn_implementation="sdpa",
            )
            print("qwen3 ready", flush=True)
        except Exception as e:  # pragma: no cover - environment dependent
            print("qwen3 unavailable:", e, flush=True)
    return list(MODELS.keys())


def gpu_name() -> str:
    return torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"


# ---------------------------------------------------------------------------
# audio helpers
# ---------------------------------------------------------------------------

def _peak_normalize(audio: np.ndarray, dbfs: float = PEAK_DBFS) -> np.ndarray:
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak <= 0:
        return audio
    return (audio * ((10 ** (dbfs / 20)) / peak)).astype(np.float32)


def _wav_b64(audio: np.ndarray, sr: int, fmt: str = "wav") -> str:
    buf = io.BytesIO()
    if fmt == "mp3":
        try:
            sf.write(buf, audio, sr, format="MP3")
        except Exception:
            buf = io.BytesIO()
            sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    else:
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return base64.b64encode(buf.getvalue()).decode()


def _stitch(parts: List[np.ndarray], sr: int, paragraph_breaks: List[bool]) -> np.ndarray:
    """Concatenate chunks with the tuned gaps — same values as the studio."""
    out: List[np.ndarray] = []
    for i, part in enumerate(parts):
        out.append(part)
        if i < len(parts) - 1:
            gap = PARAGRAPH_GAP_SEC if (i < len(paragraph_breaks) and paragraph_breaks[i]) else SENTENCE_GAP_SEC
            out.append(np.zeros(int(gap * sr), dtype=np.float32))
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


# ---------------------------------------------------------------------------
# generation
# ---------------------------------------------------------------------------

def _generate_chunk(
    text: str,
    voice_id: str,
    model: str = "chatterbox",
    seed: int = 0,
    language: str = "en",
    exaggeration: float = DEFAULT_EXAGGERATION,
    cfg: float = DEFAULT_CFG,
    temperature: float = DEFAULT_TEMPERATURE,
) -> tuple[np.ndarray, int, float]:
    if voice_id not in VOICES:
        raise KeyError("voice_not_cached")
    if model not in MODELS:
        raise ValueError(f"{model} not loaded")

    torch.manual_seed(seed)
    ref = VOICES[voice_id]
    t0 = time.time()

    if model == "chatterbox":
        import inspect

        kwargs = {
            "language_id": language,
            "audio_prompt_path": ref["path"],
            "exaggeration": float(exaggeration),
            "cfg_weight": float(cfg),
            "temperature": float(temperature),
        }
        accepted = inspect.signature(MODELS["chatterbox"].generate).parameters
        kwargs = {k: v for k, v in kwargs.items() if k in accepted}
        wav = MODELS["chatterbox"].generate(text, **kwargs)
        audio = wav.squeeze(0).cpu().numpy()
        sr = MODELS["chatterbox"].sr
    else:
        wavs, out_sr = MODELS["qwen3"].generate_voice_clone(
            text=text, language="English", ref_audio=ref["path"], ref_text=ref.get("transcript") or None
        )
        audio = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
        if torch.is_tensor(audio):
            audio = audio.cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32).squeeze()
        sr = int(out_sr)

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return np.asarray(audio, dtype=np.float32), int(sr), round(time.time() - t0, 2)


def cache_voice(voice_id: str, audio_url: str, transcript: str = "", language: str = "en") -> float:
    """Download a reference clip (from Blob) and cache it on local disk."""
    path = os.path.join(VOICES_DIR, f"{voice_id}.wav")
    with urllib.request.urlopen(audio_url, timeout=120) as resp:  # noqa: S310 - our own Blob URL
        raw = resp.read()
    data, sr = sf.read(io.BytesIO(raw))
    if getattr(data, "ndim", 1) > 1:
        data = data.mean(axis=1)
    sf.write(path, data, sr)
    VOICES[voice_id] = {"path": path, "transcript": (transcript or "").strip(), "language": language}
    return len(data) / sr


# ---------------------------------------------------------------------------
# job worker — long renders can't live inside one HTTP request
# ---------------------------------------------------------------------------

JOBS: Dict[str, Dict[str, Any]] = {}
_JOB_LOCK = threading.Lock()


def _post_json(url: str, payload: dict, token: str, timeout: int = 60) -> None:
    body = json_dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "X-Callback-Token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - our own app URL
        resp.read()


def json_dumps(obj: Any) -> str:
    import json

    return json.dumps(obj)


def _run_job(job: Dict[str, Any]) -> None:
    """Render every chunk sequentially, then upload the result in parts."""
    global _BUSY
    job_id = job["job_id"]
    chunks: List[str] = job["chunks"]
    breaks: List[bool] = job.get("paragraph_breaks") or [False] * len(chunks)
    params = job.get("params") or {}
    fmt = job.get("format", "mp3")
    mode = job.get("mode", "stitch")
    callback_url = job.get("callback_url")
    token = job.get("callback_token", "")

    t0 = time.time()
    rendered: List[np.ndarray] = []
    sr = 24000
    try:
        with _GPU_LOCK:
            _BUSY = True
            for i, text in enumerate(chunks):
                audio, sr, _ = _generate_chunk(
                    text,
                    job["voice_id"],
                    model=params.get("model", "chatterbox"),
                    seed=int(params.get("seed", 0)) + i,
                    language=params.get("language", "en"),
                    exaggeration=float(params.get("exaggeration", DEFAULT_EXAGGERATION)),
                    cfg=float(params.get("cfg", DEFAULT_CFG)),
                    temperature=float(params.get("temperature", DEFAULT_TEMPERATURE)),
                )
                rendered.append(audio)
                with _JOB_LOCK:
                    JOBS[job_id]["progress"] = round((i + 1) / max(1, len(chunks)) * 100)
            _BUSY = False

        if mode == "items":
            items = [{"audio_b64": _wav_b64(_peak_normalize(a), sr, fmt), "duration": round(len(a) / sr, 2)} for a in rendered]
            result: Dict[str, Any] = {"items": items}
        else:
            stitched = _peak_normalize(_stitch(rendered, sr, breaks))
            result = {
                "audio_b64": _wav_b64(stitched, sr, fmt),
                "duration": round(len(stitched) / sr, 2),
            }

        result.update(
            {"status": "done", "gen_seconds": round(time.time() - t0, 2), "sample_rate": sr}
        )
        with _JOB_LOCK:
            JOBS[job_id].update(result)
            JOBS[job_id]["status"] = "done"
        if callback_url:
            _post_json(callback_url, {"job_id": job_id, **result}, token)
    except Exception as e:
        _BUSY = False
        err = f"{e}\n{traceback.format_exc()[-1200:]}"
        with _JOB_LOCK:
            JOBS[job_id].update({"status": "error", "error": str(e)[:600]})
        if callback_url:
            try:
                _post_json(callback_url, {"job_id": job_id, "status": "error", "error": str(e)[:600]}, token)
            except Exception:
                pass
        print("[job]", job_id, "failed:", err, flush=True)


# ---------------------------------------------------------------------------
# app
# ---------------------------------------------------------------------------

def create_app(provider: str = "custom") -> FastAPI:
    app = FastAPI(title="VoiceForge backend", version=VERSION)
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    def _check(secret: Optional[str]) -> None:
        expected = os.environ.get("BACKEND_SECRET")
        # If no secret is configured the backend is open — acceptable for a
        # throwaway Colab tunnel, but the app always sends one.
        if expected and secret != expected:
            raise HTTPException(status_code=401, detail="bad backend secret")

    @app.get("/health")
    def health() -> dict:
        return {
            "ok": True,
            "provider": provider,
            "gpu": gpu_name(),
            "models": list(MODELS.keys()),
            "voices_cached": list(VOICES.keys()),
            "busy": _BUSY,
            "version": VERSION,
        }

    @app.put("/voices/{voice_id}")
    async def put_voice(
        voice_id: str, request: Request, x_backend_secret: Optional[str] = Header(None)
    ) -> dict:
        _check(x_backend_secret)
        body = await request.json()
        try:
            duration = cache_voice(
                voice_id,
                body["audio_url"],
                body.get("transcript", ""),
                body.get("language", "en"),
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"could not cache voice: {e}") from e
        return {"ok": True, "voice_id": voice_id, "duration": round(duration, 2)}

    @app.post("/clone")
    async def clone(
        audio: UploadFile = File(...),
        transcript: str = Form(""),
        voice_id: str = Form(""),
        x_backend_secret: Optional[str] = Header(None),
    ) -> dict:
        """Legacy path — kept so the pre-v2 studio flow keeps working."""
        _check(x_backend_secret)
        import uuid

        vid = voice_id or uuid.uuid4().hex[:12]
        path = os.path.join(VOICES_DIR, f"{vid}.wav")
        data, sr = sf.read(io.BytesIO(await audio.read()))
        if getattr(data, "ndim", 1) > 1:
            data = data.mean(axis=1)
        sf.write(path, data, sr)
        VOICES[vid] = {"path": path, "transcript": transcript.strip(), "language": "en"}
        return {"voice_id": vid, "duration": len(data) / sr}

    @app.post("/generate")
    async def generate(request: Request, x_backend_secret: Optional[str] = Header(None)):
        global _BUSY
        _check(x_backend_secret)
        p = await request.json()
        try:
            with _GPU_LOCK:
                _BUSY = True
                audio, sr, gen_seconds = _generate_chunk(
                    p["text"],
                    p["voice_id"],
                    model=p.get("model", "chatterbox"),
                    seed=int(p.get("seed", 0)),
                    language=p.get("language", "en"),
                    exaggeration=float(p.get("exaggeration", DEFAULT_EXAGGERATION)),
                    cfg=float(p.get("cfg", DEFAULT_CFG)),
                    temperature=float(p.get("temperature", DEFAULT_TEMPERATURE)),
                )
                _BUSY = False
        except KeyError:
            _BUSY = False
            # The gateway reacts to this by PUTting the voice and retrying once.
            return JSONResponse({"error": "voice_not_cached"}, status_code=409)
        except Exception as e:
            _BUSY = False
            return JSONResponse({"error": str(e)[:600]}, status_code=500)

        return {
            "audio_b64": _wav_b64(audio, sr),
            "sample_rate": sr,
            "duration": round(len(audio) / sr, 2),
            "gen_seconds": gen_seconds,
        }

    @app.post("/jobs", status_code=202)
    async def create_job(request: Request, x_backend_secret: Optional[str] = Header(None)) -> dict:
        _check(x_backend_secret)
        job = await request.json()
        job_id = job["job_id"]
        with _JOB_LOCK:
            JOBS[job_id] = {"status": "running", "progress": 0}
        threading.Thread(target=_run_job, args=(job,), daemon=True).start()
        return {"accepted": True, "job_id": job_id}

    @app.get("/jobs/{job_id}")
    def job_status(job_id: str) -> dict:
        with _JOB_LOCK:
            job = JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="unknown job")
        # Never echo the audio here — status polling must stay small.
        return {k: v for k, v in job.items() if k not in ("audio_b64", "items")}

    return app
