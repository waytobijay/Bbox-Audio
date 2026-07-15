"use client";

import { useMemo } from "react";
import { formatDuration } from "@/lib/audio";
import { EST_CHARS_PER_SEC } from "@/lib/config";
import { estimateChunkSeconds } from "@/lib/chunker";
import { useApp } from "@/lib/store";
import { ChunkRow } from "./ChunkRow";
import { ExportBar } from "./ExportBar";
import { Button } from "./ui/Button";

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
    const remaining = chunks.filter(
      (c) => c.status === "pending" || c.status === "generating"
    ).length;
    const doneSec = done.reduce((acc, c) => acc + (c.durationSec ?? 0), 0);
    const maxSec = Math.max(
      0,
      ...chunks.map((c) =>
        c.status === "done" && c.durationSec !== undefined
          ? c.durationSec
          : estimateChunkSeconds(c.charCount, EST_CHARS_PER_SEC)
      )
    );
    return { doneCount: done.length, remaining, doneSec, maxSec };
  }, [chunks]);

  const etaSec = queue.avgGenSec > 0 ? stats.remaining * queue.avgGenSec : null;
  const hasResumable = chunks.some((c) => c.status === "failed" || c.status === "pending");
  const hasDone = stats.doneCount > 0;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* screen-reader progress announcements */}
      <div aria-live="polite" className="visually-hidden">
        {announcement}
      </div>

      {queue.offline ? (
        <div className="rounded-md border border-signal/40 bg-signal/5 px-3 py-2 text-xs leading-relaxed">
          Backend went offline. {stats.doneCount} of {chunks.length} chunks are saved —
          nothing is lost. Re-run Cell 3 in Colab, reconnect with the new URL, then hit{" "}
          <strong>Generate remaining</strong>.
        </div>
      ) : null}

      {chunks.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-rule p-6 text-center text-sm text-muted">
          {!connected ? (
            <>
              <p>
                Run the Colab notebook, paste the URL it prints into the field up top.
                Takes about 4 minutes.
              </p>
              <p className="text-xs text-muted/80">
                The notebook is at{" "}
                <code className="font-mono text-[11px]">colab/voiceforge_server.ipynb</code>{" "}
                in this repo — upload it at{" "}
                <a
                  href="https://colab.research.google.com"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-text"
                >
                  colab.research.google.com
                </a>
                .
              </p>
            </>
          ) : (
            <p>Chunks appear here once you add a script.</p>
          )}
        </div>
      ) : (
        <>
          {/* progress line */}
          <div className="font-mono text-xs tabular-nums text-muted">
            <span className="text-text">
              {stats.doneCount}/{chunks.length}
            </span>{" "}
            · {formatDuration(stats.doneSec)} of audio
            {queue.running && etaSec !== null && stats.remaining > 0
              ? ` · ~${formatDuration(etaSec)} remaining`
              : ""}
            {queue.paused ? " · paused" : ""}
          </div>

          {/* the queue rail */}
          <ol className="-mx-2 min-h-0 flex-1 overflow-y-auto">
            {chunks.map((c) => (
              <ChunkRow key={c.id} chunk={c} maxSec={stats.maxSec} />
            ))}
          </ol>

          {/* controls */}
          <div className="flex flex-wrap gap-2 border-t border-rule pt-3">
            {queue.running ? (
              <>
                {queue.paused ? (
                  <Button className="flex-1" onClick={resumeGeneration}>
                    Resume
                  </Button>
                ) : (
                  <Button className="flex-1" onClick={pauseGeneration}>
                    Pause
                  </Button>
                )}
                <Button variant="danger" onClick={stopGeneration}>
                  Stop
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
                  Generate all
                </Button>
                {hasDone && hasResumable ? (
                  <Button
                    className="flex-1"
                    disabled={!connected}
                    onClick={() => void startGeneration("remaining")}
                  >
                    Generate remaining
                  </Button>
                ) : null}
              </>
            )}
          </div>

          <ExportBar />
        </>
      )}
    </div>
  );
}
