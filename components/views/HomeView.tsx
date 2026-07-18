"use client";

import { formatDuration } from "@/lib/audio";
import { useApp } from "@/lib/store";
import { useVideo } from "@/lib/videoStore";
import type { ViewId } from "../Shell";
import { SpeechConnectionForm, VideoConnectionForm } from "../Connections";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardHeader } from "../ui/Card";
import {
  IconArrowRight,
  IconDownload,
  IconMic,
  IconScript,
  IconSparkle,
  IconVideo,
  IconWave,
} from "../ui/Icons";

const STEPS = [
  { n: 1, label: "Write script", hint: "Paste or type your narration", Icon: IconScript },
  { n: 2, label: "Select voice", hint: "Clone yours, or add a photo", Icon: IconMic },
  { n: 3, label: "Generate", hint: "Chunk by chunk, resumable", Icon: IconSparkle },
  { n: 4, label: "Download", hint: "WAV, MP3, SRT or MP4", Icon: IconDownload },
];

function Workflow() {
  return (
    <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map(({ n, label, hint, Icon }, i) => (
        <li key={n} className="relative">
          <div className="flex h-full items-start gap-3 rounded-xl border border-line bg-surface2/50 p-4">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface3 text-muted">
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="flex items-baseline gap-1.5 text-[13px] font-semibold text-ink">
                <span className="font-mono text-[11px] text-faint">{n}</span>
                {label}
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-muted">{hint}</p>
            </div>
          </div>
          {i < STEPS.length - 1 ? (
            <IconArrowRight
              className="absolute -right-2.5 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-line lg:block"
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function ProductCard({
  kind,
  onOpen,
}: {
  kind: "speech" | "video";
  onOpen(): void;
}) {
  const speechReady = useApp((s) => s.backend.connected);
  const videoReady = useVideo((s) => s.backend.connected);
  const voices = useApp((s) => s.voices.length);
  const chunks = useApp((s) => s.project.chunks);
  const hasVideo = useVideo((s) => s.job.status === "done");

  const done = chunks.filter((c) => c.status === "done");
  const doneSec = done.reduce((a, c) => a + (c.durationSec ?? 0), 0);

  const isSpeech = kind === "speech";
  const ready = isSpeech ? speechReady : videoReady;

  const stat = isSpeech
    ? done.length
      ? `${done.length}/${chunks.length} chunks · ${formatDuration(doneSec)}`
      : voices
        ? `${voices} voice${voices > 1 ? "s" : ""} saved`
        : "No voice yet"
    : hasVideo
      ? "Last render ready"
      : "No render yet";

  return (
    <Card
      accent={isSpeech ? "audio" : "video"}
      interactive
      className={`group flex flex-col ${isSpeech ? "hover:shadow-glow" : "hover:shadow-glowVideo"}`}
    >
      <CardHeader
        accent={isSpeech ? "audio" : "video"}
        icon={isSpeech ? <IconWave className="h-[18px] w-[18px]" /> : <IconVideo className="h-[18px] w-[18px]" />}
        title={isSpeech ? "Text to Speech" : "AI Video Generation"}
        description={
          isSpeech
            ? "Clone your voice once, then turn any script into narration — in 23 languages."
            : "Animate a single portrait with your narration for a lip-synced talking head."
        }
        action={
          <Badge tone={ready ? (isSpeech ? "audio" : "video") : "neutral"} dot>
            {ready ? "Ready" : "Offline"}
          </Badge>
        }
      />
      <div className="mt-auto flex items-center justify-between gap-3 pt-1">
        <span className="font-mono text-[11.5px] tabular-nums text-faint">{stat}</span>
        <Button variant={isSpeech ? "primary" : "video"} onClick={onOpen}>
          Open
          <IconArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}

export function HomeView({ onNavigate }: { onNavigate(v: ViewId): void }) {
  const speechReady = useApp((s) => s.backend.connected);
  const videoReady = useVideo((s) => s.backend.connected);
  const bothOffline = !speechReady && !videoReady;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
      {/* hero */}
      <div className="stagger">
        <div className="mb-9 max-w-2xl">
          <Badge tone={speechReady ? "audio" : "neutral"} dot className="mb-4">
            {speechReady ? "GPU connected" : "Bring your own free GPU"}
          </Badge>
          <h1 className="font-display text-3xl font-bold leading-[1.15] tracking-tight text-ink sm:text-[40px]">
            Your voice, your face,
            <br />
            <span className="text-audio">rendered on your own GPU.</span>
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            A studio for long-form narration and talking-head video. No subscription, no API key —
            the models run on a free Colab session you control, and nothing leaves your browser
            except to that session.
          </p>
        </div>

        {/* workflow */}
        <section className="mb-9" aria-label="How it works">
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
            How it works
          </h2>
          <Workflow />
        </section>

        {/* products */}
        <section className="mb-9 grid gap-4 md:grid-cols-2" aria-label="Tools">
          <ProductCard kind="speech" onOpen={() => onNavigate("speech")} />
          <ProductCard kind="video" onOpen={() => onNavigate("video")} />
        </section>

        {/* setup — only nags while there's genuinely nothing connected */}
        {bothOffline ? (
          <Card>
            <CardHeader
              title="Connect a GPU to begin"
              description="Run a notebook from the repo on Colab with a T4 GPU, then paste the URL it prints. Takes about four minutes."
            />
            <div className="grid gap-6 md:grid-cols-2">
              <SpeechConnectionForm />
              <VideoConnectionForm />
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
