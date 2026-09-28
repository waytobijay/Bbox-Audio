/**
 * API key management. Behind the admin session (middleware).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/lib/server/apikeys";
import { isRedisConfigured } from "@/lib/server/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    keys: await listApiKeys(),
    storageConnected: isRedisConfigured(),
    defaultRateLimit: DEFAULT_RATE_LIMIT_PER_MINUTE,
  });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).optional(),
  monthlyCharQuota: z.number().int().min(0).max(100_000_000).optional(),
});

export async function POST(req: NextRequest) {
  if (!isRedisConfigured()) {
    return NextResponse.json({ error: "Storage isn't connected." }, { status: 503 });
  }
  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Give the key a name." }, { status: 400 });
  }

  const { view, key } = await createApiKey(body);
  // The only time the full key exists outside the caller's clipboard.
  return NextResponse.json({ ok: true, apiKey: view, key }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const hard = req.nextUrl.searchParams.get("hard") === "1";
  if (!id) return NextResponse.json({ error: "Which key?" }, { status: 400 });

  const ok = hard ? await deleteApiKey(id) : await revokeApiKey(id);
  if (!ok) return NextResponse.json({ error: "Unknown key." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
