import { describe, expect, it, vi } from "vitest";

// The library itself talks to Redis; only the picking matters here.
vi.mock("../server/assets", () => ({
  pickAssets: async (kind: string) =>
    kind === "intro" ? [{ url: "https://cdn.test/intro.mp4" }] : [],
}));
import { estimateSeconds } from "../server/videojobs";
import type { VideoScene } from "../types";

/**
 * Duration estimation decides where the closing sound effect lands and what
 * the caller is told to expect, before a single frame is rendered.
 */

const scene = (patch: Partial<VideoScene> = {}): VideoScene => ({
  type: "image",
  url: "https://cdn.test/1.png",
  ...patch,
});

describe("estimateSeconds", () => {
  it("uses each scene's own length when given", () => {
    expect(estimateSeconds([scene({ seconds: 10 }), scene({ seconds: 5 })], 4)).toBe(15);
  });

  it("falls back to the minimum for scenes that don't say", () => {
    expect(estimateSeconds([scene(), scene()], 4)).toBe(8);
  });

  it("mixes the two without double counting", () => {
    expect(estimateSeconds([scene({ seconds: 12 }), scene()], 4)).toBe(16);
  });

  it("is zero for no scenes, rather than NaN", () => {
    expect(estimateSeconds([], 4)).toBe(0);
  });

  it("scales to a long-form video", () => {
    const hundred = Array.from({ length: 100 }, () => scene({ seconds: 12 }));
    expect(estimateSeconds(hundred, 4)).toBe(1200);
  });
});

/**
 * Bookends. These used to accept only a full URL object, so a workflow that
 * had uploaded an intro got a video starting on scene one — the clip sat in
 * the library and nothing reached for it. `true` now means "take one from the
 * library", matching how `music` and `banner` have always behaved.
 */
describe("resolveBookend", () => {
  it("pulls from the library when asked for true", async () => {
    const { resolveBookend } = await import("../server/videojobs");
    const got = await resolveBookend(true, "intro");
    expect(got).toEqual({ type: "clip", url: "https://cdn.test/intro.mp4" });
  });

  it("gives nothing when the library is empty, rather than failing", async () => {
    const { resolveBookend } = await import("../server/videojobs");
    expect(await resolveBookend(true, "outro")).toBeUndefined();
  });

  it("passes a pinned scene straight through", async () => {
    const { resolveBookend } = await import("../server/videojobs");
    expect(
      await resolveBookend({ type: "clip", url: "https://cdn.test/mine.mp4", seconds: 6 }, "intro")
    ).toEqual({ type: "clip", url: "https://cdn.test/mine.mp4", audio_url: undefined, seconds: 6 });
  });

  it("renders no bookend for false or undefined", async () => {
    const { resolveBookend } = await import("../server/videojobs");
    expect(await resolveBookend(false, "intro")).toBeUndefined();
    expect(await resolveBookend(undefined, "intro")).toBeUndefined();
  });
});

/**
 * Frame windows. zod cannot check these — the limit is the request's own
 * width and height — so they are checked before a backend is claimed, and a
 * bad rect comes back as a 400 naming the scene rather than as a render that
 * dies ten minutes in.
 */
describe("assertFramesFit", () => {
  const framed = (rect: { x: number; y: number; w: number; h: number }): VideoScene => ({
    type: "image",
    url: "https://cdn.test/1.png",
    frame: { overlayUrl: "https://cdn.test/frame.png", rect },
  });

  it("accepts a window inside the canvas", async () => {
    const { assertFramesFit } = await import("../server/videojobs");
    expect(() =>
      assertFramesFit([framed({ x: 160, y: 150, w: 1600, h: 760 })], 1920, 1080)
    ).not.toThrow();
  });

  it("accepts a window flush with the edges", async () => {
    const { assertFramesFit } = await import("../server/videojobs");
    expect(() =>
      assertFramesFit([framed({ x: 0, y: 0, w: 1920, h: 1080 })], 1920, 1080)
    ).not.toThrow();
  });

  it("rejects one that hangs off the right", async () => {
    const { assertFramesFit } = await import("../server/videojobs");
    expect(() =>
      assertFramesFit([framed({ x: 1000, y: 0, w: 1600, h: 760 })], 1920, 1080)
    ).toThrow(/does not fit/);
  });

  it("rejects an empty window", async () => {
    const { assertFramesFit } = await import("../server/videojobs");
    expect(() =>
      assertFramesFit([framed({ x: 0, y: 0, w: 0, h: 760 })], 1920, 1080)
    ).toThrow(/must be positive/);
  });

  it("names the scene that is wrong", async () => {
    const { assertFramesFit } = await import("../server/videojobs");
    const ok = framed({ x: 0, y: 0, w: 100, h: 100 });
    expect(() =>
      assertFramesFit([ok, ok, framed({ x: 0, y: 0, w: 9999, h: 100 })], 1920, 1080)
    ).toThrow(/scene 2/);
  });

  it("ignores scenes with no frame at all", async () => {
    const { assertFramesFit } = await import("../server/videojobs");
    expect(() =>
      assertFramesFit([{ type: "image", url: "https://cdn.test/1.png" }], 1920, 1080)
    ).not.toThrow();
  });
});
