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
  const pct = indeterminate ? 100 : Math.min(100, Math.max(0, ((value ?? 0) / max) * 100));
  const fill = tone === "video" ? "bg-video" : tone === "live" ? "bg-live" : "bg-audio";
  return (
    <div
      className="relative h-1.5 w-full overflow-hidden rounded-full bg-surface3"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : Math.round(value ?? 0)}
      aria-label={label}
    >
      <div
        className={`relative h-full rounded-full transition-[width] duration-500 ease-out ${fill} ${
          indeterminate ? "opacity-30" : ""
        }`}
        style={{ width: `${pct}%` }}
      />
      {indeterminate ? (
        <div className={`shimmer absolute inset-0 overflow-hidden rounded-full`} />
      ) : null}
    </div>
  );
}
