"use client";

import type { ReactNode } from "react";

export type Tone = "audio" | "video" | "live" | "danger" | "neutral";

const TONES: Record<Tone, { wrap: string; dot: string }> = {
  audio: { wrap: "border-audio/30 text-audio bg-audioSoft", dot: "bg-audio" },
  video: { wrap: "border-video/30 text-video bg-videoSoft", dot: "bg-video" },
  live: { wrap: "border-live/30 text-live bg-liveSoft", dot: "bg-live" },
  danger: { wrap: "border-danger/30 text-danger bg-dangerSoft", dot: "bg-danger" },
  neutral: { wrap: "border-line text-muted bg-surface2", dot: "bg-faint" },
};

/**
 * Status chip. `dot` pairs colour with a shape so state is never carried by
 * colour alone; `pulse` marks genuinely live activity.
 */
export function Badge({
  children,
  tone = "neutral",
  dot = false,
  pulse = false,
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${t.wrap} ${className}`}
    >
      {dot ? (
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${t.dot} ${pulse ? "animate-breathe" : ""}`}
        />
      ) : null}
      {children}
    </span>
  );
}
