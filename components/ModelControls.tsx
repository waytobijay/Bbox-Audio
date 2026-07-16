"use client";

import { useState } from "react";
import { LANGUAGES, MODEL_INFO } from "@/lib/config";
import { formatDuration } from "@/lib/audio";
import { useApp } from "@/lib/store";
import { toast } from "@/lib/toast";
import type { ModelId } from "@/lib/types";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
import { Slider } from "./ui/Slider";

interface AbResult {
  model: ModelId;
  url: string;
  genSeconds: number;
  durationSec: number;
}

function AbCompareDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const chunks = useApp((s) => s.project.chunks);
  const params = useApp((s) => s.project.params);
  const generateOnce = useApp((s) => s.generateOnce);
  const setModel = useApp((s) => s.setModel);
  const modelsLoaded = useApp((s) => s.backend.modelsLoaded);

  const [chunkId, setChunkId] = useState<string>("");
  const [busy, setBusy] = useState<ModelId | null>(null);
  const [results, setResults] = useState<AbResult[]>([]);

  const chunk = chunks.find((c) => c.id === chunkId) ?? chunks[0];

  async function run() {
    if (!chunk) return;
    setResults([]);
    try {
      // sequential on purpose — one GPU
      for (const model of ["chatterbox", "qwen3"] as ModelId[]) {
        if (!modelsLoaded.includes(model)) continue;
        setBusy(model);
        const r = await generateOnce(chunk.text, model, params.seed + chunk.index);
        setResults((prev) => [
          ...prev,
          {
            model,
            url: URL.createObjectURL(r.blob),
            genSeconds: r.genSeconds,
            durationSec: r.durationSec,
          },
        ]);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "A/B generation failed.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="A/B compare" wide>
      <p className="mb-3 text-sm text-muted">
        Generates one chunk on both models, back to back. Twenty seconds of listening
        here saves regenerating twenty minutes of audio.
      </p>
      <label htmlFor="ab-chunk" className="mb-1 block text-xs font-medium text-muted">
        Chunk
      </label>
      <Select
        id="ab-chunk"
        value={chunk?.id ?? ""}
        onChange={(e) => setChunkId(e.target.value)}
        className="mb-3"
      >
        {chunks.map((c) => (
          <option key={c.id} value={c.id}>
            {String(c.index + 1).padStart(2, "0")} · {c.text.slice(0, 60)}
            {c.text.length > 60 ? "…" : ""}
          </option>
        ))}
      </Select>
      <Button variant="primary" disabled={!chunk || busy !== null} onClick={() => void run()}>
        {busy ? `Generating on ${MODEL_INFO[busy].name}…` : "Generate both"}
      </Button>
      <div className="mt-4 flex flex-col gap-3">
        {results.map((r) => (
          <div key={r.model} className="rounded-md border border-rule p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">{MODEL_INFO[r.model].name}</span>
              <span className="font-mono text-[11px] tabular-nums text-muted">
                {formatDuration(r.durationSec)} audio · {r.genSeconds.toFixed(1)}s to generate
              </span>
            </div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls src={r.url} className="mb-2 h-9 w-full" />
            <Button
              size="sm"
              onClick={() => {
                setModel(r.model);
                toast(`Model set to ${MODEL_INFO[r.model].name}.`, "success");
                onClose();
              }}
            >
              Use {MODEL_INFO[r.model].name}
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

export function ModelControls() {
  const model = useApp((s) => s.project.model);
  const params = useApp((s) => s.project.params);
  const setModel = useApp((s) => s.setModel);
  const setParams = useApp((s) => s.setParams);
  const running = useApp((s) => s.queue.running);
  const connected = useApp((s) => s.backend.connected);
  const modelsLoaded = useApp((s) => s.backend.modelsLoaded);
  const hasVoice = useApp((s) => !!s.project.voiceId);
  const hasChunks = useApp((s) => s.project.chunks.length > 0);
  const [abOpen, setAbOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Model" className="flex flex-col gap-2">
        {(Object.keys(MODEL_INFO) as ModelId[]).map((id) => {
          const loaded = !connected || modelsLoaded.includes(id);
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={model === id}
              disabled={running || !loaded}
              onClick={() => setModel(id)}
              className={`rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-40 ${
                model === id ? "border-text bg-desk" : "border-rule bg-panel hover:border-muted"
              }`}
            >
              <span className="block text-sm font-medium">
                {MODEL_INFO[id].name}
                {!loaded ? " — not loaded" : ""}
              </span>
              <span className="block text-[11px] leading-snug text-muted">
                {MODEL_INFO[id].blurb}
              </span>
            </button>
          );
        })}
      </div>

      <div>
        <label htmlFor="language" className="mb-1 block text-xs font-medium text-muted">
          Language
        </label>
        <Select
          id="language"
          value={params.language}
          disabled={running}
          onChange={(e) => setParams({ language: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-[11px] leading-snug text-muted/80">
          No Nepali in the models yet — Hindi is the closest supported option.
        </p>
      </div>

      {model === "chatterbox" ? (
        <>
          <Slider
            label="Expressiveness"
            value={params.exaggeration}
            min={0.25}
            max={2}
            step={0.05}
            disabled={running}
            onChange={(v) => setParams({ exaggeration: v })}
            hint="0.4 for factual narration. Above 0.8 gets theatrical."
          />
          <Slider
            label="Adherence to voice"
            value={params.cfg}
            min={0.2}
            max={1}
            step={0.05}
            disabled={running}
            onChange={(v) => setParams({ cfg: v })}
          />
          <Slider
            label="Variation"
            value={params.temperature}
            min={0.5}
            max={1}
            step={0.05}
            disabled={running}
            onChange={(v) => setParams({ temperature: v })}
          />
        </>
      ) : (
        <div>
          <label htmlFor="style-prompt" className="mb-1 block text-xs font-medium text-muted">
            Delivery style
          </label>
          <Input
            id="style-prompt"
            value={params.stylePrompt}
            disabled={running}
            onChange={(e) => setParams({ stylePrompt: e.target.value })}
            placeholder="Calm, clear, informative narration"
          />
        </div>
      )}

      <div>
        <label htmlFor="seed" className="mb-1 block text-xs font-medium text-muted">
          Seed — same seed + same text = same audio
        </label>
        <div className="flex gap-2">
          <Input
            id="seed"
            type="number"
            className="font-mono tabular-nums"
            value={params.seed}
            disabled={running}
            onChange={(e) => setParams({ seed: Math.floor(Number(e.target.value)) || 0 })}
          />
          <Button
            aria-label="Randomize seed"
            disabled={running}
            onClick={() => setParams({ seed: Math.floor(Math.random() * 1_000_000) })}
          >
            🎲
          </Button>
        </div>
      </div>

      <Button
        disabled={running || !connected || !hasVoice || !hasChunks || modelsLoaded.length < 2}
        onClick={() => setAbOpen(true)}
        title={
          modelsLoaded.length < 2 && connected
            ? "Both models need to be loaded on the backend"
            : undefined
        }
      >
        A/B compare a chunk
      </Button>
      <AbCompareDialog open={abOpen} onClose={() => setAbOpen(false)} />
    </div>
  );
}
