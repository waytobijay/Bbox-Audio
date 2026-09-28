/**
 * The voice library, admin side. Behind the admin session (middleware).
 *
 * Uploads arrive as multipart WAV: the browser decodes whatever the user
 * picked and re-encodes to 16-bit PCM before sending, because the GPU hosts
 * read clips with soundfile and its MP3 support isn't dependable.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  MAX_CLIP_BYTES,
  VoiceStorageError,
  createVoice,
  isVoiceStorageReady,
  listVoices,
  voiceStorageHint,
} from "@/lib/server/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    voices: await listVoices(),
    storageReady: isVoiceStorageReady(),
    hint: voiceStorageHint(),
  });
}

const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(80),
  language: z.string().trim().min(2).max(12),
  transcript: z.string().trim().max(2000),
});

export async function POST(req: NextRequest) {
  if (!isVoiceStorageReady()) {
    return NextResponse.json({ error: voiceStorageHint() }, { status: 503 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const file = form.get("audio");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No clip attached." }, { status: 400 });
  }
  if (file.size > MAX_CLIP_BYTES) {
    return NextResponse.json({ error: "That clip is too large — keep it under 8 MB." }, { status: 413 });
  }

  const parsed = fieldsSchema.safeParse({
    name: form.get("name") ?? "",
    language: form.get("language") ?? "en",
    transcript: form.get("transcript") ?? "",
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Give the voice a name and a language." }, { status: 400 });
  }

  try {
    const voice = await createVoice({ ...parsed.data, wav: await file.arrayBuffer() });
    return NextResponse.json({ ok: true, voice }, { status: 201 });
  } catch (e) {
    if (e instanceof VoiceStorageError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.warn("[voiceforge] voice upload failed:", e);
    return NextResponse.json({ error: "Couldn't save that clip." }, { status: 500 });
  }
}
