/**
 * A sign-in is a row, not just a signed cookie (migration 015, lib/session.ts). Against a real DB
 * (needs DATABASE_URL). Own +614000080xx numbers, self-cleaning.
 *
 * What has to be true, and wasn't before:
 *  - a deleted account's token opens nothing
 *  - a revoked session opens nothing, on every phone that holds that token
 *  - removing a passkey signs out the phone that used it (the row's passkey_id cascades)
 *  - a token with no session id — everything issued before this — is not a session
 *  - the refresh routes mark the session and the person as seen (the usual week reads users.last_seen_at)
 */
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vitest";

const jar = vi.hoisted(() => {
  const store = new Map<string, string>();
  const name = (a: string | { name: string }) => (typeof a === "string" ? a : a.name);
  return {
    store,
    get: (n: string) => (store.has(n) ? { value: store.get(n)! } : undefined),
    set: vi.fn((a: string | { name: string; value: string }, v?: string) =>
      (typeof a === "string" ? store.set(a, v!) : store.set(a.name, a.value))),
    delete: vi.fn((a: string | { name: string }) => store.delete(name(a))),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => jar,
  headers: async () => new Headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" }),
}));

import { NextRequest } from "next/server";
import { SignJWT } from "jose";
import { sql } from "@/lib/db";
import {
  SESSION_COOKIE, createSession, getUser, listSessions, signSession, userFromToken,
} from "@/lib/session";
import { logout, signOutOtherSessions, signOutSession } from "@/actions/auth";
import { removePasskey } from "@/actions/passkeys";
import { POST as refreshCookie } from "@/app/api/session/refresh/route";
import { POST as refreshApp } from "@/app/api/v1/auth/refresh/route";

const PHONES = {
  live: "+61400008001", gone: "+61400008002", revoked: "+61400008003",
  faceId: "+61400008004", seen: "+61400008005", many: "+61400008006",
};
const ids: Record<string, string> = {};
const DAY_MS = 24 * 60 * 60 * 1000;

