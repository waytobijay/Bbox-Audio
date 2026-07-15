"use client";

import JSZip from "jszip";
import { useState } from "react";
import {
  buildSrt,
  computeSrtEntries,
  encodeMp3,
  encodeWavPcm16,
  peakNormalize,
  stitchChunks,
  wavBlobToPcm,
  type GapConfig,
} from "@/lib/audio";
import { PARAGRAPH_GAP_SEC, SENTENCE_GAP_SEC } from "@/lib/config";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { Chunk } from "@/lib/types";
import { Button } from "./ui/Button";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "narration";
}

export function ExportBar() {
  const chunks = useApp((s) => s.project.chunks);
  const projectName = useApp((s) => s.project.name);
  const running = useApp((s) => s.queue.running);
  const [gaps, setGaps] = useState<GapConfig>({
    sentenceGapSec: SENTENCE_GAP_SEC,
    paragraphGapSec: PARAGRAPH_GAP_SEC,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const done = chunks.filter(
    (c): c is Chunk & { audioBlob: Blob; durationSec: number } =>
      c.status === "done" && !!c.audioBlob && c.durationSec !== undefined
  );
  const partial = done.length > 0 && done.length < chunks.length;
  const base = slug(projectName);

  async function stitched() {
    const items = await Promise.all(
      done.map(async (c) => ({
        audio: await wavBlobToPcm(c.audioBlob),
        isParagraphEnd: c.isParagraphEnd,
      }))
    );
    return peakNormalize(stitchChunks(items, gaps));
  }

  async function run(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed.", "error");
    } finally {
      setBusy(null);
    }
  }

  const exportWav = () =>
    run("wav", async () => {
      download(encodeWavPcm16(await stitched()), `${base}.wav`);
    });

  const exportMp3 = () =>
    run("mp3", async () => {
      download(encodeMp3(await stitched()), `${base}.mp3`);
    });

  const exportZip = () =>
    run("zip", async () => {
      const zip = new JSZip();
      for (const c of done) {
        zip.file(`chunk-${String(c.index + 1).padStart(3, "0")}.wav`, c.audioBlob);
      }
      download(await zip.generateAsync({ type: "blob" }), `${base}-chunks.zip`);
    });

  const exportSrt = () =>
    run("srt", () => {
      const entries = computeSrtEntries(
        done.map((c) => ({
          text: c.text,
          durationSec: c.durationSec,
          isParagraphEnd: c.isParagraphEnd,
        })),
        gaps
      );
      download(new Blob([buildSrt(entries)], { type: "text/plain" }), `${base}.srt`);
      return Promise.resolve();
    });

  if (done.length === 0) return null;

  const disabled = running || busy !== null;

  return (
    <div className="flex flex-col gap-2 border-t border-rule pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted">Export</h3>
        {partial ? (
          <span className="font-mono text-[11px] tabular-nums text-muted">
            {done.length}/{chunks.length} chunks ready
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted">
        <label className="flex items-center gap-1.5">
          Sentence gap
          <input
            type="number"
            min={0}
            max={3}
            step={0.05}
            value={gaps.sentenceGapSec}
            onChange={(e) => setGaps((g) => ({ ...g, sentenceGapSec: Number(e.target.value) }))}
            className="w-16 rounded border border-rule bg-desk px-1.5 py-0.5 font-mono tabular-nums text-text"
          />
          s
        </label>
        <label className="flex items-center gap-1.5">
          Paragraph
          <input
            type="number"
            min={0}
            max={5}
            step={0.05}
            value={gaps.paragraphGapSec}
            onChange={(e) => setGaps((g) => ({ ...g, paragraphGapSec: Number(e.target.value) }))}
            className="w-16 rounded border border-rule bg-desk px-1.5 py-0.5 font-mono tabular-nums text-text"
          />
          s
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="primary" size="sm" disabled={disabled} onClick={exportWav}>
          {busy === "wav" ? "Stitching…" : "Export WAV"}
        </Button>
        <Button size="sm" disabled={disabled} onClick={exportMp3}>
          {busy === "mp3" ? "Encoding…" : "MP3"}
        </Button>
        <Button size="sm" disabled={disabled} onClick={exportZip}>
          {busy === "zip" ? "Zipping…" : "chunks.zip"}
        </Button>
        <Button size="sm" disabled={disabled} onClick={exportSrt}>
          transcript.srt
        </Button>
      </div>
    </div>
  );
}
