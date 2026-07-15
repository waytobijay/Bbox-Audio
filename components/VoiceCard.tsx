"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/audio";
import { useApp } from "@/lib/store";
import type { Voice } from "@/lib/types";

export function VoiceCard({ voice }: { voice: Voice }) {
  const activeVoiceId = useApp((s) => s.activeVoiceId);
  const setActiveVoice = useApp((s) => s.setActiveVoice);
  const removeVoice = useApp((s) => s.removeVoice);
  const running = useApp((s) => s.queue.running);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const active = activeVoiceId === voice.id;

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const togglePlay = () => {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    if (!audioRef.current) {
      urlRef.current = URL.createObjectURL(voice.sampleBlob);
      audioRef.current = new Audio(urlRef.current);
      audioRef.current.onended = () => setPlaying(false);
    }
    void audioRef.current.play();
    setPlaying(true);
  };

  const onDelete = () => {
    if (window.confirm(`Delete voice "${voice.name}"? The sample is gone for good.`)) {
      void removeVoice(voice.id);
    }
  };

  return (
    <div
      className={`flex w-full items-center gap-1 rounded-md border pr-1 transition-colors ${
        active ? "border-ready/50 bg-desk" : "border-rule bg-panel hover:border-muted"
      }`}
    >
      <button
        type="button"
        onClick={() => setActiveVoice(voice.id)}
        aria-pressed={active}
        disabled={running && !active}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2 text-left disabled:opacity-50"
      >
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${active ? "bg-ready" : "bg-rule"}`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{voice.name}</span>
          <span className="block font-mono text-[11px] tabular-nums text-muted">
            {formatDuration(voice.durationSec)} sample
            {voice.remoteId ? " · on backend" : ""}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? `Pause ${voice.name} sample` : `Play ${voice.name} sample`}
        className="rounded px-1.5 py-0.5 text-muted hover:text-text"
      >
        {playing ? "⏸" : "▶"}
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete ${voice.name}`}
        className="rounded px-1.5 py-0.5 text-muted hover:text-[#f0857a]"
      >
        ✕
      </button>
    </div>
  );
}
