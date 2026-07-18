"use client";

import { useMemo, useState } from "react";
import { WORDS_PER_MINUTE } from "@/lib/config";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import { IconUpload } from "./ui/Icons";
import { Textarea } from "./ui/Input";

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-[13px] font-medium tabular-nums text-ink">{value}</span>
      <span className="text-[11px] text-faint">{label}</span>
    </div>
  );
}

export function ScriptEditor() {
  const scriptRaw = useApp((s) => s.project.scriptRaw);
  const chunks = useApp((s) => s.project.chunks);
  const setScript = useApp((s) => s.setScript);
  const running = useApp((s) => s.queue.running);
  const [showNormalized, setShowNormalized] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const words = scriptRaw.trim() ? scriptRaw.trim().split(/\s+/).length : 0;
  const minutes = words / WORDS_PER_MINUTE;

  const normalizedPreview = useMemo(
    () => chunks.map((c) => c.text + (c.isParagraphEnd ? "\n" : "")).join("\n").trim(),
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
    <div className="flex flex-col gap-4">
      <div
        className={`relative rounded-xl transition-shadow ${
          dragOver ? "shadow-glow" : ""
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
          className="min-h-[240px] text-[14.5px] lg:min-h-[300px]"
          placeholder={
            "Paste your narration script here…\n\n" +
            "Blank line = paragraph break = a longer pause.\n" +
            "A line containing only --- forces a chunk break."
          }
          value={scriptRaw}
          onChange={(e) => setScript(e.target.value)}
          disabled={running}
        />
        {dragOver ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-xl bg-bg/80">
            <span className="flex items-center gap-2 text-sm font-medium text-audio">
              <IconUpload className="h-4 w-4" /> Drop your .txt or .md file
            </span>
          </div>
        ) : null}
      </div>

      {running ? (
        <p className="text-[12px] text-faint">The script is locked while generation is running.</p>
      ) : null}

      {/* stats */}
      <div className="flex flex-wrap items-center gap-x-7 gap-y-3 rounded-xl border border-line bg-surface2/50 px-4 py-3">
        <Stat value={scriptRaw.length.toLocaleString()} label="characters" />
        <Stat value={words.toLocaleString()} label="words" />
        <Stat
          value={minutes < 1 ? `${Math.ceil(minutes * 60)}s` : `${Math.round(minutes)}m`}
          label="spoken"
        />
        <Stat value={String(chunks.length)} label="chunks" />
        {chunks.length > 0 ? (
          <label className="ml-auto flex cursor-pointer select-none items-center gap-2 text-[12px] text-muted">
            <input
              type="checkbox"
              checked={showNormalized}
              onChange={(e) => setShowNormalized(e.target.checked)}
              className="h-3.5 w-3.5 rounded accent-[#4ADE9F]"
            />
            Show pronunciation
          </label>
        ) : null}
      </div>

      {/* chunk preview */}
      {chunks.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="border-b border-line bg-surface2/60 px-4 py-2.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
              {showNormalized ? "How it will be pronounced" : "Chunk preview"}
            </h3>
          </div>
          {showNormalized ? (
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap px-4 py-3 font-body text-[13px] leading-relaxed text-muted">
              {normalizedPreview}
            </pre>
          ) : (
            <ol className="max-h-64 overflow-y-auto">
              {chunks.map((c) => (
                <li
                  key={c.id}
                  className={`flex items-baseline gap-3 border-b border-line/60 px-4 py-2 text-[13px] last:border-0 ${
                    c.isParagraphEnd ? "bg-surface2/30" : ""
                  }`}
                >
                  <span className="w-5 shrink-0 font-mono text-[11px] tabular-nums text-faint">
                    {String(c.index + 1).padStart(2, "0")}
                  </span>
                  <span
                    className={`w-11 shrink-0 font-mono text-[11px] tabular-nums ${
                      c.charCount > 240 ? "text-live" : "text-faint"
                    }`}
                  >
                    {c.charCount}c
                  </span>
                  <span className="truncate text-muted">{c.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}
