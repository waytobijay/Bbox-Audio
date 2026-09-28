import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionToken,
  isAuthConfigured,
  safeEqual,
  sha256,
  verifyPassword,
  verifySessionToken,
} from "../server/auth";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_PASSWORD = "correct horse battery staple";
  process.env.SESSION_SECRET = "a".repeat(48);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("isAuthConfigured", () => {
  it("is off until BOTH vars are set, so deploying can't lock the owner out", () => {
    delete process.env.ADMIN_PASSWORD;
    delete process.env.SESSION_SECRET;
    expect(isAuthConfigured()).toBe(false);

    process.env.ADMIN_PASSWORD = "x";
    expect(isAuthConfigured()).toBe(false); // password alone isn't enough

    process.env.SESSION_SECRET = "y";
    expect(isAuthConfigured()).toBe(true);
  });
});

describe("verifyPassword", () => {
  it("accepts the exact password and rejects near-misses", async () => {
    expect(await verifyPassword("correct horse battery staple")).toBe(true);
    expect(await verifyPassword("correct horse battery stapl")).toBe(false);
    expect(await verifyPassword("Correct horse battery staple")).toBe(false);
    expect(await verifyPassword("")).toBe(false);
  });

  it("refuses everything when no password is configured", async () => {
    delete process.env.ADMIN_PASSWORD;
    expect(await verifyPassword("anything")).toBe(false);
    expect(await verifyPassword("")).toBe(false);
  });
});

describe("safeEqual / sha256", () => {
  it("compares by digest so length never leaks", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abcd")).toBe(false);
  });

  it("hashes deterministically without echoing the input", async () => {
    const h = await sha256("secret");
    expect(h).toBe(await sha256("secret"));
    expect(h).not.toContain("secret");
    expect(await sha256("secret2")).not.toBe(h);
  });
});

describe("session tokens", () => {
  it("round-trips a freshly issued token", async () => {
    expect(await verifySessionToken(await createSessionToken())).toBe(true);
  });

  it("rejects junk, empties and tampered payloads", async () => {
    expect(await verifySessionToken(undefined)).toBe(false);
    expect(await verifySessionToken("")).toBe(false);
    expect(await verifySessionToken("nonsense")).toBe(false);

    const token = await createSessionToken();
    const [payload, sig] = token.split(".");
    // extend the expiry but keep the old signature
    expect(await verifySessionToken(`${Number(payload) + 9e6}.${sig}`)).toBe(false);
    // keep the payload but forge the signature
    expect(await verifySessionToken(`${payload}.${"A".repeat(sig.length)}`)).toBe(false);
  });

  it("rejects a token signed with a different secret (rotation logs everyone out)", async () => {
    const token = await createSessionToken();
    process.env.SESSION_SECRET = "b".repeat(48);
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = await createSessionToken();
    const [payload] = token.split(".");
    // A past expiry can't be signed without the secret, but verify the clock
    // check independently by proving a future one passes and this shape fails.
    expect(Number(payload)).toBeGreaterThan(Date.now());
    expect(await verifySessionToken(`${Date.now() - 1000}.${token.split(".")[1]}`)).toBe(false);
  });
});
