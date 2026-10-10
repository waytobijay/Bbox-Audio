/**
 * Direct-to-storage uploads for API clients.
 *
 * The file never passes through a Vercel function: anything over 4.5 MB is
 * rejected with FUNCTION_PAYLOAD_TOO_LARGE before a handler runs, which rules
 * out video clips and most decent images. Instead we mint a token scoped to
 * one exact pathname, content type, size and expiry, and the client PUTs
 * straight to Blob.
 *
 * Vercel Blob has no S3-style presigned URL and no lifecycle rules, so:
 *  - the signature travels as an Authorization header rather than in the
 *    query string (the create response tells the caller exactly what to send)
 *  - expiry is swept by the daily cron, driven by the rows written here
 */

import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { head } from "@vercel/blob";
import { blobToken, deleteBlob, isBlobConfigured } from "./blob";
import { isRedisConfigured, kvDel, kvGet, kvMGet, kvSet } from "./redis";

const KEY = (id: string) => `vf:upload:${id}`;
const INDEX = "vf:uploads";
const BASE_URL_KEY = "vf:blob:base";
/** Bounded: the sweep only needs recent uploads, not an archive. */
const INDEX_LIMIT = 2000;

export const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
export const SCENE_RETENTION_DAYS = 7;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const UPLOAD_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
] as const;

export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];
export type UploadPurpose = "scene" | "brand";

export interface UploadRow {
  id: string;
  keyId: string;
  pathname: string;
  publicUrl: string;
  contentType: UploadContentType;
  bytes: number;
  purpose: UploadPurpose;
  createdAt: number;
  /** null for "brand" — those are kept until deleted by hand. */
  expiresAt: number | null;
}

export class UploadError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

// --- pure helpers (unit-tested) ------------------------------------------

/**
 * Reduce a client-supplied filename to something safe to put in a URL.
 * Everything outside [a-z0-9._-] goes, because the name ends up in a path
 * that ffmpeg, urllib and a browser all have to agree on.
 */
export function sanitiseFilename(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned || "file";
}

export function maxBytesFor(contentType: UploadContentType): number {
  return contentType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
}

/** uploads/<key>/<yyyy-mm-dd>/<uuid>-<filename> */
export function uploadPathname(
  keyId: string,
  filename: string,
  id: string,
  now = new Date()
): string {
  const day = now.toISOString().slice(0, 10);
  return `uploads/${keyId}/${day}/${id}-${sanitiseFilename(filename)}`;
}

