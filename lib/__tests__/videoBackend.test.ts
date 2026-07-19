import { afterEach, describe, expect, it, vi } from "vitest";
import { animate, VideoBackendError } from "../videoBackend";

/**
 * These cover the job/poll protocol, which exists because a Cloudflare quick
 * tunnel kills any single response over ~100s. The client must never hold one
 * long request open — it starts a job, polls, then fetches the result.
 */

const URL_BASE = "https://x.trycloudflare.com";

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function makeArgs() {
  return {
    imageBlob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    audioBlob: new Blob([new Uint8Array([4, 5, 6])], { type: "audio/wav" }),
    engine: "wav2lip" as const,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("animate — job/poll protocol", () => {
  it("starts a job, polls until done, then fetches the video", async () => {
    const calls: string[] = [];
    let polls = 0;

    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(URL_BASE, "");
      calls.push(`${init?.method ?? "GET"} ${path}`);

      if (path === "/animate") return jsonRes({ job_id: "abc123", duration: 4.2 });
      if (path === "/job/abc123") {
        polls++;
        return polls < 2
          ? jsonRes({ status: "processing", stage: "Syncing lips", percent: 42 })
          : jsonRes({ status: "done", stage: "Finished", percent: 100, gen_seconds: 12.5 });
      }
      if (path === "/job/abc123/video") {
        return jsonRes({ video_b64: btoa("fake-mp4"), duration: 4.2, gen_seconds: 12.5 });
      }
      throw new Error("unexpected " + path);
    }));

    const reports: Array<{ stage: string; percent?: number }> = [];
    const res = await animate(URL_BASE, makeArgs(), (p) => reports.push(p));

    // never holds one long request: start, poll(s), then fetch result
    expect(calls[0]).toBe("POST /animate");
    expect(calls.filter((c) => c === "GET /job/abc123").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("GET /job/abc123/video");

    expect(res.videoBlob.type).toBe("video/mp4");
    expect(res.durationSec).toBe(4.2);
    expect(res.genSeconds).toBe(12.5);

    // the backend's own stage text is surfaced, never invented from elapsed time
    expect(reports.map((r) => r.stage)).toContain("Syncing lips");
    // and its real percentage reaches the UI, so the bar is not decorative
    expect(reports.some((r) => r.percent === 42)).toBe(true);
  }, 20_000);

  it("passes framing and enhancer choices to the backend", async () => {
    let posted: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(URL_BASE, "");
      if (path === "/animate") {
        posted = JSON.parse(String(init?.body));
        return jsonRes({ job_id: "j2", duration: 1 });
      }
      if (path === "/job/j2") return jsonRes({ status: "done", percent: 100 });
      if (path === "/job/j2/video") return jsonRes({ video_b64: btoa("v"), duration: 1 });
      throw new Error("unexpected " + path);
    }));

    await animate(URL_BASE, { ...makeArgs(), engine: "sadtalker", framing: "crop", enhance: false });
    expect(posted.framing).toBe("crop");
    expect(posted.enhance).toBe(false);
  }, 20_000);

  it("surfaces the backend's real error when a render fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = url.replace(URL_BASE, "");
      if (path === "/animate") return jsonRes({ job_id: "j1", duration: 1 });
      if (path === "/job/j1") {
        return jsonRes({ status: "failed", error: "CUDA out of memory" });
      }
      throw new Error("unexpected " + path);
    }));

    await expect(animate(URL_BASE, makeArgs())).rejects.toThrow(/CUDA out of memory/);
  }, 20_000);

  it("reports a network failure rather than hanging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await expect(animate(URL_BASE, makeArgs())).rejects.toBeInstanceOf(VideoBackendError);
  }, 20_000);
});
