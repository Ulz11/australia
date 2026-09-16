/**
 * Staying signed in, against a real DB (needs DATABASE_URL): year-long tokens, the cookie refresh route, the
 * app's refresh endpoint, the app's sign-in, and sign-out. Own +614000092xx numbers, self-cleaning.
 *
 * Route handlers run as plain functions here, so `next/headers` is a stand-in cookie jar: createSession and
 * logout write to it, and the refresh routes must not need it at all (they read the request, write the response).
 */
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vitest";

const jar = vi.hoisted(() => ({ get: (_name: string): { value: string } | undefined => undefined, set: vi.fn(), delete: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => jar, headers: async () => new Headers() }));

import fs from "node:fs";
import { NextRequest } from "next/server";
import { SignJWT, decodeJwt } from "jose";
import { sql } from "@/lib/db";
import { hashCode } from "@/lib/otp";
import { createSession, signSession, tokenExpiresAt, userFromToken } from "@/lib/session";
import { logout } from "@/actions/auth";
import { POST as refreshCookie } from "@/app/api/session/refresh/route";
import { POST as refreshApp } from "@/app/api/v1/auth/refresh/route";
import { POST as verifyApp } from "@/app/api/v1/auth/verify/route";

const PHONES = { boss: "+61400009201", gone: "+61400009202", worker: "+61400009203", code: "+61400009204" };
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;
const ids: Record<string, string> = {};

/** A token signed `days` ago, as if it had been sitting in a browser since then. */
async function signedDaysAgo(userId: string, days: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - days * DAY_MS);
  try { return (await signSession(userId))!; } finally { vi.useRealTimers(); }
}
const forged = (userId: string) => new SignJWT({ sub: userId, role: "boss" }).setProtectedHeader({ alg: "HS256" })
  .setIssuedAt().setExpirationTime("365d").sign(new TextEncoder().encode("not-the-session-secret-at-all-000000"));

const cookieCall = (cookie?: string) =>
  refreshCookie(new NextRequest("http://localhost/api/session/refresh", { method: "POST", headers: cookie ? { cookie } : {} }));
const appCall = (headers: Record<string, string> = {}) =>
  refreshApp(new Request("http://localhost/api/v1/auth/refresh", { method: "POST", headers }));
const near = (ms: number, expected: number, slackMs = 10_000) => expect(Math.abs(ms - expected)).toBeLessThan(slackMs);
const CLEARED = /^onsite_session=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/;

