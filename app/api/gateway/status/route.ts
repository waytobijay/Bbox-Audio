/**
 * What the studio needs to know before it can generate: which backend a
 * request would land on right now, and which voices exist. One call so the
 * connection panel has no waterfall.
 */

import { NextResponse } from "next/server";
import { getActiveSelection, resolveBackend } from "@/lib/server/backends";
import { isVoiceStorageReady, listVoices, voiceStorageHint } from "@/lib/server/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [backend, active, voices] = await Promise.all([
    resolveBackend(),
    getActiveSelection(),
    listVoices(),
  ]);

  return NextResponse.json({
    active,
    backend: backend
      ? {
          provider: backend.provider,
          gpu: backend.gpu ?? null,
          models: backend.models,
          health: backend.health,
          secondsSinceHeartbeat: backend.secondsSinceHeartbeat,
        }
      : null,
    voices: voices.map((v) => ({
      id: v.id,
      name: v.name,
      language: v.language,
      durationSec: v.durationSec,
      isDefault: v.isDefault,
      audioUrl: v.audioUrl,
    })),
    storageReady: isVoiceStorageReady(),
    hint: voiceStorageHint(),
  });
}
