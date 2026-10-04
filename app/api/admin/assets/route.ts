/**
 * The asset library, admin side. Behind the admin session (middleware).
 *
 * POST takes METADATA only, never the file. The browser uploads straight to
 * Blob using a token from ./upload, because Vercel rejects any request body
 * over 4.5 MB and most music tracks are bigger than that.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  AssetError,
  MAX_ASSET_BYTES,
  assetStorageHint,
  isAssetStorageReady,
  listAssets,
  registerAsset,
} from "@/lib/server/assets";
import { ASSET_KINDS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    assets: await listAssets(),
    kinds: ASSET_KINDS,
    storageReady: isAssetStorageReady(),
    hint: assetStorageHint(),
    maxBytes: MAX_ASSET_BYTES,
  });
}

const schema = z.object({
  kind: z.enum(ASSET_KINDS),
  name: z.string().trim().min(1).max(80),
  tag: z.string().trim().max(40).optional(),
  url: z.string().url().max(1000),
  mime: z.string().min(3).max(120),
  sizeBytes: z.number().int().min(1).max(MAX_ASSET_BYTES),
  durationSec: z.number().min(0).max(36000).optional(),
});

export async function POST(req: NextRequest) {
  if (!isAssetStorageReady()) {
    return NextResponse.json({ error: assetStorageHint() }, { status: 503 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (e) {
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    return NextResponse.json(
      { error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request." },
      { status: 400 }
    );
  }

  try {
    const asset = await registerAsset(body);
    return NextResponse.json({ ok: true, asset }, { status: 201 });
  } catch (e) {
    if (e instanceof AssetError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.warn("[voiceforge] asset registration failed:", e);
    return NextResponse.json({ error: "Couldn't save that file." }, { status: 500 });
  }
}
