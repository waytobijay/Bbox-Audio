/**
 * POST /api/v1/uploads — get somewhere to put a file.
 *
 * Returns a short-lived, tightly scoped target so the client can PUT the file
 * straight to storage. The bytes never pass through this function: Vercel
 * rejects any request body over 4.5 MB, which would rule out video clips and
 * most usable images.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, authenticate, checkUploadLimit } from "@/lib/server/apiauth";
import {
  UPLOAD_CONTENT_TYPES,
  UploadError,
  createUpload,
  MAX_VIDEO_BYTES,
} from "@/lib/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  filename: z.string().trim().min(1).max(120),
  content_type: z.enum(UPLOAD_CONTENT_TYPES),
  bytes: z.number().int().positive().max(MAX_VIDEO_BYTES),
  /** "scene" is swept after 7 days; "brand" is kept until you delete it. */
  purpose: z.enum(["scene", "brand"]).default("scene"),
});

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  // A five-minute video asks for ~30 of these at once, so they get their own
  // hourly budget rather than competing with the per-minute request limit.
  const limited = await checkUploadLimit(auth.key.id);
  if (limited) return limited;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (e) {
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    return apiError(
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body.",
      400,
      "invalid_request"
    );
  }

  try {
    const created = await createUpload({
      keyId: auth.key.id,
      filename: body.filename,
      contentType: body.content_type,
      bytes: body.bytes,
      purpose: body.purpose,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    if (e instanceof UploadError) return apiError(e.message, e.status, e.code);
    console.warn("[voiceforge] upload create failed:", e);
    return apiError("Couldn't create that upload.", 500, "internal_error");
  }
}
