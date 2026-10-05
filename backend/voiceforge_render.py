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
GET    /render/{id}         -> {status, progress, duration, timeline, error}
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
# One retry, because a CDN hiccup on scene 60 of 90 should not throw away
# twenty minutes of finished encoding.
DOWNLOAD_ATTEMPTS = 2
# A clip shorter than its narration is stretched rather than looped when the
# stretch is this mild — 0.8x speed is slow motion you have to look for, and a
# seamless scene beats a visible loop. Past it, looping is the lesser evil.
MAX_SLOWDOWN = 1.25
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


def _download_once(url: str, dest: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": f"voiceforge-render/{RENDER_VERSION}"})
    with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as r, open(dest, "wb") as f:  # noqa: S310
        size = 0
        while chunk := r.read(262144):
            size += len(chunk)
            if size > MAX_DOWNLOAD:
                raise ValueError(f"input too large: {url}")
            f.write(chunk)
    return dest


def _download(url: str, dest: str, attempts: int = DOWNLOAD_ATTEMPTS) -> str:
    """Fetch with a retry. "Too large" is not retried — it will not shrink."""
    last: Optional[Exception] = None
    for n in range(max(1, attempts)):
        try:
            return _download_once(url, dest)
        except ValueError:
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            if n + 1 < attempts:
                print(f"[render] download failed ({e}), retrying: {url}", flush=True)
                time.sleep(1.5 * (n + 1))
    raise last if last else RuntimeError(f"download failed: {url}")


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
    Short — a 20-minute video of aggressive pushes is exhausting.

    "none" never reaches here: a still scene skips zoompan entirely so its
    frames stay pixel-identical (see _scene_chain)."""
    cx, cy = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    f = max(frames, 1)
    if kind == "none":
        # _scene_chain skips zoompan entirely for a still, so this is belt and
        # braces — but a helper that returned a zoom for "none" would be a
        # trap for whoever calls it next.
        return "1", cx, cy
    if kind == "zoom_in":
        # Centred, deliberately gentle — a slide that creeps rather than lunges.
        return f"1+0.08*on/{f}", cx, cy
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


def _frame_of(scene: Dict[str, Any], width: int, height: int) -> Optional[Dict[str, Any]]:
    """Validate a scene's `frame`, or None when it has none.

    The window has to sit inside the canvas: an overlay PNG is cut for an
    exact rectangle, and a rect that hangs off the edge produces a picture
    that no longer lines up with the hole in the frame.
    """
    f = scene.get("frame")
    if not f:
        return None
    if not isinstance(f, dict):
        raise ValueError("frame must be an object")
    overlay = str(f.get("overlay_url") or "")
    if not overlay:
        raise ValueError("frame.overlay_url is required")
    rect = f.get("rect")
    if not isinstance(rect, dict):
        raise ValueError("frame.rect is required")
    try:
        x, y = int(rect.get("x", 0)), int(rect.get("y", 0))
        w, h = int(rect.get("w", 0)), int(rect.get("h", 0))
    except (TypeError, ValueError):
        raise ValueError("frame.rect values must be whole numbers")
    if w <= 0 or h <= 0:
        raise ValueError(f"frame.rect w and h must be positive, got {w}x{h}")
    if x < 0 or y < 0 or x + w > width or y + h > height:
        raise ValueError(
            f"frame.rect {x},{y} {w}x{h} does not fit inside {width}x{height}"
        )
    return {"overlay_url": overlay, "x": x, "y": y, "w": w, "h": h}


def _clip_plan(scene: Dict[str, Any], duration: float) -> tuple[str, float]:
    """How to make a clip last exactly `duration`.

    "trim" when it is already long enough, "slow" for a mild stretch, "loop"
    when the gap is too wide to stretch across. Never a frozen last frame:
    a still image in the middle of a video reads as a crash.
    """
    if scene.get("type") != "clip":
        return ("trim", 1.0)
    src = float(scene.get("source_seconds") or 0.0)
    if src <= 0.05 or duration <= src:
        return ("trim", 1.0)
    if duration <= src * MAX_SLOWDOWN:
        return ("slow", duration / src)
    return ("loop", 1.0)


# ---------------------------------------------------------------------------
# scene preparation
# ---------------------------------------------------------------------------

def _prepare(
    scenes: List[Dict[str, Any]],
    work: str,
    pad: float,
    min_s: float,
    prefix: str = "scene",
    width: int = 1920,
    height: int = 1080,
    overlays: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    """Fetch every input up front and work out how long each scene runs.

    Doing this before any encoding means a broken URL fails in seconds rather
    than twenty minutes into a render.

    `prefix` keeps each call's downloads apart. Without it the intro, the
    outro and scene 0 all wrote to src0 and the last one won — which is why
    the outro used to appear at the start.

    `overlays` is a url -> path cache shared across every call, because a
    whole video usually sits in one frame and fetching the same PNG ninety
    times is ninety needless round trips.
    """
    if overlays is None:
        overlays = {}
    prepared = []
    for i, scene in enumerate(scenes):
        kind = str(scene.get("type", "image"))
        src = str(scene.get("url", ""))
        if not src:
            raise ValueError(f"scene {i}: missing url")

        frame = _frame_of(scene, width, height)
        if frame:
            cached = overlays.get(frame["overlay_url"])
            if not cached:
                cached = _download(
                    frame["overlay_url"],
                    os.path.join(work, f"overlay{len(overlays)}.png"),
                )
                overlays[frame["overlay_url"]] = cached
            frame["overlay"] = cached

        visual = os.path.join(work, f"{prefix}-src{i}{_extension_of(src)}")
        try:
            _download(src, visual)
        except Exception as e:  # noqa: BLE001
            # A dead stock-video URL should cost this scene its motion, not
            # the whole render. Only if the caller gave us somewhere to fall
            # back to: silently dropping a scene would desync the narration.
            poster = scene.get("poster_url")
            if not poster:
                raise
            print(f"[render] scene {i} visual failed ({e}), using poster", flush=True)
            visual = os.path.join(work, f"{prefix}-poster{i}{_extension_of(str(poster))}")
            _download(str(poster), visual)
            kind = "image"

        audio = None
        secs = None
        if scene.get("audio_url"):
            audio_url = str(scene["audio_url"])
            audio = os.path.join(work, f"{prefix}-aud{i}{_extension_of(audio_url)}")
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
            "motion": str(scene.get("motion") or "") or None,
            "frame": frame,
            # Needed to choose between stretching and looping a short clip.
            "source_seconds": _probe_seconds(visual) if kind == "clip" else 0.0,
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
    overlay_slot: Optional[int] = None,
) -> List[str]:
    """Filter chain turning one input into a [v{slot}] of exact duration."""
    frames = max(1, round(duration * fps))
    label = f"v{slot}"
    # A scene may override the video-wide setting — text slides want "none"
    # so consecutive frames line up exactly, photos want a drift.
    kind = str(scene.get("motion") or motion)

    # With a frame, the picture is rendered at the window's size and the pan
    # happens inside it; the frame itself is a still PNG laid over the top, so
    # it never moves however hard the photo does.
    frame = scene.get("frame")
    rw, rh = (frame["w"], frame["h"]) if frame else (width, height)

    if scene["type"] == "clip":
        # Loop a short clip rather than freezing on its last frame.
        # Scale to cover, then centre-crop (crop defaults to centred).
        # The input carries -stream_loop -1, so a clip shorter than its
        # narration repeats seamlessly instead of freezing on its last frame;
        # trim cuts whatever is left over.
        # "slow" stretches a slightly short clip; "loop" repeats a very short
        # one (the input carries -stream_loop -1). Either way it never freezes.
        plan, factor = _clip_plan(scene, duration)
        speed = f"setpts=PTS*{factor:.5f}," if plan == "slow" else ""
        chain = (
            f"[{slot}:v]{speed}scale={rw}:{rh}:force_original_aspect_ratio=increase,"
            f"crop={rw}:{rh},fps={fps},"
            f"trim=duration={duration:.3f},setpts=PTS-STARTPTS[{label}p]"
        )
    elif kind == "none":
        # No zoompan at all. Oversampling and resampling a still would shift
        # pixels between frames; a text slide has to be exactly itself.
        chain = (
            f"[{slot}:v]scale={rw}:{rh}:force_original_aspect_ratio=increase,"
            f"crop={rw}:{rh},loop=loop=-1:size=1:start=0,"
            f"trim=duration={duration:.3f},setpts=PTS-STARTPTS,fps={fps}[{label}p]"
        )
    else:
        # Oversample before zoompan so the pan has pixels to work with; 1.25x
        # rather than reel-render's 1.5x because long-form uses gentler moves
        # and the bigger canvas is the main CPU cost.
        zw, zh = int(rw * 1.25), int(rh * 1.25)
        z, x, y = _motion(kind, scene["index"], frames)
        chain = (
            f"[{slot}:v]scale={zw}:{zh}:force_original_aspect_ratio=increase,crop={zw}:{zh},"
            f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={rw}x{rh}:fps={fps}[{label}p]"
        )

    out = [chain]
    cur = f"{label}p"

    if frame:
        # A canvas the full size of the video, the moving picture dropped into
        # the window, then the frame PNG over everything. `shortest` lets the
        # canvas be generously long without padding the scene.
        out.append(
            f"color=c=black:s={width}x{height}:r={fps}:d={duration + 1.0:.3f}[{label}bg]"
        )
        out.append(
            f"[{label}bg][{cur}]overlay={frame['x']}:{frame['y']}:shortest=1[{label}w]"
        )
        cur = f"{label}w"
        if overlay_slot is not None:
            out.append(f"[{overlay_slot}:v]scale={width}:{height}[{label}ov]")
            out.append(f"[{cur}][{label}ov]overlay=0:0[{label}f]")
            cur = f"{label}f"

    if captions and scene["caption"] and not scene.get("no_caption"):
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


def _timeline(scenes: List[Dict[str, Any]]) -> List[Dict[str, float]]:
    """Where each scene lands in the finished MP4, for YouTube chapters.

    Crossfades do not shift anything. xfade's output runs for
    `offset + len(second input)`, and each scene is handed an extra tail
    exactly as long as the transition that will eat it — so scene k still
    starts at the sum of the scenes before it, and the film still runs for
    the sum of them all. Batching changes nothing either: the parts are
    concatenated end to end.
    """
    out: List[Dict[str, float]] = []
    t = 0.0
    for s in scenes:
        out.append({
            "index": int(s["index"]),
            "start": round(t, 3),
            "end": round(t + s["seconds"], 3),
        })
        t += s["seconds"]
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

    # Every scene but the last carries extra tail that the crossfade eats.
    # Worked out once, up front, because -stream_loop is an input flag and so
    # has to be decided before the filter graph that uses the same number.
    vdur = {
        s["index"]: s["seconds"] + (tdur if n < len(batch) - 1 else 0.0)
        for n, s in enumerate(batch)
    }

    # Inputs in a fixed order so the filter graph can address them by index:
    # every visual, then every narration track, then the banner.
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    slot = 0
    vis_slot = {}
    for s in batch:
        # Only a clip too short to stretch across the gap gets looped; one
        # that is merely a little short is slowed down in the filter graph.
        if _clip_plan(s, vdur[s["index"]])[0] == "loop":
            args += ["-stream_loop", "-1"]
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
    # One input per distinct frame PNG in this batch, not one per scene.
    overlay_slot: Dict[str, int] = {}
    for s in batch:
        f = s.get("frame")
        if f and f.get("overlay") and f["overlay"] not in overlay_slot:
            args += ["-i", f["overlay"]]
            overlay_slot[f["overlay"]] = slot
            slot += 1

    chains: List[str] = []
    for n, s in enumerate(batch):
        f = s.get("frame")
        chains += _scene_chain(
            s, vis_slot[s["index"]], width, height, fps, vdur[s["index"]],
            cfg["motion"], cfg["captions"], banner_slot, work,
            overlay_slot.get(f["overlay"]) if f and f.get("overlay") else None,
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
            # Shared so a frame PNG used by every scene is fetched once.
            overlays: Dict[str, str] = {}
            canvas = {"width": cfg["width"], "height": cfg["height"], "overlays": overlays}
            scenes = _prepare(
                req.get("scenes") or [], work, pad, min_s, prefix="scene", **canvas
            )
            if not scenes:
                raise ValueError("no scenes")

            # Bookends are ordinary scenes with captions suppressed: they
            # already carry their own titles, and a caption drawn over a
            # designed intro card looks like a mistake. Default 4s when the
            # caller gives neither audio nor a length.
            intro = req.get("intro")
            outro = req.get("outro")
            if intro:
                prepared = _prepare(
                    [{**intro, "caption": ""}], work, pad,
                    float(intro.get("seconds") or 4.0), prefix="intro", **canvas,
                )
                for s_ in prepared:
                    s_["no_caption"] = True
                scenes = prepared + scenes
            if outro:
                prepared = _prepare(
                    [{**outro, "caption": ""}], work, pad,
                    float(outro.get("seconds") or 4.0), prefix="outro", **canvas,
                )
                for s_ in prepared:
                    s_["no_caption"] = True
                scenes = scenes + prepared

            # _prepare numbers scenes from zero per call, so renumber once the
            # bookends are in place — the index drives the motion variation.
            for n_, s_ in enumerate(scenes):
                s_["index"] = n_

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
                 timeline=_timeline(scenes),
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
            "timeline": job.get("timeline"),
            "gen_seconds": job.get("gen_seconds"),
            "bytes": job.get("bytes"),
            "scenes": job.get("scenes"),
            "timeline": job.get("timeline"),
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
            RENDERS[job_id] = {
                "status": "queued",
                "stage": "queued",
                "progress": 0,
                # Lets the finished file be fetched with ?token=… — see the
                # video route below.
                "token": str(req.get("callback_token") or ""),
            }
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
        return {k: v for k, v in job.items() if k not in ("path", "work", "token")}

    @router.get("/render/{job_id}/video")
    def render_video(
        job_id: str,
        token: Optional[str] = None,
        x_backend_secret: Optional[str] = Header(None),
    ):
        """The one route that accepts a query-string token.

        n8n downloads this file with a plain GET and cannot set headers on a
        binary download the way it can on an API call. The token is the job's
        own callback token — unguessable and useless for any other render —
        so this is no weaker than the header, just usable from a browser or a
        download node."""
        with _LOCK:
            job = RENDERS.get(job_id)
        expected = (job or {}).get("token")
        if not (token and expected and token == expected):
            check_secret(x_backend_secret)
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
