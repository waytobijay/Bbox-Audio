import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  SCENE_RETENTION_DAYS,
  expiryFor,
  maxBytesFor,
  sanitiseFilename,
  uploadPathname,
} from "../server/uploads";

/**
 * Uploads put a client-supplied name into a storage path that ffmpeg, urllib
 * and a browser all have to agree on, and decide what gets swept a week
 * later. Both are easy to get subtly wrong and hard to notice.
 */

describe("sanitiseFilename", () => {
  it("keeps an ordinary name", () => {
    expect(sanitiseFilename("scene-01.png")).toBe("scene-01.png");
  });

  it("lowercases and replaces spaces", () => {
    expect(sanitiseFilename("My Scene 1.PNG")).toBe("my-scene-1.png");
  });

  it("strips path separators, so a name can't escape its prefix", () => {
    expect(sanitiseFilename("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitiseFilename("a/b/c.png")).toBe("a-b-c.png");
  });

  it("strips characters that would need escaping in a URL", () => {
    expect(sanitiseFilename("a b&c?d#e.png")).toBe("a-b-c-d-e.png");
  });

  it("never returns empty", () => {
    expect(sanitiseFilename("???")).toBe("file");
    expect(sanitiseFilename("")).toBe("file");
  });

  it("caps the length", () => {
    expect(sanitiseFilename("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("does not leave a leading dot, which would hide the object", () => {
    expect(sanitiseFilename(".hidden.png").startsWith(".")).toBe(false);
  });
});

describe("maxBytesFor", () => {
  it("allows video to be larger than images", () => {
    expect(maxBytesFor("video/mp4")).toBe(MAX_VIDEO_BYTES);
    expect(maxBytesFor("image/png")).toBe(MAX_IMAGE_BYTES);
    expect(MAX_VIDEO_BYTES).toBeGreaterThan(MAX_IMAGE_BYTES);
  });

  it("treats every image type the same", () => {
    expect(maxBytesFor("image/jpeg")).toBe(maxBytesFor("image/webp"));
  });
});

describe("uploadPathname", () => {
  const day = new Date("2026-10-05T11:00:00Z");

  it("partitions by key and date", () => {
    expect(uploadPathname("key-1", "a.png", "uuid-1", day)).toBe(
      "uploads/key-1/2026-10-05/uuid-1-a.png"
    );
  });

  it("always sits under uploads/", () => {
    // The cleanup sweep and any storage rule key off this prefix.
    expect(uploadPathname("k", "../x.png", "id", day).startsWith("uploads/")).toBe(true);
  });

  it("keeps two uploads of the same name apart", () => {
    const a = uploadPathname("k", "same.png", "id-a", day);
    const b = uploadPathname("k", "same.png", "id-b", day);
    expect(a).not.toBe(b);
  });
});

describe("expiryFor", () => {
  const now = Date.UTC(2026, 9, 5);

  it("expires a scene upload after the retention window", () => {
    const expected = now + SCENE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(expiryFor("scene", now)).toBe(expected);
  });

  it("never expires a brand asset", () => {
    // A logo deleted a week after upload would silently vanish from every
    // later render.
    expect(expiryFor("brand", now)).toBeNull();
  });
});

/**
 * Overwrite.
 *
 * Vercel Blob refuses a PUT over an existing pathname unless the *signed
 * token* permits it — the `x-allow-overwrite` request header on its own is
 * ignored, or a client could grant itself more than it was given. An HTTP
 * client that retries a timed-out PUT therefore used to get a hard 400
 * ("This blob already exists") with no way to recover, even though the file
 * it was writing was its own.
 *
 * @vercel/blob 0.27 has no `allowOverwrite` in its types, but the token it
 * signs is a plain pass-through of the arguments. These tests pin that: if an
 * upgrade ever stops passing unknown options through, the flag would vanish
 * silently and uploads would start failing again in production only.
 */
describe("upload tokens allow a retried PUT", () => {
  const FAKE_RW = "vercel_blob_rw_store123_abcdefghijklmnop";

  const decode = (clientToken: string) => {
    const body = clientToken.replace(/^vercel_blob_client_[^_]+_/, "");
    const [, payload] = Buffer.from(body, "base64").toString().split(".");
    return JSON.parse(Buffer.from(payload, "base64").toString());
  };

  it("carries allowOverwrite in the signed payload", async () => {
    const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
    const token = await generateClientTokenFromReadWriteToken({
      token: FAKE_RW,
      pathname: "uploads/k/2026-10-05/uuid-a.png",
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: 1000,
      validUntil: Date.now() + 60_000,
      addRandomSuffix: false,
      allowOverwrite: true,
    } as Parameters<typeof generateClientTokenFromReadWriteToken>[0]);

    expect(decode(token).allowOverwrite).toBe(true);
  });

  it("still pins the pathname, type and size, so overwrite is not a loophole", async () => {
    const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
    const token = await generateClientTokenFromReadWriteToken({
      token: FAKE_RW,
      pathname: "uploads/k/2026-10-05/uuid-a.png",
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: 1000,
      validUntil: Date.now() + 60_000,
      addRandomSuffix: false,
      allowOverwrite: true,
    } as Parameters<typeof generateClientTokenFromReadWriteToken>[0]);

    const payload = decode(token);
    // The only thing a repeat PUT can replace is this one pathname, which
    // carries a UUID we generated — never another caller's file.
    expect(payload.pathname).toBe("uploads/k/2026-10-05/uuid-a.png");
    expect(payload.allowedContentTypes).toEqual(["image/png"]);
    expect(payload.maximumSizeInBytes).toBe(1000);
    expect(payload.addRandomSuffix).toBe(false);
  });

  it("gives every create a pathname of its own", () => {
    // A collision should be impossible in the first place; overwrite is for
    // a retry of the same upload, not for two uploads racing.
    const a = uploadPathname("key", "a.png", crypto.randomUUID());
    const b = uploadPathname("key", "a.png", crypto.randomUUID());
    expect(a).not.toBe(b);
  });
});
