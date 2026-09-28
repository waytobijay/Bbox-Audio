/**
 * Push a voice onto the active backend now.
 *
 * Generation already syncs lazily on a 409, so this is a convenience: it lets
 * you confirm a clip is reachable and cacheable without waiting for the first
 * render to tell you.
 */

import { NextResponse, type NextRequest } from "next/server";
import { GatewayError, syncVoiceToBackend } from "@/lib/server/gateway";
import { resolveBackend } from "@/lib/server/backends";
import { getVoice } from "@/lib/server/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const [voice, backend] = await Promise.all([getVoice(id), resolveBackend()]);

  if (!voice) return NextResponse.json({ error: "Unknown voice." }, { status: 404 });
  if (!backend) {
    return NextResponse.json(
      { error: "No backend is online to sync to. Start a notebook first." },
      { status: 503 }
    );
  }

  try {
    const t0 = Date.now();
    await syncVoiceToBackend(backend.url, voice);
    return NextResponse.json({
      ok: true,
      provider: backend.provider,
      ms: Date.now() - t0,
    });
  } catch (e) {
    const status = e instanceof GatewayError ? e.status : 502;
    const message = e instanceof Error ? e.message : "Sync failed.";
    return NextResponse.json({ error: message }, { status });
  }
}
