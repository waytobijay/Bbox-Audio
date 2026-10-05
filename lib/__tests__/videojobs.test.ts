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
