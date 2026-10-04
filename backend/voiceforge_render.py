"""
VoiceForge — long-form video renderer (ffmpeg, CPU only).

Deliberately separate from voiceforge_server.py and importing no torch, so the
same file can run three ways:
  * inside the Colab/Kaggle notebook alongside TTS — one session, both jobs
  * as a CPU-only Modal function — rendering never wakes a T4
  * on its own anywhere ffmpeg exists

Contract
--------
POST   /render              -> 202, renders in a background worker
GET    /render/{id}         -> {status, progress, duration, error}
GET    /render/{id}/video   -> the finished MP4
DELETE /render/{id}         -> drop a collected render and its files

Every call requires the X-Backend-Secret header.

Why batches
-----------
A 20-minute video is 100+ scenes. Building one ffmpeg filter_complex for all
of them produces a graph that is slow to parse, enormous in memory, and fails
outright past a few dozen xfades. So scenes are rendered in small batches with
crossfades inside each batch, then the batches are joined with the concat
demuxer at stream-copy speed. The cost is a hard cut at each batch boundary —
roughly once a minute in practice, which reads as a section break.
"""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.request
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse

RENDER_VERSION = "1.0.0"

WORK_ROOT = os.environ.get("VOICEFORGE_RENDER_DIR", "/tmp/voiceforge/renders")
os.makedirs(WORK_ROOT, exist_ok=True)

FONT = os.environ.get(
    "VOICEFORGE_FONT", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
)

MAX_DOWNLOAD = 200 * 1024 * 1024
DOWNLOAD_TIMEOUT = 120
# Small enough that the filter graph stays sane, large enough that hard cuts
# are rare. 8 scenes is roughly a minute of long-form narration.
DEFAULT_BATCH = 8
XFADES = ["fade", "dissolve", "smoothleft", "fadeblack", "wiperight", "smoothup"]

RENDERS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()
# One render at a time: ffmpeg already saturates the CPU, and two renders would
# simply halve each other's speed while doubling peak memory.
_RENDER_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _extension_of(url: str) -> str:
    """Keep the source extension — ffprobe is happier with a real container
    suffix than with a bare filename."""
    tail = url.split("?")[0].rsplit("/", 1)[-1]
    ext = tail.rsplit(".", 1)[-1].lower() if "." in tail else ""
    return f".{ext}" if 1 <= len(ext) <= 5 and ext.isalnum() else ""


def _download(url: str, dest: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": f"voiceforge-render/{RENDER_VERSION}"})
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as r, open(dest, "wb") as f:  # noqa: S310
        size = 0
        while chunk := r.read(262144):
            size += len(chunk)
            if size > MAX_DOWNLOAD:
                raise ValueError(f"input too large: {url}")
            f.write(chunk)
    return dest


def _probe_seconds(path: str) -> float:
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, timeout=60,
    )
    try:
        return float(p.stdout.strip())
    except ValueError:
        return 0.0


def _run(args: List[str], cwd: str, timeout: int) -> None:
    proc = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + proc.stderr[-2500:])


def _wrap(text: str, width: int = 38, max_lines: int = 2) -> List[str]:
    lines, cur = [], ""
    for word in " ".join(str(text).split()).split(" "):
        if cur and len(cur) + 1 + len(word) > width:
            lines.append(cur)
            cur = word
        else:
            cur = (cur + " " + word).strip()
    if cur:
        lines.append(cur)
    return lines[:max_lines]


