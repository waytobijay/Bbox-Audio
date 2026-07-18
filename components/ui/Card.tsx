"use client";

import type { ReactNode } from "react";

export type Accent = "audio" | "video" | "neutral";

const RING: Record<Accent, string> = {
  audio: "hover:border-audio/40",
  video: "hover:border-video/40",
  neutral: "hover:border-lineStrong",
};

export function Card({
  children,
  className = "",
  accent = "neutral",
  interactive = false,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  accent?: Accent;
  interactive?: boolean;
  padded?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-line bg-surface shadow-card transition-colors duration-200 ${
        padded ? "p-5 sm:p-6" : ""
      } ${interactive ? RING[accent] : ""} ${className}`}
    >
      {/* top-light hairline — reads as a physical edge, not a border */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px hairline" />
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  icon,
  accent = "neutral",
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  accent?: Accent;
  action?: ReactNode;
}) {
  const tone =
    accent === "audio"
      ? "bg-audioSoft text-audio"
      : accent === "video"
        ? "bg-videoSoft text-video"
        : "bg-surface3 text-muted";
  return (
    <div className="mb-5 flex items-start gap-3.5">
      {icon ? (
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${tone}`}>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-[15px] font-semibold leading-tight text-ink">{title}</h2>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Small uppercase label that opens a group of controls inside a card. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line px-6 py-10 text-center">
      {icon ? (
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface2 text-faint">
          {icon}
        </span>
      ) : null}
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {children ? (
          <div className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
            {children}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
