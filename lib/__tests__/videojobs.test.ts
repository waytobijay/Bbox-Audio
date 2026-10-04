import { describe, expect, it } from "vitest";
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
