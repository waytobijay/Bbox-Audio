/**
 * Vercel Blob — voice reference clips and generated audio.
 *
 * Same rule as redis.ts: unconfigured means "feature unavailable", never a
 * crash. Callers check isBlobConfigured() and show a setup hint instead.
 */

import { del, put, type PutBlobResult } from "@vercel/blob";

/**
 * The SDK reads BLOB_READ_WRITE_TOKEN by default, but Vercel prefixes the
 * variable with the store's name when a project has more than one store
 * (e.g. VOICEFORGE_BLOB_READ_WRITE_TOKEN). Find whichever one exists and pass
 * it explicitly, so naming never becomes something the user has to fix.
 */
export function blobToken(): string | undefined {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  const key = Object.keys(process.env).find((k) => k.endsWith("BLOB_READ_WRITE_TOKEN"));
  return key ? process.env[key] : undefined;
}

export function isBlobConfigured(): boolean {
  return Boolean(blobToken());
}

export class BlobNotConfiguredError extends Error {
  constructor() {
    super("Vercel Blob is not connected. Add the Blob store in the Vercel dashboard.");
    this.name = "BlobNotConfiguredError";
  }
}

export async function putBlob(
  pathname: string,
  body: Blob | ArrayBuffer | Buffer | string,
  contentType?: string
): Promise<PutBlobResult> {
  const token = blobToken();
  if (!token) throw new BlobNotConfiguredError();
  return put(pathname, body as Blob, {
    access: "public",
    contentType,
    token,
    // Paths are already namespaced (voices/<id>, jobs/<id>) and we want a
    // stable URL per id, so don't let Blob append a random suffix.
    addRandomSuffix: false,
  });
}

export async function deleteBlob(url: string): Promise<void> {
  const token = blobToken();
  if (!token) return;
  try {
    await del(url, { token });
  } catch (e) {
    console.warn("[voiceforge] blob delete failed:", e);
  }
}
