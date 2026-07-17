/**
 * Client for the talking-head video backend (colab/voiceforge_video.ipynb).
 *
 * This is a SEPARATE backend from the TTS one: SadTalker/Wav2Lip need an older
 * torch/numpy stack that conflicts with Chatterbox, so they run in their own
 * Colab session with their own tunnel URL.
 *
 * Video payloads are multi-MB MP4s, too large to route through the Vercel
 * proxy reliably, so we call the tunnel directly. The Cloudflare quick tunnel
 * sends permissive CORS, so a direct browser call works.
 */

import { base64ToBlob, blobToBase64 } from "./audio";
import { normalizeBackendUrl } from "./backend";
import type { AnimateResult, VideoEngine } from "./types";

export class VideoBackendError extends Error {
  kind: "network" | "api";
  constructor(message: string, kind: "network" | "api") {
    super(message);
    this.name = "VideoBackendError";
    this.kind = kind;
  }
}

export interface VideoHealthInfo {
  gpu: string;
  engines: VideoEngine[];
  latencyMs: number;
}

const HEALTH_TIMEOUT = 15_000;
// Rendering a talking head can take many minutes — give it a wide ceiling.
const ANIMATE_TIMEOUT = 20 * 60 * 1000;

export async function checkVideoHealth(baseUrl: string): Promise<VideoHealthInfo> {
  const url = normalizeBackendUrl(baseUrl);
  if (!url) throw new VideoBackendError("No video backend URL", "network");
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
  } catch (e) {
    throw new VideoBackendError(
      e instanceof Error ? e.message : "Video backend unreachable",
      "network"
    );
  }
  let data: { ok?: boolean; gpu?: string; engines?: string[] };
  try {
    data = await res.json();
  } catch {
    throw new VideoBackendError("Video backend returned a non-JSON response", "api");
  }
  if (!res.ok) throw new VideoBackendError(`Video backend error ${res.status}`, "api");
  return {
    gpu: data.gpu ?? "unknown",
    engines: (data.engines ?? []) as VideoEngine[],
    latencyMs: Math.round(performance.now() - t0),
  };
}

export interface AnimateArgs {
  imageBlob: Blob;
  audioBlob: Blob;
  engine: VideoEngine;
}

/**
 * POST image + audio to /animate, wait for the rendered MP4.
 * The backend returns { video_b64, duration, gen_seconds }.
 */
export async function animate(baseUrl: string, args: AnimateArgs): Promise<AnimateResult> {
  const url = normalizeBackendUrl(baseUrl);
  if (!url) throw new VideoBackendError("No video backend URL", "network");

  const body = {
    engine: args.engine,
    image_b64: await blobToBase64(args.imageBlob),
    image_mime: args.imageBlob.type || "image/png",
    audio_b64: await blobToBase64(args.audioBlob),
  };

  let res: Response;
  try {
    res = await fetch(`${url}/animate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ANIMATE_TIMEOUT),
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new VideoBackendError(
      timedOut ? "Rendering timed out. Try a shorter script or Wav2Lip." : "Video backend unreachable",
      "network"
    );
  }

  let data: { video_b64?: string; duration?: number; gen_seconds?: number; error?: string };
  try {
    data = await res.json();
  } catch {
    throw new VideoBackendError("Video backend returned a non-JSON response", "api");
  }
  if (!res.ok || data.error) {
    throw new VideoBackendError(data.error ?? `Video backend error ${res.status}`, "api");
  }
  if (!data.video_b64) throw new VideoBackendError("No video returned", "api");

  return {
    videoBlob: base64ToBlob(data.video_b64, "video/mp4"),
    durationSec: data.duration ?? 0,
    genSeconds: data.gen_seconds ?? 0,
  };
}
