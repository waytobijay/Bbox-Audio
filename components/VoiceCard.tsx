"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/audio";
import { useApp } from "@/lib/store";
import type { Voice } from "@/lib/types";
import { IconCheck, IconPause, IconPlay, IconTrash } from "./ui/Icons";

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

  return (
    <div
      className={`group flex items-center gap-1 rounded-xl border pr-1.5 transition-all duration-150 ${
        active
          ? "border-audio/40 bg-audioSoft"
          : "border-line bg-surface2 hover:border-lineStrong"
      }`}
    >
      <button
        type="button"
        onClick={() => setActiveVoice(voice.id)}
        aria-pressed={active}
        disabled={running && !active}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left disabled:opacity-50"
      >
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${
            active ? "bg-audio text-white" : "bg-surface3 text-faint"
          }`}
        >
          {active ? (
            <IconCheck className="h-3.5 w-3.5" />
          ) : (
            <span className="text-[11px] font-semibold">{voice.name.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{voice.name}</span>
          <span className="block font-mono text-[11px] tabular-nums text-faint">
            {formatDuration(voice.durationSec)}
            {voice.remoteId ? " · on GPU" : ""}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? `Pause ${voice.name}` : `Play ${voice.name}`}
        className="grid h-7 w-7 place-items-center rounded-md text-faint transition-colors hover:bg-surface3 hover:text-ink"
      >
        {playing ? <IconPause className="h-3.5 w-3.5" /> : <IconPlay className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => {
          if (window.confirm(`Delete "${voice.name}"? The sample is gone for good.`)) {
            void removeVoice(voice.id);
          }
        }}
        aria-label={`Delete ${voice.name}`}
        className="grid h-7 w-7 place-items-center rounded-md text-faint opacity-0 transition-all hover:bg-dangerSoft hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
      >
        <IconTrash className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
