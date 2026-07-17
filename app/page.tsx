"use client";

import { useEffect, useState } from "react";
import { BackendPanel } from "@/components/BackendPanel";
import { ChunkList } from "@/components/ChunkList";
import { ModelControls } from "@/components/ModelControls";
import { ScriptEditor } from "@/components/ScriptEditor";
import { VideoLab } from "@/components/VideoLab";
import { VoiceLab } from "@/components/VoiceLab";
import { Toaster } from "@/components/ui/Toast";
import { useApp } from "@/lib/store";
import { useVideo } from "@/lib/videoStore";

type View = "studio" | "video";
type Tab = "voice" | "script" | "queue";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "voice", label: "Voice" },
  { id: "script", label: "Script" },
  { id: "queue", label: "Queue" },
];

const VIEWS: Array<{ id: View; label: string }> = [
  { id: "studio", label: "Studio" },
  { id: "video", label: "Video" },
];

function Column({
  title,
  visible,
  children,
}: {
  title: string;
  visible: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`${visible ? "flex" : "hidden"} min-h-0 flex-col rounded-lg border border-rule bg-panel p-4 lg:flex`}
    >
      <h2 className="mb-4 font-display text-xs font-semibold uppercase tracking-[0.25em] text-muted">
        {title}
      </h2>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export default function Studio() {
  const hydrate = useApp((s) => s.hydrate);
  const hydrated = useApp((s) => s.hydrated);
  const generating = useApp((s) => s.queue.running && !s.queue.paused);
  const hydrateVideo = useVideo((s) => s.hydrate);
  const videoProcessing = useVideo((s) => s.job.status === "processing");
  const [view, setView] = useState<View>("studio");
  const [tab, setTab] = useState<Tab>("voice");

  useEffect(() => {
    void hydrate();
    void hydrateVideo();
  }, [hydrate, hydrateVideo]);

  // Don't let a laptop lid or tab close silently nuke a run or a render.
  useEffect(() => {
    if (!generating && !videoProcessing) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [generating, videoProcessing]);

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <BackendPanel />

      {/* view switch — Studio vs Video, all viewports */}
      <div className="sticky top-[57px] z-20 flex items-center gap-1 border-b border-rule bg-desk px-4 py-2">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            aria-current={view === v.id ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              view === v.id ? "bg-panel text-text" : "text-muted hover:text-text"
            }`}
          >
            {v.label}
          </button>
        ))}
        {videoProcessing ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-signal">
            <span aria-hidden className="h-2 w-2 rounded-full bg-signal signal-pulse" />
            rendering video
          </span>
        ) : null}
      </div>

      {/* mobile studio sub-tabs (only in studio view) */}
      {view === "studio" ? (
        <nav
          aria-label="Studio sections"
          className="sticky top-[105px] z-10 flex border-b border-rule bg-desk lg:hidden"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`flex-1 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                tab === t.id ? "border-text text-text" : "border-transparent text-muted hover:text-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      ) : null}

      {!hydrated ? (
        <div className="flex flex-1 items-center justify-center py-24 text-sm text-muted">
          Loading session…
        </div>
      ) : view === "studio" ? (
        <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[320px_minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)]">
          <Column title="Voice" visible={tab === "voice"}>
            <div className="flex flex-col gap-6">
              <VoiceLab />
              <div className="border-t border-rule pt-4">
                <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted">
                  Model
                </h3>
                <ModelControls />
              </div>
            </div>
          </Column>
          <Column title="Script" visible={tab === "script"}>
            <ScriptEditor />
          </Column>
          <Column title="Queue" visible={tab === "queue"}>
            <ChunkList />
          </Column>
        </main>
      ) : (
        <main className="mx-auto w-full max-w-[1600px] flex-1 overflow-y-auto p-4">
          <section
            aria-label="Video"
            className="flex min-h-full flex-col rounded-lg border border-rule bg-panel p-5"
          >
            <div className="mb-4">
              <h2 className="font-display text-xs font-semibold uppercase tracking-[0.25em] text-muted">
                Talking-head video
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-muted">
                Turn a single photo plus your generated narration into a lip-synced video. Runs on a
                separate GPU backend — start <code className="font-mono text-[11px]">colab/voiceforge_video.ipynb</code>{" "}
                after your speech is done.
              </p>
            </div>
            <VideoLab />
          </section>
        </main>
      )}

      <Toaster />
    </div>
  );
}
