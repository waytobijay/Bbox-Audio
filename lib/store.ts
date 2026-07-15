/**
 * App state (Zustand) + the sequential generation queue.
 *
 * Invariants:
 * - Generation is SEQUENTIAL — one /generate in flight, ever. One GPU.
 * - Every completed chunk is written to IndexedDB the moment it returns.
 * - A network failure pauses the queue and keeps everything already done.
 */

import { create } from "zustand";
import {
  BackendError,
  checkHealth,
  cloneVoice,
  generateChunk,
  normalizeBackendUrl,
  type GeneratePayload,
} from "./backend";
import { chunkScript } from "./chunker";
import { DEFAULT_PARAMS, MAX_ATTEMPTS } from "./config";
import * as db from "./db";
import { toast } from "./toast";
import type {
  BackendStatus,
  Chunk,
  ChunkDraft,
  GenParams,
  ModelId,
  Project,
  Voice,
} from "./types";

const LS_BACKEND_URL = "voiceforge:backendUrl";

export interface QueueState {
  running: boolean;
  paused: boolean;
  /** Backend went away mid-run — show the "nothing is lost" banner. */
  offline: boolean;
  currentChunkId: string | null;
  /** Rolling average seconds per generated chunk, for the ETA. */
  avgGenSec: number;
}

interface AppState {
  hydrated: boolean;
  backendUrl: string;
  backend: BackendStatus;
  connecting: boolean;
  voices: Voice[];
  activeVoiceId: string | null;
  project: Project;
  queue: QueueState;
  /** For the ARIA live region — announces chunk completion. */
  announcement: string;

  hydrate(): Promise<void>;
  setBackendUrl(url: string): void;
  connect(opts?: { silent?: boolean }): Promise<boolean>;
  addVoice(voice: Voice): Promise<void>;
  removeVoice(id: string): Promise<void>;
  setActiveVoice(id: string | null): void;
  setScript(raw: string): void;
  setModel(model: ModelId): void;
  setParams(patch: Partial<GenParams>): void;
  startGeneration(mode: "all" | "remaining"): Promise<void>;
  pauseGeneration(): void;
  resumeGeneration(): void;
  stopGeneration(): void;
  regenerateChunk(id: string, newText?: string): Promise<void>;
  /** One-off generation outside the queue, for A/B compare. */
  generateOnce(text: string, model: ModelId, seed: number): Promise<{
    blob: Blob;
    durationSec: number;
    genSeconds: number;
  }>;
}

function createDefaultProject(): Project {
  return {
    id: crypto.randomUUID(),
    name: "Untitled session",
    voiceId: "",
    model: "chatterbox",
    params: { ...DEFAULT_PARAMS },
    scriptRaw: "",
    chunks: [],
    updatedAt: Date.now(),
  };
}

function newChunk(draft: ChunkDraft, index: number, baseSeed: number): Chunk {
  return {
    id: crypto.randomUUID(),
    index,
    text: draft.text,
    charCount: draft.charCount,
    status: "pending",
    seed: baseSeed + index,
    attempts: 0,
    isParagraphEnd: draft.isParagraphEnd,
  };
}

/**
 * Rebuild the chunk list from fresh drafts, keeping status + audio for any
 * chunk whose text is unchanged so an edit never throws away finished work.
 */
function reconcileChunks(drafts: ChunkDraft[], old: Chunk[], baseSeed: number): Chunk[] {
  const pool = new Map<string, Chunk[]>();
  for (const c of old) {
    const list = pool.get(c.text) ?? [];
    list.push(c);
    pool.set(c.text, list);
  }
  return drafts.map((d, i) => {
    const match = pool.get(d.text)?.shift();
    if (match) {
      return { ...match, index: i, charCount: d.charCount, isParagraphEnd: d.isParagraphEnd };
    }
    return newChunk(d, i, baseSeed);
  });
}

function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Monotonic token — bumping it makes any in-flight queue loop stand down. */
let runToken = 0;

