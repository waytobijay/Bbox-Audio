/**
 * GET /api/v1/voices — the voices this key can use.
 */

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/server/apiauth";
import { listVoices } from "@/lib/server/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const voices = await listVoices();
  return NextResponse.json({
    voices: voices.map((v) => ({
      id: v.id,
      name: v.name,
      language: v.language,
      duration: v.durationSec,
      default: v.isDefault,
    })),
  });
}
