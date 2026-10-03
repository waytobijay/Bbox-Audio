/**
 * TTS jobs — the asynchronous path used by the public API.
 *
 * Why jobs at all: a Vercel function is capped at 60 seconds and a Modal cold
 * start alone can take most of a minute, so no API request may wait for a
 * render. The client gets a job id immediately and either polls or is called
 * back.
 *
 * Lifecycle:
 *   queued  -> dispatched to a backend
 *   running -> the GPU is rendering
 *   done    -> audio collected into Blob, audio_url set
 *   error   -> something failed; `error` says what, in words
 *
 * Completion is driven by the backend's callback, but never *depends* on it:
 * a poll of a stale running job reconciles against the backend directly. A
 * dropped callback therefore costs a delay, not the render.
 */

import type { BackendProvider } from "@/lib/types";
import { backendHeaders, resolveBackend } from "./backends";
import { syncVoiceToBackend } from "./gateway";
import { deleteBlob, putBlob } from "./blob";
import { kvDel, kvGet, kvSet } from "./redis";
import { getVoice } from "./voices";
import { getSettings } from "./redis";

const KEY = (id: string) => `vf:job:${id}`;
const INDEX = "vf:jobs";
/** Keep the recent-jobs list bounded — it's an admin view, not an archive. */
const INDEX_LIMIT = 200;

export type JobStatus = "queued" | "running" | "done" | "error";
export type JobMode = "stitch" | "items";

export interface JobItem {
  index: number;
  duration: number;
  audioUrl?: string;
  bytes?: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  mode: JobMode;
  format: "mp3" | "wav";
  voiceId: string;
  /** Which API key created it, or "studio". Used for the admin Jobs list. */
  source: string;
  chars: number;
  chunks: number;
  createdAt: number;
  updatedAt: number;
  backend?: BackendProvider;
  backendUrl?: string;
  duration?: number;
  genSeconds?: number;
  audioUrl?: string;
  items?: JobItem[];
  error?: string;
  /** Where to POST the finished job, if the caller asked for a callback. */
  callbackUrl?: string;
  /** Set once we've delivered the callback, so a retry can't double-fire. */
  callbackSentAt?: number;
}

export async function getJob(id: string): Promise<Job | null> {
  return kvGet<Job>(KEY(id));
}

export async function saveJob(job: Job): Promise<Job> {
  const next = { ...job, updatedAt: Date.now() };
  await kvSet(KEY(job.id), next);
  return next;
}

export async function listJobs(limit = 50): Promise<Job[]> {
  const ids = ((await kvGet<string[]>(INDEX)) ?? []).slice(0, limit);
  const rows = await Promise.all(ids.map((id) => kvGet<Job>(KEY(id))));
  return rows.filter((r): r is Job => Boolean(r));
}

async function indexJob(id: string): Promise<void> {
  const ids = (await kvGet<string[]>(INDEX)) ?? [];
  await kvSet(INDEX, [id, ...ids.filter((x) => x !== id)].slice(0, INDEX_LIMIT));
}

export async function deleteJob(id: string): Promise<void> {
  const job = await getJob(id);
  for (const url of [job?.audioUrl, ...(job?.items ?? []).map((i) => i.audioUrl)]) {
    if (url) await deleteBlob(url);
  }
  await kvDel(KEY(id));
  await kvSet(INDEX, ((await kvGet<string[]>(INDEX)) ?? []).filter((x) => x !== id));
}

// --- callback auth --------------------------------------------------------

/**
 * The token a backend presents when calling us back. Derived from the job id
 * and BACKEND_SECRET, so it needs no storage and is useless for any other job.
 */
