export type ModelId = "chatterbox" | "qwen3";

export interface Voice {
  id: string;
  name: string;
  createdAt: number;
  sampleBlob: Blob; // reference audio, 10–20s, trimmed WAV
  sampleMime: string;
  transcript: string; // exact transcript of sampleBlob — required for Qwen3
  durationSec: number;
  /**
   * The voice_id currently cached on the backend. Colab sessions are
   * ephemeral — when the runtime restarts this goes stale and the app
   * silently re-clones from sampleBlob.
   */
  remoteId?: string;
}

export type ChunkStatus = "pending" | "generating" | "done" | "failed";

export interface Chunk {
  id: string;
  index: number;
  text: string;
  charCount: number;
  status: ChunkStatus;
  seed: number;
  audioBlob?: Blob;
  durationSec?: number;
  sampleRate?: number;
  error?: string;
  attempts: number;
  /** True when this chunk closes a paragraph — the stitcher uses the longer gap. */
  isParagraphEnd: boolean;
}

/** What the chunker emits before chunks are materialized for generation. */
export interface ChunkDraft {
  text: string;
  charCount: number;
  isParagraphEnd: boolean;
}

export interface Project {
  id: string;
  name: string;
  voiceId: string;
  model: ModelId;
  params: GenParams;
  scriptRaw: string;
  chunks: Chunk[];
  updatedAt: number;
}

export interface GenParams {
  // shared
  seed: number; // base seed; chunk seed = seed + chunk.index
  speed: number; // 0.8–1.2, default 1.0 (reserved — backend doesn't apply it yet)
  /** ISO 639-1 code sent to the backend (Chatterbox Multilingual language_id). */
  language: string;
  // chatterbox
  exaggeration: number; // 0.25–2.0, default 0.4 for narration
  cfg: number; // 0.2–1.0, default 0.5
  temperature: number; // 0.5–1.0, default 0.7
  // qwen3
  stylePrompt: string; // e.g. "Calm, clear, informative narration"
}

export type ConnectionMode = "direct" | "proxy";

export interface BackendStatus {
  connected: boolean;
  url: string;
  gpu?: string;
  modelsLoaded: ModelId[];
  latencyMs?: number;
  mode?: ConnectionMode;
  /** voice_ids currently cached on the backend (from /health). */
  remoteVoices?: string[];
}

export interface GenerateResult {
  audioBlob: Blob;
  sampleRate: number;
  durationSec: number;
  genSeconds: number;
}

// ---------------------------------------------------------------------------
// Talking-head video (separate backend — see colab/voiceforge_video.ipynb)
// ---------------------------------------------------------------------------

/**
 * sadtalker — lip sync + blinking + head motion + expressions. Rich but slow;
 *   realistic only for short clips on a free T4.
 * wav2lip   — mouth-only lip sync on a static photo. Fast enough for long
 *   narration, but no blinking/head movement.
 */
export type VideoEngine = "sadtalker" | "wav2lip";

export type VideoStatus =
  | "idle"
  | "uploading"
  | "processing"
  | "done"
  | "failed";

export interface VideoBackendStatus {
  connected: boolean;
  url: string;
  gpu?: string;
  enginesLoaded: VideoEngine[];
  latencyMs?: number;
}

export interface VideoJob {
  status: VideoStatus;
  engine: VideoEngine;
  progress: string; // real stage text reported by the backend
  /** 0–100 parsed from the engine's own output; undefined until it reports. */
  percent?: number;
  elapsedSec: number;
  videoBlob?: Blob;
  durationSec?: number;
  error?: string;
}

/**
 * How SadTalker frames the result.
 * crop — cut to the face. Sharpest mouth detail, much faster. Best default,
 *   especially when the face is small in a wide photo.
 * full — keep the whole photo. The generated face is scaled back into frame,
 *   so a small face loses detail and can smear around the lips.
 */
export type VideoFraming = "crop" | "full";

export interface AnimateResult {
  videoBlob: Blob;
  durationSec: number;
  genSeconds: number;
}

// ---------------------------------------------------------------------------
// GPU backend registry (platform v2)
// ---------------------------------------------------------------------------

export type BackendProvider = "modal" | "colab" | "kaggle" | "custom";

export const BACKEND_PROVIDERS: BackendProvider[] = ["modal", "colab", "kaggle", "custom"];

/** "auto" picks the first enabled+online backend by priority. */
export type ActiveBackend = "auto" | BackendProvider;

export type BackendHealthKind = "online" | "busy" | "offline" | "disabled";

/** What a backend sends when it registers itself / heartbeats. */
export interface BackendRegistration {
  provider: BackendProvider;
  url: string;
  gpu?: string;
  models?: string[];
  version?: string;
}

/** A row in the registry, as stored. */
export interface RegisteredBackend extends BackendRegistration {
  models: string[];
  registeredAt: number;
  lastHeartbeat: number;
  enabled: boolean;
  /** Lower wins when the active selection is "auto". */
  priority: number;
  /**
   * True when a notebook registered itself and keeps heartbeating. False for
   * a URL typed into the admin panel (Modal, custom), which has no heartbeat
   * and must NOT be aged out — see computeHealth.
   */
  selfRegistered?: boolean;
  busy?: boolean;
  voicesCached?: string[];
  /** Summed from job gen_seconds — used for the Modal free-credit gauge. */
  gpuSecondsMonth?: number;
  jobsToday?: number;
  lastError?: string;
}

/** Registry row plus the status computed at read time. */
export interface BackendView extends RegisteredBackend {
  health: BackendHealthKind;
  secondsSinceHeartbeat: number;
}

// ---------------------------------------------------------------------------
// Central voice library (platform v2)
// ---------------------------------------------------------------------------

/**
 * A voice that lives on the server, not in one browser.
 *
 * The reference clip sits in Vercel Blob at a public URL; backends download it
 * themselves the first time they're asked to use the voice. That's what makes
 * "clone once, works everywhere" true — a Colab restart loses its local cache,
 * not the voice.
 */
export interface LibraryVoice {
  id: string;
  name: string;
  /** ISO 639-1, passed through to Chatterbox as language_id. */
  language: string;
  /** Exact words spoken in the clip. Required by Qwen3, helps Chatterbox. */
  transcript: string;
  /** Public Blob URL of the reference clip (always 16-bit PCM WAV). */
  audioUrl: string;
  durationSec: number;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
}

/** Library row plus whether it's the default pick. */
export interface LibraryVoiceView extends LibraryVoice {
  isDefault: boolean;
}
