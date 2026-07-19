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
          ? jsonRes({ status: "processing", stage: "Rendering with wav2lip…" })
          : jsonRes({ status: "done", stage: "Finished", gen_seconds: 12.5 });
      }
      if (path === "/job/abc123/video") {
        return jsonRes({ video_b64: btoa("fake-mp4"), duration: 4.2, gen_seconds: 12.5 });
      }
      throw new Error("unexpected " + path);
    }));

    const stages: string[] = [];
    const res = await animate(URL_BASE, makeArgs(), (s) => stages.push(s));

    // never holds one long request: start, poll(s), then fetch result
    expect(calls[0]).toBe("POST /animate");
    expect(calls.filter((c) => c === "GET /job/abc123").length).toBeGreaterThanOrEqual(2);
    expect(calls).toContain("GET /job/abc123/video");

    expect(res.videoBlob.type).toBe("video/mp4");
    expect(res.durationSec).toBe(4.2);
    expect(res.genSeconds).toBe(12.5);

    // backend's own stage text is surfaced, not guessed from elapsed time
    expect(stages).toContain("Rendering with wav2lip…");
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
