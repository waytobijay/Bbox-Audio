/**
 * Admin view of the backend registry. Behind the admin session (middleware).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  forgetBackend,
  getActiveSelection,
  listBackends,
  registerBackend,
  setActiveSelection,
  updateBackend,
} from "@/lib/server/backends";
import { isRedisConfigured } from "@/lib/server/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const providerSchema = z.enum(["modal", "colab", "kaggle", "custom"]);

export async function GET() {
  const [backends, active] = await Promise.all([listBackends(), getActiveSelection()]);
  return NextResponse.json({
    backends,
    active,
    storageConnected: isRedisConfigured(),
    registrationTokenSet: Boolean(process.env.REGISTRATION_TOKEN),
    backendSecretSet: Boolean(process.env.BACKEND_SECRET),
  });
}

const patchSchema = z.union([
  z.object({ active: z.union([z.literal("auto"), providerSchema]) }),
  z.object({
    provider: providerSchema,
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(99).optional(),
  }),
  // Modal and Custom are the two an admin registers by hand: Modal has a
  // permanent URL printed by `modal deploy`, so there's nothing to
  // self-register, and Custom is any other conforming backend.
  z.object({
    provider: z.enum(["modal", "custom"]),
    url: z.string().url().max(500),
  }),
]);

export async function PATCH(req: NextRequest) {
  if (!isRedisConfigured()) {
    return NextResponse.json({ error: "Storage isn't connected." }, { status: 503 });
  }
  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if ("active" in body) {
    await setActiveSelection(body.active);
    return NextResponse.json({ ok: true, active: body.active });
  }

  if ("url" in body) {
    // Registering by hand still goes through the same path as
    // self-registration, so there's one code path for liveness.
    const row = await registerBackend({ provider: body.provider, url: body.url });
    return NextResponse.json({ ok: true, backend: row });
  }

  const updated = await updateBackend(body.provider, {
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
  });
  if (!updated) return NextResponse.json({ error: "Unknown backend." }, { status: 404 });
  return NextResponse.json({ ok: true, backend: updated });
}

export async function DELETE(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider");
  const parsed = providerSchema.safeParse(provider);
  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown backend." }, { status: 400 });
  }
  await forgetBackend(parsed.data);
  return NextResponse.json({ ok: true });
}
