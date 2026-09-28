import { describe, expect, it } from "vitest";
import { OFFLINE_AFTER_SECONDS, computeHealth } from "../server/backends";
import type { BackendProvider, RegisteredBackend } from "../types";

/**
 * The registry decides where every generation goes, so the liveness and
 * fallback rules are worth pinning down. computeHealth is the pure core;
 * resolveBackend just sorts by priority and picks the first usable row, so
 * we exercise that same predicate here without needing Redis.
 */

function backend(patch: Partial<RegisteredBackend> = {}): RegisteredBackend {
  return {
    provider: "colab" as BackendProvider,
    url: "https://x.trycloudflare.com",
    models: ["chatterbox"],
    registeredAt: Date.now(),
    lastHeartbeat: Date.now(),
    enabled: true,
    priority: 1,
    ...patch,
  };
}

const NOW = 1_700_000_000_000;

describe("computeHealth", () => {
  it("is online right after a heartbeat", () => {
    expect(computeHealth(backend({ lastHeartbeat: NOW }), NOW)).toBe("online");
  });

  it("stays online through two missed heartbeats", () => {
    const twoMissed = NOW - 2 * 60 * 1000;
    expect(computeHealth(backend({ lastHeartbeat: twoMissed }), NOW)).toBe("online");
  });

  it("goes offline after three missed heartbeats", () => {
    const past = NOW - (OFFLINE_AFTER_SECONDS + 1) * 1000;
    expect(computeHealth(backend({ lastHeartbeat: past }), NOW)).toBe("offline");
  });

  it("reports busy while a job is running", () => {
    expect(computeHealth(backend({ busy: true }), NOW)).toBe("busy");
  });

  it("reports disabled regardless of heartbeat, so an admin's choice wins", () => {
    expect(computeHealth(backend({ enabled: false, lastHeartbeat: NOW }), NOW)).toBe("disabled");
  });
});

describe("auto-selection semantics", () => {
  // Mirrors resolveBackend(): sort by priority, take the first usable.
  const usable = (h: string) => h === "online" || h === "busy";
  const pick = (rows: RegisteredBackend[]) =>
    rows
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .find((r) => usable(computeHealth(r, NOW)))?.provider ?? null;

  const dead = NOW - (OFFLINE_AFTER_SECONDS + 5) * 1000;

  it("prefers the highest-priority healthy backend", () => {
    expect(
      pick([
        backend({ provider: "colab", priority: 1, lastHeartbeat: NOW }),
        backend({ provider: "modal", priority: 0, lastHeartbeat: NOW }),
      ])
    ).toBe("modal");
  });

  it("falls past a dead backend to the next one", () => {
    expect(
      pick([
        backend({ provider: "modal", priority: 0, lastHeartbeat: dead }),
        backend({ provider: "colab", priority: 1, lastHeartbeat: NOW }),
      ])
    ).toBe("colab");
  });

  it("skips a disabled backend even when it is heartbeating", () => {
    expect(
      pick([
        backend({ provider: "modal", priority: 0, lastHeartbeat: NOW, enabled: false }),
        backend({ provider: "kaggle", priority: 2, lastHeartbeat: NOW }),
      ])
    ).toBe("kaggle");
  });

  it("returns nothing when everything is down, rather than a dead URL", () => {
    expect(
      pick([
        backend({ provider: "modal", priority: 0, lastHeartbeat: dead }),
        backend({ provider: "colab", priority: 1, lastHeartbeat: dead }),
      ])
    ).toBeNull();
  });

  it("treats a busy backend as usable — jobs queue rather than fail over", () => {
    expect(pick([backend({ provider: "modal", priority: 0, busy: true })])).toBe("modal");
  });
});
