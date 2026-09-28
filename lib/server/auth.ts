/**
 * Admin auth — one admin user, password from an env var.
 *
 * Deliberately dependency-free: everything uses Web Crypto, so this runs in
 * both the Node runtime and Edge middleware without bundling bcrypt.
 *
 * Session = an HMAC-signed cookie value. There is no session store, so
 * logging out everywhere is done by rotating SESSION_SECRET.
 */

export const SESSION_COOKIE = "vf_session";
const SESSION_HOURS = 12;

/** Auth only switches on once BOTH vars are set — see isAuthConfigured(). */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.SESSION_SECRET);
}

/**
 * Returns a plain ArrayBuffer. TextEncoder yields Uint8Array<ArrayBufferLike>,
 * which recent TS lib types won't accept as a BufferSource (it could in
 * principle be backed by a SharedArrayBuffer). Copying into a fresh buffer
 * keeps Web Crypto happy without casting away the type.
 */
function enc(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc(message));
  return toBase64Url(new Uint8Array(sig));
}

/**
 * Compare without leaking length or position through timing. Both sides are
 * hashed first so the comparison is always over equal-length digests.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc(value));
  return toBase64Url(new Uint8Array(digest));
}

export async function verifyPassword(candidate: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

/** `<expiresAt>.<signature>` — self-contained, no server-side session store. */
export async function createSessionToken(): Promise<string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = String(expiresAt);
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  const secret = process.env.SESSION_SECRET;
  if (!secret || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = await hmac(secret, payload);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  if (diff !== 0) return false;

  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 60 * 60,
  };
}
