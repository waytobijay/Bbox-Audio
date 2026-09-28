import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The collection step is where a long render could silently break: audio must
 * come back over GET (a response has no size cap) rather than inside the
 * callback body (which Vercel rejects over 4.5 MB). These tests pin that
 * contract, plus the reconcile path that rescues a job whose callback was
 * lost — the failure that would otherwise strand a finished render forever.
 */

const store = new Map<string, unknown>();
const putBlob = vi.fn(async (pathname: string) => ({
  url: `https://blob.test/${pathname}`,
}));

vi.mock("../server/redis", () => ({
  kvGet: vi.fn(async (k: string) => store.get(k) ?? null),
  kvSet: vi.fn(async (k: string, v: unknown) => {
    store.set(k, v);
    return true;
  }),
  kvDel: vi.fn(async (k: string) => store.delete(k)),
  getRedis: () => null,
  isRedisConfigured: () => true,
  getSettings: async () => ({
    retentionDays: 7,
    kaggleNotebookUrl: "",
    defaultModel: "chatterbox",
    defaultLanguage: "en",
  }),
}));

vi.mock("../server/blob", () => ({
  putBlob: (...args: unknown[]) => putBlob(args[0] as string),
  deleteBlob: vi.fn(async () => {}),
  isBlobConfigured: () => true,
}));

vi.mock("../server/backends", () => ({
  backendHeaders: () => ({ "Content-Type": "application/json", "X-Backend-Secret": "s" }),
  resolveBackend: async () => null,
}));

const { collectJob, reconcileJob } = await import("../server/jobs");
type Job = Awaited<ReturnType<typeof reconcileJob>>;

function job(patch: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    status: "running",
    mode: "stitch",
    format: "mp3",
    voiceId: "me-1234",
    source: "key-1",
    chars: 100,
    chunks: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    backend: "colab",
    backendUrl: "https://gpu.test",
    ...patch,
  } as Job;
}

/** Minimal fetch double that maps URL substrings to responses. */
function routeFetch(routes: Record<string, { status?: number; json?: unknown; body?: string }>) {
  const fn = vi.fn(async (url: string | URL) => {
    const href = String(url);
    const hit = Object.entries(routes).find(([frag]) => href.includes(frag));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    const [, spec] = hit;
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.json,
      arrayBuffer: async () => new TextEncoder().encode(spec.body ?? "AUDIO").buffer,
      text: async () => spec.body ?? "",
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => store.clear());
afterEach(() => vi.unstubAllGlobals());

describe("collectJob", () => {
  it("pulls the file over GET and stores it, rather than reading it from the callback", async () => {
    const fetchMock = routeFetch({ "/jobs/job-1/audio/0": { body: "MP3BYTES" } });

    const done = await collectJob(job(), {
      status: "done",
      format: "mp3",
      duration: 12.5,
      gen_seconds: 30,
      items: [{ index: 0, duration: 12.5 }],
    });

    expect(done.status).toBe("done");
    expect(done.audioUrl).toBe("https://blob.test/jobs/job-1.mp3");
    expect(done.duration).toBe(12.5);
    // The audio came from a GET to the backend, not from the request body.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/jobs/job-1/audio/0"))).toBe(true);
  });

  it("keeps one file per item in batch mode and sets no single audio_url", async () => {
    routeFetch({
      "/jobs/job-1/audio/0": { body: "ONE" },
      "/jobs/job-1/audio/1": { body: "TWO" },
    });

    const done = await collectJob(job({ mode: "items" }), {
      status: "done",
      format: "mp3",
      items: [
        { index: 0, duration: 1 },
        { index: 1, duration: 2 },
      ],
    });

    expect(done.items?.map((i) => i.audioUrl)).toEqual([
      "https://blob.test/jobs/job-1-0.mp3",
      "https://blob.test/jobs/job-1-1.mp3",
    ]);
    expect(done.audioUrl).toBeUndefined();
  });

  it("records the backend's error instead of pretending the job finished", async () => {
    routeFetch({});
    const failed = await collectJob(job(), { status: "error", error: "CUDA out of memory" });
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("CUDA out of memory");
  });

  it("fails the job when a file can't be collected, rather than half-finishing it", async () => {
    routeFetch({ "/jobs/job-1/audio/0": { status: 410 } });
    const failed = await collectJob(job(), {
      status: "done",
      items: [{ index: 0, duration: 1 }],
    });
    expect(failed.status).toBe("error");
    expect(failed.error).toMatch(/couldn't collect item 0/i);
  });

  it("honours the format the backend actually produced, not the one requested", async () => {
    // The backend falls back to WAV when libsndfile has no MP3 support.
    routeFetch({ "/jobs/job-1/audio/0": { body: "WAVBYTES" } });
    const done = await collectJob(job({ format: "mp3" }), {
      status: "done",
      format: "wav",
      items: [{ index: 0, duration: 1 }],
    });
    expect(done.format).toBe("wav");
    expect(done.audioUrl).toBe("https://blob.test/jobs/job-1.wav");
  });
});

describe("reconcileJob", () => {
  it("finishes a job whose callback never arrived", async () => {
    routeFetch({
      "/jobs/job-1/audio/0": { body: "MP3" },
      "/jobs/job-1": { json: { status: "done", format: "mp3", items: [{ index: 0, duration: 3 }] } },
    });

    const settled = await reconcileJob(job());
    expect(settled.status).toBe("done");
    expect(settled.audioUrl).toBe("https://blob.test/jobs/job-1.mp3");
  });

  it("gives up when the backend has forgotten the job — a restarted Colab", async () => {
    routeFetch({ "/jobs/job-1": { status: 404 } });
    const settled = await reconcileJob(job());
    expect(settled.status).toBe("error");
    expect(settled.error).toMatch(/restarted/i);
  });

  it("leaves a still-running job alone", async () => {
    routeFetch({ "/jobs/job-1": { json: { status: "running", progress: 40 } } });
    expect((await reconcileJob(job())).status).toBe("running");
  });

  it("keeps the job running when the backend is briefly unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      })
    );
    expect((await reconcileJob(job())).status).toBe("running");
  });

  it("never re-collects a job that is already done", async () => {
    const fetchMock = routeFetch({});
    const already = job({ status: "done" });
    expect(await reconcileJob(already)).toBe(already);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
