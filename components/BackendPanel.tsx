"use client";

import { useEffect } from "react";
import { HEALTH_POLL_MS } from "@/lib/config";
import { useApp } from "@/lib/store";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

function StatusPill() {
  const backend = useApp((s) => s.backend);
  const connecting = useApp((s) => s.connecting);

  if (connecting) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-rule px-2.5 py-1 text-xs text-muted">
        <span className="h-2 w-2 rounded-full bg-muted signal-pulse" aria-hidden />
        Connecting
      </span>
    );
  }
  if (backend.connected) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-ready/30 px-2.5 py-1 text-xs text-ready">
        <span className="h-2 w-2 rounded-full bg-ready" aria-hidden />
        Live
        {backend.gpu ? (
          <span className="hidden font-mono text-[11px] tabular-nums text-muted sm:inline">
            {backend.gpu}
            {backend.latencyMs !== undefined ? ` · ${backend.latencyMs}ms` : ""}
            {backend.mode === "proxy" ? " · via proxy" : ""}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-rule px-2.5 py-1 text-xs text-muted/70">
      <span className="h-2 w-2 rounded-full bg-rule" aria-hidden />
      Offline
    </span>
  );
}

export function BackendPanel() {
  const backendUrl = useApp((s) => s.backendUrl);
  const setBackendUrl = useApp((s) => s.setBackendUrl);
  const connect = useApp((s) => s.connect);
  const connecting = useApp((s) => s.connecting);
  const connected = useApp((s) => s.backend.connected);

  // poll /health while connected so a dead tunnel is noticed quickly
  useEffect(() => {
    if (!connected) return;
    const id = setInterval(() => void connect({ silent: true }), HEALTH_POLL_MS);
    return () => clearInterval(id);
  }, [connected, connect]);

  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-desk/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <h1 className="font-display text-sm font-semibold tracking-[0.2em] text-text">
          VOICEFORGE
        </h1>
        <form
          className="flex min-w-0 flex-1 basis-64 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <Input
            type="url"
            inputMode="url"
            placeholder="https://your-tunnel.trycloudflare.com"
            aria-label="Backend URL"
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <Button type="submit" size="sm" disabled={connecting || !backendUrl.trim()}>
            Connect
          </Button>
        </form>
        <StatusPill />
      </div>
    </header>
  );
}
