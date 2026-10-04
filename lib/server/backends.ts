/**
 * GPU backend registry.
 *
 * Backends register THEMSELVES (a Colab notebook POSTs its tunnel URL once
 * the tunnel is up, then heartbeats), so nobody copies URLs by hand. One row
 * per provider: a fresh Colab session replaces the previous Colab row.
 *
 * Liveness is computed on READ from the last heartbeat — no cron job, which
 * matters because Vercel's free tier has no always-on worker.
 */

import type {
  ActiveBackend,
  BackendHealthKind,
  BackendProvider,
  BackendRegistration,
  BackendView,
  RegisteredBackend,
} from "@/lib/types";
import { BACKEND_PROVIDERS } from "@/lib/types";
import { getRedis, kvDel, kvGet, kvSet } from "./redis";

const KEY = (p: BackendProvider) => `vf:backend:${p}`;
const ACTIVE_KEY = "vf:backend:active";

/** Three missed 60 s heartbeats. */
export const HEARTBEAT_SECONDS = 60;
export const OFFLINE_AFTER_SECONDS = HEARTBEAT_SECONDS * 3;

/**
 * Lower wins under "auto". Free GPUs first, paid last: Modal bills per second,
 * so it should only pick up work when the free backends are actually down.
 * Reorder it per backend in Admin → Backends if you'd rather it led.
 */
const DEFAULT_PRIORITY: Record<BackendProvider, number> = {
  colab: 0,
  kaggle: 1,
  custom: 2,
  modal: 3,
};

export function computeHealth(b: RegisteredBackend, now = Date.now()): BackendHealthKind {
  if (!b.enabled) return "disabled";

  // Only heartbeating backends can be aged out. Modal and custom URLs are
  // permanent endpoints that never check in — Modal in particular scales to
  // zero, so "quiet" is its normal state. Expiring them would silently remove
  // the fallback you added precisely for when the notebooks are down.
  if (b.selfRegistered !== false) {
    const age = (now - b.lastHeartbeat) / 1000;
    if (age > OFFLINE_AFTER_SECONDS) return "offline";
  }

  return b.busy ? "busy" : "online";
}

function toView(b: RegisteredBackend, now = Date.now()): BackendView {
  return {
    ...b,
    health: computeHealth(b, now),
    secondsSinceHeartbeat: Math.max(0, Math.round((now - b.lastHeartbeat) / 1000)),
  };
}

export async function getBackend(provider: BackendProvider): Promise<BackendView | null> {
  const row = await kvGet<RegisteredBackend>(KEY(provider));
  return row ? toView(row) : null;
}

