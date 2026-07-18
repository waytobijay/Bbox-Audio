"use client";

import JSZip from "jszip";
import { useState } from "react";
import {
  buildSrt,
  computeSrtEntries,
  encodeMp3,
  encodeWavPcm16,
  formatDuration,
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
import { Card, CardHeader, FieldLabel } from "./ui/Card";
import { IconDownload } from "./ui/Icons";

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
  const totalSec = done.reduce((a, c) => a + c.durationSec, 0);
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

  const exportWav = () => run("wav", async () => download(encodeWavPcm16(await stitched()), `${base}.wav`));
  const exportMp3 = () => run("mp3", async () => download(encodeMp3(await stitched()), `${base}.mp3`));
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
    <Card>
      <CardHeader
        accent="audio"
        icon={<IconDownload className="h-[18px] w-[18px]" />}
        title="Export"
        description={
          partial
            ? `${done.length} of ${chunks.length} chunks ready · ${formatDuration(totalSec)}`
            : `${formatDuration(totalSec)} of finished narration`
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Sentence gap</FieldLabel>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={3}
              step={0.05}
              value={gaps.sentenceGapSec}
              onChange={(e) => setGaps((g) => ({ ...g, sentenceGapSec: Number(e.target.value) }))}
              className="h-9 w-full rounded-lg border border-line bg-surface2 px-2.5 font-mono text-[13px] tabular-nums text-ink focus:border-audio/60 focus:outline-none"
            />
            <span className="text-[12px] text-faint">s</span>
          </div>
        </label>
        <label className="flex flex-col gap-1.5">
          <FieldLabel>Paragraph gap</FieldLabel>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              max={5}
              step={0.05}
              value={gaps.paragraphGapSec}
              onChange={(e) => setGaps((g) => ({ ...g, paragraphGapSec: Number(e.target.value) }))}
              className="h-9 w-full rounded-lg border border-line bg-surface2 px-2.5 font-mono text-[13px] tabular-nums text-ink focus:border-audio/60 focus:outline-none"
            />
            <span className="text-[12px] text-faint">s</span>
          </div>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="primary" disabled={disabled} onClick={exportWav} className="col-span-2">
          <IconDownload className="h-4 w-4" />
          {busy === "wav" ? "Stitching…" : "Download WAV"}
        </Button>
        <Button size="sm" disabled={disabled} onClick={exportMp3}>
          {busy === "mp3" ? "Encoding…" : "MP3"}
        </Button>
        <Button size="sm" disabled={disabled} onClick={exportZip}>
          {busy === "zip" ? "Zipping…" : "chunks.zip"}
        </Button>
        <Button size="sm" disabled={disabled} onClick={exportSrt} className="col-span-2">
          Captions (.srt)
        </Button>
      </div>
    </Card>
  );
}
