"use client";

import { useToasts } from "@/lib/toast";
import { IconAlert, IconCheck, IconX } from "./Icons";

const KIND = {
  info: { ring: "border-line", tone: "text-muted", Icon: IconSparkleDot },
  success: { ring: "border-audio/30", tone: "text-audio", Icon: IconCheck },
  error: { ring: "border-danger/30", tone: "text-danger", Icon: IconAlert },
} as const;

function IconSparkleDot({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(380px,calc(100vw-2.5rem))] flex-col gap-2.5"
    >
      {toasts.map((t) => {
        const k = KIND[t.kind];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex animate-fade-up items-start gap-3 rounded-xl border bg-surface2/95 px-4 py-3 shadow-lift backdrop-blur ${k.ring}`}
          >
            <k.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${k.tone}`} />
            <span className="flex-1 text-[13px] leading-relaxed text-ink">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="-mr-1 -mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-surface3 hover:text-ink"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
