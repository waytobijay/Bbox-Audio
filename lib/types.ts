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
