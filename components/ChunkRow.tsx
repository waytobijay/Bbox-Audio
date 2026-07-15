"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/audio";
import { EST_CHARS_PER_SEC } from "@/lib/config";
import { estimateChunkSeconds } from "@/lib/chunker";
import { useApp } from "@/lib/store";
import type { Chunk } from "@/lib/types";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Textarea } from "./ui/Input";

/** Only one chunk plays at a time. */
let currentAudio: HTMLAudioElement | null = null;
let currentStop: (() => void) | null = null;

const GLYPHS: Record<Chunk["status"], { char: string; label: string; cls: string }> = {
  done: { char: "✓", label: "done", cls: "text-ready" },
  generating: { char: "◐", label: "generating", cls: "text-signal signal-pulse" },
  pending: { char: "·", label: "pending", cls: "text-muted" },
  failed: { char: "✕", label: "failed", cls: "text-[#f0857a]" },
};

export function ChunkRow({ chunk, maxSec }: { chunk: Chunk; maxSec: number }) {
  const regenerateChunk = useApp((s) => s.regenerateChunk);
  const running = useApp((s) => s.queue.running);
  const [playing, setPlaying] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState(chunk.text);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const seconds =
    chunk.status === "done" && chunk.durationSec !== undefined
      ? chunk.durationSec
      : estimateChunkSeconds(chunk.charCount, EST_CHARS_PER_SEC);
  const widthPct = maxSec > 0 ? Math.max(6, (seconds / maxSec) * 100) : 6;

  const glyph = GLYPHS[chunk.status];
  const barCls =
    chunk.status === "done"
      ? "bg-ready bar-fill"
      : chunk.status === "generating"
        ? "bg-signal signal-pulse"
        : chunk.status === "failed"
          ? "bg-[#f0857a]/50"
          : "bg-rule";

  function togglePlay() {
    if (playing) {
      currentStop?.();
      return;
    }
    if (!chunk.audioBlob) return;
    currentStop?.(); // stop whatever else is playing
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(chunk.audioBlob);
    const audio = new Audio(urlRef.current);
    currentAudio = audio;
    currentStop = () => {
      audio.pause();
      setPlaying(false);
      currentAudio = null;
      currentStop = null;
    };
    audio.onended = () => currentStop?.();
    void audio.play();
    setPlaying(true);
  }

  return (
    <li
      className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-desk"
      title={chunk.status === "failed" ? chunk.error : chunk.text}
    >
      <span className="w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
        {String(chunk.index + 1).padStart(2, "0")}
      </span>
      <span
        aria-hidden
        className={`w-3 shrink-0 text-center text-xs ${glyph.cls}`}
      >
        {glyph.char}
      </span>
      <span className="visually-hidden">{glyph.label}</span>

      {/* the rail bar — width ∝ audio duration */}
      <span className="h-3 min-w-0 flex-1 overflow-hidden rounded-sm" aria-hidden>
        <span
          key={`${chunk.status}-${chunk.durationSec ?? 0}`}
          className={`block h-full rounded-sm ${barCls}`}
          style={{ width: `${widthPct}%` }}
        />
      </span>

      <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
        {chunk.status === "done" ? formatDuration(seconds) : "–"}
      </span>

      <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={togglePlay}
          disabled={chunk.status !== "done"}
          aria-label={playing ? `Pause chunk ${chunk.index + 1}` : `Play chunk ${chunk.index + 1}`}
          className="rounded px-1 text-xs text-muted hover:text-text disabled:opacity-30"
        >
          {playing ? "⏸" : "▶"}
        </button>
        <button
          type="button"
          onClick={() => void regenerateChunk(chunk.id)}
          disabled={running}
          aria-label={`Regenerate chunk ${chunk.index + 1} with a new seed`}
          className="rounded px-1 text-xs text-muted hover:text-text disabled:opacity-30"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={() => {
            setEditText(chunk.text);
            setEditOpen(true);
          }}
          disabled={running}
          aria-label={`Edit text of chunk ${chunk.index + 1}`}
          className="rounded px-1 text-xs text-muted hover:text-text disabled:opacity-30"
        >
          ✎
        </button>
      </span>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edit chunk ${chunk.index + 1}`}
      >
        <Textarea
          rows={5}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          aria-label="Chunk text"
        />
        <p className="mt-1 font-mono text-[11px] tabular-nums text-muted">
          {editText.length} chars {editText.length > 240 ? "— over 240, may drift" : ""}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!editText.trim()}
            onClick={() => {
              setEditOpen(false);
              void regenerateChunk(chunk.id, editText);
            }}
          >
            Save &amp; regenerate
          </Button>
        </div>
      </Dialog>
    </li>
  );
}
