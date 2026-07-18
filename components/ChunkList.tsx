"use client";

import { useMemo } from "react";
import { formatDuration } from "@/lib/audio";
import { estimateChunkSeconds } from "@/lib/chunker";
import { EST_CHARS_PER_SEC } from "@/lib/config";
import { useApp } from "@/lib/store";
import { ChunkRow } from "./ChunkRow";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/Card";
import { IconAlert, IconPause, IconPlay, IconScript, IconSparkle, IconX } from "./ui/Icons";
import { ProgressBar } from "./ui/ProgressBar";

export function ChunkList() {
  const chunks = useApp((s) => s.project.chunks);
  const queue = useApp((s) => s.queue);
  const connected = useApp((s) => s.backend.connected);
  const announcement = useApp((s) => s.announcement);
  const startGeneration = useApp((s) => s.startGeneration);
  const pauseGeneration = useApp((s) => s.pauseGeneration);
  const resumeGeneration = useApp((s) => s.resumeGeneration);
  const stopGeneration = useApp((s) => s.stopGeneration);

  const stats = useMemo(() => {
    const done = chunks.filter((c) => c.status === "done");
    const failed = chunks.filter((c) => c.status === "failed").length;
    const remaining = chunks.filter((c) => c.status === "pending" || c.status === "generating").length;
    const doneSec = done.reduce((a, c) => a + (c.durationSec ?? 0), 0);
    const maxSec = Math.max(
      0,
      ...chunks.map((c) =>
        c.status === "done" && c.durationSec !== undefined
          ? c.durationSec
          : estimateChunkSeconds(c.charCount, EST_CHARS_PER_SEC)
      )
    );
    return { doneCount: done.length, failed, remaining, doneSec, maxSec };
  }, [chunks]);

  const etaSec = queue.avgGenSec > 0 ? stats.remaining * queue.avgGenSec : null;
  const hasResumable = chunks.some((c) => c.status === "failed" || c.status === "pending");
  const pct = chunks.length ? (stats.doneCount / chunks.length) * 100 : 0;

  if (chunks.length === 0) {
    return (
      <EmptyState icon={<IconScript className="h-5 w-5" />} title="No chunks yet">
        Add a script above and it will be split into chunks here, ready to generate.
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div aria-live="polite" className="visually-hidden">
        {announcement}
      </div>

      {queue.offline ? (
        <div className="flex gap-3 rounded-xl border border-live/30 bg-liveSoft px-4 py-3">
          <IconAlert className="mt-0.5 h-4 w-4 shrink-0 text-live" />
          <p className="text-[13px] leading-relaxed text-ink">
            The GPU went offline. <strong>{stats.doneCount} of {chunks.length} chunks are saved</strong> —
            nothing is lost. Re-run the notebook, reconnect with the new URL, then pick up with
            Generate remaining.
          </p>
        </div>
      ) : null}

      {/* progress summary */}
      <div className="rounded-xl border border-line bg-surface2/50 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-lg font-semibold tabular-nums text-ink">
              {stats.doneCount}
              <span className="text-faint">/{chunks.length}</span>
            </span>
            <span className="text-[12px] text-muted">chunks</span>
          </div>
          <div className="flex items-center gap-2">
            {stats.failed > 0 ? <Badge tone="danger" dot>{stats.failed} failed</Badge> : null}
            {queue.running ? (
              <Badge tone="live" dot pulse>
                {queue.paused ? "Paused" : "Generating"}
              </Badge>
            ) : null}
          </div>
        </div>
        <ProgressBar
          value={pct}
          tone={queue.running && !queue.paused ? "live" : "audio"}
          label="Generation progress"
        />
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-faint">
          <span>{formatDuration(stats.doneSec)} of audio</span>
          {queue.running && etaSec !== null && stats.remaining > 0 ? (
            <span>~{formatDuration(etaSec)} remaining</span>
          ) : null}
          {queue.avgGenSec > 0 ? <span>{queue.avgGenSec.toFixed(1)}s / chunk</span> : null}
        </div>
      </div>

      {/* the queue */}
      <ol className="-mx-2 max-h-[380px] overflow-y-auto">
        {chunks.map((c) => (
          <ChunkRow key={c.id} chunk={c} maxSec={stats.maxSec} />
        ))}
      </ol>

      {/* controls */}
      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {queue.running ? (
          <>
            {queue.paused ? (
              <Button variant="primary" className="flex-1" onClick={resumeGeneration}>
                <IconPlay className="h-4 w-4" /> Resume
              </Button>
            ) : (
              <Button className="flex-1" onClick={pauseGeneration}>
                <IconPause className="h-4 w-4" /> Pause
              </Button>
            )}
            <Button variant="danger" onClick={stopGeneration}>
              <IconX className="h-4 w-4" /> Stop
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              className="flex-1"
              disabled={!connected}
              onClick={() => void startGeneration("all")}
            >
              <IconSparkle className="h-4 w-4" />
              {stats.doneCount ? "Regenerate all" : "Generate all"}
            </Button>
            {stats.doneCount > 0 && hasResumable ? (
              <Button className="flex-1" disabled={!connected} onClick={() => void startGeneration("remaining")}>
                Generate remaining
              </Button>
            ) : null}
          </>
        )}
      </div>
      {!connected ? (
        <p className="text-[12px] text-faint">Connect the speech engine to start generating.</p>
      ) : null}
    </div>
  );
}
