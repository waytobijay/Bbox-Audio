import type { GenParams, ModelId } from "./types";

/** Narration language sent to Qwen3. Chatterbox is English-only. */
export const LANGUAGE = "English";

/**
 * Hard ceiling per chunk. Load-bearing: both models drift, rush, and
 * hallucinate words on long inputs. 1–3 sentences per pass is the sweet spot.
 */
export const MAX_CHARS = 240;

/** Chunks under this get merged into a neighbour — tiny chunks sound clipped. */
export const MIN_CHARS = 20;

/** Stitch gaps (seconds). Tuned — don't casually change. */
export const SENTENCE_GAP_SEC = 0.35;
export const PARAGRAPH_GAP_SEC = 0.7;

/** Export peak-normalization target. */
export const NORMALIZE_PEAK_DBFS = -1;

/** Spoken-minutes estimate for the script stats. */
export const WORDS_PER_MINUTE = 150;

/** Rough speaking rate used to size pending bars in the queue rail. */
export const EST_CHARS_PER_SEC = 15;

/** Health poll interval while connected / generating. */
export const HEALTH_POLL_MS = 30_000;

/** 1 initial try + 2 automatic retries with fresh seeds. */
export const MAX_ATTEMPTS = 3;

/** Reference sample guidance (seconds). */
export const SAMPLE_MIN_SEC = 8;
export const SAMPLE_IDEAL_MIN_SEC = 15;
export const SAMPLE_IDEAL_MAX_SEC = 20;

export const DEFAULT_PARAMS: GenParams = {
  seed: 4242,
  speed: 1.0,
  // Chatterbox defaults tuned for factual narration — don't casually change.
  exaggeration: 0.4,
  cfg: 0.5,
  temperature: 0.7,
  stylePrompt: "Calm, clear, informative narration",
};

export const MODEL_INFO: Record<ModelId, { name: string; blurb: string }> = {
  chatterbox: {
    name: "Chatterbox",
    blurb: "Faster, consistent, no tuning. Best default for narration.",
  },
  qwen3: {
    name: "Qwen3-TTS 1.7B",
    blurb: "Higher fidelity, slower, more sensitive to the reference clip.",
  },
};

export const COLAB_NOTEBOOK_PATH = "colab/voiceforge_server.ipynb";
