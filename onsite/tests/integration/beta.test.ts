/**
 * The closed beta's guest list, against a real DB (needs DATABASE_URL). Runs the real requestCode / verifyCode
 * actions and the real mobile route on its own +614000093xx numbers and 198.51.100.x addresses, and cleans up.
 *
 * Sharing the database with files running in parallel: tests/integration/otp.test.ts counts the app-wide code
 * budget (`otp-send:all`) exactly, so here that one key is an in-memory counter. Every other key — the
 * per-connection limit this file asserts on — is the real row.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";

const spent = vi.hoisted(() => ({ all: 0, keys: [] as string[], texts: 0 }));
vi.mock("@/lib/ratelimit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ratelimit")>();
  const ALL = "otp-send:all";
  return {
    ...real,
    hit: (key: string, limit: number, win: number) => {
      spent.keys.push(key);
      return key === ALL ? Promise.resolve(++spent.all <= limit) : real.hit(key, limit, win);
    },
    refund: (key: string, win: number) => (key === ALL ? Promise.resolve(void (spent.all = Math.max(0, spent.all - 1))) : real.refund(key, win)),
  };
});
vi.mock("@/lib/sms", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sms")>();
  return { ...real, sendSms: (to: string, body: string) => { spent.texts++; return real.sendSms(to, body); } };
});

import * as auth from "@/actions/auth";
import { sql } from "@/lib/db";
import { OTP } from "@/lib/otp";
import { BETA_REFUSAL, invite, listInvites, uninvite } from "@/lib/beta";
import { POST as requestCodeApi } from "@/app/api/v1/auth/request-code/route";

const PHONES = { stranger: "+61400009301", invited: "+61400009302", member: "+61400009303", probe: "+61400009304", later: "+61400009305", api: "+61400009306", apiInvited: "+61400009307", admin: "+61400009308" };
const ALL_PHONES = Object.values(PHONES);
const IP = { refused: "198.51.100.10", probing: "198.51.100.11", invited: "198.51.100.12" };
const local = (e164: string) => "0" + e164.slice(3);
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const request = (phone: string, ip: string | null = null) => auth.requestCode({ step: "phone" }, fd({ phone: local(phone) }), { ip });
const signIn = (phone: string, code: string) => auth.verifyCode({ step: "code", phone }, fd({ code }), { ip: null })
  .then(() => "no-redirect", (e) => (String((e as { digest?: string })?.digest ?? e).includes("NEXT_REDIRECT") ? "signed-in" : String(e)));
const ipHits = async (ip: string) => (await sql<{ hits: number }[]>`SELECT hits FROM rate_limits WHERE key = ${`otp-send:ip:${ip}`}`)[0]?.hits ?? 0;
const codeRow = async (phone: string) => (await sql`SELECT sends FROM otp_codes WHERE phone = ${phone}`)[0];

describe.skipIf(!process.env.DATABASE_URL)("closed beta: who can ask for a login code", () => {
  const clean = async () => {
    await sql`DELETE FROM beta_invites WHERE phone = ANY(${ALL_PHONES})`;
    await sql`DELETE FROM otp_codes WHERE phone = ANY(${ALL_PHONES})`;
    await sql`DELETE FROM users WHERE phone = ANY(${ALL_PHONES})`;
    await sql`DELETE FROM rate_limits WHERE key LIKE 'otp-%:ip:198.51.100.%'`;
  };
  beforeAll(async () => { await clean(); });
  beforeEach(async () => {
    await clean();
    Object.assign(spent, { all: 0, keys: [], texts: 0 });
    vi.stubEnv("DEV_SHOW_OTP", "1");                          // codes come back from the action instead of by SMS
    for (const k of ["SMS_PROVIDER", "CLICKSEND_USERNAME", "CLICKSEND_API_KEY", "TWILIO_ACCOUNT_SID"]) vi.stubEnv(k, "");   // never text a real number
    vi.stubEnv("TEST_USER_ID", "00000000-0000-0000-0000-000000000000");   // createSession skips the cookie jar
    vi.spyOn(console, "log").mockImplementation(() => {});   // the dev SMS stub
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  afterAll(async () => { await clean(); await sql.end(); });

  it("with BETA_INVITE_ONLY unset, sign-in works exactly as before: anyone gets a code", async () => {
    vi.stubEnv("BETA_INVITE_ONLY", "");
    const r = await request(PHONES.stranger, IP.refused);
    expect(r).toMatchObject({ step: "code", phone: PHONES.stranger });
    expect(r.devCode).toMatch(/^\d{6}$/);
    expect(r.refused).toBeUndefined();
  });

  it("a number that is neither invited nor an account gets one sentence — no text, no code, no app-wide or per-number budget", async () => {
    vi.stubEnv("BETA_INVITE_ONLY", "1");
    const r = await request(PHONES.stranger, IP.refused);
    expect(r).toEqual({ step: "phone", error: BETA_REFUSAL, refused: "invite_only" });
    expect(BETA_REFUSAL).toBe("OnSite is in a closed beta — ask the person who invited you to add this number.");
    expect(spent.texts).toBe(0);                                              // no SMS
    expect(await codeRow(PHONES.stranger)).toBeUndefined();                    // nothing charged to that number
    expect(spent.keys).not.toContain("otp-send:all");                          // the app-wide budget was never touched
    expect(spent.all).toBe(0);
    expect(await ipHits(IP.refused)).toBe(1);                                  // …but the connection paid for asking
  });

  it("asking about numbers uses up the connection's hourly allowance, so the list can't be probed for free", async () => {
    vi.stubEnv("BETA_INVITE_ONLY", "1");
    await invite(PHONES.invited);
    await sql`INSERT INTO rate_limits (key, window_start, hits) VALUES (${`otp-send:ip:${IP.probing}`}, now(), ${OTP.sendsPerIpPerHour - 2})`;
    expect((await request(PHONES.probe, IP.probing)).refused).toBe("invite_only");
    expect((await request(PHONES.later, IP.probing)).refused).toBe("invite_only");
    expect(await ipHits(IP.probing)).toBe(OTP.sendsPerIpPerHour);
    // Spent: from here the answer is the same whether a number is invited or not.
    const stranger = await request(PHONES.stranger, IP.probing);
    const invited = await request(PHONES.invited, IP.probing);
    expect(stranger).toEqual({ step: "phone", error: "Too many codes from this connection. Try again in an hour." });
    expect(invited).toEqual(stranger);
    expect(spent.texts).toBe(0);
  });

  it("an invited number gets a code, and so does an existing account that was never invited", async () => {
    vi.stubEnv("BETA_INVITE_ONLY", "1");
    await invite(local(PHONES.invited), { role: "worker", note: "beta test fixture" });
    const r = await request(PHONES.invited, IP.invited);
    expect(r).toMatchObject({ step: "code", phone: PHONES.invited });
    expect(r.devCode).toMatch(/^\d{6}$/);
    expect(spent.all).toBe(1);                                                // a real send spends the app-wide budget as always
    expect(spent.texts).toBe(1);

    await sql`INSERT INTO users (phone, name, role) VALUES (${PHONES.member}, 'Beta Member Fixture', 'worker')`;
    const m = await request(PHONES.member, IP.invited);
    expect(m).toMatchObject({ step: "code", phone: PHONES.member });
  });

  it("the mobile API applies the same gate: 403 and the same sentence, and a code for an invited number", async () => {
    vi.stubEnv("BETA_INVITE_ONLY", "1");
    const call = (phone: string) => requestCodeApi(new Request("http://localhost/api/v1/auth/request-code", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: local(phone) }),
    }));
    const refused = await call(PHONES.api);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: BETA_REFUSAL });
    expect(await codeRow(PHONES.api)).toBeUndefined();
    expect(spent.texts).toBe(0);

    await invite(PHONES.apiInvited);
    const ok = await call(PHONES.apiInvited);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ step: "code", phone: PHONES.apiInvited, devCode: expect.stringMatching(/^\d{6}$/) });
  });

  it("the first sign-in stamps the invite, and later sign-ins leave the stamp alone", async () => {
    vi.stubEnv("BETA_INVITE_ONLY", "1");
    await invite(PHONES.invited);
    const stamp = async () => (await sql`SELECT first_signed_in_at FROM beta_invites WHERE phone = ${PHONES.invited}`)[0].first_signed_in_at as Date | null;
    expect(await stamp()).toBeNull();

    const first = await request(PHONES.invited);
    expect(await stamp()).toBeNull();                                          // asking for a code isn't signing in
    expect(await signIn(PHONES.invited, first.devCode!)).toBe("signed-in");
    const stamped = await stamp();
    expect(stamped).toBeInstanceOf(Date);

    await sql`UPDATE otp_codes SET last_sent_at = now() - interval '2 minutes' WHERE phone = ${PHONES.invited}`;
    const again = await request(PHONES.invited);
    expect(await signIn(PHONES.invited, again.devCode!)).toBe("signed-in");
    expect((await stamp())?.getTime()).toBe(stamped!.getTime());
  });

  it("beta:invite's helpers: numbers are normalised and checked, a re-invite keeps what it doesn't change, removal works", async () => {
    const r = await invite("0400 009 308", { role: "boss", note: "  Dave's mate  " });
    expect(r).toMatchObject({ phone: PHONES.admin, role: "boss", note: "Dave's mate", first_signed_in_at: null, has_account: false });
    expect((await invite(PHONES.admin, { note: "moved sites" })).role).toBe("boss");      // role left out: kept
    expect((await invite("61400009308")).note).toBe("moved sites");                       // note left out: kept
    expect((await listInvites()).filter((i) => i.phone === PHONES.admin)).toHaveLength(1); // one row, however it was spelled

    await expect(invite("12345")).rejects.toThrow(/Australian mobile/);
    await expect(invite("+97699112233")).rejects.toThrow(/Australian mobile/);            // same rule as the login form
    await expect(invite(PHONES.admin, { role: "foreman" as never })).rejects.toThrow(/worker or boss/);

    expect(await uninvite("0400009308")).toBe(true);
    expect(await uninvite("0400009308")).toBe(false);
    expect((await listInvites()).some((i) => i.phone === PHONES.admin)).toBe(false);
  });
});
