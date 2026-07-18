"use client";

import { useEffect, useState } from "react";
import { HEALTH_POLL_MS } from "@/lib/config";
import { useApp } from "@/lib/store";
import { useVideo } from "@/lib/videoStore";
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

/**
 * Explicit, unmissable connection state. The words "Live" / "Offline" carry
 * the meaning — colour and the filled/hollow dot only reinforce it.
 */
export function EngineStatus({
  kind,
  size = "md",
}: {
  kind: "speech" | "video";
  size?: "sm" | "md";
}) {
  const speechOn = useApp((s) => s.backend.connected);
  const speechGpu = useApp((s) => s.backend.gpu);
  const videoOn = useVideo((s) => s.backend.connected);
  const videoGpu = useVideo((s) => s.backend.gpu);

  const on = kind === "speech" ? speechOn : videoOn;
  const gpu = kind === "speech" ? speechGpu : videoGpu;
  const accent = kind === "speech" ? "audio" : "video";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg border font-medium ${
        size === "sm" ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-[12px]"
      } ${
        on
          ? accent === "audio"
            ? "border-audio/40 bg-audioSoft text-audio"
            : "border-video/40 bg-videoSoft text-video"
          : "border-line bg-surface2 text-muted"
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${
          on
            ? accent === "audio"
              ? "bg-audio"
              : "bg-video"
            : "border border-faint bg-transparent"
        }`}
      />
      <span>{kind === "speech" ? "Speech" : "Video"}</span>
      <span className={on ? "" : "text-faint"}>{on ? "Live" : "Offline"}</span>
      {on && gpu ? (
        <span className="hidden font-mono text-[10.5px] opacity-70 sm:inline">{gpu}</span>
      ) : null}
    </span>
  );
}

export function ConnectionBadges({ onOpen }: { onOpen(): void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-2 rounded-xl border border-line bg-surface/80 p-1.5 transition-colors hover:border-lineStrong"
      aria-label="Manage GPU connections"
      title="Manage GPU connections"
    >
      <EngineStatus kind="speech" size="sm" />
      <EngineStatus kind="video" size="sm" />
      <IconLink className="mr-0.5 h-3.5 w-3.5 text-faint" />
    </button>
  );
}

/** Status + a way to fix it, for use in a page header. */
export function EngineStatusBar({ kind }: { kind: "speech" | "video" }) {
  const [open, setOpen] = useState(false);
  const speechOn = useApp((s) => s.backend.connected);
  const videoOn = useVideo((s) => s.backend.connected);
  const on = kind === "speech" ? speechOn : videoOn;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <EngineStatus kind={kind} />
        {!on ? (
          <Button size="sm" variant={kind === "video" ? "video" : "primary"} onClick={() => setOpen(true)}>
            Connect GPU
          </Button>
        ) : null}
      </div>
      <ConnectionsDialog open={open} onClose={() => setOpen(false)} />
    </>
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
