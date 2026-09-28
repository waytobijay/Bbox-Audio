/**
 * Shared backend primitives for the browser.
 *
 * This used to be a full client for the speech GPU: the studio held a tunnel
 * URL and called /clone and /generate itself, with an /api/proxy fallback for
 * CORS. That's gone. Speech now goes through lib/gateway.ts, because the
 * backend secret must never reach a browser and the active backend can change
 * between two chunks.
 *
 * What's left is what both paths need: one error type with the network/api
 * distinction the generation queue depends on, and URL normalization, which the
 * talking-head video backend still uses (it keeps its own user-pasted URL and
 * is deliberately outside the registry).
 */

export class BackendError extends Error {
  kind: "network" | "api";
  status?: number;

  constructor(message: string, kind: "network" | "api", status?: number) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    this.status = status;
  }
}

export function normalizeBackendUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}
