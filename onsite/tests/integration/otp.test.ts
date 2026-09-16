/**
 * Login codes under attack: parallel guessing, resend-to-reset, parallel sends.
 * Runs the real actions against a real DB. Needs DATABASE_URL. Uses its own +614000097xx numbers and cleans up.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as auth from "@/actions/auth";
import { sql } from "@/lib/db";
import { hit } from "@/lib/ratelimit";
import { OTP } from "@/lib/otp";

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const PHONES = ["+61400009701", "+61400009702", "+61400009703", "+61400009704", "+61400009705", "+61400009706", "+61400009707"];
const local = (e164: string) => "0" + e164.slice(3);
const request = (phone: string, ip: string | null = null) => auth.requestCode({ step: "phone" }, fd({ phone: local(phone) }), { ip });
const guess = (phone: string, code: string, ip: string | null = null) => auth.verifyCode({ step: "code", phone }, fd({ code }), { ip });
const isRedirect = (e: unknown) => String((e as { digest?: string })?.digest ?? (e as Error)?.message).includes("NEXT_REDIRECT");
const wrong = (code: string) => String((Number(code) - 100000 + 1) % 900000 + 100000);   // any other 6-digit code
const seed = (key: string, hits: number) => sql`
  INSERT INTO rate_limits (key, window_start, hits) VALUES (${key}, now(), ${hits})
  ON CONFLICT (key) DO UPDATE SET window_start = now(), hits = ${hits}`;

describe.skipIf(!process.env.DATABASE_URL)("login codes under attack", () => {
  const saved = { dev: process.env.DEV_SHOW_OTP, user: process.env.TEST_USER_ID, sid: process.env.TWILIO_ACCOUNT_SID };
  const clean = async () => {
    await sql`DELETE FROM otp_codes WHERE phone = ANY(${PHONES}) OR phone = '+97699112233'`;
    await sql`DELETE FROM users WHERE phone = ANY(${PHONES})`;
    await sql`DELETE FROM rate_limits WHERE key LIKE 'test:%' OR key = 'otp-send:all' OR key LIKE 'otp-%:ip:203.0.113.%'`;
    await sql`DELETE FROM otp_codes WHERE phone LIKE '+614000097%' OR phone LIKE '+614000098%'`;
    await sql`DELETE FROM users WHERE phone LIKE '+614000097%' OR phone LIKE '+614000098%'`;
  };
  beforeAll(async () => {
    process.env.DEV_SHOW_OTP = "1";             // codes come back from the action instead of by SMS
    delete process.env.TWILIO_ACCOUNT_SID;      // never text a real number from a test
    process.env.TEST_USER_ID = "00000000-0000-0000-0000-000000000000";   // createSession skips the cookie jar
    await clean();
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    process.env.DEV_SHOW_OTP = saved.dev; process.env.TEST_USER_ID = saved.user;
    if (saved.sid) process.env.TWILIO_ACCOUNT_SID = saved.sid;
    await sql.end();
  });

  it("the database never holds the code itself", async () => {
    const r = await request(PHONES[0]);
    const [row] = await sql`SELECT code FROM otp_codes WHERE phone = ${PHONES[0]}`;
    expect(r.devCode).toMatch(/^\d{6}$/);
    expect(row.code).not.toBe(r.devCode);
    expect(row.code).toMatch(/^[0-9a-f]{64}$/);
  });

  it("40 guesses fired at once spend exactly 5 — then even the right code is refused", async () => {
    const { devCode } = await request(PHONES[1]);
    const results = await Promise.all(Array.from({ length: 40 }, () => guess(PHONES[1], wrong(devCode!))));
    expect(results.filter((r) => r.error === "Wrong code")).toHaveLength(OTP.wrongPerHour);
    const [row] = await sql`SELECT attempts FROM otp_codes WHERE phone = ${PHONES[1]}`;
    expect(row.attempts).toBe(OTP.wrongPerHour);
    const last = await guess(PHONES[1], devCode!);
    expect(last.error).toMatch(/Too many wrong codes/);
  });

  it("asking for a new code doesn't buy more guesses", async () => {
    const { devCode } = await request(PHONES[2]);
    for (let i = 0; i < OTP.wrongPerHour; i++) await guess(PHONES[2], wrong(devCode!));
    await sql`UPDATE otp_codes SET last_sent_at = now() - interval '2 minutes' WHERE phone = ${PHONES[2]}`;   // past the resend wait
    const again = await request(PHONES[2]);
    expect(again.step).toBe("phone");
    expect(again.error).toMatch(/Too many wrong codes/);
    // an hour later the slate is clean
    await sql`UPDATE otp_codes SET last_sent_at = now() - interval '61 minutes', window_start = now() - interval '61 minutes' WHERE phone = ${PHONES[2]}`;
    const later = await request(PHONES[2]);
    expect(later.step).toBe("code");
    const [row] = await sql`SELECT attempts FROM otp_codes WHERE phone = ${PHONES[2]}`;
    expect(row.attempts).toBe(0);
  });

  it("ten taps on 'Text me a code' at once send one code", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => request(PHONES[3])));
    expect(results.filter((r) => r.step === "code")).toHaveLength(1);
    expect(results.filter((r) => /minute/.test(r.error ?? ""))).toHaveLength(9);
  });

  it("the right code signs in once, and only once", async () => {
    const { devCode } = await request(PHONES[4]);
    const outcomes = await Promise.all([0, 1, 2].map(() => guess(PHONES[4], devCode!).then(() => "no-redirect", (e) => (isRedirect(e) ? "signed-in" : String(e)))));
    expect(outcomes.filter((o) => o === "signed-in")).toHaveLength(1);
    const [u] = await sql`SELECT id FROM users WHERE phone = ${PHONES[4]}`;
    expect(u).toBeTruthy();
    const again = await guess(PHONES[4], devCode!);
    expect(again.error).toMatch(/expired/);                                         // spent
  });

  it("signing in doesn't hand out a fresh set of guesses", async () => {
    const { devCode } = await request(PHONES[5]);
    for (let i = 0; i < OTP.wrongPerHour - 1; i++) await guess(PHONES[5], wrong(devCode!));   // 4 wrong
    const signedIn = await guess(PHONES[5], devCode!).then(() => "no", (e) => (isRedirect(e) ? "signed-in" : String(e)));
    expect(signedIn).toBe("signed-in");                                                       // the 5th attempt is the right one
    const [row] = await sql`SELECT attempts FROM otp_codes WHERE phone = ${PHONES[5]}`;
    expect(row.attempts).toBe(OTP.wrongPerHour);                                              // the guesses stay spent
    await sql`UPDATE otp_codes SET last_sent_at = now() - interval '2 minutes' WHERE phone = ${PHONES[5]}`;
    const again = await request(PHONES[5]);
    expect(again.error).toMatch(/Too many wrong codes/);
  });

  it("signing in doesn't reset the send limits for that number", async () => {
    const { devCode } = await request(PHONES[3]);
    await guess(PHONES[3], devCode!).catch((e) => { if (!isRedirect(e)) throw e; });
    const straightAway = await request(PHONES[3]);
    expect(straightAway.step).toBe("phone");
    expect(straightAway.error).toMatch(/minute/);
  });

  it("refused taps don't use up the app-wide code budget (one attacker can't lock everyone out)", async () => {
    process.env.OTP_SENDS_PER_HOUR = "3";
    try {
      const hammered = await Promise.all(Array.from({ length: 12 }, () => request(PHONES[6])));
      expect(hammered.filter((r) => r.step === "code")).toHaveLength(1);        // one real send, eleven refusals
      const innocent = await request(PHONES[0]);
      expect(innocent.step).toBe("code");                                         // still room: refusals didn't count
      const [c] = await sql`SELECT hits FROM rate_limits WHERE key = 'otp-send:all'`;
      expect(c.hits).toBe(2);
    } finally {
      delete process.env.OTP_SENDS_PER_HOUR;
    }
  });

  it("when the app-wide ceiling is reached, nobody's live code is destroyed", async () => {
    const first = await request(PHONES[0]);
    const [before] = await sql`SELECT code, sends FROM otp_codes WHERE phone = ${PHONES[0]}`;
    await sql`UPDATE otp_codes SET last_sent_at = now() - interval '2 minutes' WHERE phone = ${PHONES[0]}`;
    await sql`INSERT INTO rate_limits (key, window_start, hits) VALUES ('otp-send:all', now(), 99999)
              ON CONFLICT (key) DO UPDATE SET window_start = now(), hits = 99999`;
    const ip = "203.0.113.80";
    try {
      const refused = await request(PHONES[0], ip);
      expect(refused.error).toMatch(/sending a lot of codes/);
      const [perIp] = await sql`SELECT hits FROM rate_limits WHERE key = ${`otp-send:ip:${ip}`}`;
      expect(perIp?.hits ?? 0).toBe(0);                                            // the ceiling's refusal cost this connection nothing
      const [after] = await sql`SELECT code, sends FROM otp_codes WHERE phone = ${PHONES[0]}`;
      expect(after.code).toBe(before.code);                                        // their code still works
      expect(after.sends).toBe(before.sends);                                      // and their allowance is untouched
      const signIn = await guess(PHONES[0], first.devCode!).then(() => "no", (e) => (isRedirect(e) ? "signed-in" : String(e)));
      expect(signIn).toBe("signed-in");
    } finally {
      await sql`DELETE FROM rate_limits WHERE key = 'otp-send:all'`;
    }
  });

  it("one connection gets a fixed number of codes an hour, and a refusal doesn't cost it one", async () => {
    const ip = "203.0.113.77";
    const key = `otp-send:ip:${ip}`;
    const room = 3;
    await seed(key, OTP.sendsPerIpPerHour - room);                                  // nearly spent already
    const sent = [];
    for (let i = 0; i < room; i++) sent.push(await request(`+6140000974${i}`, ip));
    expect(sent.every((r) => r.step === "code")).toBe(true);
    const over = await request("+61400009749", ip);
    expect(over.error).toMatch(/Too many codes from this connection/);
    const [after] = await sql`SELECT hits FROM rate_limits WHERE key = ${key}`;
    expect(after.hits).toBe(OTP.sendsPerIpPerHour);                                // the refusal was handed back
  });

  it("a burst from one connection can't slip past its cap", async () => {
    const ip = "203.0.113.79";
    const key = `otp-send:ip:${ip}`;
    const room = 5;
    await seed(key, OTP.sendsPerIpPerHour - room);
    const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => request(`+614000098${String(i).padStart(2, "0")}`, ip)));
    expect(burst.filter((r) => r.step === "code").length).toBeLessThanOrEqual(room);
    const [after] = await sql`SELECT hits FROM rate_limits WHERE key = ${key}`;
    expect(after.hits).toBe(OTP.sendsPerIpPerHour);                                // never above the cap, even mid-burst
  });

  it("a wrong-code burst from one connection is capped too", async () => {
    const ip = "203.0.113.78";
    const { devCode } = await request(PHONES[1], ip);
    const tries = await Promise.all(Array.from({ length: OTP.verifiesPerIpPerHour + 12 }, () => guess(PHONES[1], wrong(devCode!), ip)));
    expect(tries.filter((r) => /Too many tries from this connection/.test(r.error ?? ""))).toHaveLength(12);
    await sql`DELETE FROM rate_limits WHERE key LIKE ${`otp-%:ip:${ip}`}`;
  });

  it("foreign numbers are refused before anything is sent", async () => {
    const r = await auth.requestCode({ step: "phone" }, fd({ phone: "+97699112233" }));
    expect(r.step).toBe("phone");
    const [row] = await sql`SELECT 1 FROM otp_codes WHERE phone = '+97699112233'`;
    expect(row).toBeUndefined();
  });

  it("rate limit counters hold under a burst: limit 10, 25 at once → exactly 10 allowed", async () => {
    const ok = await Promise.all(Array.from({ length: 25 }, () => hit("test:burst", 10, 3600)));
    expect(ok.filter(Boolean)).toHaveLength(10);
  });
});
