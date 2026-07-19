"use client";

export function ProgressBar({
  value,
  max = 100,
  tone = "audio",
  indeterminate = false,
  label,
}: {
  value?: number;
  max?: number;
  tone?: "audio" | "video" | "live";
  indeterminate?: boolean;
  label?: string;
}) {
  const fill = tone === "video" ? "bg-video" : tone === "live" ? "bg-live" : "bg-audio";

  // Indeterminate is a narrow segment that travels. Filling the whole track
  // and dimming it reads as a finished-but-stuck bar, which is worse than
  // showing nothing.
  if (indeterminate) {
    return (
      <div
        className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface3"
        role="progressbar"
        aria-label={label}
      >
        <div className={`absolute inset-y-0 w-1/3 rounded-full ${fill} animate-slide`} />
      </div>
    );
  }

  const pct = Math.min(100, Math.max(0, ((value ?? 0) / max) * 100));
  return (
    <div
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface3"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value ?? 0)}
      aria-label={label}
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ease-out ${fill}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
