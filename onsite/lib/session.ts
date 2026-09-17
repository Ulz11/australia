import { SignJWT, decodeJwt, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { sql } from "./db";
import { demoConsoleOn } from "./flags";
import { deviceLabel } from "./device";
import { isUuid } from "./validate";

export const SESSION_COOKIE = "onsite_session";

/**
 * Stay signed in: a login code is a text, and texts cost money. A session (cookie or bearer token) lasts a year
 * — Chrome caps a cookie at 400 days — and slides: POST /api/session/refresh (called from the boss and worker
 * layouts, at most every 6 h per browser) re-issues a cookie more than a day old, and the app swaps its token
 * at POST /api/v1/auth/refresh. Someone who opens OnSite at least once a year never needs another code.
 *
 * A sign-in is also a row in `sessions` (migration 015), and the token carries its id as `sid`. Every read of
 * "who is this" joins that row to the user, so three things are true that weren't before: a deleted account's
 * cookie opens nothing, signing out ends the session everywhere rather than dropping one cookie, and removing
 * a passkey signs out the phone that used it (the row's passkey_id cascades). A token with no sid — every
 * token issued before this — is not a session and is refused: everyone signs in once more.
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

/** How someone got in. 'mobile' is the app's bearer token; the other two are this browser. */
export type SessionVia = "code" | "passkey" | "mobile";
export type SessionUser = { id: string; phone: string; name: string | null; role: "boss" | "worker" | null; lang: string; sid: string };

/** What a new session row says about itself. The label comes off the user agent when one is there to read. */
export type NewSession = { via?: SessionVia; passkeyId?: string | null; label?: string; ttl?: string };

/** "iPhone", "Android phone" — the same words Me uses for a passkey. Outside a request there is no agent to read. */
async function labelFromRequest(): Promise<string> {
  try {
    return deviceLabel((await headers()).get("user-agent") ?? "");
  } catch {
    return deviceLabel("");
  }
}

/**
 * Open a session and sign a token for it: one row in `sessions`, and the JWT that carries its id. The user's
 * name and role ride along so a screen can read them without a second query, but the session id is what makes
 * the token worth anything.
 */
export async function signSession(userId: string, opts: NewSession = {}): Promise<string | null> {
  const [s] = await sql<(SessionUser & { sid: string })[]>`
    WITH s AS (
      INSERT INTO sessions (user_id, passkey_id, via, label)
      SELECT u.id, ${opts.passkeyId ?? null}, ${opts.via ?? "code"}, ${(opts.label ?? (await labelFromRequest())).slice(0, 40)}
      FROM users u WHERE u.id = ${userId}
      RETURNING id AS sid, user_id
    ), seen AS (
      UPDATE users SET last_seen_at = now() WHERE id = (SELECT user_id FROM s)
    )
    SELECT u.id, u.phone, u.name, u.role, u.lang, s.sid FROM s JOIN users u ON u.id = s.user_id`;
  if (!s) return null;
  return sign(s, opts.ttl ?? SESSION_TTL);
}

const sign = (u: SessionUser, ttl = SESSION_TTL) =>
  new SignJWT({ sub: u.id, sid: u.sid, phone: u.phone, name: u.name, role: u.role, lang: u.lang })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(ttl).sign(secret());

/** When a token we signed stops working. Read, not verified — only call it on a token you just signed or checked. */
export const tokenExpiresAt = (token: string) => new Date((decodeJwt(token).exp ?? 0) * 1000);

/** The live session behind a session id: the person, or null when the row is gone, revoked, or their account is. */
const sessionUser = async (sid: string): Promise<SessionUser | null> => {
  const [u] = await sql<SessionUser[]>`
    SELECT u.id, u.phone, u.name, u.role, u.lang, s.id AS sid
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sid} AND s.revoked_at IS NULL`;
  return u ?? null;
};

/** The session id a token carries, once its signature and expiry check out. Null for anything else. */
async function liveSid(token: string | null | undefined): Promise<{ sid: string; sub: string; iat?: number } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const sid = payload.sid, sub = payload.sub;
    if (!isUuid(sid) || !isUuid(sub)) return null;           // no sid: issued before sessions existed
    return { sid, sub, iat: payload.iat };
  } catch {
    return null;
  }
}

/**
 * The sliding part. Checks the signature and expiry, then that the session is still live and its user still
 * exists (one query). A token at least `renewAfterSeconds` old is re-signed from the current row — fresh name
 * and role, a fresh year, the same session id; a younger one comes back as it was. Either way the session and
 * the person are marked as seen just now. Null for a missing, forged, expired or sid-less token, a revoked
 * session, or a deleted user.
 */