export function expiryFor(purpose: UploadPurpose, now = Date.now()): number | null {
  return purpose === "brand" ? null : now + SCENE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

// --- blob base url --------------------------------------------------------

/**
 * Work out this store's public hostname rather than guessing it from the
 * store id. Learned once from a real blob and cached — a wrong public_url
 * would be discovered only when a render failed to fetch it.
 */
export async function blobBaseUrl(): Promise<string> {
  const cached = await kvGet<string>(BASE_URL_KEY);
  if (cached) return cached;

  const token = blobToken();
  if (!token) throw new UploadError("Blob isn't connected.", 503, "storage_unavailable");

  const { list, put, del } = await import("@vercel/blob");
  let sample: string | undefined;

  const existing = await list({ token, limit: 1 });
  sample = existing.blobs[0]?.url;

  if (!sample) {
    // Empty store: write a marker, read its URL, remove it.
    const probe = await put(".voiceforge-probe", "ok", {
      access: "public",
      token,
      addRandomSuffix: false,
      contentType: "text/plain",
      // The delete below is best-effort. If it ever fails and the cached base
      // url is later lost, a second probe would hit its own leftover and
      // throw "already exists" — breaking every upload, from a marker file.
      allowOverwrite: true,
    } as Parameters<typeof put>[2]);
    sample = probe.url;
    await del(probe.url, { token }).catch(() => {});
  }

  const base = new URL(sample).origin;
  await kvSet(BASE_URL_KEY, base);
  return base;
}

// --- create ---------------------------------------------------------------

export interface CreateUploadInput {
  keyId: string;
  filename: string;
  contentType: UploadContentType;
  bytes: number;
  purpose: UploadPurpose;
}

export interface CreatedUpload {
  upload_id: string;
  upload_url: string;
  method: "PUT";
  headers: Record<string, string>;
  public_url: string;
  expires_at: string | null;
}

export async function createUpload(input: CreateUploadInput): Promise<CreatedUpload> {
  if (!isBlobConfigured() || !isRedisConfigured()) {
    throw new UploadError(
      "Storage isn't connected. Add Upstash Redis and Blob in Vercel.",
      503,
      "storage_unavailable"
    );
  }

  const limit = maxBytesFor(input.contentType);
  if (input.bytes > limit) {
    throw new UploadError(
      `${input.contentType} is limited to ${Math.round(limit / 1024 / 1024)} MB.`,
      413,
      "file_too_large"
    );
  }

  const id = crypto.randomUUID();
  const pathname = uploadPathname(input.keyId, input.filename, id);
  const token = blobToken()!;

  const clientToken = await generateClientTokenFromReadWriteToken({
    token,
    pathname,
    // Blob enforces all three, which is what makes this equivalent to a
    // presigned PUT: wrong type, oversized or late and the store refuses it.
    allowedContentTypes: [input.contentType],
    maximumSizeInBytes: input.bytes,
    validUntil: Date.now() + UPLOAD_WINDOW_MS,
    addRandomSuffix: false,
    // The store refuses a PUT over an existing pathname unless the *token*
    // permits it — a request header alone is ignored, or a client could
    // escalate past what it was granted. Safe here because the pathname
    // contains a UUID we generated, so the only thing a repeat PUT can
    // overwrite is the caller's own half-finished upload. Without this a
    // retried PUT fails with "This blob already exists", and an HTTP client
    // that retries a timeout has no way to recover.
    //
    // Cast: @vercel/blob 0.27 predates the option, but the payload it signs
    // is a plain pass-through of these arguments, and the store reads it.
    allowOverwrite: true,
  } as Parameters<typeof generateClientTokenFromReadWriteToken>[0]);

  const base = await blobBaseUrl();
  const row: UploadRow = {
    id,
    keyId: input.keyId,
    pathname,
    publicUrl: `${base}/${pathname}`,
    contentType: input.contentType,
    bytes: input.bytes,
    purpose: input.purpose,
    createdAt: Date.now(),
    expiresAt: expiryFor(input.purpose),
  };

  await kvSet(KEY(id), row);
  await kvSet(INDEX, [id, ...((await kvGet<string[]>(INDEX)) ?? [])].slice(0, INDEX_LIMIT));

  return {
    upload_id: id,
    upload_url: `https://blob.vercel-storage.com/${pathname}`,
    method: "PUT",
    headers: {
      // Exactly what the store expects. Sent as headers rather than a signed
      // query string because that is the shape Blob's upload API takes.
      authorization: `Bearer ${clientToken}`,
      "content-type": input.contentType,
      "x-content-type": input.contentType,
      "x-add-random-suffix": "0",
      // Matches the token above; the store wants both.
      "x-allow-overwrite": "1",
    },
    public_url: row.publicUrl,
    expires_at: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
  };
}

// --- complete -------------------------------------------------------------

export async function getUpload(id: string): Promise<UploadRow | null> {
  return kvGet<UploadRow>(KEY(id));
}

export async function completeUpload(
  id: string,
  keyId: string
): Promise<{ public_url: string; bytes: number }> {
  const row = await getUpload(id);
  if (!row || row.keyId !== keyId) {
    throw new UploadError("No upload with that id.", 404, "unknown_upload");
  }

  let info: { size: number; contentType?: string };
  try {
    info = await head(row.publicUrl, { token: blobToken() });
  } catch {
    throw new UploadError(
      "That file hasn't been uploaded yet.",
      409,
      "upload_incomplete"
    );
  }

  if (info.contentType && info.contentType !== row.contentType) {
    throw new UploadError(
      `Stored file is ${info.contentType}, not the declared ${row.contentType}.`,
      409,
      "content_type_mismatch"
    );
  }
  if (info.size > row.bytes) {
    throw new UploadError("Stored file is larger than declared.", 409, "size_mismatch");
  }

  return { public_url: row.publicUrl, bytes: info.size };
}

// --- retention ------------------------------------------------------------

/** Deletes expired "scene" uploads. "brand" rows have no expiry and are kept. */
export async function purgeExpiredUploads(now = Date.now()): Promise<number> {
  const ids = (await kvGet<string[]>(INDEX)) ?? [];
  if (!ids.length) return 0;

  const rows = await kvMGet<UploadRow>(ids.map(KEY));
  const keep: string[] = [];
  let deleted = 0;

  for (const [i, row] of rows.entries()) {
    if (!row) continue;
    if (row.expiresAt !== null && row.expiresAt < now) {
      await deleteBlob(row.publicUrl);
      await kvDel(KEY(row.id));
      deleted++;
    } else {
      keep.push(ids[i]);
    }
  }

  if (deleted) await kvSet(INDEX, keep);
  return deleted;
}
