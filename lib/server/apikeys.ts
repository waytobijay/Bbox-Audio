/**
 * API keys for the public /api/v1 surface.
 *
 * The full key is shown exactly once, at creation. Only its SHA-256 hash is
 * stored, so a leak of the database doesn't leak working keys — and there is
 * deliberately no way to recover a lost key, only to revoke and reissue.
 *
 * Lookup is by hash, which makes verification a single O(1) Redis GET rather
 * than a scan-and-compare over every key.
 */

import { kvDel, kvGet, kvMGet, kvSet, getRedis } from "./redis";

const BY_HASH = (hash: string) => `vf:apikey:h:${hash}`;
const BY_ID = (id: string) => `vf:apikey:${id}`;
const INDEX = "vf:apikeys";
const USAGE = (id: string, month: string) => `vf:usage:${id}:${month}`;

/** Visible in the UI and in logs; the rest of the key never is. */
export const KEY_PREFIX = "vf_live_";

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First few characters, for "which key is this?" in the list. */
  prefix: string;
  hash: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
  /** Requests per minute. 0 or undefined = the platform default. */
  rateLimitPerMinute?: number;
  /** Characters per calendar month. 0 or undefined = unlimited. */
  monthlyCharQuota?: number;
}

/** What the admin UI sees — never the hash. */
export interface ApiKeyView extends Omit<ApiKeyRecord, "hash"> {
  charsThisMonth: number;
  revoked: boolean;
}

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function hashKey(key: string): Promise<string> {
  const bytes = new TextEncoder().encode(key);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url — 256 bits, so guessing is not a threat model. */
export function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${KEY_PREFIX}${b64}`;
}

async function readIndex(): Promise<string[]> {
  return (await kvGet<string[]>(INDEX)) ?? [];
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  const ids = await readIndex();
  if (!ids.length) return [];
  const month = currentMonth();
  const rows = await kvMGet<ApiKeyRecord>(ids.map(BY_ID));
  const usage = await kvMGet<number>(ids.map((id) => USAGE(id, month)));
  return rows
    .map((r, i) => (r ? toView(r, usage[i] ?? 0) : null))
    .filter((r): r is ApiKeyView => Boolean(r))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function toView(r: ApiKeyRecord, charsThisMonth: number): ApiKeyView {
  const { hash: _hash, ...rest } = r;
  return { ...rest, charsThisMonth, revoked: Boolean(r.revokedAt) };
}

export interface CreateKeyInput {
  name: string;
  rateLimitPerMinute?: number;
  monthlyCharQuota?: number;
}

/** Returns the record plus the one and only sight of the full key. */
export async function createApiKey(
  input: CreateKeyInput
): Promise<{ view: ApiKeyView; key: string }> {
  const key = generateKey();
  const hash = await hashKey(key);
  const id = crypto.randomUUID();
  const record: ApiKeyRecord = {
    id,
    name: input.name.trim().slice(0, 60) || "Untitled key",
    prefix: key.slice(0, KEY_PREFIX.length + 6),
    hash,
    createdAt: Date.now(),
    rateLimitPerMinute: input.rateLimitPerMinute || undefined,
    monthlyCharQuota: input.monthlyCharQuota || undefined,
  };

  await kvSet(BY_ID(id), record);
  await kvSet(BY_HASH(hash), id);
  await kvSet(INDEX, [id, ...(await readIndex())]);
  return { view: toView(record, 0), key };
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const record = await kvGet<ApiKeyRecord>(BY_ID(id));
  if (!record) return false;
  // Keep the row so the list still explains what the key was, but drop the
  // hash lookup immediately — a revoked key must fail on the very next call.
  await kvDel(BY_HASH(record.hash));
  await kvSet(BY_ID(id), { ...record, revokedAt: Date.now() });
  return true;
}

export async function deleteApiKey(id: string): Promise<boolean> {
  const record = await kvGet<ApiKeyRecord>(BY_ID(id));
  if (!record) return false;
  await kvDel(BY_HASH(record.hash));
  await kvDel(BY_ID(id));
  await kvSet(INDEX, (await readIndex()).filter((x) => x !== id));
  return true;
}

/** Bearer token -> the key that owns it, or null. Revoked keys resolve to null. */
export async function resolveApiKey(authorization: string | null): Promise<ApiKeyRecord | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  const presented = match?.[1]?.trim();
  if (!presented || !presented.startsWith(KEY_PREFIX)) return null;

  const id = await kvGet<string>(BY_HASH(await hashKey(presented)));
  if (!id) return null;
  const record = await kvGet<ApiKeyRecord>(BY_ID(id));
  if (!record || record.revokedAt) return null;
  return record;
}

/** Fire-and-forget: a slow usage write must never delay an API response. */
export async function recordKeyUsage(id: string, chars: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = USAGE(id, currentMonth());
  try {
    await redis.incrby(key, chars);
    // Two months is enough for "this month" plus a late-arriving job.
    await redis.expire(key, 60 * 60 * 24 * 62);
  } catch {
    /* usage counting is not worth failing a request over */
  }
  await kvSet(BY_ID(id), {
    ...(await kvGet<ApiKeyRecord>(BY_ID(id))),
    lastUsedAt: Date.now(),
  } as ApiKeyRecord);
}

export async function charsThisMonth(id: string): Promise<number> {
  return (await kvGet<number>(USAGE(id, currentMonth()))) ?? 0;
}

/**
 * Quota check. Returns null when fine, or a message when the key is over.
 * Deliberately checked BEFORE work starts, so a job can't sneak past it.
 */
export async function quotaError(
  record: ApiKeyRecord,
  incomingChars: number
): Promise<string | null> {
  if (!record.monthlyCharQuota) return null;
  const used = await charsThisMonth(record.id);
  if (used + incomingChars <= record.monthlyCharQuota) return null;
  return `Monthly quota exceeded: ${used.toLocaleString()} of ${record.monthlyCharQuota.toLocaleString()} characters used.`;
}
