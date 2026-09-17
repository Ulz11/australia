import { SignJWT, decodeJwt, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { sql } from "./db";
import { demoConsoleOn } from "./flags";
import { isUuid } from "./validate";

export const SESSION_COOKIE = "onsite_session";

/**
 * Stay signed in: a login code is a text, and texts cost money. A session (cookie or bearer token) lasts a year
 * — Chrome caps a cookie at 400 days — and slides: POST /api/session/refresh (called from the boss and worker
 * layouts, at most every 6 h per browser) re-issues a cookie more than a day old, and the app swaps its token
 * at POST /api/v1/auth/refresh. Someone who opens OnSite at least once a year never needs another code.
 */
export const SESSION_DAYS = 365;
const SESSION_TTL = `${SESSION_DAYS}d`;
const SESSION_SECONDS = SESSION_DAYS * 24 * 60 * 60;
/** The cookie route leaves a younger session alone, so a busy day doesn't mean a Set-Cookie on every refresh. */
export const RENEW_AFTER_SECONDS = 24 * 60 * 60;

/** The session cookie, the same way every time it is set. */
export const sessionCookie = (token: string) => ({
  name: SESSION_COOKIE, value: token, httpOnly: true, sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production", maxAge: SESSION_SECONDS, path: "/",
});

/**
 * The control room shows a Boss phone and a Worker phone side by side on one origin.
 * Each frame gets its own cookie, scoped to its own path, so /boss/* and /worker/*
 * can be two different people at once. Only ever set by /api/console/login, which is
 * off unless DEMO_CONSOLE=1 (and always off in Vercel production — lib/flags.ts).
 */
export const FRAME_COOKIES = { boss: "onsite_frame_boss", worker: "onsite_frame_worker" } as const;
const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!s || s.length < 32))
    throw new Error("SESSION_SECRET must be set to a random string of 32+ characters in production");
  return new TextEncoder().encode(s || "dev-secret-change-me");
};

export type SessionUser = { id: string; phone: string; name: string | null; role: "boss" | "worker" | null; lang: string };

/**
 * The signed cookie carries the whole user (id, role, name), so reading "who is this"
 * costs zero database trips. Re-issue it whenever role or name changes (createSession again).
 */
export async function signSession(userId: string, ttl = SESSION_TTL): Promise<string | null> {
  const [u] = await sql<SessionUser[]>`SELECT id, phone, name, role, lang FROM users WHERE id = ${userId}`;
  if (!u) return null;
  return sign(u, ttl);
}

const sign = (u: SessionUser, ttl = SESSION_TTL) =>
  new SignJWT({ sub: u.id, phone: u.phone, name: u.name, role: u.role, lang: u.lang })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(ttl).sign(secret());

/** When a token we signed stops working. Read, not verified — only call it on a token you just signed or checked. */
export const tokenExpiresAt = (token: string) => new Date((decodeJwt(token).exp ?? 0) * 1000);

/**
 * The sliding part. Checks the signature and expiry, then that the user still exists (one query). A token at
 * least `renewAfterSeconds` old is re-signed from the current row — fresh name and role, a fresh year; a younger
 * one comes back as it was. Null for a missing, forged or expired token, or a deleted user.
 */
export async function renewSession(token: string | null | undefined, renewAfterSeconds = RENEW_AFTER_SECONDS): Promise<{ token: string; renewed: boolean } | null> {
  if (!token) return null;
  let sub: string | undefined, iat: number | undefined;
  try {
    ({ payload: { sub, iat } } = await jwtVerify(token, secret()));
  } catch {
    return null;
  }
  if (!isUuid(sub)) return null;
  const [u] = await sql<SessionUser[]>`SELECT id, phone, name, role, lang FROM users WHERE id = ${sub}`;
  if (!u) return null;
  if (iat !== undefined && Date.now() / 1000 - iat < renewAfterSeconds) return { token, renewed: false };
  return { token: await sign(u), renewed: true };
}

/** The token in an `Authorization: Bearer …` header, or null. */
export const bearerToken = (authorization: string | null | undefined) =>
  authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() || null : null;

/**
 * Where a fresh sign-in lands — a text code or Face ID alike: onboarding (keeping an invite) until the account has a
 * role and a name, then that side's home.
 */
export const signedInPath = (u: { role: string | null; name: string | null }, invite?: string) =>
  !u.role || !u.name ? (invite ? `/onboarding?invite=${encodeURIComponent(invite)}` : "/onboarding")
    : u.role === "boss" ? "/boss" : "/worker";

export async function createSession(userId: string) {
  if (process.env.TEST_USER_ID && process.env.NODE_ENV !== "production") return; // scripts/tests: no cookie jar
  const token = await signSession(userId);
  if (!token) return;
  (await cookies()).set(sessionCookie(token));
}

export async function destroySession() { (await cookies()).delete(SESSION_COOKIE); }

/** Verify a JWT and unpack the user it carries. No database trip. */
export async function userFromToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub) return null;
    return { id: payload.sub, phone: String(payload.phone ?? ""), name: (payload.name as string) ?? null, role: (payload.role as SessionUser["role"]) ?? null, lang: String(payload.lang ?? "en") };
  } catch { return null; }
}

/**
 * Who is calling an /api/v1 route. The mobile app has no cookie jar, so the same JWT
 * travels as a bearer token; a browser calling the same route still works via the cookie.
 * There is no proxy in front of any route: every handler must call this itself.
 */
export const getApiUser = cache(async (): Promise<SessionUser | null> => {
  return (await userFromToken(bearerToken((await headers()).get("authorization")))) ?? (await getUser());
});

/** One verification per request (React cache), no DB. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  if (process.env.TEST_USER_ID && process.env.NODE_ENV !== "production") {
    const rows = await sql<SessionUser[]>`SELECT id, phone, name, role, lang FROM users WHERE id = ${process.env.TEST_USER_ID}`;
    return rows[0] ?? null;
  }
  const jar = await cookies();
  // A control-room frame cookie only reaches its own path, so if one is present it wins.
  const frame = demoConsoleOn() ? jar.get(FRAME_COOKIES.boss)?.value ?? jar.get(FRAME_COOKIES.worker)?.value : undefined;
  const token = frame ?? jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub) return null;
    return { id: payload.sub, phone: String(payload.phone ?? ""), name: (payload.name as string) ?? null, role: (payload.role as SessionUser["role"]) ?? null, lang: String(payload.lang ?? "en") };
  } catch { return null; }
});

export async function requireRole(role: "boss" | "worker"): Promise<SessionUser> {
  const u = await getUser();
  if (!u) redirect("/login");
  if (!u.role || !u.name) redirect("/onboarding");
  if (u.role !== role) redirect(u.role === "boss" ? "/boss" : "/worker");
  return u;
}