export async function callbackToken(jobId: string): Promise<string> {
  const secret = process.env.BACKEND_SECRET ?? "";
  const bytes = new TextEncoder().encode(`${jobId}:${secret}`);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isValidCallbackToken(
  jobId: string,
  presented: string | null
): Promise<boolean> {
  if (!presented) return false;
  const expected = await callbackToken(jobId);
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

// --- dispatch -------------------------------------------------------------

export interface CreateJobInput {
  chunks: string[];
  paragraphBreaks: boolean[];
  voiceId: string;
  mode: JobMode;
  format: "mp3" | "wav";
  source: string;
  callbackUrl?: string;
  params: Record<string, unknown>;
}

export class JobError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Make sure the chosen backend actually holds this voice before we hand it a
 * job.
 *
 * The one-chunk path can recover from a cold backend by reacting to a 409 and
 * retrying, but a job renders in a background worker where there is nothing to
 * retry into — an unknown voice just fails the whole render with
 * "voice_not_cached". So the sync happens up front, here.
 *
 * /health lists what's already cached, so a warm backend costs one cheap GET
 * rather than re-uploading the clip on every job.
 */
async function ensureVoiceCached(backendUrl: string, voiceId: string): Promise<void> {
  const voice = await getVoice(voiceId);
  if (!voice) {
    throw new JobError(`No voice with id "${voiceId}".`, 404, "unknown_voice");
  }

  let cached: string[] = [];
  try {
    const res = await fetch(`${backendUrl}/health`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      cached = ((await res.json()) as { voices_cached?: string[] }).voices_cached ?? [];
    }
  } catch {
    // Couldn't ask — fall through and push the voice anyway. Caching twice is
    // harmless; dispatching a job for a voice the GPU lacks is not.
  }

  if (cached.includes(voiceId)) return;

  try {
    await syncVoiceToBackend(backendUrl, voice);
  } catch (e) {
    throw new JobError(
      `Couldn't send the voice to the backend: ${e instanceof Error ? e.message : "unknown error"}`,
      502,
      "voice_sync_failed"
    );
  }
}

/**
 * Create the job, then hand it to a backend.
 *
 * The record is written BEFORE dispatch on purpose: if the backend call fails
 * we still have a job to report the error against, rather than a request that
 * vanished.
 */
export async function createAndDispatchJob(
  input: CreateJobInput,
  appUrl: string
): Promise<Job> {
  const backend = await resolveBackend();
  if (!backend) {
    throw new JobError(
      "No GPU backend is online. Start a notebook, or pick another backend in Admin → Backends.",
      503,
      "no_backend"
    );
  }

  // Before anything is written down: a job for a voice the GPU doesn't have
  // would fail in the worker with no way to recover.
  await ensureVoiceCached(backend.url, input.voiceId);

  const id = crypto.randomUUID();
  const now = Date.now();
  let job: Job = {
    id,
    status: "queued",
    mode: input.mode,
    format: input.format,
    voiceId: input.voiceId,
    source: input.source,
    chars: input.chunks.reduce((n, c) => n + c.length, 0),
    chunks: input.chunks.length,
    createdAt: now,
    updatedAt: now,
    backend: backend.provider,
    backendUrl: backend.url,
    callbackUrl: input.callbackUrl,
  };
  await saveJob(job);
  await indexJob(id);

  const body = {
    job_id: id,
    voice_id: input.voiceId,
    chunks: input.chunks,
    paragraph_breaks: input.paragraphBreaks,
    params: input.params,
    format: input.format,
    mode: input.mode,
    callback_url: `${appUrl.replace(/\/+$/, "")}/api/internal/jobs/${id}/complete`,
    callback_token: await callbackToken(id),
  };

  try {
    const res = await fetch(`${backend.url}/jobs`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`backend returned ${res.status} ${detail.slice(0, 200)}`);
    }
  } catch (e) {
    job = await saveJob({
      ...job,
      status: "error",
      error: e instanceof Error ? e.message : "could not reach the backend",
    });
    throw new JobError(
      `Couldn't start the render on ${backend.provider}: ${job.error}`,
      502,
      "dispatch_failed"
    );
  }

  return saveJob({ ...job, status: "running" });
}

// --- collection -----------------------------------------------------------

interface BackendItem {
  index: number;
  duration: number;
  bytes?: number;
}

export interface BackendResult {
  status: string;
  mode?: JobMode;
  format?: "mp3" | "wav";
  duration?: number;
  gen_seconds?: number;
  items?: BackendItem[];
  error?: string;
}

/**
 * Pull every rendered file off the backend and into Blob.
 *
 * This is the step that keeps audio out of request bodies: we GET each file
 * (a response, so no 4.5 MB cap) and stream it straight to storage.
 */
export async function collectJob(job: Job, result: BackendResult): Promise<Job> {
  if (result.status === "error") {
    return saveJob({ ...job, status: "error", error: result.error ?? "render failed" });
  }
  if (!job.backendUrl) {
    return saveJob({ ...job, status: "error", error: "job has no backend to collect from" });
  }

  const format = result.format ?? job.format;
  const contentType = format === "mp3" ? "audio/mpeg" : "audio/wav";
  const backendItems = result.items ?? [];
  const items: JobItem[] = [];

  for (const item of backendItems) {
    const res = await fetch(`${job.backendUrl}/jobs/${job.id}/audio/${item.index}`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(50_000),
    });
    if (!res.ok) {
      return saveJob({
        ...job,
        status: "error",
        error: `couldn't collect item ${item.index} (${res.status})`,
      });
    }
    const bytes = await res.arrayBuffer();
    const suffix = backendItems.length > 1 ? `-${item.index}` : "";
    const blob = await putBlob(`jobs/${job.id}${suffix}.${format}`, bytes, contentType);
    items.push({
      index: item.index,
      duration: item.duration,
      bytes: bytes.byteLength,
      audioUrl: blob.url,
    });
  }

  // The backend can drop its copy now that we hold everything.
  void fetch(`${job.backendUrl}/jobs/${job.id}`, {
    method: "DELETE",
    headers: backendHeaders(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});

  return saveJob({
    ...job,
    status: "done",
    format,
    duration: result.duration,
    genSeconds: result.gen_seconds,
    items,
    // A stitched job has exactly one file; expose it directly so the common
    // case is `audio_url` and callers never index into a list of one.
    audioUrl: job.mode === "stitch" ? items[0]?.audioUrl : undefined,
  });
}

/**
 * Ask the backend how a job is doing, and finish it if it's ready.
 *
 * This is the safety net for a lost callback — a tunnel that died between the
 * render finishing and the POST arriving would otherwise strand the job as
 * "running" forever.
 */
export async function reconcileJob(job: Job): Promise<Job> {
  if (job.status === "done" || job.status === "error" || !job.backendUrl) return job;

  let result: BackendResult;
  try {
    const res = await fetch(`${job.backendUrl}/jobs/${job.id}`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      // The backend forgot it — a restarted Colab. Nothing is coming.
      return saveJob({
        ...job,
        status: "error",
        error: "the backend restarted before this job finished",
      });
    }
    if (!res.ok) return job;
    result = (await res.json()) as BackendResult;
  } catch {
    return job; // transient; the next poll tries again
  }

  if (result.status === "done") return collectJob(job, result);
  if (result.status === "error") {
    return saveJob({ ...job, status: "error", error: result.error ?? "render failed" });
  }
  return job;
}

// --- retention ------------------------------------------------------------

/** Jobs older than the retention window, oldest first. */
export async function expiredJobs(now = Date.now()): Promise<Job[]> {
  const { retentionDays } = await getSettings();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return (await listJobs(INDEX_LIMIT)).filter((j) => j.createdAt < cutoff);
}

export async function purgeExpiredJobs(): Promise<number> {
  const expired = await expiredJobs();
  for (const job of expired) await deleteJob(job.id);
  return expired.length;
}
