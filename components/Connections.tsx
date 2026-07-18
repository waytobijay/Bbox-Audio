"use client";

import { useEffect, useState } from "react";
import { HEALTH_POLL_MS } from "@/lib/config";
import { useApp } from "@/lib/store";
import { useVideo } from "@/lib/videoStore";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { FieldLabel } from "./ui/Card";
import { IconLink, IconVideo, IconWave } from "./ui/Icons";
import { Input } from "./ui/Input";

/**
 * Both GPU backends live behind one panel. Speech and Video are separate
 * Colab sessions with separate tunnel URLs, so they connect independently —
 * the app stays fully usable with only one of them live.
 */

export function SpeechConnectionForm() {
  const url = useApp((s) => s.backendUrl);
  const setUrl = useApp((s) => s.setBackendUrl);
  const connect = useApp((s) => s.connect);
  const connecting = useApp((s) => s.connecting);
  const backend = useApp((s) => s.backend);

  // keep an eye on the tunnel while it's up
  useEffect(() => {
    if (!backend.connected) return;
    const id = setInterval(() => void connect({ silent: true }), HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [backend.connected, connect]);

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <FieldLabel>Speech engine · voiceforge_server.ipynb</FieldLabel>
      <div className="flex gap-2">
        <Input
          type="url"
          inputMode="url"
          aria-label="Speech backend URL"
          placeholder="https://your-tunnel.trycloudflare.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="submit" disabled={connecting || !url.trim()}>
          {connecting ? "…" : "Connect"}
        </Button>
      </div>
      {backend.connected ? (
        <p className="font-mono text-[11px] text-muted">
          {backend.gpu}
          {backend.latencyMs !== undefined ? ` · ${backend.latencyMs}ms` : ""}
          {backend.modelsLoaded.length ? ` · ${backend.modelsLoaded.join(", ")}` : ""}
          {backend.mode === "proxy" ? " · via proxy" : ""}
        </p>
      ) : (
        <p className="text-[12px] leading-relaxed text-faint">
          Run the notebook on Colab with a T4 GPU, then paste the URL it prints.
        </p>
      )}
    </form>
  );
}

export function VideoConnectionForm() {
  const url = useVideo((s) => s.videoBackendUrl);
  const setUrl = useVideo((s) => s.setVideoBackendUrl);
  const connect = useVideo((s) => s.connect);
  const connecting = useVideo((s) => s.connecting);
  const backend = useVideo((s) => s.backend);

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <FieldLabel>Video engine · voiceforge_video.ipynb</FieldLabel>
      <div className="flex gap-2">
        <Input
          type="url"
          inputMode="url"
          aria-label="Video backend URL"
          placeholder="https://your-video-tunnel.trycloudflare.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button type="submit" variant="video" disabled={connecting || !url.trim()}>
          {connecting ? "…" : "Connect"}
        </Button>
      </div>
      {backend.connected ? (
        <p className="font-mono text-[11px] text-muted">
          {backend.gpu}
          {backend.latencyMs !== undefined ? ` · ${backend.latencyMs}ms` : ""}
          {backend.enginesLoaded.length ? ` · ${backend.enginesLoaded.join(", ")}` : ""}
        </p>
      ) : (
        <p className="text-[12px] leading-relaxed text-faint">
          A second notebook, run after your speech is done — it needs its own GPU session.
        </p>
      )}
    </form>
  );
}

export function ConnectionBadges({ onOpen }: { onOpen(): void }) {
  const speech = useApp((s) => s.backend.connected);
  const speechBusy = useApp((s) => s.connecting);
  const video = useVideo((s) => s.backend.connected);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-2 rounded-xl border border-line bg-surface2 px-2.5 py-1.5 transition-colors hover:border-lineStrong"
      aria-label="Manage GPU connections"
    >
      <Badge tone={speech ? "audio" : "neutral"} dot pulse={speechBusy}>
        Speech
      </Badge>
      <Badge tone={video ? "video" : "neutral"} dot>
        Video
      </Badge>
      <IconLink className="h-3.5 w-3.5 text-faint" />
    </button>
  );
}

export function ConnectionsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="GPU connections"
      description="Each engine runs in its own free Colab session and prints a URL. Paste them here."
      wide
    >
      <div className="flex flex-col gap-6">
        <div className="flex gap-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-audioSoft text-audio">
            <IconWave className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <SpeechConnectionForm />
          </div>
        </div>
        <div className="h-px bg-line" />
        <div className="flex gap-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-videoSoft text-video">
            <IconVideo className="h-4.5 w-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <VideoConnectionForm />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Convenience wrapper used by the top bar. */
export function ConnectionsControl() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ConnectionBadges onOpen={() => setOpen(true)} />
      <ConnectionsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