def _textfile(work: str, name: str, text: str) -> str:
    path = os.path.join(work, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


def _motion(kind: str, index: int, frames: int) -> tuple[str, str, str]:
    """zoompan expressions. Long-form wants slower, calmer movement than a
    Short — a 20-minute video of aggressive pushes is exhausting."""
    cx, cy = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    if kind == "none":
        return "1", cx, cy
    f = max(frames, 1)
    if kind != "dynamic":
        return f"min(zoom+0.00035,1.10)", cx, cy
    style = index % 4
    if style == 0:
        return f"1+0.12*on/{f}", cx, cy
    if style == 1:
        return f"1.12-0.12*on/{f}", cx, cy
    if style == 2:
        return "1.10", f"(iw-iw/zoom)*on/{f}", cy
    return "1.10", f"(iw-iw/zoom)*(1-on/{f})", cy


# ---------------------------------------------------------------------------
# scene preparation
# ---------------------------------------------------------------------------

def _prepare(scenes: List[Dict[str, Any]], work: str, pad: float, min_s: float) -> List[Dict[str, Any]]:
    """Fetch every input up front and work out how long each scene runs.

    Doing this before any encoding means a broken URL fails in seconds rather
    than twenty minutes into a render.
    """
    prepared = []
    for i, scene in enumerate(scenes):
        kind = str(scene.get("type", "image"))
        src = str(scene.get("url", ""))
        if not src:
            raise ValueError(f"scene {i}: missing url")

        visual = os.path.join(work, f"src{i}{_extension_of(src)}")
        _download(src, visual)

        audio = None
        secs = None
        if scene.get("audio_url"):
            audio_url = str(scene["audio_url"])
            audio = os.path.join(work, f"aud{i}{_extension_of(audio_url)}")
            _download(audio_url, audio)
            secs = _probe_seconds(audio) + pad

        if secs is None:
            if scene.get("seconds"):
                secs = float(scene["seconds"])
            elif kind == "clip":
                secs = _probe_seconds(visual)
            else:
                secs = min_s

        prepared.append({
            "index": i,
            "type": kind,
            "visual": visual,
            "audio": audio,
            "seconds": max(float(secs), 0.5),
            "caption": str(scene.get("caption") or ""),
        })
    return prepared


def _scene_chain(
    scene: Dict[str, Any],
    slot: int,
    width: int,
    height: int,
    fps: int,
    duration: float,
    motion: str,
    captions: bool,
    banner_slot: Optional[int],
    work: str,
) -> List[str]:
    """Filter chain turning one input into a [v{slot}] of exact duration."""
    frames = max(1, round(duration * fps))
    label = f"v{slot}"

    if scene["type"] == "clip":
        # Loop a short clip rather than freezing on its last frame.
        # tpad clones the final frame when the clip is shorter than the scene;
        # trim cuts it when it is longer. "loop" would repeat a single frame.
        chain = (
            f"[{slot}:v]scale={width}:{height}:force_original_aspect_ratio=increase,"
            f"crop={width}:{height},fps={fps},"
            f"tpad=stop_mode=clone:stop_duration={duration:.3f},"
            f"trim=duration={duration:.3f},setpts=PTS-STARTPTS[{label}p]"
        )
    else:
        # Oversample before zoompan so the pan has pixels to work with; 1.25x
        # rather than reel-render's 1.5x because long-form uses gentler moves
        # and the bigger canvas is the main CPU cost.
        zw, zh = int(width * 1.25), int(height * 1.25)
        z, x, y = _motion(motion, scene["index"], frames)
        chain = (
            f"[{slot}:v]scale={zw}:{zh}:force_original_aspect_ratio=increase,crop={zw}:{zh},"
            f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={width}x{height}:fps={fps}[{label}p]"
        )

    out = [chain]
    cur = f"{label}p"

    if captions and scene["caption"]:
        draws = []
        for k, line in enumerate(_wrap(scene["caption"])):
            tf = _textfile(work, f"cap{scene['index']}_{k}.txt", line)
            draws.append(
                f"drawtext=fontfile={FONT}:textfile={tf}:expansion=none:fontcolor=white:"
                f"fontsize={max(int(height * 0.040), 20)}:box=1:boxcolor=black@0.5:boxborderw=16:"
                f"x=(w-text_w)/2:y=h*0.82+{k * int(height * 0.055)}"
            )
        out.append(f"[{cur}]" + ",".join(draws) + f"[{label}c]")
        cur = f"{label}c"

    if banner_slot is not None:
        out.append(
            f"[{banner_slot}:v]scale=-1:{max(int(height * 0.07), 24)}[bn{slot}]"
        )
        out.append(f"[{cur}][bn{slot}]overlay=W-w-{int(width*0.025)}:{int(height*0.035)}[{label}b]")
        cur = f"{label}b"

    out.append(f"[{cur}]setsar=1,format=yuv420p[{label}]")
    return out


def _render_batch(
    batch: List[Dict[str, Any]],
    out_path: str,
    cfg: Dict[str, Any],
    work: str,
) -> None:
    """Render one batch of scenes into a single MP4, crossfaded internally."""
    width, height, fps = cfg["width"], cfg["height"], cfg["fps"]
    tdur = cfg["transition_seconds"] if cfg["transition"] != "none" and len(batch) > 1 else 0.0

    # Inputs in a fixed order so the filter graph can address them by index:
    # every visual, then every narration track, then the banner.
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    slot = 0
    vis_slot = {}
    for s in batch:
        args += ["-i", s["visual"]]
        vis_slot[s["index"]] = slot
        slot += 1
    aud_slot = {}
    for s in batch:
        if s["audio"]:
            args += ["-i", s["audio"]]
            aud_slot[s["index"]] = slot
            slot += 1
    banner_slot = None
    if cfg.get("banner"):
        args += ["-i", cfg["banner"]]
        banner_slot = slot
        slot += 1

    chains: List[str] = []
    for n, s in enumerate(batch):
        # The last scene of a pair carries extra tail that the crossfade eats.
        vdur = s["seconds"] + (tdur if n < len(batch) - 1 else 0.0)
        chains += _scene_chain(
            s, vis_slot[s["index"]], width, height, fps, vdur,
            cfg["motion"], cfg["captions"], banner_slot, work,
        )

    # audio: real narration where present, silence where not
    for n, s in enumerate(batch):
        if s["index"] in aud_slot:
            chains.append(
                f"[{aud_slot[s['index']]}:a]aresample=48000,aformat=channel_layouts=stereo,"
                f"apad,atrim=0:{s['seconds']:.3f},asetpts=N/SR/TB[a{n}]"
            )
        else:
            chains.append(
                f"anullsrc=r=48000:cl=stereo,atrim=0:{s['seconds']:.3f},asetpts=N/SR/TB[a{n}]"
            )

    if tdur > 0:
        prev, offset = f"v{vis_slot[batch[0]['index']]}", 0.0
        for k in range(1, len(batch)):
            offset += batch[k - 1]["seconds"]
            name = XFADES[(k - 1) % len(XFADES)] if cfg["transition"] == "mix" else cfg["transition"]
            out = "vout" if k == len(batch) - 1 else f"x{k}"
            cur = f"v{vis_slot[batch[k]['index']]}"
            chains.append(
                f"[{prev}][{cur}]xfade=transition={name}:duration={tdur:.3f}:offset={offset:.3f}[{out}]"
            )
            prev = out
    else:
        chains.append(
            "".join(f"[v{vis_slot[s['index']]}]" for s in batch)
            + f"concat=n={len(batch)}:v=1:a=0[vout]"
        )

    chains.append("".join(f"[a{n}]" for n in range(len(batch))) + f"concat=n={len(batch)}:v=0:a=1[aout]")

    args += [
        "-filter_complex", ";".join(chains),
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", cfg["preset"], "-crf", str(cfg["crf"]),
        "-pix_fmt", "yuv420p", "-r", str(fps),
        "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
        out_path,
    ]
    _run(args, work, timeout=cfg["batch_timeout"])


def _concat(parts: List[str], out_path: str, work: str, timeout: int) -> None:
    listing = os.path.join(work, "concat.txt")
    with open(listing, "w", encoding="utf-8") as f:
        for p in parts:
            f.write(f"file '{p}'\n")
    _run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", out_path],
        work, timeout=timeout,
    )


