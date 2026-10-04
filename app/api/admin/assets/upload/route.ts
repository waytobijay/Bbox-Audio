/**
 * Hands the browser a short-lived token so it can upload straight to Blob.
 *
 * Assets do NOT go through this function. Vercel rejects any request body
 * over 4.5 MB with FUNCTION_PAYLOAD_TOO_LARGE, and a typical music track is
 * 3–8 MB — so routing the file through here silently capped uploads at a size
 * most real files exceed. The browser now talks to Blob directly and only the
 * metadata comes back to us.
 *
 * Behind the admin session (middleware), and the token is scoped to one
 * pathname so it cannot be reused to write anywhere else in the store.
 */

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { isAssetKind } from "@/lib/server/assets";
import { ASSET_KINDS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mirrors the server-side rules, so a token is never issued for a mismatch. */
const ALLOWED_TYPES: Record<string, string[]> = {
  music: ["audio/*"],
  sfx: ["audio/*"],
  motion: ["video/*"],
  // Raster only: ffmpeg cannot decode SVG on the Debian build Modal uses.
  banner: ["image/png", "image/jpeg", "image/webp"],
  intro: ["video/*"],
  outro: ["video/*"],
  clip: ["video/*"],
};

export async function POST(req: Request) {
  const body = (await req.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const kind = String(
          (JSON.parse(clientPayload || "{}") as { kind?: string }).kind ?? ""
        );
        if (!isAssetKind(kind)) {
          throw new Error(`kind must be one of ${ASSET_KINDS.join(", ")}`);
        }
        if (!pathname.startsWith(`assets/${kind}/`)) {
          throw new Error("pathname must sit under assets/<kind>/");
        }
        return {
          allowedContentTypes: ALLOWED_TYPES[kind],
          addRandomSuffix: false,
          // Long enough for a slow connection to finish a 50 MB file.
          validUntil: Date.now() + 30 * 60 * 1000,
          tokenPayload: clientPayload ?? "",
        };
      },
      // The metadata row is written by the browser's follow-up call to
      // /api/admin/assets, not here: onUploadCompleted never fires against
      // localhost, and a path that only works in production is a path that
      // never gets tested.
      onUploadCompleted: async () => {},
    });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Couldn't authorise that upload." },
      { status: 400 }
    );
  }
}