describe.skipIf(!process.env.DATABASE_URL)("staying signed in", () => {
  const clean = async () => {
    await sql`DELETE FROM otp_codes WHERE phone = ANY(${Object.values(PHONES)})`;
    await sql`DELETE FROM users WHERE phone = ANY(${Object.values(PHONES)})`;
  };
  beforeAll(async () => {
    await clean();
    for (const [k, role] of [["boss", "boss"], ["gone", "worker"], ["worker", "worker"]] as const)
      ids[k] = (await sql`INSERT INTO users (phone, name, role) VALUES (${PHONES[k]}, ${`Session ${k} fixture`}, ${role}) RETURNING id`)[0].id;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    jar.set.mockReset();
    jar.delete.mockReset();
  });
  afterAll(async () => { await clean(); await sql.end(); });

  it("a sign-in lasts a year: the token expires 365 days after it was issued, and so does the cookie", async () => {
    vi.stubEnv("TEST_USER_ID", "");                                           // use the (stand-in) cookie jar
    const token = (await signSession(ids.boss))!;
    const { iat, exp } = decodeJwt(token);
    expect(exp! - iat!).toBe(365 * 24 * 60 * 60);
    near(tokenExpiresAt(token).getTime(), Date.now() + YEAR_MS);

    await createSession(ids.boss);
    expect(jar.set).toHaveBeenCalledTimes(1);
    const set = jar.set.mock.calls[0][0];
    expect(set).toEqual({ name: "onsite_session", value: expect.any(String), httpOnly: true, sameSite: "lax", secure: false, maxAge: 365 * 24 * 60 * 60, path: "/" });
    expect(decodeJwt(set.value).sub).toBe(ids.boss);
  });

  it("the refresh route re-issues a session more than a day old — a fresh year, from the user's current row", async () => {
    const old = await signedDaysAgo(ids.boss, 2);
    await sql`UPDATE users SET name = 'Session boss renamed' WHERE id = ${ids.boss}`;
    const res = await cookieCall(`onsite_session=${old}`);
    expect(res.status).toBe(204);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const [pair, ...attrs] = cookies[0].split("; ");
    expect(attrs.filter((a) => !a.startsWith("Expires="))).toEqual(["Path=/", "Max-Age=31536000", "HttpOnly", "SameSite=lax"]);   // no Secure outside production
    const fresh = decodeURIComponent(pair.slice("onsite_session=".length));
    expect(fresh).not.toBe(old);
    near(decodeJwt(fresh).iat! * 1000, Date.now());
    near(tokenExpiresAt(fresh).getTime(), Date.now() + YEAR_MS);
    expect(await userFromToken(fresh)).toMatchObject({ id: ids.boss, name: "Session boss renamed", role: "boss" });
  });

  it("and leaves a younger session alone: 204, no cookie", async () => {
    for (const token of [await signedDaysAgo(ids.boss, 0.5), (await signSession(ids.boss))!]) {
      const res = await cookieCall(`onsite_session=${token}`);
      expect(res.status).toBe(204);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it("401 and a cleared cookie for no session, rubbish, a forged or expired token, or a user who was deleted", async () => {
    const goneToken = await signedDaysAgo(ids.gone, 3);
    await sql`DELETE FROM users WHERE id = ${ids.gone}`;
    const cases = {
      none: undefined,
      rubbish: "onsite_session=not-a-token",
      forged: `onsite_session=${await forged(ids.boss)}`,
      expired: `onsite_session=${await signedDaysAgo(ids.boss, 366)}`,
      deleted: `onsite_session=${goneToken}`,
    };
    for (const [why, cookie] of Object.entries(cases)) {
      const res = await cookieCall(cookie);
      expect(res.status, why).toBe(401);
      expect(res.headers.getSetCookie(), why).toEqual([expect.stringMatching(CLEARED)]);
      expect(await res.text(), why).toBe("");
    }
  });

  it("never reads or renews the control room's frame cookies", async () => {
    vi.stubEnv("DEMO_CONSOLE", "1");                                         // even with the control room on
    const frames = `onsite_frame_boss=${await signedDaysAgo(ids.boss, 2)}; onsite_frame_worker=${await signedDaysAgo(ids.worker, 2)}`;

    const framesOnly = await cookieCall(frames);                              // a valid frame is not a session here
    expect(framesOnly.status).toBe(401);
    expect(framesOnly.headers.getSetCookie()).toEqual([expect.stringMatching(CLEARED)]);

    const both = await cookieCall(`${frames}; onsite_session=${await signedDaysAgo(ids.worker, 2)}`);
    expect(both.status).toBe(204);
    const set = both.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(decodeJwt(decodeURIComponent(set[0].split(";")[0].slice("onsite_session=".length))).sub).toBe(ids.worker);
    expect(set.join("\n")).not.toMatch(/onsite_frame/);
    expect(fs.readFileSync("app/api/session/refresh/route.ts", "utf8")).not.toMatch(/FRAME_COOKIES|onsite_frame/);
  });

  it("the app's refresh swaps a valid bearer token for a new one good for a year", async () => {
    const old = await signedDaysAgo(ids.worker, 40);                          // older than the old 30-day tokens lived
    const res = await appCall({ authorization: `Bearer ${old}` });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Object.keys(b).sort()).toEqual(["expires_at", "token"]);
    expect(b.token).not.toBe(old);
    expect(await userFromToken(b.token)).toMatchObject({ id: ids.worker, role: "worker" });
    expect(Date.parse(b.expires_at)).toBe(decodeJwt(b.token).exp! * 1000);
    near(Date.parse(b.expires_at), Date.now() + YEAR_MS);
  });

  it("and answers 401 for no token, a cookie instead of a bearer, rubbish, a forged or expired token, or a deleted user", async () => {
    const [{ id: tempId }] = await sql`INSERT INTO users (phone, name, role) VALUES (${PHONES.gone}, 'Session gone fixture', 'worker')
                                       ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
    const goneToken = (await signSession(tempId))!;
    await sql`DELETE FROM users WHERE id = ${tempId}`;
    const valid = (await signSession(ids.worker))!;
    const cases: Record<string, Record<string, string>> = {
      none: {},
      cookie: { cookie: `onsite_session=${valid}` },
      basic: { authorization: `Basic ${valid}` },
      rubbish: { authorization: "Bearer not-a-token" },
      forged: { authorization: `Bearer ${await forged(ids.worker)}` },
      expired: { authorization: `Bearer ${await signedDaysAgo(ids.worker, 366)}` },
      deleted: { authorization: `Bearer ${goneToken}` },
    };
    for (const [why, headers] of Object.entries(cases)) {
      const res = await appCall(headers);
      expect(res.status, why).toBe(401);
      expect(await res.json(), why).toEqual({ error: "Sign in again." });
    }
  });

  it("the app's sign-in hands out a year-long token and its expires_at says so", async () => {
    await sql`INSERT INTO otp_codes (phone, code, expires_at, attempts, last_sent_at, sends, window_start)
              VALUES (${PHONES.code}, ${hashCode(PHONES.code, "246810")}, now() + interval '10 minutes', 0, now(), 1, now())`;
    const res = await verifyApp(new Request("http://localhost/api/v1/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "0400009204", code: "246810" }),
    }));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(Date.parse(b.expires_at)).toBe(decodeJwt(b.token).exp! * 1000);
    near(Date.parse(b.expires_at), Date.now() + YEAR_MS);
  });

  it("signing out clears the session exactly as before: alerts cookie, both frame cookies, the session, then /login", async () => {
    vi.stubEnv("TEST_USER_ID", "");
    const to = await logout().then(() => "no redirect", (e) => String((e as { digest?: string }).digest ?? e));
    expect(to.split(";")[2]).toBe("/login");
    expect(jar.delete.mock.calls).toEqual([
      ["onsite_push"],
      [{ name: "onsite_frame_boss", path: "/boss" }],
      [{ name: "onsite_frame_worker", path: "/worker" }],
      ["onsite_session"],
    ]);
    expect(jar.set).not.toHaveBeenCalled();
  });
});
