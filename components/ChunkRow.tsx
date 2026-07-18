"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/audio";
import { estimateChunkSeconds } from "@/lib/chunker";
import { EST_CHARS_PER_SEC } from "@/lib/config";
import { useApp } from "@/lib/store";
import type { Chunk } from "@/lib/types";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { IconCheck, IconEdit, IconPause, IconPlay, IconRefresh, IconX } from "./ui/Icons";
import { Textarea } from "./ui/Input";

/** Only one chunk plays at a time. */
let currentStop: (() => void) | null = null;

export function ChunkRow({ chunk, maxSec }: { chunk: Chunk; maxSec: number }) {
  const regenerateChunk = useApp((s) => s.regenerateChunk);
  const running = useApp((s) => s.queue.running);
  const [playing, setPlaying] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState(chunk.text);
  const urlRef = useRef<string | null>(null);

  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), []);

  const seconds =
    chunk.status === "done" && chunk.durationSec !== undefined
      ? chunk.durationSec
      : estimateChunkSeconds(chunk.charCount, EST_CHARS_PER_SEC);
  const widthPct = maxSec > 0 ? Math.max(5, (seconds / maxSec) * 100) : 5;

  const bar =
    chunk.status === "done"
      ? "bg-audio"
      : chunk.status === "generating"
        ? "bg-live animate-breathe"
        : chunk.status === "failed"
          ? "bg-danger/60"
          : "bg-surface3";

  function togglePlay() {
    if (playing) {
      currentStop?.();
      return;
    }
    if (!chunk.audioBlob) return;
    currentStop?.();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(chunk.audioBlob);
    const audio = new Audio(urlRef.current);
    currentStop = () => {
      audio.pause();
      setPlaying(false);
      currentStop = null;
    };
    audio.onended = () => currentStop?.();
    void audio.play();
    setPlaying(true);
  }

  return (
    <li
      className="group flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface2"
      title={chunk.status === "failed" ? chunk.error : chunk.text}
    >
      <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">
        {String(chunk.index + 1).padStart(2, "0")}
      </span>

      {/* status glyph — colour is always paired with a shape */}
      <span className="w-4 shrink-0" aria-hidden>
        {chunk.status === "done" ? (
          <IconCheck className="h-3.5 w-3.5 text-audio" />
        ) : chunk.status === "failed" ? (
          <IconX className="h-3.5 w-3.5 text-danger" />
        ) : chunk.status === "generating" ? (
          <span className="block h-2 w-2 rounded-full bg-live animate-breathe" />
        ) : (
          <span className="block h-1.5 w-1.5 rounded-full bg-surface3" />
        )}
      </span>
      <span className="visually-hidden">{chunk.status}</span>

      {/* duration bar — width is proportional to the audio it produced */}
      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface2">
        <span
          className={`block h-full rounded-full transition-all duration-500 ${bar}`}
          style={{ width: `${widthPct}%` }}
        />
      </span>

      <span className="w-8 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">
        {chunk.status === "done" ? formatDuration(seconds) : "–"}
      </span>

      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={togglePlay}
          disabled={chunk.status !== "done"}
          aria-label={playing ? `Pause chunk ${chunk.index + 1}` : `Play chunk ${chunk.index + 1}`}
          className="grid h-7 w-7 place-items-center rounded-md text-faint transition-colors hover:bg-surface3 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {playing ? <IconPause className="h-3.5 w-3.5" /> : <IconPlay className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => void regenerateChunk(chunk.id)}
          disabled={running}
          aria-label={`Regenerate chunk ${chunk.index + 1}`}
          className="grid h-7 w-7 place-items-center rounded-md text-faint transition-colors hover:bg-surface3 hover:text-ink disabled:opacity-30"
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            setEditText(chunk.text);
            setEditOpen(true);
          }}
          disabled={running}
          aria-label={`Edit chunk ${chunk.index + 1}`}
          className="grid h-7 w-7 place-items-center rounded-md text-faint transition-colors hover:bg-surface3 hover:text-ink disabled:opacity-30"
        >
          <IconEdit className="h-3.5 w-3.5" />
        </button>
      </span>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title={`Edit chunk ${chunk.index + 1}`}
        description="Reword anything that came out awkward, then regenerate just this chunk."
      >
        <Textarea rows={5} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Chunk text" />
        <p className="mt-2 font-mono text-[11px] tabular-nums text-faint">
          {editText.length} chars{editText.length > 240 ? " — over 240, the model may drift" : ""}
        </p>
        <div className="mt-5 flex justify-end gap-2">
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
