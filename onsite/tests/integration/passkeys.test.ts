/**
 * Face ID / fingerprint sign-in end to end, through the real server actions and a real database (needs
 * DATABASE_URL), with a software passkey (tests/helpers/softAuthenticator.ts) standing in for the phone.
 * Own +614000086xx numbers, self-cleaning.
 *
 * `next/headers` is a stand-in: a cookie jar the session is written to, and request headers the test sets
 * (the connection's address for the rate limits, the user agent for the device's label).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const req = vi.hoisted(() => ({
  headers: new Headers(),
  jar: {
    store: new Map<string, string>(),
    get(name: string) { const v = this.store.get(name); return v === undefined ? undefined : { name, value: v }; },
    has(name: string) { return this.store.has(name); },
    set: undefined as unknown as (c: { name: string; value: string }) => void,
    delete(name: string) { this.store.delete(name); },
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => req.jar, headers: async () => req.headers }));

import { sql } from "@/lib/db";
import { SESSION_COOKIE, sessionCookie, signedInPath, userFromToken } from "@/lib/session";
import { PASSKEY_LIMITS, userHandleB64 } from "@/lib/passkeys";
import { PASSKEY_OFFER_COOKIE, PASSKEY_WORDS } from "@/lib/passkeyClient";
import { passkeyLoginOptions, passkeyRegister, passkeyRegisterOptions, passkeySignIn, removePasskey } from "@/actions/passkeys";
import { verifyCode } from "@/actions/auth";
import { hashCode } from "@/lib/otp";
import { SoftAuthenticator } from "../helpers/softAuthenticator";

const BASE = "https://onsite-au.vercel.app";
const RP = "onsite-au.vercel.app";
const PHONES = { worker: "+61400008601", boss: "+61400008602", fresh: "+61400008603", other: "+61400008604" };
const IP = "198.51.100.86";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const ids: Record<keyof typeof PHONES, string> = { worker: "", boss: "", fresh: "", other: "" };
const set = vi.fn((c: { name: string; value: string }) => { req.jar.store.set(c.name, c.value); });
req.jar.set = set;

/** Where an action sent them (a sign-in always ends in a redirect), or what it returned instead. */
const outcome = <T,>(p: Promise<T>) => p.then(
  (v) => ({ returned: v, to: null as string | null }),
  (e) => { const d = String((e as { digest?: string })?.digest ?? ""); if (!d.includes("NEXT_REDIRECT")) throw e; return { returned: null, to: d.split(";")[2] }; },
);
const as = (who: keyof typeof ids | null) => vi.stubEnv("TEST_USER_ID", who ? ids[who] : "");
const seed = (key: string, hits: number) => sql`
  INSERT INTO rate_limits (key, window_start, hits) VALUES (${key}, now(), ${hits})
  ON CONFLICT (key) DO UPDATE SET window_start = now(), hits = ${hits}`;

async function registerFor(who: keyof typeof ids, auth = new SoftAuthenticator(RP, BASE)) {
  as(who);
  const o = await passkeyRegisterOptions();
  if (!o.ok) throw new Error(o.error);
  const r = await passkeyRegister(auth.register(o.options));
  if (!r.ok) throw new Error(r.error);
  return auth;
}
async function loginOptions() {
  as(null);
  const o = await passkeyLoginOptions();
  if (!o.ok) throw new Error(o.error);
  return o.options;
}
const sessionSet = () => set.mock.calls.map(([c]) => c).filter((c) => c.name === SESSION_COOKIE);

