"""
VoiceForge on Modal — the always-available backend.

Why Modal: a permanent HTTPS URL that scales to zero, so it costs nothing
while idle and needs no notebook left open. Deployed automatically from
GitHub by .github/workflows/deploy-modal.yml.

Deploy by hand:
    pip install modal
    modal token new
    modal secret create voiceforge-backend BACKEND_SECRET=<same value as Vercel>
    modal deploy modal/voiceforge_modal.py
"""

import modal

APP_NAME = "voiceforge"

# Same pinned stack the notebooks use — see colab/voiceforge_server.ipynb.
# numpy<2 and the exact transformers/safetensors pins are load-bearing:
# chatterbox breaks on newer ones.
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install(
        "chatterbox-tts",
        "fastapi[standard]",
        "soundfile",
        "numpy==1.26.4",
        "transformers==5.2.0",
        "safetensors==0.5.3",
    )
    .add_local_dir("backend", remote_path="/root/backend")
)

app = modal.App(APP_NAME)

# Cached reference clips survive container restarts, so a voice is downloaded
# from Blob once rather than on every cold start.
volume = modal.Volume.from_name("voiceforge-voices", create_if_missing=True)
VOICES_DIR = "/voices"

secret = modal.Secret.from_name("voiceforge-backend")


@app.function(
    image=image,
    gpu="T4",
    volumes={VOICES_DIR: volume},
    secrets=[secret],
    # One container: generation is sequential by design (single GPU).
    max_containers=1,
    # Idle for ~2 minutes then shut down — this is what makes it free.
    scaledown_window=120,
    timeout=60 * 30,
)
@modal.asgi_app()
def api():
    import os

    os.environ.setdefault("VOICEFORGE_VOICES_DIR", VOICES_DIR)

    import sys

    sys.path.insert(0, "/root")
    from backend.voiceforge_server import create_app, load_models

    load_models()
    return create_app(provider="modal")


@app.function(image=image, secrets=[secret], max_containers=1)
@modal.asgi_app()
def health():
    """
    A CPU-only health endpoint.

    Deliberately separate from `api`: the admin page polls health every 15s,
    and hitting the GPU function would wake a T4 each time and burn the free
    credit doing nothing. This answers without touching the GPU.
    """
    from fastapi import FastAPI

    probe = FastAPI()

    @probe.get("/health")
    def _health():
        return {"ok": True, "provider": "modal", "gpu": "T4 (cold)", "models": ["chatterbox"]}

    return probe