def _mix_audio(video: str, out_path: str, cfg: Dict[str, Any], work: str, total: float) -> None:
    """Add background music (ducked) and sound effects in one audio-only pass.

    Video is stream-copied, so this is cheap however long the film is.
    """
    music = cfg.get("music")
    sfx = cfg.get("sfx") or []
    if not music and not sfx:
        shutil.move(video, out_path)
        return

    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", video]
    slot = 1
    music_slot = None
    if music:
        args += ["-stream_loop", "-1", "-i", music]
        music_slot = slot
        slot += 1
    sfx_slots = []
    for item in sfx:
        args += ["-i", item["path"]]
        sfx_slots.append((slot, float(item.get("at", 0.0))))
        slot += 1

    chains = ["[0:a]aresample=48000,aformat=channel_layouts=stereo[vo]"]
    current = "vo"

    if music_slot is not None:
        fade_at = max(total - 2.0, 0.0)
        chains.append(
            f"[{music_slot}:a]aresample=48000,aformat=channel_layouts=stereo,"
            f"volume={cfg['music_volume']:.3f},atrim=0:{total:.3f},asetpts=N/SR/TB,"
            f"afade=t=out:st={fade_at:.3f}:d=2[bg]"
        )
        chains.append(f"[{current}]asplit=2[vo1][vo2]")
        # Sidechain so the music drops under speech instead of fighting it.
        chains.append("[bg][vo2]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=400[duck]")
        chains.append("[vo1][duck]amix=inputs=2:duration=first:dropout_transition=0,volume=2[mixed]")
        current = "mixed"

    if sfx_slots:
        labels = []
        for n, (s, at) in enumerate(sfx_slots):
            ms = int(round(at * 1000))
            chains.append(
                f"[{s}:a]aresample=48000,aformat=channel_layouts=stereo,"
                f"volume={cfg['sfx_volume']:.3f},adelay={ms}|{ms},apad,"
                f"atrim=0:{total:.3f},asetpts=N/SR/TB[fx{n}]"
            )
            labels.append(f"[fx{n}]")
        if len(labels) == 1:
            chains.append("[fx0]anull[fxall]")
        else:
            chains.append(
                "".join(labels) + f"amix=inputs={len(labels)}:duration=first:dropout_transition=0,"
                f"volume={len(labels)}[fxall]"
            )
        chains.append(f"[{current}][fxall]amix=inputs=2:duration=first:dropout_transition=0,volume=2[final]")
        current = "final"
    else:
        chains.append(f"[{current}]anull[final]")
        current = "final"

    args += [
        "-filter_complex", ";".join(chains),
        "-map", "0:v", "-map", f"[{current}]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", out_path,
    ]
    _run(args, work, timeout=cfg["batch_timeout"])


# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------

def _set(job_id: str, **patch: Any) -> None:
    with _LOCK:
        if job_id in RENDERS:
            RENDERS[job_id].update(patch)


def _run_render(req: Dict[str, Any]) -> None:
    job_id = req["job_id"]
    work = tempfile.mkdtemp(prefix="vfr-", dir=WORK_ROOT)
    t0 = time.time()

    try:
        with _RENDER_LOCK:
            _set(job_id, status="running", stage="fetching", progress=1)

            cfg = {
                "width": int(req.get("width", 1920)),
                "height": int(req.get("height", 1080)),
                "fps": int(req.get("fps", 30)),
                "motion": str(req.get("motion", "classic")),
                "transition": str(req.get("transition", "mix")),
                "transition_seconds": min(max(float(req.get("transition_seconds", 0.5)), 0.1), 2.0),
                "captions": bool(req.get("captions", False)),
                "music_volume": min(max(float(req.get("music_volume", 0.12)), 0.0), 1.0),
                "sfx_volume": min(max(float(req.get("sfx_volume", 0.5)), 0.0), 1.5),
                "preset": str(req.get("preset", "veryfast")),
                "crf": int(req.get("crf", 22)),
                "batch_timeout": int(req.get("batch_timeout", 1800)),
                "banner": None,
                "music": None,
                "sfx": [],
            }

            pad = float(req.get("pad_seconds", 0.35))
            min_s = float(req.get("min_scene_seconds", 4.0))
            scenes = _prepare(req.get("scenes") or [], work, pad, min_s)
            if not scenes:
                raise ValueError("no scenes")

            if req.get("banner_url"):
                cfg["banner"] = _download(str(req["banner_url"]), os.path.join(work, "banner.png"))
            if req.get("music_url"):
                try:
                    cfg["music"] = _download(str(req["music_url"]), os.path.join(work, "music"))
                except Exception as e:  # noqa: BLE001
                    print(f"[render] music failed ({e}), continuing without", flush=True)

            total = sum(s["seconds"] for s in scenes)
            for n, item in enumerate(req.get("sfx") or []):
                try:
                    path = _download(str(item["url"]), os.path.join(work, f"sfx{n}"))
                    cfg["sfx"].append({"path": path, "at": float(item.get("at", 0.0))})
                except Exception as e:  # noqa: BLE001
                    print(f"[render] sfx {n} failed ({e}), skipping", flush=True)

            batch_size = max(2, int(req.get("batch_size", DEFAULT_BATCH)))
            batches = [scenes[i:i + batch_size] for i in range(0, len(scenes), batch_size)]
            parts: List[str] = []

            for bi, batch in enumerate(batches):
                _set(job_id,
                     stage=f"rendering {bi + 1}/{len(batches)}",
                     progress=int(5 + 80 * bi / max(1, len(batches))))
                part = os.path.join(work, f"part{bi:04d}.mp4")
                _render_batch(batch, part, cfg, work)
                parts.append(part)

            _set(job_id, stage="joining", progress=88)
            body = os.path.join(work, "body.mp4")
            if len(parts) == 1:
                shutil.move(parts[0], body)
            else:
                _concat(parts, body, work, cfg["batch_timeout"])

            _set(job_id, stage="audio", progress=94)
            final = os.path.join(work, f"{job_id}.mp4")
            _mix_audio(body, final, cfg, work, total)

            duration = _probe_seconds(final)
            _set(job_id,
                 status="done", stage="done", progress=100,
                 path=final, work=work,
                 duration=round(duration, 2),
                 bytes=os.path.getsize(final),
                 scenes=len(scenes),
                 gen_seconds=round(time.time() - t0, 2))

    except Exception as e:  # noqa: BLE001
        shutil.rmtree(work, ignore_errors=True)
        detail = f"{e}\n{traceback.format_exc()[-1200:]}"
        print("[render]", job_id, "failed:", detail, flush=True)
        _set(job_id, status="error", error=str(e)[:600], progress=100)

    # Tell the gateway either way; it collects the file with a GET.
    callback = req.get("callback_url")
    if callback:
        with _LOCK:
            job = dict(RENDERS.get(job_id) or {})
        payload = {
            "job_id": job_id,
            "kind": "video",
            "status": job.get("status", "error"),
            "duration": job.get("duration"),
            "gen_seconds": job.get("gen_seconds"),
            "bytes": job.get("bytes"),
            "scenes": job.get("scenes"),
            "error": job.get("error"),
        }
        try:
            body_bytes = json.dumps(payload).encode()
            r = urllib.request.Request(
                callback, data=body_bytes, method="POST",
                headers={"Content-Type": "application/json",
                         "X-Callback-Token": req.get("callback_token", "")},
            )
            with urllib.request.urlopen(r, timeout=60) as resp:  # noqa: S310
                resp.read()
        except Exception as e:  # noqa: BLE001
            print("[render] callback failed:", e, flush=True)


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

