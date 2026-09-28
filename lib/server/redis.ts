/**
 * Upstash Redis — the platform's data store (config, API keys, jobs, usage).
 *
 * Degrades gracefully on purpose: if the Upstash env vars aren't connected
 * yet, every call returns empty instead of throwing, so the app still builds,
 * deploys and runs. The admin UI surfaces "storage not connected" rather than
 * crashing. Storage is a feature, not a startup requirement.
 */

import { Redis } from "@upstash/redis";

let client: Redis | null = null;

/**
 * Vercel's Upstash integration injects KV_REST_API_URL / KV_REST_API_TOKEN,
 * while Upstash's own dashboard gives you UPSTASH_REDIS_REST_*. Accept either,
 * so connecting the store from Vercel just works with nothing copied by hand.
 */
function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

export function isRedisConfigured(): boolean {
  return credentials() !== null;
}

export function getRedis(): Redis | null {
  const creds = credentials();
  if (!creds) return null;
  if (!client) client = new Redis(creds);
  return client;
}

// --- typed helpers -------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<T>(key)) ?? null;
  } catch (e) {
    console.warn("[voiceforge] redis get failed:", key, e);
    return null;
  }
}

export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    if (ttlSeconds) await r.set(key, value, { ex: ttlSeconds });
    else await r.set(key, value);
    return true;
  } catch (e) {
    console.warn("[voiceforge] redis set failed:", key, e);
    return false;
  }
}

export async function kvDel(key: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    await r.del(key);
    return true;
  } catch {
    return false;
  }
}

// --- settings ------------------------------------------------------------

export const SETTINGS_KEY = "vf:settings";

export interface PlatformSettings {
  /** Days before generated audio is purged from Blob. */
  retentionDays: number;
  /** Notebook URL shown in the Backends connect dialog. */
  kaggleNotebookUrl: string;
  defaultModel: "chatterbox" | "qwen3";
  defaultLanguage: string;
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  retentionDays: 7,
  kaggleNotebookUrl: "",
  defaultModel: "chatterbox",
  defaultLanguage: "en",
};

export async function getSettings(): Promise<PlatformSettings> {
  const stored = await kvGet<Partial<PlatformSettings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  const next = { ...(await getSettings()), ...patch };
  await kvSet(SETTINGS_KEY, next);
  return next;
}
