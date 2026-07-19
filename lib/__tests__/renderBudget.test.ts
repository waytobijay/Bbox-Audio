import { describe, expect, it } from "vitest";
import {
  ENHANCER_MULTIPLIER,
  RENDER_COST,
  SADTALKER_MAX_AUDIO_SEC,
  estimateRenderSec,
} from "../config";

/**
 * These encode the lesson from a real 2.5-minute SadTalker job that ran 45
 * minutes and then timed out: the app must refuse work it cannot finish,
 * rather than warn and let the user discover it the hard way.
 */
describe("render budgeting", () => {
  it("rates SadTalker as far slower than real time", () => {
    expect(RENDER_COST.sadtalker).toBeGreaterThan(RENDER_COST.wav2lip * 4);
  });

  it("would have predicted the 2.5-minute job overrunning", () => {
    const audioSec = 150; // the clip that wasted 45 minutes
    const est = estimateRenderSec("sadtalker", audioSec);
    expect(est).toBeGreaterThan(25 * 60);
    // and that same clip is over the hard limit, so it is now blocked outright
    expect(audioSec).toBeGreaterThan(SADTALKER_MAX_AUDIO_SEC);
  });

  it("keeps Wav2Lip on the same clip to a practical wait", () => {
    expect(estimateRenderSec("wav2lip", 150)).toBeLessThan(10 * 60);
  });

  it("accounts for the per-frame enhancer", () => {
    const off = estimateRenderSec("sadtalker", 60, false);
    const on = estimateRenderSec("sadtalker", 60, true);
    expect(on).toBeCloseTo(off * ENHANCER_MULTIPLIER);
  });

  it("allows a short clip through", () => {
    expect(60).toBeLessThanOrEqual(SADTALKER_MAX_AUDIO_SEC);
    expect(estimateRenderSec("sadtalker", 60)).toBeLessThan(20 * 60);
  });
});