def create_render_router(check_secret) -> APIRouter:
    """Routes for mounting into an existing app (the notebook does this)."""
    router = APIRouter()

    @router.post("/render", status_code=202)
    async def start_render(request: Request, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        req = await request.json()
        job_id = str(req.get("job_id") or uuid.uuid4().hex)
        req["job_id"] = job_id
        with _LOCK:
            RENDERS[job_id] = {"status": "queued", "stage": "queued", "progress": 0}
        threading.Thread(target=_run_render, args=(req,), daemon=True).start()
        return {"accepted": True, "job_id": job_id}

    @router.get("/render/{job_id}")
    def render_status(job_id: str, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        with _LOCK:
            job = RENDERS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="unknown render")
        # Never leak local paths to the caller.
        return {k: v for k, v in job.items() if k not in ("path", "work")}

    @router.get("/render/{job_id}/video")
    def render_video(job_id: str, x_backend_secret: Optional[str] = Header(None)):
        check_secret(x_backend_secret)
        with _LOCK:
            job = RENDERS.get(job_id)
        if not job or job.get("status") != "done":
            raise HTTPException(status_code=404, detail="render not finished")
        path = job.get("path")
        if not path or not os.path.exists(path):
            raise HTTPException(status_code=410, detail="file already collected")
        return FileResponse(path, media_type="video/mp4", filename=f"{job_id}.mp4")

    @router.delete("/render/{job_id}")
    def render_delete(job_id: str, x_backend_secret: Optional[str] = Header(None)) -> dict:
        check_secret(x_backend_secret)
        with _LOCK:
            job = RENDERS.pop(job_id, None)
        if job and job.get("work"):
            shutil.rmtree(job["work"], ignore_errors=True)
        return {"ok": True}

    return router


def create_render_app(provider: str = "custom"):
    """Standalone app — used by the CPU-only Modal function."""
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="VoiceForge render", version=RENDER_VERSION)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    def check(secret: Optional[str]) -> None:
        expected = os.environ.get("BACKEND_SECRET")
        if expected and secret != expected:
            raise HTTPException(status_code=401, detail="bad backend secret")

    @app.get("/health")
    def health() -> dict:
        with _LOCK:
            busy = any(j.get("status") == "running" for j in RENDERS.values())
        return {
            "ok": True,
            "provider": provider,
            "capabilities": ["render"],
            "version": RENDER_VERSION,
            "busy": busy,
            "ffmpeg": shutil.which("ffmpeg") is not None,
        }

    app.include_router(create_render_router(check))
    return app
