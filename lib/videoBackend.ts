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
/**
 * Every call is short-lived by design. A Cloudflare quick tunnel terminates
 * any single response that takes longer than ~100s, so rendering is a
 * background job we start and then poll — never one long-held request.
 */
const START_TIMEOUT = 120_000; // upload of photo + audio
const POLL_TIMEOUT = 20_000;
const RESULT_TIMEOUT = 180_000; // pulling back a multi-MB MP4
const POLL_INTERVAL = 3_000;
/** Give up if a render exceeds this. SadTalker on long audio can crawl. */
const MAX_RENDER_MS = 45 * 60 * 1000;

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

async function call<T>(url: string, path: string, init: RequestInit, timeout: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    throw new VideoBackendError(
      timedOut ? "The video backend stopped responding." : "Video backend unreachable",
      "network"
    );
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new VideoBackendError("Video backend returned a non-JSON response", "api");
  }
  const err = (data as { error?: string })?.error;
  if (!res.ok || err) {
    throw new VideoBackendError(err ?? `Video backend error ${res.status}`, "api");
  }
  return data as T;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start a render, poll it to completion, then pull the MP4 back.
 *
 * Deliberately split into three short requests: a Cloudflare quick tunnel
 * kills any single response over ~100s, so holding one request open for a
 * multi-minute render always died with "backend unreachable".
 *
 * `onProgress` receives the backend's own stage text as it advances.
 */
export async function animate(
  baseUrl: string,
  args: AnimateArgs,
  onProgress?: (stage: string) => void
): Promise<AnimateResult> {
  const url = normalizeBackendUrl(baseUrl);
  if (!url) throw new VideoBackendError("No video backend URL", "network");

  onProgress?.("Uploading photo and audio…");
  const started = await call<{ job_id: string; duration: number }>(
    url,
    "/animate",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        engine: args.engine,
        image_b64: await blobToBase64(args.imageBlob),
        image_mime: args.imageBlob.type || "image/png",
        audio_b64: await blobToBase64(args.audioBlob),
      }),
    },
    START_TIMEOUT
  );

  const jobId = started.job_id;
  const deadline = Date.now() + MAX_RENDER_MS;
  let lastStage = "";

  for (;;) {
    if (Date.now() > deadline) {
      throw new VideoBackendError(
        "Rendering took too long. Try a shorter clip, or use Wav2Lip.",
        "api"
      );
    }
    await sleep(POLL_INTERVAL);

    const job = await call<{
      status: "queued" | "processing" | "done" | "failed";
      stage?: string;
      error?: string;
      gen_seconds?: number;
    }>(url, `/job/${jobId}`, { method: "GET" }, POLL_TIMEOUT);

    if (job.stage && job.stage !== lastStage) {
      lastStage = job.stage;
      onProgress?.(job.stage);
    }
    if (job.status === "failed") {
      throw new VideoBackendError(job.error ?? "Rendering failed", "api");
    }
    if (job.status === "done") break;
  }

  onProgress?.("Downloading video…");
  const result = await call<{ video_b64: string; duration?: number; gen_seconds?: number }>(
    url,
    `/job/${jobId}/video`,
    { method: "GET" },
    RESULT_TIMEOUT
  );

  // Best-effort cleanup of the job's scratch dir on the GPU box.
  void fetch(`${url}/job/${jobId}`, { method: "DELETE" }).catch(() => {});

  return {
    videoBlob: base64ToBlob(result.video_b64, "video/mp4"),
    durationSec: result.duration ?? started.duration ?? 0,
    genSeconds: result.gen_seconds ?? 0,
  };
}
