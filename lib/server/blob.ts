/**
 * Vercel Blob — voice reference clips and generated audio.
 *
 * Same rule as redis.ts: unconfigured means "feature unavailable", never a
 * crash. Callers check isBlobConfigured() and show a setup hint instead.
 */

import { del, put, type PutBlobResult } from "@vercel/blob";

export function isBlobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
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
  if (!isBlobConfigured()) throw new BlobNotConfiguredError();
  return put(pathname, body as Blob, {
    access: "public",
    contentType,
    // Paths are already namespaced (voices/<id>, jobs/<id>) and we want a
    // stable URL per id, so don't let Blob append a random suffix.
    addRandomSuffix: false,
  });
}

export async function deleteBlob(url: string): Promise<void> {
  if (!isBlobConfigured()) return;
  try {
    await del(url);
  } catch (e) {
    console.warn("[voiceforge] blob delete failed:", e);
  }
}