export const useApp = create<AppState>((set, get) => {
  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void db.putProject({ ...get().project, updatedAt: Date.now() });
    }, 400);
  };

  const updateChunk = (id: string, patch: Partial<Chunk>) => {
    set((s) => ({
      project: {
        ...s.project,
        chunks: s.project.chunks.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      },
    }));
    schedulePersist();
  };

  const setQueue = (patch: Partial<QueueState>) =>
    set((s) => ({ queue: { ...s.queue, ...patch } }));

  const ensureRemoteVoice = async (voiceId: string): Promise<string> => {
    const voice = get().voices.find((v) => v.id === voiceId);
    if (!voice) throw new BackendError("No voice selected", "api");
    if (voice.remoteId) return voice.remoteId;
    const res = await cloneVoice(get().backendUrl, voice.sampleBlob, voice.transcript);
    const updated = { ...voice, remoteId: res.voice_id };
    set((s) => ({ voices: s.voices.map((v) => (v.id === voiceId ? updated : v)) }));
    await db.putVoice(updated);
    return res.voice_id;
  };

  const clearRemoteVoice = async (voiceId: string) => {
    const voice = get().voices.find((v) => v.id === voiceId);
    if (!voice) return;
    const updated = { ...voice, remoteId: undefined };
    set((s) => ({ voices: s.voices.map((v) => (v.id === voiceId ? updated : v)) }));
    await db.putVoice(updated);
  };

  const buildPayload = (chunk: Chunk, remoteVoiceId: string): GeneratePayload => {
    const { model, params } = get().project;
    return {
      text: chunk.text,
      voice_id: remoteVoiceId,
      model,
      seed: chunk.seed,
      exaggeration: params.exaggeration,
      cfg: params.cfg,
      temperature: params.temperature,
      style_prompt: params.stylePrompt,
    };
  };

  /**
   * The queue. Picks pending chunks one at a time (optionally restricted to
   * `only`), generates, saves. Retries live here too: a failed chunk goes
   * back to pending with a fresh seed until MAX_ATTEMPTS, then is marked
   * failed and the queue moves on.
   */
  const runQueue = async (only: Set<string> | null) => {
    const token = ++runToken;
    setQueue({ running: true, paused: false, offline: false });
    let recloneAttempts = 0;

    while (runToken === token) {
      if (get().queue.paused) {
        await sleep(300);
        continue;
      }
      const chunk = get().project.chunks.find(
        (c) => c.status === "pending" && (!only || only.has(c.id))
      );
      if (!chunk) break;

      updateChunk(chunk.id, { status: "generating" });
      setQueue({ currentChunkId: chunk.id });

      try {
        const remoteId = await ensureRemoteVoice(get().project.voiceId);
        const t0 = performance.now();
        const result = await generateChunk(get().backendUrl, buildPayload(chunk, remoteId));
        const wallSec = (performance.now() - t0) / 1000;

        // Save first — IndexedDB before UI, so a crash can't lose the chunk.
        await db.saveChunkAudio(
          get().project.id,
          chunk.id,
          result.audioBlob,
          result.durationSec,
          result.sampleRate
        );
        updateChunk(chunk.id, {
          status: "done",
          audioBlob: result.audioBlob,
          durationSec: result.durationSec,
          sampleRate: result.sampleRate,
          error: undefined,
        });
        set((s) => ({
          queue: {
            ...s.queue,
            avgGenSec: s.queue.avgGenSec
              ? s.queue.avgGenSec * 0.7 + wallSec * 0.3
              : wallSec,
          },
          announcement: `Chunk ${chunk.index + 1} of ${s.project.chunks.length} finished`,
        }));
      } catch (e) {
        if (runToken !== token) break;
        const err = e instanceof BackendError ? e : new BackendError(String(e), "api");

        if (err.kind === "network") {
          // Colab went away. Pause everything, lose nothing.
          updateChunk(chunk.id, { status: "pending" });
          const doneCount = get().project.chunks.filter((c) => c.status === "done").length;
          setQueue({ running: false, currentChunkId: null, offline: true });
          set((s) => ({ backend: { ...s.backend, connected: false } }));
          set({
            announcement: `Backend went offline. ${doneCount} chunks are saved.`,
          });
          return;
        }

        if (/unknown voice_id/i.test(err.message) && recloneAttempts < 2) {
          // Colab restarted since we cloned — re-clone silently and retry.
          recloneAttempts++;
          await clearRemoteVoice(get().project.voiceId);
          updateChunk(chunk.id, { status: "pending" });
          continue;
        }

        const attempts = chunk.attempts + 1;
        if (attempts < MAX_ATTEMPTS) {
          updateChunk(chunk.id, {
            status: "pending",
            attempts,
            seed: randomSeed(),
            error: err.message,
          });
        } else {
          updateChunk(chunk.id, { status: "failed", attempts, error: err.message });
          toast(`Chunk ${chunk.index + 1} failed: ${err.message}`, "error");
        }
      }
    }

    if (runToken === token) {
      setQueue({ running: false, paused: false, currentChunkId: null });
    }
  };

  // -------------------------------------------------------------------------
  // store
  // -------------------------------------------------------------------------

  return {
    hydrated: false,
    backendUrl: "",
    backend: { connected: false, url: "", modelsLoaded: [] },
    connecting: false,
    voices: [],
    activeVoiceId: null,
    project: createDefaultProject(),
    queue: {
      running: false,
      paused: false,
      offline: false,
      currentChunkId: null,
      avgGenSec: 0,
    },
    announcement: "",

    async hydrate() {
      const voices = await db.getAllVoices();
      let project = await db.getFirstProject();
      if (!project) {
        project = createDefaultProject();
      } else {
        const audio = await db.loadAllChunkAudio(project.id);
        project = {
          ...project,
          chunks: project.chunks.map((c) => {
            const stored = audio.get(c.id);
            if (c.status === "done" && stored) {
              return {
                ...c,
                audioBlob: stored.blob,
                durationSec: stored.durationSec,
                sampleRate: stored.sampleRate,
              };
            }
            if (c.status === "done" || c.status === "generating") {
              return { ...c, status: "pending" as const, audioBlob: undefined };
            }
            return c;
          }),
        };
      }
      const backendUrl =
        typeof window !== "undefined" ? localStorage.getItem(LS_BACKEND_URL) ?? "" : "";
      const activeVoiceId =
        voices.find((v) => v.id === project!.voiceId)?.id ?? voices[0]?.id ?? null;
      set({
        hydrated: true,
        voices,
        project: { ...project, voiceId: activeVoiceId ?? "" },
        activeVoiceId,
        backendUrl,
      });
      if (backendUrl) void get().connect({ silent: true });
    },

    setBackendUrl(url: string) {
      set({ backendUrl: url });
      if (typeof window !== "undefined") localStorage.setItem(LS_BACKEND_URL, url.trim());
    },

    async connect(opts) {
      const url = normalizeBackendUrl(get().backendUrl);
      if (!url) return false;
      set({ connecting: true });
      try {
        const health = await checkHealth(url);
        const remote = new Set(health.voices);
        // drop remoteIds the (possibly restarted) backend no longer knows
        const voices = get().voices.map((v) =>
          v.remoteId && !remote.has(v.remoteId) ? { ...v, remoteId: undefined } : v
        );
        for (const v of voices) {
          const before = get().voices.find((x) => x.id === v.id);
          if (before && before.remoteId !== v.remoteId) void db.putVoice(v);
        }
        set({
          connecting: false,
          voices,
          backend: {
            connected: true,
            url,
            gpu: health.gpu,
            modelsLoaded: health.models,
            latencyMs: health.latencyMs,
            mode: health.mode,
            remoteVoices: health.voices,
          },
        });
        return true;
      } catch {
        set((s) => ({
          connecting: false,
          backend: { ...s.backend, url, connected: false },
        }));
        if (!opts?.silent) {
          toast("Couldn't reach the backend. Is the Colab tab still open?", "error");
        }
        return false;
      }
    },

    async addVoice(voice: Voice) {
      await db.putVoice(voice);
      set((s) => ({
        voices: [voice, ...s.voices],
        activeVoiceId: voice.id,
        project: { ...s.project, voiceId: voice.id },
      }));
      schedulePersist();
    },

    async removeVoice(id: string) {
      await db.deleteVoice(id);
      set((s) => {
        const voices = s.voices.filter((v) => v.id !== id);
        const activeVoiceId = s.activeVoiceId === id ? voices[0]?.id ?? null : s.activeVoiceId;
        return {
          voices,
          activeVoiceId,
          project: { ...s.project, voiceId: activeVoiceId ?? "" },
        };
      });
      schedulePersist();
    },

    setActiveVoice(id: string | null) {
      set((s) => ({ activeVoiceId: id, project: { ...s.project, voiceId: id ?? "" } }));
      schedulePersist();
    },

    setScript(raw: string) {
      if (get().queue.running) return; // editor is locked during a run
      const drafts = chunkScript(raw);
      set((s) => {
        const chunks = reconcileChunks(drafts, s.project.chunks, s.project.params.seed);
        // clean up stored audio for chunks that no longer exist
        const keep = new Set(chunks.map((c) => c.id));
        for (const old of s.project.chunks) {
          if (!keep.has(old.id) && old.status === "done") {
            void db.deleteChunkAudio(s.project.id, old.id);
          }
        }
        return { project: { ...s.project, scriptRaw: raw, chunks } };
      });
      schedulePersist();
    },

    setModel(model: ModelId) {
      set((s) => ({ project: { ...s.project, model } }));
      schedulePersist();
    },

    setParams(patch: Partial<GenParams>) {
      set((s) => ({ project: { ...s.project, params: { ...s.project.params, ...patch } } }));
      schedulePersist();
    },

    async startGeneration(mode: "all" | "remaining") {
      const s = get();
      if (s.queue.running) return;
      if (!s.backend.connected) {
        toast("Connect the backend first — paste your Colab URL up top.", "error");
        return;
      }
      if (!s.project.voiceId) {
        toast("Clone a voice first.", "error");
        return;
      }
      if (s.project.chunks.length === 0) {
        toast("Add a script first.", "error");
        return;
      }

      if (mode === "all") {
        await db.clearProjectAudio(s.project.id);
        set((st) => ({
          project: {
            ...st.project,
            chunks: st.project.chunks.map((c, i) => ({
              ...c,
              status: "pending" as const,
              attempts: 0,
              seed: st.project.params.seed + i,
              audioBlob: undefined,
              durationSec: undefined,
              error: undefined,
            })),
          },
        }));
      } else {
        set((st) => ({
          project: {
            ...st.project,
            chunks: st.project.chunks.map((c) =>
              c.status === "failed"
                ? { ...c, status: "pending" as const, attempts: 0, error: undefined }
                : c
            ),
          },
        }));
      }
      schedulePersist();
      void runQueue(null);
    },

    pauseGeneration() {
      if (get().queue.running) setQueue({ paused: true });
    },

    resumeGeneration() {
      setQueue({ paused: false });
    },

    stopGeneration() {
      runToken++; // any in-flight loop stands down; a finishing chunk still saves
      set((s) => ({
        queue: { ...s.queue, running: false, paused: false, currentChunkId: null },
        project: {
          ...s.project,
          chunks: s.project.chunks.map((c) =>
            c.status === "generating" ? { ...c, status: "pending" as const } : c
          ),
        },
      }));
      schedulePersist();
    },

    async regenerateChunk(id: string, newText?: string) {
      const s = get();
      if (s.queue.running) return;
      const chunk = s.project.chunks.find((c) => c.id === id);
      if (!chunk) return;
      updateChunk(id, {
        text: newText?.trim() || chunk.text,
        charCount: (newText?.trim() || chunk.text).length,
        status: "pending",
        attempts: 0,
        seed: randomSeed(),
        error: undefined,
      });
      void runQueue(new Set([id]));
    },

    async generateOnce(text: string, model: ModelId, seed: number) {
      const s = get();
      const remoteId = await ensureRemoteVoice(s.project.voiceId);
      const { params } = s.project;
      const result = await generateChunk(s.backendUrl, {
        text,
        voice_id: remoteId,
        model,
        seed,
        exaggeration: params.exaggeration,
        cfg: params.cfg,
        temperature: params.temperature,
        style_prompt: params.stylePrompt,
      });
      return {
        blob: result.audioBlob,
        durationSec: result.durationSec,
        genSeconds: result.genSeconds,
      };
    },
  };
});
