"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  encodeWavPcm16,
  formatDuration,
  peakNormalize,
  stitchChunks,
  wavBlobToPcm,
} from "@/lib/audio";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Chunk, VideoEngine } from "@/lib/types";
import { useVideo } from "@/lib/videoStore";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

const ENGINE_INFO: Record<VideoEngine, { name: string; blurb: string }> = {
  sadtalker: {
    name: "SadTalker",
    blurb: "Lip sync + blinking + head motion. Best for short clips — slow at length.",
  },
  wav2lip: {
    name: "Wav2Lip",
    blurb: "Mouth-only lip sync. Fast enough for full narration; head stays still.",
  },
};

type AudioSource = "narration" | "upload";

function VideoBackendField() {
  const url = useVideo((s) => s.videoBackendUrl);
  const setUrl = useVideo((s) => s.setVideoBackendUrl);
  const connect = useVideo((s) => s.connect);
  const connecting = useVideo((s) => s.connecting);
  const backend = useVideo((s) => s.backend);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="video-url" className="text-[11px] font-medium uppercase tracking-wider text-muted">
        Video backend
      </label>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <Input
          id="video-url"
          type="url"
          inputMode="url"
          placeholder="https://your-video-tunnel.trycloudflare.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={connecting || !url.trim()}>
          Connect
        </Button>
      </form>
      {backend.connected ? (
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-ready/30 px-2.5 py-1 text-xs text-ready">
          <span className="h-2 w-2 rounded-full bg-ready" aria-hidden />
          Live
          <span className="font-mono text-[11px] text-muted">
            {backend.gpu}
            {backend.enginesLoaded.length ? ` · ${backend.enginesLoaded.join(", ")}` : ""}
          </span>
        </span>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted/80">
          A second Colab notebook — <code className="font-mono">colab/voiceforge_video.ipynb</code>.
          Run it after your speech is done, paste its URL here.
        </p>
      )}
    </div>
  );
}

