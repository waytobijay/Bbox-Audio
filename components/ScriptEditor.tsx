"use client";

import { useMemo, useState } from "react";
import { WORDS_PER_MINUTE } from "@/lib/config";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import { Textarea } from "./ui/Input";

function Stats({ raw, chunkCount }: { raw: string; chunkCount: number }) {
  const chars = raw.length;
  const words = raw.trim() ? raw.trim().split(/\s+/).length : 0;
  const minutes = words / WORDS_PER_MINUTE;
  return (
    <p className="font-mono text-[11px] tabular-nums text-muted">
      {chars.toLocaleString()} chars · {words.toLocaleString()} words · ~
      {minutes < 1 ? `${Math.ceil(minutes * 60)} sec` : `${Math.round(minutes)} min`} spoken ·{" "}
      {chunkCount} chunks
    </p>
  );
}

export function ScriptEditor() {
  const scriptRaw = useApp((s) => s.project.scriptRaw);
  const chunks = useApp((s) => s.project.chunks);
  const setScript = useApp((s) => s.setScript);
  const running = useApp((s) => s.queue.running);
  const [showNormalized, setShowNormalized] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const normalizedPreview = useMemo(
    () =>
      chunks
        .map((c) => c.text + (c.isParagraphEnd ? "\n" : ""))
        .join("\n")
        .trim(),
    [chunks]
  );

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (running) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name)) {
      toast("Drop a .txt or .md file.", "error");
      return;
    }
    setScript(await file.text());
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div
        className={`relative flex min-h-[240px] flex-1 flex-col ${
          dragOver ? "outline-dashed outline-2 outline-ready/60" : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => void onDrop(e)}
      >
        <Textarea
          aria-label="Narration script"
          className="min-h-[240px] flex-1 font-body leading-relaxed"
          placeholder={
            "Paste your narration script. It'll be split into chunks automatically.\n\n" +
            "Blank line = paragraph break = longer pause.\n" +
            "A line with just --- forces a chunk break."
          }
          value={scriptRaw}
          onChange={(e) => setScript(e.target.value)}
          disabled={running}
        />
        {running ? (
          <p className="mt-1 text-[11px] text-muted">
            Script is locked while the queue is running.
          </p>
        ) : null}
      </div>

      <Stats raw={scriptRaw} chunkCount={chunks.length} />

      {chunks.length > 0 ? (
        <div className="min-h-0 rounded-md border border-rule">
          <div className="flex items-center justify-between border-b border-rule px-3 py-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted">
              Chunk preview
            </h3>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
              <input
                type="checkbox"
                checked={showNormalized}
                onChange={(e) => setShowNormalized(e.target.checked)}
                className="accent-[#5EE6A8]"
              />
              Show normalized
            </label>
          </div>
          {showNormalized ? (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-body text-xs leading-relaxed text-text">
              {normalizedPreview}
            </pre>
          ) : (
            <ol className="max-h-64 overflow-y-auto py-1">
              {chunks.map((c) => (
                <li
                  key={c.id}
                  className={`flex items-baseline gap-2 px-3 py-1 text-xs ${
                    c.isParagraphEnd ? "mb-1 border-b border-rule/60 pb-2" : ""
                  }`}
                >
                  <span className="shrink-0 font-mono tabular-nums text-muted">
                    {String(c.index + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={`shrink-0 font-mono tabular-nums ${
                      c.charCount > 240 ? "text-signal" : "text-muted/70"
                    }`}
                  >
                    {c.charCount}c
                  </span>
                  <span className="truncate text-text/80">{c.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}
