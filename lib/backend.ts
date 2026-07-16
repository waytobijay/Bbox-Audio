/**
 * Typed client for the Colab API.
 *
 * Strategy: try the tunnel URL directly (faster, no Vercel bandwidth).
 * If the direct call fails on CORS / mixed-content / network, silently fall
 * back to /api/proxy and remember the choice per URL for this session.
 */

import { base64ToBlob, blobToBase64 } from "./audio";
import type { ConnectionMode, GenerateResult, ModelId } from "./types";

export class BackendError extends Error {
  kind: "network" | "api";
  status?: number;

  constructor(message: string, kind: "network" | "api", status?: number) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    this.status = status;
  }
}

export interface HealthInfo {
  gpu: string;
  models: ModelId[];
  voices: string[];
  latencyMs: number;
  mode: ConnectionMode;
}

export interface GeneratePayload {
  text: string;
  voice_id: string;
  model: ModelId;
  seed: number;
  /** ISO 639-1 code — Chatterbox Multilingual language_id. */
  language?: string;
  exaggeration?: number;
  cfg?: number;
  temperature?: number;
  style_prompt?: string;
}

const TIMEOUTS = { health: 15_000, clone: 60_000, generate: 240_000 };

/** Per-URL mode memory for the session — direct until proven otherwise. */
const modeCache = new Map<string, ConnectionMode>();

export function normalizeBackendUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export function getConnectionMode(url: string): ConnectionMode {
  return modeCache.get(url) ?? "direct";
}

interface CallOptions {
  method: "GET" | "POST";
  json?: unknown;
  /** multipart clone payload — sent as FormData direct, base64 via proxy */
  form?: { audioBlob: Blob; transcript: string };
  timeoutMs: number;
}

async function directCall(baseUrl: string, path: string, opts: CallOptions): Promise<Response> {
  const init: RequestInit = { method: opts.method };
  if (opts.form) {
    const fd = new FormData();
    fd.append("audio", opts.form.audioBlob, "sample.wav");
    fd.append("transcript", opts.form.transcript);
    init.body = fd;
  } else if (opts.json !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
}

async function proxyCall(baseUrl: string, path: string, opts: CallOptions): Promise<Response> {
  const body: Record<string, unknown> = {
    backendUrl: baseUrl,
    path,
    method: opts.method,
  };
  if (opts.form) {
    body.audioB64 = await blobToBase64(opts.form.audioBlob);
    body.audioMime = opts.form.audioBlob.type || "audio/wav";
    body.transcript = opts.form.transcript;
  } else if (opts.json !== undefined) {
    body.body = opts.json;
  }
  return fetch("/api/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
}

async function call<T>(baseUrl: string, path: string, opts: CallOptions): Promise<T> {
  const url = normalizeBackendUrl(baseUrl);
  if (!url) throw new BackendError("No backend URL", "network");

  let response: Response | null = null;

  if (modeCache.get(url) !== "proxy") {
    try {
      response = await directCall(url, path, opts);
      modeCache.set(url, "direct");
    } catch {
      // CORS / mixed-content / network — fall through to the proxy
      response = null;
    }
  }

  if (!response) {
    try {
      response = await proxyCall(url, path, opts);
      modeCache.set(url, "proxy");
    } catch (e) {
      modeCache.delete(url);
      throw new BackendError(
        e instanceof Error ? e.message : "Backend unreachable",
        "network"
      );
    }
  }

  // Proxy answers 502 when it can't reach the tunnel — that's a network
  // problem (Colab closed / URL expired), not an API error.
  if (response.status === 502 || response.status === 504) {
    modeCache.delete(url);
    throw new BackendError("Backend unreachable", "network", response.status);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new BackendError("Backend returned a non-JSON response", "api", response.status);
  }

  if (!response.ok) {
    const message =
      (data as { error?: string; detail?: string })?.error ??
      (data as { detail?: string })?.detail ??
      `Backend error ${response.status}`;
    throw new BackendError(message, "api", response.status);
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export async function checkHealth(baseUrl: string): Promise<HealthInfo> {
  const t0 = performance.now();
  const data = await call<{ ok: boolean; gpu: string; models: string[]; voices: string[] }>(
    baseUrl,
    "/health",
    { method: "GET", timeoutMs: TIMEOUTS.health }
  );
  return {
    gpu: data.gpu,
    models: (data.models ?? []) as ModelId[],
    voices: data.voices ?? [],
    latencyMs: Math.round(performance.now() - t0),
    mode: getConnectionMode(normalizeBackendUrl(baseUrl)),
  };
}

export async function cloneVoice(
  baseUrl: string,
  audioBlob: Blob,
  transcript: string
): Promise<{ voice_id: string; duration: number }> {
  return call(baseUrl, "/clone", {
    method: "POST",
    form: { audioBlob, transcript },
    timeoutMs: TIMEOUTS.clone,
  });
}

export async function generateChunk(
  baseUrl: string,
  payload: GeneratePayload
): Promise<GenerateResult> {
  const data = await call<{
    audio_b64: string;
    sample_rate: number;
    duration: number;
    gen_seconds: number;
  }>(baseUrl, "/generate", {
    method: "POST",
    json: payload,
    timeoutMs: TIMEOUTS.generate,
  });
  return {
    audioBlob: base64ToBlob(data.audio_b64, "audio/wav"),
    sampleRate: data.sample_rate,
    durationSec: data.duration,
    genSeconds: data.gen_seconds,
  };
}
