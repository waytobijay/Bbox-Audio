/**
 * POST /api/v1/uploads/{id}/complete — confirm the file actually landed.
 *
 * Optional: a scene URL works without it. Worth calling in a pipeline so a
 * failed PUT is caught here, where the error is obvious, rather than fifteen
 * minutes into a render as "could not fetch scene 12".
 */

import { NextResponse } from "next/server";
import { apiError, authenticate } from "@/lib/server/apiauth";
import { UploadError, completeUpload } from "@/lib/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  try {
    // Scoped to the calling key, so one key cannot probe another's uploads.
    return NextResponse.json(await completeUpload(id, auth.key.id));
  } catch (e) {
    if (e instanceof UploadError) return apiError(e.message, e.status, e.code);
    console.warn("[voiceforge] upload complete failed:", e);
    return apiError("Couldn't verify that upload.", 500, "internal_error");
  }
}
