"use client";

import type { ReactNode } from "react";
import { useApp } from "@/lib/store";
import { useVideo } from "@/lib/videoStore";
import { ConnectionsControl } from "./Connections";
import { Badge } from "./ui/Badge";
import { IconHome, IconVideo, IconWave } from "./ui/Icons";

export type ViewId = "home" | "speech" | "video";

const NAV: Array<{ id: ViewId; label: string; Icon: typeof IconHome }> = [
  { id: "home", label: "Home", Icon: IconHome },
  { id: "speech", label: "Text to Speech", Icon: IconWave },
  { id: "video", label: "AI Video", Icon: IconVideo },
];

function NavItem({
  id,
  label,
  Icon,
  active,
  onSelect,
  badge,
}: {
  id: ViewId;
  label: string;
  Icon: typeof IconHome;
  active: boolean;
  onSelect(id: ViewId): void;
  badge?: ReactNode;
}) {
  const accent = id === "video" ? "text-video" : id === "speech" ? "text-audio" : "text-ink";
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={active ? "page" : undefined}
      className={`group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-150 ${
        active ? "bg-surface2 text-ink" : "text-muted hover:bg-surface2/60 hover:text-ink"
      }`}
    >
      <Icon className={`h-[18px] w-[18px] ${active ? accent : "text-faint group-hover:text-muted"}`} />
      <span className="flex-1 text-left">{label}</span>
      {badge}
    </button>
  );
}

export function Shell({
  view,
  onViewChange,
  children,
}: {
  view: ViewId;
  onViewChange(v: ViewId): void;
  children: ReactNode;
}) {
  const queueRunning = useApp((s) => s.queue.running);
  const doneCount = useApp((s) => s.project.chunks.filter((c) => c.status === "done").length);
  const totalCount = useApp((s) => s.project.chunks.length);
  const videoBusy = useVideo((s) => s.job.status === "processing");

  const speechBadge = queueRunning ? (
    <Badge tone="live" dot pulse>
      {doneCount}/{totalCount}
    </Badge>
  ) : null;
  const videoBadge = videoBusy ? (
    <Badge tone="live" dot pulse>
      live
    </Badge>
  ) : null;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:flex-row">
      {/* ---------- sidebar (desktop) ---------- */}
      <aside className="relative hidden w-[248px] shrink-0 flex-col border-r border-line bg-surface/60 px-4 py-5 backdrop-blur lg:flex">
        <div className="mb-7 flex items-center gap-2.5 px-1">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-audio text-[#06231A]">
            <IconWave className="h-[18px] w-[18px]" />
          </span>
          <span className="font-display text-[15px] font-bold tracking-tight text-ink">
            VoiceForge
          </span>
        </div>

        <nav className="flex flex-col gap-1" aria-label="Main">
          {NAV.map((n) => (
            <NavItem
              key={n.id}
              {...n}
              active={view === n.id}
              onSelect={onViewChange}
              badge={n.id === "speech" ? speechBadge : n.id === "video" ? videoBadge : undefined}
            />
          ))}
        </nav>

        <div className="mt-auto space-y-3 pt-6">
          <p className="px-1 text-[11px] leading-relaxed text-faint">
            Runs on your own free Colab GPU. Nothing leaves your browser except to your session.
          </p>
        </div>
      </aside>

      {/* ---------- main ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-bg/80 px-4 py-3 backdrop-blur-xl sm:px-6">
          <span className="flex items-center gap-2 lg:hidden">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-audio text-[#06231A]">
              <IconWave className="h-4 w-4" />
            </span>
            <span className="font-display text-sm font-bold text-ink">VoiceForge</span>
          </span>
          <div className="ml-auto">
            <ConnectionsControl />
          </div>
        </header>

        {/* mobile nav */}
        <nav
          aria-label="Main"
          className="sticky top-[57px] z-20 flex gap-1 border-b border-line bg-bg/90 px-3 py-2 backdrop-blur lg:hidden"
        >
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onViewChange(id)}
              aria-current={view === id ? "page" : undefined}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[13px] font-medium transition-colors ${
                view === id ? "bg-surface2 text-ink" : "text-muted"
              }`}
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{id === "speech" ? "Speech" : id === "video" ? "Video" : "Home"}</span>
            </button>
          ))}
        </nav>

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
