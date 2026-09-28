/**
 * Auth, rate limiting and quota for /api/v1.
 *
 * One helper so every endpoint enforces the same three things in the same
 * order, and none of them can quietly forget one:
 *   1. a valid, unrevoked key
 *   2. the per-minute rate limit
 *   3. the monthly character quota, checked BEFORE work starts
 */

import { NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  quotaError,
  resolveApiKey,
  type ApiKeyRecord,
} from "./apikeys";
import { getRedis, isRedisConfigured } from "./redis";

export interface AuthOk {
  ok: true;
  key: ApiKeyRecord;
}
export interface AuthFail {
  ok: false;
  response: NextResponse;
}
export type AuthResult = AuthOk | AuthFail;

export function apiError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json({ error: { message, code, type: "voiceforge_error" } }, { status });
}

// One limiter per distinct limit value — constructing these is cheap but
// caching keeps the sliding-window state consistent across requests.
const limiters = new Map<number, Ratelimit>();

function limiterFor(perMinute: number): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;
  let limiter = limiters.get(perMinute);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(perMinute, "1 m"),
      prefix: "vf:rl",
      analytics: false,
    });
    limiters.set(perMinute, limiter);
  }
  return limiter;
}

/**
 * Quota check, split out so endpoints can authenticate BEFORE parsing a body.
 * Returns null when the key is within quota, or a response when it isn't.
 */
export async function checkQuota(
  key: ApiKeyRecord,
  chars: number
): Promise<NextResponse | null> {
  if (chars <= 0) return null;
  const overQuota = await quotaError(key, chars);
  return overQuota ? apiError(overQuota, 429, "quota_exceeded") : null;
}

/**
 * @param chars characters this request would generate, for the quota check.
 *   Pass 0 when the body hasn't been read yet and call checkQuota after.
 */
export async function authenticate(req: Request, chars = 0): Promise<AuthResult> {
  if (!isRedisConfigured()) {
    return {
      ok: false,
      response: apiError(
        "Storage isn't connected, so API keys can't be verified. Add Upstash Redis in Vercel.",
        503,
        "storage_unavailable"
      ),
    };
  }

  const key = await resolveApiKey(req.headers.get("authorization"));
  if (!key) {
    return {
      ok: false,
      response: apiError(
        "Missing or invalid API key. Send `Authorization: Bearer vf_live_…`.",
        401,
        "invalid_api_key"
      ),
    };
  }

  const perMinute = key.rateLimitPerMinute || DEFAULT_RATE_LIMIT_PER_MINUTE;
  const limiter = limiterFor(perMinute);
  if (limiter) {
    const { success, reset } = await limiter.limit(key.id);
    if (!success) {
      const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      const response = apiError(
        `Rate limit exceeded: ${perMinute} requests per minute. Retry in ${retryAfter}s.`,
        429,
        "rate_limit_exceeded"
      );
      response.headers.set("Retry-After", String(retryAfter));
      return { ok: false, response };
    }
  }

  if (chars > 0) {
    const overQuota = await quotaError(key, chars);
    if (overQuota) {
      return { ok: false, response: apiError(overQuota, 429, "quota_exceeded") };
    }
  }

  return { ok: true, key };
}

/**
 * This deployment's own public URL, for building callback and status URLs.
 * Prefers the explicit env var, then Vercel's, then the request — so it is
 * correct on localhost, previews and production without configuration.
 */
export function appUrlFrom(req: Request): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}
