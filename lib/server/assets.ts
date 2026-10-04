/**
 * The asset library — music, sound effects, motion overlays, banners, stock
 * clips.
 *
 * Deliberately central rather than a folder on each machine: Colab and Kaggle
 * get a fresh disk every session, so anything stored on the backend would have
 * to be re-uploaded constantly. Here it's uploaded once and every backend sees
 * it, because the gateway picks the assets and passes URLs.
 *
 * Random selection also happens HERE, not on the backend, so a render looks
 * the same whichever GPU answered.
 */

import type { Asset, AssetKind } from "@/lib/types";
import { ASSET_KINDS } from "@/lib/types";
import { deleteBlob, isBlobConfigured, putBlob } from "./blob";
import { isRedisConfigured, kvDel, kvGet, kvSet } from "./redis";

const KEY = (id: string) => `vf:asset:${id}`;
const INDEX = "vf:assets";

/** Motion loops are the big ones; everything else is far smaller. */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

/** What each kind is allowed to be, so a banner can't arrive as an MP3. */
const ALLOWED: Record<AssetKind, RegExp> = {
  music: /^audio\//,
  sfx: /^audio\//,
  motion: /^video\//,
  banner: /^image\//,
  intro: /^video\//,
  outro: /^video\//,
  clip: /^video\//,
};

export class AssetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AssetError";
    this.status = status;
  }
}

export function isAssetStorageReady(): boolean {
  return isRedisConfigured() && isBlobConfigured();
}

export function assetStorageHint(): string | null {
  const missing: string[] = [];
  if (!isRedisConfigured()) missing.push("Upstash Redis");
  if (!isBlobConfigured()) missing.push("Blob");
  if (!missing.length) return null;
  return `Add ${missing.join(" and ")} in Vercel → Storage → Marketplace (free), then redeploy.`;
}

// --- pure helpers (unit-tested) ------------------------------------------

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

/** Keeps Blob paths readable: "Epic Drums.mp3" -> "epic-drums". */
export function slugifyAssetName(name: string): string {
  const slug = name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "asset";
}

/**
 * Pick a file extension we're willing to serve.
 *
 * Taken from the original filename when it looks sane, since that's more
 * reliable than guessing from a MIME type a browser may have invented, and
 * ffmpeg on the backend cares about the container.
 */
export function assetExtension(fileName: string, mime: string): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(fileName)?.[1]?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const fromMime = mime.split("/")[1]?.split(";")[0]?.toLowerCase();
  return fromMime && /^[a-z0-9]{2,5}$/.test(fromMime) ? fromMime : "bin";
}

export function assertAllowed(kind: AssetKind, mime: string): void {
  if (!ALLOWED[kind].test(mime)) {
    const want = ALLOWED[kind].source.replace(/[^a-z]/g, "");
    throw new AssetError(`A ${kind} asset must be ${want}, not "${mime}".`);
  }
}

/**
 * Deterministic-ish random choice.
 *
 * `rand` is injectable so tests can pin the result; production just uses
 * Math.random. Picking without replacement matters for motion overlays — the
 * same loop twice in one video is noticeable.
 */
export function sample<T>(items: T[], count: number, rand: () => number = Math.random): T[] {
  if (count >= items.length) return [...items];
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

// --- store ---------------------------------------------------------------

async function readIndex(): Promise<string[]> {
  return (await kvGet<string[]>(INDEX)) ?? [];
}

export async function listAssets(kind?: AssetKind): Promise<Asset[]> {
  const ids = await readIndex();
  if (!ids.length) return [];
  const rows = await Promise.all(ids.map((id) => kvGet<Asset>(KEY(id))));
  return rows
    .filter((r): r is Asset => Boolean(r) && (!kind || r!.kind === kind))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAsset(id: string): Promise<Asset | null> {
  return kvGet<Asset>(KEY(id));
}

export interface CreateAssetInput {
  kind: AssetKind;
  name: string;
  tag?: string;
  fileName: string;
  mime: string;
  bytes: ArrayBuffer;
  durationSec?: number;
}

export async function createAsset(input: CreateAssetInput): Promise<Asset> {
  if (!isAssetStorageReady()) {
    throw new AssetError(assetStorageHint() ?? "Storage isn't connected.", 503);
  }
  if (input.bytes.byteLength > MAX_ASSET_BYTES) {
    throw new AssetError("That file is over 50 MB.", 413);
  }
  assertAllowed(input.kind, input.mime);

  const id = `${slugifyAssetName(input.name || input.fileName)}-${crypto.randomUUID().slice(0, 8)}`;
  const ext = assetExtension(input.fileName, input.mime);
  const blob = await putBlob(`assets/${input.kind}/${id}.${ext}`, input.bytes, input.mime);

  const asset: Asset = {
    id,
    kind: input.kind,
    name: (input.name || input.fileName).trim().slice(0, 80),
    tag: input.tag?.trim().slice(0, 40) || undefined,
    url: blob.url,
    mime: input.mime,
    sizeBytes: input.bytes.byteLength,
    durationSec: input.durationSec,
    createdAt: Date.now(),
  };

  await kvSet(KEY(id), asset);
  await kvSet(INDEX, [id, ...(await readIndex()).filter((x) => x !== id)]);
  return asset;
}

export async function deleteAsset(id: string): Promise<boolean> {
  const existing = await getAsset(id);
  if (!existing) return false;
  await deleteBlob(existing.url);
  await kvDel(KEY(id));
  await kvSet(INDEX, (await readIndex()).filter((x) => x !== id));
  return true;
}

/**
 * Choose assets for a render. Returns [] rather than throwing when the
 * library is empty — a missing music track should mean "no music", never a
 * failed video.
 */
export async function pickAssets(
  kind: AssetKind,
  count = 1,
  tag?: string
): Promise<Asset[]> {
  const all = await listAssets(kind);
  const pool = tag ? all.filter((a) => a.tag === tag) : all;
  return sample(pool, count);
}
