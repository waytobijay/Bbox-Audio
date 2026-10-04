import { describe, expect, it } from "vitest";
import {
  AssetError,
  assertAllowed,
  assetExtension,
  isAssetKind,
  sample,
  slugifyAssetName,
} from "../server/assets";

/**
 * The asset library's sharp edges: what a kind is allowed to be (a banner
 * arriving as an MP3 would break a render deep inside ffmpeg), what extension
 * the file gets (the backend's ffmpeg cares about the container), and the
 * random pick that decides what a video sounds and looks like.
 */

describe("isAssetKind", () => {
  it("accepts the kinds the renderer understands", () => {
    for (const k of ["music", "sfx", "motion", "banner", "intro", "outro", "clip"]) {
      expect(isAssetKind(k)).toBe(true);
    }
  });

  it("rejects anything else, rather than storing an unusable row", () => {
    expect(isAssetKind("voice")).toBe(false);
    expect(isAssetKind("")).toBe(false);
  });
});

describe("assertAllowed", () => {
  it("lets each kind through with the media type it needs", () => {
    expect(() => assertAllowed("music", "audio/mpeg")).not.toThrow();
    expect(() => assertAllowed("motion", "video/webm")).not.toThrow();
    expect(() => assertAllowed("banner", "image/png")).not.toThrow();
  });

  it("rejects a banner that isn't an image", () => {
    expect(() => assertAllowed("banner", "audio/mpeg")).toThrow(AssetError);
  });

  it("rejects a motion overlay that is actually audio", () => {
    expect(() => assertAllowed("motion", "audio/wav")).toThrow();
  });

  it("names the offending type in the message, so the fix is obvious", () => {
    expect(() => assertAllowed("music", "image/png")).toThrow(/image\/png/);
  });
});

describe("slugifyAssetName", () => {
  it("drops the extension and makes a readable path", () => {
    expect(slugifyAssetName("Epic Drums.mp3")).toBe("epic-drums");
  });

  it("collapses punctuation", () => {
    expect(slugifyAssetName("  Light__Leak (v2)!.webm ")).toBe("light-leak-v2");
  });

  it("never returns empty, so the blob path stays valid", () => {
    expect(slugifyAssetName("日本語.mp3")).toBe("asset");
    expect(slugifyAssetName("")).toBe("asset");
  });
});

describe("assetExtension", () => {
  it("prefers the real filename extension", () => {
    expect(assetExtension("loop.webm", "video/mp4")).toBe("webm");
  });

  it("falls back to the media type when the name has none", () => {
    expect(assetExtension("noextension", "audio/mpeg")).toBe("mpeg");
  });

  it("gives up safely rather than producing a junk extension", () => {
    expect(assetExtension("file", "application/octet-stream")).toBe("bin");
  });

  it("ignores a query string masquerading as an extension", () => {
    expect(assetExtension("track.mp3", "audio/mpeg")).toBe("mp3");
  });
});

describe("sample", () => {
  const items = ["a", "b", "c", "d"];

  it("returns the number asked for", () => {
    expect(sample(items, 2, () => 0).length).toBe(2);
  });

  it("never repeats — the same overlay twice in one video is obvious", () => {
    const picked = sample(items, 4, () => 0.5);
    expect(new Set(picked).size).toBe(4);
  });

  it("returns everything when asked for more than exists", () => {
    expect(sample(items, 99).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("returns nothing from an empty library instead of throwing", () => {
    // A missing music track must mean "no music", never a failed render.
    expect(sample([], 3)).toEqual([]);
  });

  it("is driven by the supplied randomness, so it can be pinned", () => {
    expect(sample(items, 2, () => 0)).toEqual(["a", "b"]);
  });
});