export async function renewSession(token: string | null | undefined, renewAfterSeconds = RENEW_AFTER_SECONDS): Promise<{ token: string; renewed: boolean } | null> {
  const t = await liveSid(token);
  if (!t) return null;
  const u = await sessionUser(t.sid);
  if (!u || u.id !== t.sub) return null;
  await touch(t.sid);
  if (t.iat !== undefined && Date.now() / 1000 - t.iat < renewAfterSeconds) return { token: token!, renewed: false };
  return { token: await sign(u), renewed: true };
}

/** This session and this person were here just now. One statement; nothing waits on it being exact. */
const touch = (sid: string) => sql`
  WITH s AS (UPDATE sessions SET last_seen_at = now() WHERE id = ${sid} RETURNING user_id)
  UPDATE users SET last_seen_at = now() WHERE id = (SELECT user_id FROM s)`;

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

/**
 * Sign this browser in. A fresh sign-in opens a session; a re-issue after a name or role change (onboarding,
 * Me) keeps the session this browser already holds, so "Where you're signed in" lists phones, not edits.
 */
export async function createSession(userId: string, opts: NewSession = {}) {
  if (process.env.TEST_USER_ID && process.env.NODE_ENV !== "production") return; // scripts/tests: no cookie jar
  const jar = await cookies();
  const held = await liveSid(jar.get(SESSION_COOKIE)?.value);
  const current = held && held.sub === userId ? await sessionUser(held.sid) : null;
  if (current) {
    await touch(current.sid);
    jar.set(sessionCookie(await sign(current)));
    return;
  }
  const token = await signSession(userId, opts);
  if (!token) return;
  jar.set(sessionCookie(token));
}

/** Sign out: the row is revoked (every copy of that token dies with it), then the cookie goes. */
export async function destroySession() {
  const jar = await cookies();
  const held = await liveSid(jar.get(SESSION_COOKIE)?.value);
  if (held) await revokeSessionRow(held.sid);
  jar.delete(SESSION_COOKIE);
}

/** End one session, whoever is asking — the caller has already checked it is theirs. */
export const revokeSessionRow = (sid: string) =>
  sql`UPDATE sessions SET revoked_at = now() WHERE id = ${sid} AND revoked_at IS NULL`.then(() => undefined);

/** Verify a JWT and look up the session it names. Null for a token with no live session behind it. */
export async function userFromToken(token: string | undefined | null): Promise<SessionUser | null> {
  const t = await liveSid(token);
  if (!t) return null;
  const u = await sessionUser(t.sid);
  return u && u.id === t.sub ? u : null;
}

/**
 * Who is calling an /api/v1 route. The mobile app has no cookie jar, so the same JWT
 * travels as a bearer token; a browser calling the same route still works via the cookie.
 * There is no proxy in front of any route: every handler must call this itself.
 */
export const getApiUser = cache(async (): Promise<SessionUser | null> => {
  return (await userFromToken(bearerToken((await headers()).get("authorization")))) ?? (await getUser());
});

/** One lookup per request (React cache): the token's signature, then the session row behind it. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  if (process.env.TEST_USER_ID && process.env.NODE_ENV !== "production") {
    const rows = await sql<SessionUser[]>`SELECT id, phone, name, role, lang, '' AS sid FROM users WHERE id = ${process.env.TEST_USER_ID}`;
    return rows[0] ?? null;
  }
  const jar = await cookies();
  // A control-room frame cookie only reaches its own path, so if one is present it wins.
  const frame = demoConsoleOn() ? jar.get(FRAME_COOKIES.boss)?.value ?? jar.get(FRAME_COOKIES.worker)?.value : undefined;
  return userFromToken(frame ?? jar.get(SESSION_COOKIE)?.value);
});

export async function requireRole(role: "boss" | "worker"): Promise<SessionUser> {
  const u = await getUser();
  if (!u) redirect("/login");
  if (!u.role || !u.name) redirect("/onboarding");
  if (u.role !== role) redirect(u.role === "boss" ? "/boss" : "/worker");
  return u;
}

export type SessionRow = { id: string; label: string; via: SessionVia; created_at: Date; last_seen_at: Date };

/** Me → "Where you're signed in": this person's live sessions, the one used most recently first. */
export const listSessions = (userId: string) => sql<SessionRow[]>`
  SELECT id, label, via, created_at, last_seen_at FROM sessions
  WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY last_seen_at DESC`;
