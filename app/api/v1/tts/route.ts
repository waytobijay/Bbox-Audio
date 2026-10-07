/**
 * POST /api/v1/tts — text in, a job id back.
 *
 * Always asynchronous. A Vercel function has 60 seconds and a Modal cold start
 * can eat most of that before a word is spoken, so this endpoint never waits
 * for audio: it returns 202 with a status_url, and optionally calls you back.
 *
 * Chunking and normalization run through lib/normalize.ts + lib/chunker.ts,
 * the same code the studio uses, so API output is identical to what you'd get
 * by pasting the script into the UI.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { chunkScript } from "@/lib/chunker";
import { DEFAULT_PARAMS } from "@/lib/config";
import { apiError, appUrlFrom, authenticate, checkQuota } from "@/lib/server/apiauth";
import { recordKeyUsage } from "@/lib/server/apikeys";
import { JobError, createAndDispatchJob } from "@/lib/server/jobs";
import { resolveVoice } from "@/lib/server/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One call's worth of script. Longer than this belongs in several jobs. */
const MAX_CHARS = 50_000;

const paramsSchema = z
  .object({
    seed: z.number().int().min(0).max(2 ** 31).optional(),
    exaggeration: z.number().min(0).max(2).optional(),
    cfg: z.number().min(0).max(1).optional(),
    /** Alias: Chatterbox calls it cfg_weight, so accept both spellings. */
    cfg_weight: z.number().min(0).max(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    model: z.enum(["chatterbox", "qwen3"]).optional(),
    /** Overrides the language profile's engine for this one request. */
    engine: z.string().min(1).max(40).optional(),
  })
  .optional();

const ttsSchema = z.object({
  text: z.string().min(1).max(MAX_CHARS),
  voice_id: z.string().max(120).optional(),
  language: z.string().min(2).max(12).optional(),
  format: z.enum(["mp3", "wav"]).optional(),
  params: paramsSchema,
  callback_url: z.string().url().max(2000).optional(),
});

export async function POST(req: Request) {
  // Auth first: an unauthenticated caller shouldn't be able to probe the
  // schema, or make us do any work at all.
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof ttsSchema>;
  try {
    body = ttsSchema.parse(await req.json());
  } catch (e) {
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    return apiError(
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body.",
      400,
      "invalid_request"
    );
  }

  const overQuota = await checkQuota(auth.key, body.text.length);
  if (overQuota) return overQuota;

  const voice = await resolveVoice(body.voice_id ?? null);
  if (!voice) {
    return apiError(
      body.voice_id
        ? `No voice with id "${body.voice_id}". GET /api/v1/voices lists them.`
        : "No voice_id given and no default voice is set. Add one in Admin → Voices.",
      body.voice_id ? 404 : 400,
      "unknown_voice"
    );
  }

  const language = body.language ?? voice.language;
  const drafts = chunkScript(body.text, undefined, language);
  if (!drafts.length) {
    return apiError("That text has nothing to say once normalized.", 400, "empty_text");
  }

  try {
    const job = await createAndDispatchJob(
      {
        chunks: drafts.map((d) => d.text),
        paragraphBreaks: drafts.map((d) => d.isParagraphEnd),
        voiceId: voice.id,
        mode: "stitch",
        format: body.format ?? "mp3",
        source: auth.key.id,
        callbackUrl: body.callback_url,
        params: {
          ...DEFAULT_PARAMS,
          ...body.params,
          language,
        },
      },
      appUrlFrom(req)
    );

    void recordKeyUsage(auth.key.id, job.chars);

    return NextResponse.json(
      {
        job_id: job.id,
        status: job.status,
        status_url: `${appUrlFrom(req)}/api/v1/jobs/${job.id}`,
        chars: job.chars,
        chunks: job.chunks,
        backend: job.backend,
      },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof JobError) return apiError(e.message, e.status, e.code);
    console.warn("[voiceforge] tts failed:", e);
    return apiError("Couldn't start that job.", 500, "internal_error");
  }
}