export function VideoLab() {
  const chunks = useApp((s) => s.project.chunks);
  const projectName = useApp((s) => s.project.name);

  const photoBlob = useVideo((s) => s.photoBlob);
  const setPhoto = useVideo((s) => s.setPhoto);
  const removePhoto = useVideo((s) => s.removePhoto);
  const engine = useVideo((s) => s.engine);
  const setEngine = useVideo((s) => s.setEngine);
  const backend = useVideo((s) => s.backend);
  const job = useVideo((s) => s.job);
  const generate = useVideo((s) => s.generate);
  const clearResult = useVideo((s) => s.clearResult);

  const [audioSource, setAudioSource] = useState<AudioSource>("narration");
  const [uploadedAudio, setUploadedAudio] = useState<{ blob: Blob; name: string } | null>(null);
  const [preparing, setPreparing] = useState(false);

  const photoUrl = useMemo(() => (photoBlob ? URL.createObjectURL(photoBlob) : null), [photoBlob]);
  const videoUrl = useMemo(
    () => (job.videoBlob ? URL.createObjectURL(job.videoBlob) : null),
    [job.videoBlob]
  );
  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);
  useEffect(() => () => void (videoUrl && URL.revokeObjectURL(videoUrl)), [videoUrl]);

  const doneChunks = useMemo(
    () =>
      chunks.filter(
        (c): c is Chunk & { audioBlob: Blob; durationSec: number } =>
          c.status === "done" && !!c.audioBlob && c.durationSec !== undefined
      ),
    [chunks]
  );
  const narrationSec = doneChunks.reduce((a, c) => a + c.durationSec, 0);

  async function buildNarrationWav(): Promise<Blob> {
    const items = await Promise.all(
      doneChunks.map(async (c) => ({
        audio: await wavBlobToPcm(c.audioBlob),
        isParagraphEnd: c.isParagraphEnd,
      }))
    );
    return encodeWavPcm16(peakNormalize(stitchChunks(items)));
  }

  async function onGenerate() {
    let audioBlob: Blob;
    setPreparing(true);
    try {
      if (audioSource === "narration") {
        if (doneChunks.length === 0) {
          toast("Generate some narration first, or upload an audio file.", "error");
          return;
        }
        audioBlob = await buildNarrationWav();
      } else {
        if (!uploadedAudio) {
          toast("Choose an audio file, or switch to generated narration.", "error");
          return;
        }
        audioBlob = uploadedAudio.blob;
      }
    } finally {
      setPreparing(false);
    }
    await generate(audioBlob);
  }

  const processing = job.status === "processing";
  const engineLoaded = (e: VideoEngine) => !backend.connected || backend.enginesLoaded.includes(e);
  const base = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "talking-head";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <VideoBackendField />

      {/* photo */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted">Portrait photo</h3>
        {photoUrl ? (
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoUrl}
              alt="Selected portrait"
              className="h-24 w-24 rounded-md border border-rule object-cover"
            />
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted">A clear, front-facing photo works best.</p>
              <Button size="sm" variant="ghost" onClick={() => void removePhoto()} disabled={processing}>
                Remove photo
              </Button>
            </div>
          </div>
        ) : (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-rule p-6 text-center text-sm text-muted hover:border-muted">
            <span>Upload a single face photo — JPG or PNG.</span>
            <span className="text-[11px] text-muted/80">Front-facing, well-lit, one person, eyes open.</span>
            <input
              type="file"
              accept="image/jpeg,image/png"
              className="visually-hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void setPhoto(f);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>

      {/* engine */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted">Engine</h3>
        <div role="radiogroup" aria-label="Video engine" className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(ENGINE_INFO) as VideoEngine[]).map((id) => {
            const loaded = engineLoaded(id);
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={engine === id}
                disabled={processing || !loaded}
                onClick={() => setEngine(id)}
                className={`rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                  engine === id ? "border-text bg-desk" : "border-rule bg-panel hover:border-muted"
                }`}
              >
                <span className="block text-sm font-medium">
                  {ENGINE_INFO[id].name}
                  {!loaded ? " — not loaded" : ""}
                </span>
                <span className="block text-[11px] leading-snug text-muted">{ENGINE_INFO[id].blurb}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* audio source */}
      <div className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted">Voice audio</h3>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="audiosrc"
              checked={audioSource === "narration"}
              onChange={() => setAudioSource("narration")}
              className="accent-[#5EE6A8]"
            />
            Use generated narration
            <span className="font-mono text-[11px] tabular-nums text-muted">
              {doneChunks.length
                ? `${doneChunks.length} chunks · ${formatDuration(narrationSec)}`
                : "none yet"}
            </span>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name="audiosrc"
              checked={audioSource === "upload"}
              onChange={() => setAudioSource("upload")}
              className="accent-[#5EE6A8]"
            />
            Upload audio
            <input
              type="file"
              accept="audio/*,.wav,.mp3,.m4a"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setUploadedAudio({ blob: f, name: f.name });
                  setAudioSource("upload");
                }
                e.target.value = "";
              }}
              className="text-xs text-muted file:mr-2 file:rounded file:border file:border-rule file:bg-panel file:px-2 file:py-1 file:text-xs file:text-text"
            />
            {uploadedAudio ? (
              <span className="font-mono text-[11px] text-muted">{uploadedAudio.name}</span>
            ) : null}
          </label>
        </div>
        {engine === "sadtalker" && narrationSec > 120 && audioSource === "narration" ? (
          <p className="rounded-md border border-signal/40 bg-signal/5 px-3 py-2 text-[11px] leading-relaxed text-muted">
            Heads up: SadTalker renders far slower than real time. {formatDuration(narrationSec)} of
            audio could take a very long time on a free T4 and may exceed the session limit. For
            anything past ~1–2 minutes, use Wav2Lip.
          </p>
        ) : null}
      </div>

      {/* generate + progress */}
      <div className="flex flex-col gap-3 border-t border-rule pt-4">
        {processing ? (
          <div className="rounded-md border border-signal/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="inline-flex items-center gap-2 text-sm text-signal">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-signal signal-pulse" />
                {ENGINE_INFO[job.engine].name} rendering
              </span>
              <span className="font-mono text-sm tabular-nums">{formatDuration(job.elapsedSec)}</span>
            </div>
            <p aria-live="polite" className="text-xs text-muted">
              {job.progress}
            </p>
            <p className="mt-2 text-[11px] text-muted/70">
              Keep this tab and the Colab tab open. Don&apos;t navigate away.
            </p>
          </div>
        ) : (
          <Button
            variant="primary"
            disabled={!backend.connected || !photoBlob || preparing}
            onClick={() => void onGenerate()}
          >
            {preparing ? "Preparing audio…" : "Generate talking-head video"}
          </Button>
        )}

        {job.status === "failed" && job.error ? (
          <p className="text-xs text-[#f0857a]">{job.error}</p>
        ) : null}

        {job.status === "done" && videoUrl ? (
          <div className="flex flex-col gap-2">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={videoUrl} controls className="w-full rounded-md border border-rule" />
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={videoUrl}
                download={`${base}.mp4`}
                className="inline-flex items-center gap-1.5 rounded-md bg-text px-3.5 py-2 text-sm font-medium text-desk hover:bg-white"
              >
                Download MP4
              </a>
              <Button variant="ghost" onClick={() => void clearResult()}>
                Clear
              </Button>
              {job.durationSec ? (
                <span className="font-mono text-[11px] tabular-nums text-muted">
                  {formatDuration(job.durationSec)} video
                  {job.elapsedSec ? ` · ${formatDuration(job.elapsedSec)} to render` : ""}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
