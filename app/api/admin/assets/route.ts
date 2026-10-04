/**
 * The asset library, admin side. Behind the admin session (middleware).
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  AssetError,
  MAX_ASSET_BYTES,
  assetStorageHint,
  createAsset,
  isAssetKind,
  isAssetStorageReady,
  listAssets,
} from "@/lib/server/assets";
import { ASSET_KINDS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json({
    assets: await listAssets(),
    kinds: ASSET_KINDS,
    storageReady: isAssetStorageReady(),
    hint: assetStorageHint(),
    maxBytes: MAX_ASSET_BYTES,
  });
}

export async function POST(req: NextRequest) {
  if (!isAssetStorageReady()) {
    return NextResponse.json({ error: assetStorageHint() }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file attached." }, { status: 400 });
  }
  if (file.size > MAX_ASSET_BYTES) {
    return NextResponse.json({ error: "That file is over 50 MB." }, { status: 413 });
  }

  const kind = String(form.get("kind") ?? "");
  if (!isAssetKind(kind)) {
    return NextResponse.json({ error: "Unknown asset kind." }, { status: 400 });
  }

  try {
    const asset = await createAsset({
      kind,
      name: String(form.get("name") ?? file.name),
      tag: String(form.get("tag") ?? "") || undefined,
      fileName: file.name,
      mime: file.type || "application/octet-stream",
      bytes: await file.arrayBuffer(),
      durationSec: Number(form.get("durationSec")) || undefined,
    });
    return NextResponse.json({ ok: true, asset }, { status: 201 });
  } catch (e) {
    if (e instanceof AssetError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.warn("[voiceforge] asset upload failed:", e);
    return NextResponse.json({ error: "Couldn't save that file." }, { status: 500 });
  }
}
