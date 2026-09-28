import { describe, expect, it } from "vitest";
import {
  KEY_PREFIX,
  currentMonth,
  generateKey,
  hashKey,
} from "../server/apikeys";

/**
 * Key handling is the security boundary of the public API, so the properties
 * worth pinning are: keys are unguessable, the stored form is not the key, and
 * the same key always hashes to the same lookup value.
 */

describe("generateKey", () => {
  it("is prefixed so a leaked key is recognisable in a log", () => {
    expect(generateKey().startsWith(KEY_PREFIX)).toBe(true);
  });

  it("carries 256 bits of randomness", () => {
    // 32 bytes base64url, unpadded = 43 characters.
    expect(generateKey().slice(KEY_PREFIX.length).length).toBe(43);
  });

  it("is URL-safe, so it survives headers and query strings intact", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateKey()).toMatch(/^vf_live_[A-Za-z0-9_-]+$/);
    }
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateKey()));
    expect(seen.size).toBe(200);
  });
});

describe("hashKey", () => {
  it("is stable, so lookup by hash finds the same key every time", async () => {
    const key = generateKey();
    expect(await hashKey(key)).toBe(await hashKey(key));
  });

  it("is a 64-character SHA-256 hex digest", async () => {
    expect(await hashKey("vf_live_example")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not contain the key — that's the point of storing the hash", async () => {
    const key = generateKey();
    const hash = await hashKey(key);
    expect(hash).not.toContain(key.slice(KEY_PREFIX.length));
  });

  it("differs for keys that differ by one character", async () => {
    expect(await hashKey("vf_live_aaaa")).not.toBe(await hashKey("vf_live_aaab"));
  });

  it("matches the known SHA-256 of a fixed string", async () => {
    // Guards against a future refactor quietly changing the digest and
    // invalidating every stored key.
    expect(await hashKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("currentMonth", () => {
  it("formats as YYYY-MM in UTC", () => {
    expect(currentMonth(new Date("2026-09-29T23:30:00Z"))).toBe("2026-09");
  });

  it("pads single-digit months, so keys sort lexicographically", () => {
    expect(currentMonth(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01");
  });

  it("rolls over on the UTC boundary, not the local one", () => {
    expect(currentMonth(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10");
  });
});
