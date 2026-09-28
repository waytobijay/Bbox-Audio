/**
 * Admin login / logout.
 *
 * Rate-limited by IP in Redis when it's connected; when it isn't, a small
 * in-memory fallback still slows down a brute-force attempt within a single
 * serverless instance. Never logs the submitted password.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  SESSION_COOKIE,
  createSessionToken,
  isAuthConfigured,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/server/auth";
import { getRedis } from "@/lib/server/redis";

export const runtime = "nodejs";

const MAX_ATTEMPTS = 8;
const WINDOW_SECONDS = 300;

const bodySchema = z.object({
  password: z.string().min(1).max(200),
  next: z.string().max(512).optional(),
});

const memoryHits = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

async function tooManyAttempts(ip: string): Promise<boolean> {
  const redis = getRedis();
  if (redis) {
    try {
      const key = `vf:login:${ip}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, WINDOW_SECONDS);
      return count > MAX_ATTEMPTS;
    } catch {
      // fall through to the in-memory limiter
    }
  }
  const now = Date.now();
  const entry = memoryHits.get(ip);
  if (!entry || now > entry.resetAt) {
    memoryHits.set(ip, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(req: NextRequest) {
  if (!isAuthConfigured()) {
    return NextResponse.json(
      {
        error:
          "Admin login isn't configured yet. Set ADMIN_PASSWORD and SESSION_SECRET in Vercel, then redeploy.",
      },
      { status: 503 }
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (await tooManyAttempts(clientIp(req))) {
    return NextResponse.json(
      { error: "Too many attempts. Wait a few minutes and try again." },
      { status: 429 }
    );
  }

  if (!(await verifyPassword(parsed.password))) {
    // Deliberately vague, and never echoes the attempt.
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions());
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