export async function listBackends(): Promise<BackendView[]> {
  const now = Date.now();
  const rows = await Promise.all(
    BACKEND_PROVIDERS.map((p) => kvGet<RegisteredBackend>(KEY(p)))
  );
  return rows
    .filter((r): r is RegisteredBackend => Boolean(r))
    .map((r) => toView(r, now))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Upsert from a registration/heartbeat. Operator choices (enabled, priority)
 * survive re-registration, so a Colab restart can't silently re-enable a
 * backend the admin turned off.
 */
export async function registerBackend(
  reg: BackendRegistration,
  opts: { selfRegistered?: boolean } = {}
): Promise<RegisteredBackend> {
  const existing = await kvGet<RegisteredBackend>(KEY(reg.provider));
  const now = Date.now();
  const row: RegisteredBackend = {
    provider: reg.provider,
    url: reg.url.replace(/\/+$/, ""),
    gpu: reg.gpu ?? existing?.gpu,
    models: reg.models ?? existing?.models ?? [],
    version: reg.version ?? existing?.version,
    registeredAt: existing?.registeredAt ?? now,
    lastHeartbeat: now,
    enabled: existing?.enabled ?? true,
    priority: existing?.priority ?? DEFAULT_PRIORITY[reg.provider],
    selfRegistered: opts.selfRegistered ?? true,
    busy: false,
    voicesCached: existing?.voicesCached ?? [],
    gpuSecondsMonth: existing?.gpuSecondsMonth ?? 0,
    jobsToday: existing?.jobsToday ?? 0,
    lastError: undefined,
  };
  await kvSet(KEY(reg.provider), row);
  return row;
}

export async function updateBackend(
  provider: BackendProvider,
  patch: Partial<RegisteredBackend>
): Promise<RegisteredBackend | null> {
  const existing = await kvGet<RegisteredBackend>(KEY(provider));
  if (!existing) return null;
  const next = { ...existing, ...patch, provider };
  await kvSet(KEY(provider), next);
  return next;
}

export async function forgetBackend(provider: BackendProvider): Promise<void> {
  await kvDel(KEY(provider));
}

// --- active selection ----------------------------------------------------

export async function getActiveSelection(): Promise<ActiveBackend> {
  return (await kvGet<ActiveBackend>(ACTIVE_KEY)) ?? "auto";
}

export async function setActiveSelection(value: ActiveBackend): Promise<void> {
  await kvSet(ACTIVE_KEY, value);
}

/**
 * Resolve the backend a request should actually go to.
 *
 * "auto"  -> first enabled + online backend by priority. This IS the fallback
 *            behaviour: a dead Colab is simply skipped.
 * pinned  -> that provider, but only if usable; otherwise null so the caller
 *            reports a clear error instead of hanging on a dead tunnel.
 */
export async function resolveBackend(): Promise<BackendView | null> {
  const [selection, all] = await Promise.all([getActiveSelection(), listBackends()]);
  const usable = (b: BackendView) => b.health === "online" || b.health === "busy";

  if (selection === "auto") return all.find(usable) ?? null;
  const pinned = all.find((b) => b.provider === selection);
  return pinned && usable(pinned) ? pinned : null;
}

// --- auth for machine endpoints ------------------------------------------

async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const enc = (s: string) => {
    const u8 = new TextEncoder().encode(s);
    const out = new ArrayBuffer(u8.byteLength);
    new Uint8Array(out).set(u8);
    return out;
  };
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc(a)),
    crypto.subtle.digest("SHA-256", enc(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function isValidRegistrationToken(token: string | null): Promise<boolean> {
  const expected = process.env.REGISTRATION_TOKEN;
  if (!expected || !token) return false;
  return constantTimeEquals(token, expected);
}

export function backendSecret(): string | undefined {
  return process.env.BACKEND_SECRET;
}

/** Every gateway -> backend call carries this. */
export function backendHeaders(): Record<string, string> {
  const secret = backendSecret();
  return {
    "Content-Type": "application/json",
    ...(secret ? { "X-Backend-Secret": secret } : {}),
  };
}

/**
 * Fold what a /health response told us back into the registry row.
 *
 * A self-registering notebook reports its GPU and models on every heartbeat,
 * but a backend added by URL has nobody doing that — and if it happened to be
 * asleep when it was added, its row stays blank and the studio greys out the
 * model picker. Any successful health call now refreshes those facts, so the
 * row corrects itself the first time the backend is actually reachable.
 */
export async function recordHealthFacts(
  provider: BackendProvider,
  health: { gpu?: string; models?: string[]; version?: string; voices_cached?: string[] }
): Promise<void> {
  const existing = await kvGet<RegisteredBackend>(KEY(provider));
  if (!existing) return;

  const next: RegisteredBackend = {
    ...existing,
    gpu: health.gpu ?? existing.gpu,
    models: health.models?.length ? health.models : existing.models,
    version: health.version ?? existing.version,
    voicesCached: health.voices_cached ?? existing.voicesCached,
  };

  const unchanged =
    next.gpu === existing.gpu &&
    next.version === existing.version &&
    next.models.join() === existing.models.join() &&
    (next.voicesCached ?? []).join() === (existing.voicesCached ?? []).join();
  if (unchanged) return;

  await kvSet(KEY(provider), next);
}

// --- usage counters ------------------------------------------------------

export async function recordJobUsage(
  provider: BackendProvider,
  genSeconds: number
): Promise<void> {
  if (!getRedis()) return;
  const existing = await kvGet<RegisteredBackend>(KEY(provider));
  if (!existing) return;
  await kvSet(KEY(provider), {
    ...existing,
    gpuSecondsMonth: Math.round((existing.gpuSecondsMonth ?? 0) + genSeconds),
    jobsToday: (existing.jobsToday ?? 0) + 1,
  });
}
