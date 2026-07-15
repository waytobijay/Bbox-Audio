/**
 * Opt-in CORS relay to the user's Colab backend.
 *
 * The app tries the tunnel directly first; this route is the fallback for
 * CORS / mixed-content edge cases. Guarded: forwards ONLY to Cloudflare
 * quick-tunnel and ngrok free-tier hosts so a deployed instance can't be
 * used as an open relay.
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const ALLOWED_HOSTS = [/\.trycloudflare\.com$/i, /\.ngrok-free\.app$/i];
const ALLOWED_PATHS = new Set(["/health", "/clone", "/generate"]);

interface ProxyBody {
  backendUrl?: string;
  path?: string;
  method?: string;
  body?: unknown;
  // multipart /clone payload, base64-encoded because JSON can't carry blobs
  audioB64?: string;
  audioMime?: string;
  transcript?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let payload: ProxyBody;
  try {
    payload = (await req.json()) as ProxyBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { backendUrl, path } = payload;
  if (!backendUrl || !path) {
    return NextResponse.json({ error: "backendUrl and path are required" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(path, backendUrl);
  } catch {
    return NextResponse.json({ error: "Invalid backendUrl" }, { status: 400 });
  }

  if (target.protocol !== "https:") {
    return NextResponse.json({ error: "Backend must be https" }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.some((re) => re.test(target.hostname))) {
    return NextResponse.json(
      { error: "Only *.trycloudflare.com and *.ngrok-free.app backends are allowed" },
      { status: 400 }
    );
  }
  if (!ALLOWED_PATHS.has(target.pathname)) {
    return NextResponse.json({ error: "Path not allowed" }, { status: 400 });
  }

  const method = payload.method === "GET" ? "GET" : "POST";
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(58_000),
  };

  if (method === "POST") {
    if (payload.audioB64) {
      const bytes = Buffer.from(payload.audioB64, "base64");
      const form = new FormData();
      form.append(
        "audio",
        new Blob([new Uint8Array(bytes)], { type: payload.audioMime || "audio/wav" }),
        "sample.wav"
      );
      form.append("transcript", payload.transcript ?? "");
      init.body = form;
    } else {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(payload.body ?? {});
    }
  }

  try {
    const upstream = await fetch(target, init);
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    return NextResponse.json(
      { error: timedOut ? "Backend timed out" : "Backend unreachable" },
      { status: timedOut ? 504 : 502 }
    );
  }
}