describe.skipIf(!process.env.DATABASE_URL)("Face ID / fingerprint sign-in (passkeys)", () => {
  const clean = async () => {
    await sql`DELETE FROM otp_codes WHERE phone = ANY(${Object.values(PHONES)})`;
    await sql`DELETE FROM users WHERE phone = ANY(${Object.values(PHONES)})`;                // passkeys and challenges cascade
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`passkey-%:ip:${IP}`} OR key LIKE 'otp-verify:ip:198.51.100.86'`;
  };
  const challenges: string[] = [];
  beforeAll(async () => {
    await clean();
    for (const [k, role] of [["worker", "worker"], ["boss", "boss"], ["fresh", null], ["other", "worker"]] as const)
      ids[k] = (await sql`INSERT INTO users (phone, name, role) VALUES (${PHONES[k]}, ${role ? `Passkey ${k} fixture` : null}, ${role}) RETURNING id`)[0].id;
  });
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", BASE);
    vi.stubEnv("WEBAUTHN_RP_ID", "");
    req.headers = new Headers({ "x-forwarded-for": IP, "user-agent": IPHONE });
    req.jar.store.clear();
    set.mockClear();
    await sql`DELETE FROM passkeys WHERE user_id = ANY(${Object.values(ids)})`;
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`passkey-%:ip:${IP}`} OR key LIKE ANY(${Object.values(ids).map((id) => `passkey-register%:${id}`)})`;
  });
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(async () => {
    await sql`DELETE FROM webauthn_challenges WHERE challenge = ANY(${challenges})`;
    await sql`DELETE FROM rate_limits WHERE key LIKE ANY(${Object.values(ids).map((id) => `passkey-register%:${id}`)})`;
    await clean();
    await sql.end();
  });
  const track = <T extends { challenge: string }>(o: T) => { challenges.push(o.challenge); return o; };

  it("registering: the options, then the passkey stored against the signed-in person", async () => {
    as("worker");
    const o = await passkeyRegisterOptions();
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    track(o.options);
    expect(o.options.rp).toEqual({ id: RP, name: "OnSite" });
    expect(o.options.user).toEqual({ id: userHandleB64(ids.worker), name: "Passkey worker fixture · 04•• ••• 601", displayName: "Passkey worker fixture" });
    expect(JSON.stringify(o.options)).not.toMatch(/400008601|0400 008 601/);
    expect(o.options.authenticatorSelection).toMatchObject({ residentKey: "required", requireResidentKey: true, userVerification: "required", authenticatorAttachment: "platform" });
    expect(o.options.attestation).toBe("none");
    expect(o.options.excludeCredentials).toEqual([]);
    expect(o.options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -8, -257]);
    expect(o.options.timeout).toBe(5 * 60 * 1000);
    const [row] = await sql`SELECT kind, user_id, expires_at > now() + interval '4 minutes' AND expires_at <= now() + interval '5 minutes' AS five FROM webauthn_challenges WHERE challenge = ${o.options.challenge}`;
    expect(row).toEqual({ kind: "register", user_id: ids.worker, five: true });

    const auth = new SoftAuthenticator(RP, BASE);
    const r = await passkeyRegister(auth.register(o.options));
    expect(r).toEqual({ ok: true, credentialId: auth.id });
    const [p] = await sql`SELECT user_id, credential_id, counter, transports, device_type, backed_up, label, last_used_at, length(public_key) > 60 AS key FROM passkeys WHERE credential_id = ${auth.id}`;
    expect(p).toEqual({ user_id: ids.worker, credential_id: auth.id, counter: "0", transports: ["internal", "hybrid"], device_type: "multiDevice", backed_up: true, label: "iPhone", last_used_at: null, key: true });
    expect((await sql`SELECT 1 FROM webauthn_challenges WHERE challenge = ${o.options.challenge}`).length).toBe(0);   // spent

    // Next time this person asks, the phone is told not to make a second one.
    const again = await passkeyRegisterOptions();
    expect(again.ok && again.options.excludeCredentials).toEqual([{ id: auth.id, transports: ["internal", "hybrid"], type: "public-key" }]);
    if (again.ok) track(again.options);
  });

  it("signing in: a session cookie for the right person, exactly as a text code makes it, and the passkey's use recorded", async () => {
    const auth = await registerFor("worker", new SoftAuthenticator(RP, BASE, { counter: 7, synced: false }));
    const options = track(await loginOptions());
    expect(options).toMatchObject({ rpId: RP, userVerification: "required", timeout: 5 * 60 * 1000 });
    expect(options.allowCredentials).toBeUndefined();                        // usernameless: the phone says who
    const [c] = await sql`SELECT kind, user_id FROM webauthn_challenges WHERE challenge = ${options.challenge}`;
    expect(c).toEqual({ kind: "login", user_id: null });

    const { to } = await outcome(passkeySignIn(auth.signIn(options)));
    expect(to).toBe("/worker");
    const cookies = sessionSet();
    expect(cookies).toHaveLength(1);
    expect({ ...cookies[0], value: "…" }).toEqual({ ...sessionCookie("…") });   // same name, httpOnly, SameSite, a year, path
    expect(await userFromToken(cookies[0].value)).toMatchObject({ id: ids.worker, role: "worker", name: "Passkey worker fixture" });
    expect(req.jar.store.has(PASSKEY_OFFER_COOKIE)).toBe(false);             // no "set up Face ID?" after signing in with it

    const [p] = await sql`SELECT counter, last_used_at > now() - interval '1 minute' AS just FROM passkeys WHERE credential_id = ${auth.id}`;
    expect(p).toEqual({ counter: "8", just: true });
  });

  it("goes where a code sign-in goes: the boss home, or onboarding (keeping an invite) for an account not set up yet", async () => {
    const boss = await registerFor("boss");
    expect((await outcome(passkeySignIn(boss.signIn(track(await loginOptions()))))).to).toBe("/boss");

    // a fresh account can't register itself before onboarding in the UI, but a passkey can outlive a reset role
    const fresh = await registerFor("fresh");
    expect((await outcome(passkeySignIn(fresh.signIn(track(await loginOptions())), "ABC123"))).to).toBe("/onboarding?invite=ABC123");
    expect((await outcome(passkeySignIn(fresh.signIn(track(await loginOptions()))))).to).toBe("/onboarding");
    expect(signedInPath({ role: null, name: null }, "ABC123")).toBe("/onboarding?invite=ABC123");

    // …and the code path goes through the same function, and asks about Face ID on the next screen
    await sql`INSERT INTO otp_codes (phone, code, expires_at) VALUES (${PHONES.boss}, ${hashCode(PHONES.boss, "123456")}, now() + interval '5 minutes')
              ON CONFLICT (phone) DO UPDATE SET code = EXCLUDED.code, expires_at = EXCLUDED.expires_at, attempts = 0`;
    as(null);
    set.mockClear();
    const code = await outcome(verifyCode({ step: "code", phone: PHONES.boss }, (() => { const f = new FormData(); f.set("code", "123456"); return f; })()));
    expect(code.to).toBe("/boss");
    expect(sessionSet()).toHaveLength(1);
    expect(req.jar.store.get(PASSKEY_OFFER_COOKIE)).toBe("1");
  });

  it("a challenge signs in once, and not after five minutes", async () => {
    const auth = await registerFor("worker");
    const options = track(await loginOptions());
    const signed = auth.signIn(options);
    expect((await outcome(passkeySignIn(signed))).to).toBe("/worker");
    set.mockClear();
    expect((await outcome(passkeySignIn(signed))).returned).toEqual({ ok: false, reason: "expired", error: PASSKEY_WORDS.expired });
    expect(sessionSet()).toEqual([]);

    const late = track(await loginOptions());
    await sql`UPDATE webauthn_challenges SET expires_at = now() - interval '1 second' WHERE challenge = ${late.challenge}`;
    expect((await outcome(passkeySignIn(auth.signIn(late)))).returned).toMatchObject({ ok: false, reason: "expired" });

    // a registration challenge is no good for signing in, and one person's registration challenge is no good for another
    as("worker");
    const reg = await passkeyRegisterOptions();
    if (!reg.ok) throw new Error(reg.error);
    track(reg.options);
    expect((await outcome(passkeySignIn(auth.signIn({ challenge: reg.options.challenge })))).returned).toMatchObject({ ok: false, reason: "expired" });
    as("other");
    expect(await passkeyRegister(new SoftAuthenticator(RP, BASE).register(reg.options))).toMatchObject({ ok: false, reason: "expired" });
    as("worker");
    expect(await passkeyRegister(new SoftAuthenticator(RP, BASE).register(reg.options))).toMatchObject({ ok: true });   // still the worker's, unspent
    expect(sessionSet()).toEqual([]);
  });

  it("refuses the wrong origin, the wrong rpID, a challenge we never gave, a tampered signature, a counter going backwards", async () => {
    const auth = await registerFor("worker", new SoftAuthenticator(RP, BASE, { counter: 10, synced: false }));
    const cases: [string, (o: { challenge: string }) => unknown, string][] = [
      ["origin", (o) => auth.signIn(o, { origin: "https://onsite-au.vercel.app.evil.example" }), "failed"],
      ["http origin", (o) => auth.signIn(o, { origin: "http://onsite-au.vercel.app" }), "failed"],
      ["rpID", (o) => auth.signIn(o, { rpID: "evil.example" }), "failed"],
      ["challenge", (o) => auth.signIn(o, { challenge: Buffer.from("never issued, 32 bytes long......").toString("base64url") }), "expired"],
      ["signature", (o) => auth.signIn(o, { tamper: true }), "failed"],
      ["counter", (o) => auth.signIn(o, { counter: 3 }), "failed"],
      ["no user verification", (o) => auth.signIn(o, { flags: 0x01 }), "failed"],
      ["somebody else's user handle", (o) => auth.signIn(o, { userHandle: userHandleB64(ids.other) }), "failed"],
      ["a registration, not a sign-in", (o) => auth.signIn(o, { type: "webauthn.create" }), "failed"],
      ["rubbish", () => ({ id: "not base64url!", response: { clientDataJSON: 42 } }), "expired"],
    ];
    for (const [what, forge, reason] of cases) {
      const o = track(await loginOptions());
      expect((await outcome(passkeySignIn(forge(o)))).returned, what).toMatchObject({ ok: false, reason });
    }
    expect(sessionSet()).toEqual([]);
    const [p] = await sql`SELECT counter, last_used_at FROM passkeys WHERE credential_id = ${auth.id}`;
    expect(p).toEqual({ counter: "10", last_used_at: null });
    // and the real thing still works afterwards
    expect((await outcome(passkeySignIn(auth.signIn(track(await loginOptions())))))).toMatchObject({ to: "/worker" });
  });

  it("two sign-ins racing with the same counter: one gets in", async () => {
    const auth = await registerFor("worker", new SoftAuthenticator(RP, BASE, { counter: 20, synced: false }));
    const [a, b] = [track(await loginOptions()), track(await loginOptions())];
    const results = await Promise.all([a, b].map((o) => outcome(passkeySignIn(auth.signIn(o, { counter: 21 })))));
    expect(results.map((r) => r.to ?? (r.returned as { reason: string }).reason).sort()).toEqual(["/worker", "failed"]);
    expect((await sql`SELECT counter FROM passkeys WHERE credential_id = ${auth.id}`)[0].counter).toBe("21");
  });

  it("a registration with the wrong origin, rpID or no user verification is not stored", async () => {
    as("worker");
    for (const [what, o] of [["origin", { origin: "https://evil.example" }], ["rpID", { rpID: "evil.example" }], ["uv", { flags: 0x41 }]] as const) {
      const opts = await passkeyRegisterOptions();
      if (!opts.ok) throw new Error(opts.error);
      track(opts.options);
      expect(await passkeyRegister(new SoftAuthenticator(RP, BASE).register(opts.options, o)), what).toMatchObject({ ok: false, reason: "failed" });
    }
    expect((await sql`SELECT 1 FROM passkeys WHERE user_id = ${ids.worker}`).length).toBe(0);
  });

  it("a removed passkey signs nobody in, and says so in plain words", async () => {
    const auth = await registerFor("worker");
    const [{ id }] = await sql`SELECT id FROM passkeys WHERE credential_id = ${auth.id}`;
    as("worker");
    await removePasskey(id);
    expect((await sql`SELECT 1 FROM passkeys WHERE id = ${id}`).length).toBe(0);
    const r = await outcome(passkeySignIn(auth.signIn(track(await loginOptions()))));
    expect(r.returned).toEqual({ ok: false, reason: "unknown", error: "That Face ID sign-in isn't linked to an account any more. Use a text code." });
    expect(sessionSet()).toEqual([]);
  });

  it("nobody can remove someone else's passkey", async () => {
    const auth = await registerFor("worker");
    const [{ id }] = await sql`SELECT id FROM passkeys WHERE credential_id = ${auth.id}`;
    as("other");
    await removePasskey(id);
    as(null);
    await removePasskey(id);
    await removePasskey("not-a-uuid");
    expect((await sql`SELECT 1 FROM passkeys WHERE id = ${id}`).length).toBe(1);
  });

  it("registering needs someone signed in", async () => {
    const auth = new SoftAuthenticator(RP, BASE);
    as("worker");
    const opts = await passkeyRegisterOptions();
    if (!opts.ok) throw new Error(opts.error);
    track(opts.options);
    as(null);                                                               // no TEST_USER_ID, nothing in the cookie jar
    expect(await passkeyRegisterOptions()).toMatchObject({ ok: false, error: "Sign in first." });
    expect(await passkeyRegister(auth.register(opts.options))).toMatchObject({ ok: false, error: "Sign in first." });
    expect((await sql`SELECT 1 FROM passkeys WHERE credential_id = ${auth.id}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM webauthn_challenges WHERE challenge = ${opts.options.challenge}`).length).toBe(1);   // not even spent
  });

  it("rate limits: sign-in options and tries per connection, registration per person", async () => {
    await seed(`passkey-login:ip:${IP}`, PASSKEY_LIMITS.loginOptionsPerIp);
    expect(await passkeyLoginOptions()).toEqual({ ok: false, reason: "busy", error: PASSKEY_WORDS.busy });

    const auth = await registerFor("worker");
    await sql`DELETE FROM rate_limits WHERE key = ${`passkey-login:ip:${IP}`}`;
    const options = track(await loginOptions());
    await seed(`passkey-verify:ip:${IP}`, PASSKEY_LIMITS.loginVerifiesPerIp);
    expect((await outcome(passkeySignIn(auth.signIn(options)))).returned).toMatchObject({ ok: false, reason: "busy" });
    expect(sessionSet()).toEqual([]);
    req.headers = new Headers({ "x-forwarded-for": "198.51.100.87", "user-agent": IPHONE });   // another connection isn't held up
    expect((await outcome(passkeySignIn(auth.signIn(options)))).to).toBe("/worker");
    await sql`DELETE FROM rate_limits WHERE key LIKE 'passkey-%:ip:198.51.100.87'`;

    as("worker");
    await seed(`passkey-register-options:${ids.worker}`, PASSKEY_LIMITS.registerOptionsPerUser);
    expect(await passkeyRegisterOptions()).toMatchObject({ ok: false, reason: "busy" });
    await sql`DELETE FROM rate_limits WHERE key = ${`passkey-register-options:${ids.worker}`}`;
    const opts = await passkeyRegisterOptions();
    if (!opts.ok) throw new Error(opts.error);
    track(opts.options);
    await seed(`passkey-register:${ids.worker}`, PASSKEY_LIMITS.registersPerUser);
    expect(await passkeyRegister(new SoftAuthenticator(RP, BASE).register(opts.options))).toMatchObject({ ok: false, reason: "busy" });
    as("other");                                                            // another person isn't
    await registerFor("other");
  });

  it("fails closed: without an https base URL every action refuses and nothing is written", async () => {
    const auth = await registerFor("worker");
    const options = track(await loginOptions());
    for (const url of ["", "http://onsite-au.vercel.app", "not a url"]) {
      vi.stubEnv("NEXT_PUBLIC_BASE_URL", url);
      expect(await passkeyLoginOptions(), url).toMatchObject({ ok: false, reason: "off" });
      expect((await outcome(passkeySignIn(auth.signIn(options)))).returned, url).toMatchObject({ ok: false, reason: "off" });
      as("worker");
      expect(await passkeyRegisterOptions(), url).toMatchObject({ ok: false, reason: "off" });
      as(null);
    }
    expect(sessionSet()).toEqual([]);
    // an override that doesn't fit the address is off too — and a passkey made for one rpID doesn't work under another
    vi.stubEnv("NEXT_PUBLIC_BASE_URL", BASE);
    vi.stubEnv("WEBAUTHN_RP_ID", "vercel.app");
    const moved = track(await loginOptions());
    expect(moved.rpId).toBe("vercel.app");
    expect((await outcome(passkeySignIn(auth.signIn(moved)))).returned).toMatchObject({ ok: false, reason: "failed" });
  });
});
