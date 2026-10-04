/**
 * POST /api/v1/video — scenes in, a rendered MP4 back.
 *
 * Asynchronous like everything else here: a twenty-minute render takes far
 * longer than a Vercel function may live, so this returns a job id and the
 * render continues on the backend.
 *
 * Music, banner and sound effects are chosen from your asset library by the
 * gateway, so the result is the same whichever backend answered and a
 * notebook needs no files on disk.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, appUrlFrom, authenticate } from "@/lib/server/apiauth";
import { JobError } from "@/lib/server/jobs";
import { createAndDispatchRender } from "@/lib/server/videojobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Enough for a 20-minute video at a sane pace; past this, split it up. */
const MAX_SCENES = 400;

const sceneSchema = z.object({
  type: z.enum(["image", "clip"]).default("image"),
  url: z.string().url().max(2000),
  audio_url: z.string().url().max(2000).optional(),
  caption: z.string().max(300).optional(),
  seconds: z.number().min(0.5).max(600).optional(),
});

/** Bookends. Same shape as a scene, but never captioned. */
const bookendSchema = z.object({
  type: z.enum(["image", "clip"]).default("clip"),
  url: z.string().url().max(2000),
  audio_url: z.string().url().max(2000).optional(),
  seconds: z.number().min(0.5).max(120).optional(),
});

const schema = z.object({
  scenes: z.array(sceneSchema).min(1).max(MAX_SCENES),
  intro: bookendSchema.optional(),
  outro: bookendSchema.optional(),
  /** 16:9 by default — this endpoint is for long-form. */
  width: z.number().int().min(256).max(3840).default(1920),
  height: z.number().int().min(256).max(2160).default(1080),
  fps: z.number().int().min(12).max(60).default(30),
  motion: z.enum(["none", "classic", "dynamic"]).default("classic"),
  transition: z.string().max(30).default("mix"),
  transition_seconds: z.number().min(0.1).max(2).default(0.5),
  captions: z.boolean().default(false),
  music: z.boolean().default(true),
  music_tag: z.string().max(40).optional(),
  sfx: z.boolean().default(false),
  banner: z.boolean().default(true),
  callback_url: z.string().url().max(2000).optional(),
});

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

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
    const job = await createAndDispatchRender(
      {
        scenes: body.scenes.map((s) => ({
          type: s.type,
          url: s.url,
          audioUrl: s.audio_url,
          caption: s.caption,
          seconds: s.seconds,
        })),
        intro: body.intro
          ? { type: body.intro.type, url: body.intro.url, audioUrl: body.intro.audio_url, seconds: body.intro.seconds }
          : undefined,
        outro: body.outro
          ? { type: body.outro.type, url: body.outro.url, audioUrl: body.outro.audio_url, seconds: body.outro.seconds }
          : undefined,
        width: body.width,
        height: body.height,
        fps: body.fps,
        motion: body.motion,
        transition: body.transition,
        transitionSeconds: body.transition_seconds,
        captions: body.captions,
        music: body.music,
        musicTag: body.music_tag,
        sfx: body.sfx,
        banner: body.banner,
        source: auth.key.id,
        callbackUrl: body.callback_url,
      },
      appUrlFrom(req)
    );

    return NextResponse.json(
      {
        job_id: job.id,
        status: job.status,
        status_url: `${appUrlFrom(req)}/api/v1/jobs/${job.id}`,
        scenes: body.scenes.length,
        backend: job.backend,
      },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof JobError) return apiError(e.message, e.status, e.code);
    console.warn("[voiceforge] video dispatch failed:", e);
    return apiError("Couldn't start that render.", 500, "internal_error");
  }
}
