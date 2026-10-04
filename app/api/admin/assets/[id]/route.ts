import { NextResponse, type NextRequest } from "next/server";
import { deleteAsset } from "@/lib/server/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await deleteAsset(id))) {
    return NextResponse.json({ error: "Unknown asset." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
