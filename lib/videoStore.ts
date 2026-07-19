/**
 * State for the talking-head video feature. Deliberately a SEPARATE store from
 * the main TTS app state (lib/store.ts) so this feature can't destabilize the
 * working voice/generation flow, and its own backend connection is isolated.
 */

import { create } from "zustand";
import { normalizeBackendUrl } from "./backend";
import * as db from "./db";
import { toast } from "./toast";
import {
  animate,
  checkVideoHealth,
  VideoBackendError,
} from "./videoBackend";
import type { VideoBackendStatus, VideoEngine, VideoJob } from "./types";

const LS_VIDEO_URL = "voiceforge:videoBackendUrl";

const ENGINE_STAGES: Record<VideoEngine, Array<[number, string]>> = {
  // [elapsed seconds threshold, message]
  sadtalker: [
    [0, "Uploading photo and audio…"],
    [6, "Detecting and cropping the face…"],
    [20, "Predicting head motion and expressions…"],
    [45, "Rendering frames (this is the slow part)…"],
  ],
  wav2lip: [
    [0, "Uploading photo and audio…"],
    [5, "Detecting the face…"],
    [15, "Syncing lips to the audio…"],
    [40, "Encoding the final video…"],
  ],
};

function stageFor(engine: VideoEngine, elapsedSec: number): string {
  const stages = ENGINE_STAGES[engine];
  let msg = stages[0][1];
  for (const [t, m] of stages) if (elapsedSec >= t) msg = m;
  return msg;
}

const IDLE_JOB: VideoJob = {
  status: "idle",
  engine: "sadtalker",
  progress: "",
  elapsedSec: 0,
};

interface VideoState {
  hydrated: boolean;
  videoBackendUrl: string;
  backend: VideoBackendStatus;
  connecting: boolean;
  photoBlob: Blob | null;
  engine: VideoEngine;
  job: VideoJob;

  hydrate(): Promise<void>;
  setVideoBackendUrl(url: string): void;
  connect(opts?: { silent?: boolean }): Promise<boolean>;
  setPhoto(blob: Blob): Promise<void>;
  removePhoto(): Promise<void>;
  setEngine(engine: VideoEngine): void;
  generate(audioBlob: Blob): Promise<void>;
  clearResult(): Promise<void>;
}

export const useVideo = create<VideoState>((set, get) => {
  let ticker: ReturnType<typeof setInterval> | null = null;

  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };

  return {
    hydrated: false,
    videoBackendUrl: "",
    backend: { connected: false, url: "", enginesLoaded: [] },
    connecting: false,
    photoBlob: null,
    engine: "sadtalker",
    job: { ...IDLE_JOB },

    async hydrate() {
      const url =
        typeof window !== "undefined" ? localStorage.getItem(LS_VIDEO_URL) ?? "" : "";
      // Same rule as the speech store: storage can never block startup.
      try {
        const photo = await db.loadVideoAsset("sourcePhoto");
        const result = await db.loadVideoAsset("resultVideo");
        set({
          hydrated: true,
          videoBackendUrl: url,
          photoBlob: photo?.blob ?? null,
          job: result
            ? {
                ...IDLE_JOB,
                status: "done",
                videoBlob: result.blob,
                durationSec: result.durationSec,
              }
            : { ...IDLE_JOB },
        });
      } catch (e) {
        console.warn("[voiceforge] video assets unavailable:", e);
        set({ hydrated: true, videoBackendUrl: url });
      }
      if (url) void get().connect({ silent: true });
    },

    setVideoBackendUrl(url: string) {
      set({ videoBackendUrl: url });
      if (typeof window !== "undefined") localStorage.setItem(LS_VIDEO_URL, url.trim());
    },

    async connect(opts) {
      const url = normalizeBackendUrl(get().videoBackendUrl);
      if (!url) return false;
      set({ connecting: true });
      try {
        const health = await checkVideoHealth(url);
        set((s) => ({
          connecting: false,
          backend: {
            connected: true,
            url,
            gpu: health.gpu,
            enginesLoaded: health.engines,
            latencyMs: health.latencyMs,
          },
          // if the chosen engine isn't loaded, fall back to one that is
          engine: health.engines.includes(s.engine)
            ? s.engine
            : health.engines[0] ?? s.engine,
        }));
        return true;
      } catch {
        set((s) => ({ connecting: false, backend: { ...s.backend, url, connected: false } }));
        if (!opts?.silent) {
          toast("Couldn't reach the video backend. Is that Colab tab open?", "error");
        }
        return false;
      }
    },

    async setPhoto(blob: Blob) {
      await db.saveVideoAsset("sourcePhoto", blob);
      set({ photoBlob: blob });
    },

    async removePhoto() {
      await db.deleteVideoAsset("sourcePhoto");
      set({ photoBlob: null });
    },

    setEngine(engine: VideoEngine) {
      set({ engine });
    },

    async generate(audioBlob: Blob) {
      const s = get();
      if (s.job.status === "processing") return;
      if (!s.backend.connected) {
        toast("Connect the video backend first.", "error");
        return;
      }
      if (!s.photoBlob) {
        toast("Upload a photo first.", "error");
        return;
      }
      if (!s.backend.enginesLoaded.includes(s.engine)) {
        toast(`${s.engine} isn't loaded on the backend.`, "error");
        return;
      }

      const startedAt = performance.now();
      set({
        job: {
          status: "processing",
          engine: s.engine,
          progress: stageFor(s.engine, 0),
          elapsedSec: 0,
        },
      });
      stopTicker();
      ticker = setInterval(() => {
        const elapsedSec = (performance.now() - startedAt) / 1000;
        set((st) =>
          st.job.status === "processing"
            ? { job: { ...st.job, elapsedSec, progress: stageFor(st.job.engine, elapsedSec) } }
            : {}
        );
      }, 1000);

      try {
        const result = await animate(
          s.videoBackendUrl,
          { imageBlob: s.photoBlob, audioBlob, engine: s.engine },
          // Real stage text from the backend beats guessing from elapsed time.
          (stage) =>
            set((st) =>
              st.job.status === "processing" ? { job: { ...st.job, progress: stage } } : {}
            )
        );
        await db.saveVideoAsset("resultVideo", result.videoBlob, result.durationSec);
        stopTicker();
        set({
          job: {
            status: "done",
            engine: s.engine,
            progress: "",
            elapsedSec: result.genSeconds,
            videoBlob: result.videoBlob,
            durationSec: result.durationSec,
          },
        });
        toast("Talking-head video ready.", "success");
      } catch (e) {
        stopTicker();
        const err = e instanceof VideoBackendError ? e : new VideoBackendError(String(e), "api");
        set((st) => ({
          job: { ...st.job, status: "failed", progress: "", error: err.message },
        }));
        if (err.kind === "network") {
          set((st) => ({ backend: { ...st.backend, connected: false } }));
        }
        toast(`Video failed: ${err.message}`, "error");
      }
    },

    async clearResult() {
      await db.deleteVideoAsset("resultVideo");
      set({ job: { ...IDLE_JOB } });
    },
  };
});
