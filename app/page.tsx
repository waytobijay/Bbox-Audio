"use client";

import { useEffect, useState } from "react";
import { BackendPanel } from "@/components/BackendPanel";
import { ChunkList } from "@/components/ChunkList";
import { ModelControls } from "@/components/ModelControls";
import { ScriptEditor } from "@/components/ScriptEditor";
import { VoiceLab } from "@/components/VoiceLab";
import { Toaster } from "@/components/ui/Toast";
import { useApp } from "@/lib/store";

type Tab = "voice" | "script" | "queue";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "voice", label: "Voice" },
  { id: "script", label: "Script" },
  { id: "queue", label: "Queue" },
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
  const [tab, setTab] = useState<Tab>("voice");

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Don't let a laptop lid or tab close nuke a run silently.
  useEffect(() => {
    if (!generating) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [generating]);

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      <BackendPanel />

      {/* mobile tab bar */}
      <nav
        aria-label="Studio sections"
        className="sticky top-[57px] z-20 flex border-b border-rule bg-desk lg:hidden"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
            className={`flex-1 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-text text-text"
                : "border-transparent text-muted hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="mx-auto grid w-full max-w-[1600px] flex-1 grid-cols-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[320px_minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)]">
        {!hydrated ? (
          <div className="col-span-full flex items-center justify-center py-24 text-sm text-muted">
            Loading session…
          </div>
        ) : (
          <>
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
          </>
        )}
      </main>

      <Toaster />
    </div>
  );
}