const secret = () => new TextEncoder().encode(process.env.SESSION_SECRET || "dev-secret-change-me");
/** A token exactly as OnSite signed them before sessions existed: a user, no session id. */
const sidless = (userId: string) =>
  new SignJWT({ sub: userId, phone: "+61400008001", name: "Sessions live fixture", role: "worker", lang: "en" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("365d").sign(secret());

const cookieCall = (cookie?: string) =>
  refreshCookie(new NextRequest("http://localhost/api/session/refresh", { method: "POST", headers: cookie ? { cookie } : {} }));

describe.skipIf(!process.env.DATABASE_URL)("a session is a row", () => {
  const clean = async () => { await sql`DELETE FROM users WHERE phone = ANY(${Object.values(PHONES)})`; };

  beforeAll(async () => {
    await clean();
    for (const [k, phone] of Object.entries(PHONES))
      ids[k] = (await sql`INSERT INTO users (phone, name, role) VALUES (${phone}, ${`Sessions ${k} fixture`}, 'worker') RETURNING id`)[0].id;
  });
  afterEach(() => { jar.store.clear(); jar.set.mockClear(); jar.delete.mockClear(); vi.unstubAllEnvs(); });
  afterAll(async () => { await clean(); await sql.end(); });

  it("signing in writes the row, labels the phone from its user agent, and the token carries the row's id", async () => {
    vi.stubEnv("TEST_USER_ID", "");
    await createSession(ids.live, { via: "code" });
    const token = jar.store.get(SESSION_COOKIE)!;
    const [s] = await sql`SELECT id, via, label, revoked_at, passkey_id FROM sessions WHERE user_id = ${ids.live}`;
    expect(s).toMatchObject({ via: "code", label: "iPhone", revoked_at: null, passkey_id: null });
    expect(await userFromToken(token)).toMatchObject({ id: ids.live, sid: s.id, role: "worker" });
    expect(await getUser()).toMatchObject({ id: ids.live, sid: s.id });
  });

  it("a re-issue after a name change keeps the same session — Me lists phones, not edits", async () => {
    vi.stubEnv("TEST_USER_ID", "");
    await sql`DELETE FROM sessions WHERE user_id = ${ids.live}`;
    await createSession(ids.live, { via: "code" });
    const first = (await userFromToken(jar.store.get(SESSION_COOKIE)!))!.sid;
    await sql`UPDATE users SET name = 'Renamed on the way in' WHERE id = ${ids.live}`;
    await createSession(ids.live);
    const again = await userFromToken(jar.store.get(SESSION_COOKIE)!);
    expect(again).toMatchObject({ sid: first, name: "Renamed on the way in" });
    expect((await listSessions(ids.live)).length).toBe(1);
  });

  it("a deleted account's token opens nothing, even though it is still signed and in date", async () => {
    const token = (await signSession(ids.gone, { via: "code" }))!;
    expect(await userFromToken(token)).toMatchObject({ id: ids.gone });
    await sql`DELETE FROM users WHERE id = ${ids.gone}`;
    expect(await userFromToken(token)).toBeNull();
    jar.store.set(SESSION_COOKIE, token);
    vi.stubEnv("TEST_USER_ID", "");
    expect(await getUser()).toBeNull();
    expect((await cookieCall(`onsite_session=${token}`)).status).toBe(401);
  });

  it("a revoked session opens nothing — the same token on two phones dies on both", async () => {
    const token = (await signSession(ids.revoked, { via: "code" }))!;
    const sid = (await userFromToken(token))!.sid;
    await sql`UPDATE sessions SET revoked_at = now() WHERE id = ${sid}`;
    expect(await userFromToken(token)).toBeNull();
    expect((await cookieCall(`onsite_session=${token}`)).status).toBe(401);
    expect(await listSessions(ids.revoked)).toEqual([]);
  });

  it("removing a passkey signs out the phone that used it, and leaves the code sign-in alone", async () => {
    const [p] = await sql`
      INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
      VALUES (${ids.faceId}, ${"cred-" + ids.faceId}, ${Buffer.from("public-key-bytes")}, 0, '{internal}', 'multiDevice', true, 'iPhone')
      RETURNING id`;
    const face = (await signSession(ids.faceId, { via: "passkey", passkeyId: p.id }))!;
    const code = (await signSession(ids.faceId, { via: "code", label: "Android phone" }))!;
    expect((await listSessions(ids.faceId)).length).toBe(2);

    vi.stubEnv("TEST_USER_ID", ids.faceId);
    await removePasskey(p.id);

    expect(await userFromToken(face)).toBeNull();
    expect(await userFromToken(code)).toMatchObject({ id: ids.faceId });
    expect((await listSessions(ids.faceId)).map((s) => s.via)).toEqual(["code"]);
  });

  it("a token with no session id — everything issued before this change — is refused", async () => {
    const old = await sidless(ids.live);
    expect(await userFromToken(old)).toBeNull();
    expect((await cookieCall(`onsite_session=${old}`)).status).toBe(401);
    const app = await refreshApp(new Request("http://localhost/api/v1/auth/refresh", { method: "POST", headers: { authorization: `Bearer ${old}` } }));
    expect(app.status).toBe(401);
  });

  it("both refresh routes mark the session and the person as seen, and keep the same session id", async () => {
    const token = (await signSession(ids.seen, { via: "code" }))!;
    const sid = (await userFromToken(token))!.sid;
    const long = new Date(Date.now() - 30 * DAY_MS);
    await sql`UPDATE sessions SET last_seen_at = ${long} WHERE id = ${sid}`;
    await sql`UPDATE users SET last_seen_at = ${long} WHERE id = ${ids.seen}`;

    expect((await cookieCall(`onsite_session=${token}`)).status).toBe(204);
    const [a] = await sql`SELECT s.last_seen_at AS s_seen, u.last_seen_at AS u_seen FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ${sid}`;
    expect(a.s_seen.getTime()).toBeGreaterThan(long.getTime());
    expect(a.u_seen.getTime()).toBeGreaterThan(long.getTime());

    await sql`UPDATE sessions SET last_seen_at = ${long} WHERE id = ${sid}`;
    const res = await refreshApp(new Request("http://localhost/api/v1/auth/refresh", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    const fresh = (await res.json()).token as string;
    expect(await userFromToken(fresh)).toMatchObject({ id: ids.seen, sid });     // re-signed, same session
    const [b] = await sql`SELECT last_seen_at FROM sessions WHERE id = ${sid}`;
    expect(b.last_seen_at.getTime()).toBeGreaterThan(long.getTime());
  });

  it("signing out revokes this session's row, not just the cookie", async () => {
    vi.stubEnv("TEST_USER_ID", "");
    await createSession(ids.live, { via: "code" });
    const token = jar.store.get(SESSION_COOKIE)!;
    await logout().catch(() => {});                                    // redirect() throws out of an action
    expect(await userFromToken(token)).toBeNull();
    expect(jar.store.has(SESSION_COOKIE)).toBe(false);
  });

  it("Me signs out one phone, or every other one, and never anybody else's", async () => {
    vi.stubEnv("TEST_USER_ID", "");
    const phones = [] as string[];
    for (const label of ["iPhone", "Android phone", "Mac"]) phones.push((await signSession(ids.many, { via: "code", label }))!);
    const stranger = (await signSession(ids.live, { via: "code" }))!;
    const sids = (await Promise.all(phones.map((t) => userFromToken(t)))).map((u) => u!.sid);

    // The caller is the phone holding the first token.
    jar.store.set(SESSION_COOKIE, phones[0]);
    await signOutSession(sids[1]);
    expect(await userFromToken(phones[1])).toBeNull();
    expect(await userFromToken(phones[0])).toMatchObject({ id: ids.many });

    await signOutSession(sids[1]);                                     // twice is the same as once
    await signOutOtherSessions();
    expect(await userFromToken(phones[2])).toBeNull();
    expect(await userFromToken(phones[0])).toMatchObject({ id: ids.many });
    expect(await userFromToken(stranger)).toMatchObject({ id: ids.live });
  });
});
