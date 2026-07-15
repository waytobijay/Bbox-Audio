"use client";

import { useToasts } from "@/lib/toast";

const KIND_STYLES = {
  info: "border-rule",
  success: "border-ready/40",
  error: "border-[#f0857a]/40",
} as const;

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start justify-between gap-3 rounded-md border bg-panel px-3 py-2.5 text-sm shadow-lg shadow-black/30 ${KIND_STYLES[t.kind]}`}
        >
          <span>{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss notification"
            className="text-muted hover:text-text"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
