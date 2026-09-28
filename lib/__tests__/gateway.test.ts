import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendError } from "../backend";
import { gatewayGenerate } from "../gateway";

/**
 * How a gateway failure is classified decides what the studio does with a
 * half-finished narration: "network" pauses the queue and keeps every rendered
 * chunk, "api" burns a retry on that chunk. Getting this backwards means
 * either losing work or hammering a backend that isn't there.
 */

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const body = {
  text: "Hello.",
  voiceId: "me-abcd1234",
  model: "chatterbox" as const,
  seed: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe("gatewayGenerate", () => {
  it("returns audio on success", async () => {
    // "UklGRg==" is just some valid base64 — decoding is audio.ts's job.
    mockFetch(200, {
      audio_b64: "UklGRg==",
      sample_rate: 24000,
      duration: 1.5,
      gen_seconds: 2.1,
    });
    const result = await gatewayGenerate(body);
    expect(result.durationSec).toBe(1.5);
    expect(result.sampleRate).toBe(24000);
    expect(result.audioBlob.size).toBeGreaterThan(0);
  });

  it("treats a missing backend as a network failure, so the queue pauses", async () => {
    mockFetch(503, { error: "No GPU backend is online.", code: "no_backend" });
    await expect(gatewayGenerate(body)).rejects.toMatchObject({
      name: "BackendError",
      kind: "network",
    });
  });

  it("treats a backend timeout as a network failure too", async () => {
    mockFetch(504, { error: "Took too long.", code: "backend_timeout" });
    await expect(gatewayGenerate(body)).rejects.toMatchObject({ kind: "network" });
  });

  it("treats a bad request as an api failure, so it isn't retried forever", async () => {
    mockFetch(404, { error: 'No voice with id "nope".', code: "unknown_voice" });
    await expect(gatewayGenerate(body)).rejects.toMatchObject({ kind: "api" });
  });

  it("surfaces the server's own message rather than a generic one", async () => {
    mockFetch(502, { error: "Generation failed on colab (500).", code: "generate_failed" });
    await expect(gatewayGenerate(body)).rejects.toThrow(/Generation failed on colab/);
  });

  it("fails as network when the request itself can't be sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const err = await gatewayGenerate(body).catch((e) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect(err.kind).toBe("network");
  });

  it("rejects a 200 that carries no audio instead of returning an empty clip", async () => {
    mockFetch(200, { sample_rate: 24000 });
    await expect(gatewayGenerate(body)).rejects.toBeInstanceOf(BackendError);
  });
});
