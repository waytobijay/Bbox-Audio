import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callbackToken, isValidCallbackToken } from "../server/jobs";

/**
 * The callback token is what stops anyone from POSTing a fake "done" to a job
 * and pointing it at audio they chose. It's derived rather than stored, so the
 * properties that matter are: bound to one job, bound to the secret, and
 * compared without leaking length or position.
 */

const ORIGINAL = process.env.BACKEND_SECRET;

beforeEach(() => {
  process.env.BACKEND_SECRET = "test-secret";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BACKEND_SECRET;
  else process.env.BACKEND_SECRET = ORIGINAL;
});

describe("callbackToken", () => {
  it("is stable for one job", async () => {
    expect(await callbackToken("job-1")).toBe(await callbackToken("job-1"));
  });

  it("differs per job, so a token for one job can't finish another", async () => {
    expect(await callbackToken("job-1")).not.toBe(await callbackToken("job-2"));
  });

  it("changes when BACKEND_SECRET is rotated", async () => {
    const before = await callbackToken("job-1");
    process.env.BACKEND_SECRET = "rotated";
    expect(await callbackToken("job-1")).not.toBe(before);
  });

  it("is a hex digest, safe to put in a header", async () => {
    expect(await callbackToken("job-1")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isValidCallbackToken", () => {
  it("accepts the matching token", async () => {
    expect(await isValidCallbackToken("job-1", await callbackToken("job-1"))).toBe(true);
  });

  it("rejects another job's token", async () => {
    expect(await isValidCallbackToken("job-1", await callbackToken("job-2"))).toBe(false);
  });

  it("rejects a missing token rather than defaulting to allowed", async () => {
    expect(await isValidCallbackToken("job-1", null)).toBe(false);
    expect(await isValidCallbackToken("job-1", "")).toBe(false);
  });

  it("rejects a truncated token", async () => {
    const token = await callbackToken("job-1");
    expect(await isValidCallbackToken("job-1", token.slice(0, -1))).toBe(false);
  });

  it("rejects a token that differs in the last character only", async () => {
    const token = await callbackToken("job-1");
    const flipped = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expect(await isValidCallbackToken("job-1", flipped)).toBe(false);
  });
});
