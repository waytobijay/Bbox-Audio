"use client";

import { useEffect, useMemo, useState } from "react";
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
import { VideoConnectionForm } from "./Connections";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Card, CardHeader, EmptyState, FieldLabel } from "./ui/Card";
import {
  IconAlert,
  IconClock,
  IconDownload,
  IconImage,
  IconSparkle,
  IconUpload,
  IconVideo,
  IconWave,
} from "./ui/Icons";
import { ProgressBar } from "./ui/ProgressBar";

const ENGINES: Record<VideoEngine, { name: string; tag: string; blurb: string }> = {
  sadtalker: {
    name: "SadTalker",
    tag: "Short video",
    blurb: "Lip sync, eye blinking, head movement and expressions. Keep it to 1–2 minutes.",
  },
  wav2lip: {
    name: "Wav2Lip",
    tag: "Long video",
    blurb: "Mouth-only lip sync. Fast enough for a full narration; the head stays still.",
  },
};

type AudioSource = "narration" | "upload";

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
  const [dragOver, setDragOver] = useState(false);

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

  function acceptPhoto(f: File) {
    if (!/^image\/(jpeg|png)$/.test(f.type)) {
      toast("Use a JPG or PNG photo.", "error");
      return;
    }
    void setPhoto(f);
  }

  const processing = job.status === "processing";
  const engineLoaded = (e: VideoEngine) => !backend.connected || backend.enginesLoaded.includes(e);
  const base = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "talking-head";
  const selectedSec = audioSource === "narration" ? narrationSec : 0;
  const tooLongForSadTalker = engine === "sadtalker" && audioSource === "narration" && selectedSec > 120;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      {/* main column */}
      <div className="flex min-w-0 flex-col gap-4">
        {/* photo */}
        <Card>
          <CardHeader
            accent="video"
            icon={<IconImage className="h-[18px] w-[18px]" />}
            title="Portrait photo"
            description="One clear, front-facing face — well lit, eyes open, no group shots."
            action={
              photoBlob ? (
                <Button size="sm" variant="ghost" onClick={() => void removePhoto()} disabled={processing}>
                  Replace
                </Button>
              ) : undefined
            }
          />
          {photoUrl ? (
            <div className="flex items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photoUrl}
                alt="Selected portrait"
                className="h-28 w-28 rounded-xl border border-line object-cover"
              />
              <div className="text-[13px] text-muted">
                <Badge tone="video" dot>
                  Ready to animate
                </Badge>
                <p className="mt-2 leading-relaxed">
                  This photo stays in your browser and is sent only to your own GPU session.
                </p>
              </div>
            </div>
          ) : (
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) acceptPhoto(f);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center transition-all ${
                dragOver
                  ? "border-video/60 bg-videoSoft shadow-glowVideo"
                  : "border-line bg-surface2/40 hover:border-lineStrong"
              }`}
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface3 text-faint">
                <IconUpload className="h-5 w-5" />
              </span>
              <span className="text-[13px] font-medium text-ink">
                Drop a photo here, or click to browse
              </span>
              <span className="text-[12px] text-faint">JPG or PNG</span>
              <input
                type="file"
                accept="image/jpeg,image/png"
                className="visually-hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) acceptPhoto(f);
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </Card>

        {/* result / progress */}
        <Card>
          <CardHeader
            accent="video"
            icon={<IconVideo className="h-[18px] w-[18px]" />}
            title="Result"
            description="Your rendered video appears here and is saved in this browser."
          />
          {processing ? (
            <div className="rounded-xl border border-live/40 bg-liveSoft p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-[13px] font-medium text-live">
                  <span aria-hidden className="h-2 w-2 animate-breathe rounded-full bg-live" />
                  {ENGINES[job.engine].name} rendering
                </span>
                <span className="flex items-center gap-1.5 font-mono text-[13px] tabular-nums text-ink">
                  <IconClock className="h-3.5 w-3.5 text-faint" />
                  {formatDuration(job.elapsedSec)}
                </span>
              </div>
              <ProgressBar indeterminate tone="live" label="Rendering" />
              <p aria-live="polite" className="mt-3 text-[12.5px] text-muted">
                {job.progress}
              </p>
              <p className="mt-1.5 text-[11.5px] text-faint">
                Keep this tab and the Colab tab open — don&apos;t navigate away.
              </p>
            </div>
          ) : job.status === "done" && videoUrl ? (
            <div className="flex flex-col gap-3">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={videoUrl} controls className="w-full rounded-xl border border-line bg-black" />
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={videoUrl}
                  download={`${base}.mp4`}
                  className="inline-flex h-10 items-center gap-2 rounded-xl bg-video px-4 text-sm font-semibold text-[#0A1330] transition-all hover:brightness-110"
                >
                  <IconDownload className="h-4 w-4" /> Download MP4
                </a>
                <Button variant="ghost" onClick={() => void clearResult()}>
                  Clear
                </Button>
                <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">
                  {job.durationSec ? formatDuration(job.durationSec) : ""}
                  {job.elapsedSec ? ` · rendered in ${formatDuration(job.elapsedSec)}` : ""}
                </span>
              </div>
            </div>
          ) : job.status === "failed" ? (
            <div className="flex gap-3 rounded-xl border border-danger/30 bg-dangerSoft p-4">
              <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <div>
                <p className="text-[13px] font-medium text-ink">Render failed</p>
                <p className="mt-1 break-words font-mono text-[11.5px] leading-relaxed text-muted">
                  {job.error}
                </p>
              </div>
            </div>
          ) : (
            <EmptyState icon={<IconVideo className="h-5 w-5" />} title="Nothing rendered yet">
              Add a photo, pick an engine, then generate.
            </EmptyState>
          )}
        </Card>
      </div>

      {/* settings rail */}
      <aside className="flex min-w-0 flex-col gap-4">
        {!backend.connected ? (
          <Card>
            <CardHeader
              accent="video"
              icon={<IconVideo className="h-[18px] w-[18px]" />}
              title="Connect the video GPU"
              description="A second Colab notebook, run after your speech is done."
            />
            <VideoConnectionForm />
          </Card>
        ) : null}

        {/* engine */}
        <Card>
          <CardHeader title="Engine" description="Pick per render — you can compare both." />
          <div role="radiogroup" aria-label="Video engine" className="flex flex-col gap-2">
            {(Object.keys(ENGINES) as VideoEngine[]).map((id) => {
              const loaded = engineLoaded(id);
              const on = engine === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={processing || !loaded}
                  onClick={() => setEngine(id)}
                  className={`rounded-xl border px-3.5 py-3 text-left transition-all duration-150 disabled:opacity-40 ${
                    on ? "border-video/40 bg-videoSoft" : "border-line bg-surface2 hover:border-lineStrong"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">{ENGINES[id].name}</span>
                    <Badge tone={on ? "video" : "neutral"}>{ENGINES[id].tag}</Badge>
                  </span>
                  <span className="mt-1 block text-[11.5px] leading-snug text-muted">
                    {loaded ? ENGINES[id].blurb : "Not loaded on the GPU."}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        {/* voice audio */}
        <Card>
          <CardHeader
            icon={<IconWave className="h-[18px] w-[18px]" />}
            title="Voice audio"
            description="Use what you generated, or bring your own."
          />
          <div className="flex flex-col gap-2">
            <label
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
                audioSource === "narration"
                  ? "border-video/40 bg-videoSoft"
                  : "border-line bg-surface2 hover:border-lineStrong"
              }`}
            >
              <input
                type="radio"
                name="audiosrc"
                checked={audioSource === "narration"}
                onChange={() => setAudioSource("narration")}
                className="h-3.5 w-3.5 accent-[#7C9BFF]"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">Generated narration</span>
                <span className="block font-mono text-[11px] tabular-nums text-faint">
                  {doneChunks.length
                    ? `${doneChunks.length} chunks · ${formatDuration(narrationSec)}`
                    : "none generated yet"}
                </span>
              </span>
            </label>

            {/* The radio and the file picker must be SEPARATE labels — a single
                label only ever activates its first control, which silently made
                uploading impossible. */}
            <div
              className={`rounded-xl border px-3.5 py-3 transition-colors ${
                audioSource === "upload"
                  ? "border-video/40 bg-videoSoft"
                  : "border-line bg-surface2"
              }`}
            >
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="radio"
                  name="audiosrc"
                  checked={audioSource === "upload"}
                  onChange={() => setAudioSource("upload")}
                  className="h-3.5 w-3.5 accent-[#7C9BFF]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink">Upload audio</span>
                  <span className="block truncate font-mono text-[11px] text-faint">
                    {uploadedAudio ? uploadedAudio.name : "wav, mp3 or m4a"}
                  </span>
                </span>
              </label>
              <label className="mt-2.5 flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-surface3 text-[13px] font-medium text-ink transition-colors hover:border-lineStrong">
                <IconUpload className="h-4 w-4" />
                {uploadedAudio ? "Choose a different file" : "Choose file"}
                <input
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a"
                  className="visually-hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setUploadedAudio({ blob: f, name: f.name });
                      setAudioSource("upload");
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>

          {tooLongForSadTalker ? (
            <div className="mt-3 flex gap-2.5 rounded-xl border border-live/30 bg-liveSoft px-3.5 py-3">
              <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-live" />
              <p className="text-[11.5px] leading-relaxed text-muted">
                {formatDuration(narrationSec)} is long for SadTalker — it renders far slower than
                real time and may exceed the free session. Switch to Wav2Lip for this length.
              </p>
            </div>
          ) : null}

          <Button
            variant="video"
            size="lg"
            className="mt-4 w-full"
            disabled={!backend.connected || !photoBlob || preparing || processing}
            onClick={() => void onGenerate()}
          >
            <IconSparkle className="h-4 w-4" />
            {preparing ? "Preparing audio…" : processing ? "Rendering…" : "Generate video"}
          </Button>
        </Card>
      </aside>
    </div>
  );
}
