import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isAuthConfigured, verifySessionToken } from "@/lib/server/auth";

/**
 * Gates the whole UI + /api/admin behind the admin session.
 *
 * SAFETY: if ADMIN_PASSWORD / SESSION_SECRET are not set, the app stays open
 * exactly as before. That is intentional — deploying this must never lock the
 * owner out of a live site before they've had a chance to set the env vars.
 * The gate switches itself on the moment both are present.
 *
 * Machine endpoints (/api/v1, /api/backends/register, /api/internal) carry
 * their own auth (API key / registration token / callback token) and are
 * excluded here so automations keep working without a browser session.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/api/admin/session", // the login endpoint itself
  "/api/v1", // API-key auth
  "/api/backends/register", // registration-token auth
  "/api/internal", // callback-token auth
  "/api/proxy", // legacy studio relay (allowlisted separately)
];

export async function middleware(req: NextRequest) {
  // Feature-flagged by configuration: no credentials set ⇒ no gate.
  if (!isAuthConfigured()) return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const authed = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (authed) return NextResponse.next();

  // API calls get a clean 401; humans get redirected to the login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.svg|favicon.ico).*)"],
};
