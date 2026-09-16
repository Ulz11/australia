/**
 * Alerts end to end, without a phone: a local stand-in push service receives exactly what FCM/Apple would,
 * and decrypts it with a real browser-style key pair — so the encryption, VAPID signature, payload and
 * SMS fallback are all checked for real. Needs DATABASE_URL + a seeded DB.
 *
 * Other test files write notifications at the same time and deliverAlerts() takes every unsent row, so this file
 * uses two workers AND two bosses of its own (nobody else's rows share their SMS budget) and counts only its own
 * rows, recipients and endpoints.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import https from "node:https";
import type http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import webpush from "web-push";
// @ts-expect-error — http_ece ships no types; it's the same library web-push encrypts with
import ece from "http_ece";
import * as boss from "@/actions/boss";
import { sql } from "@/lib/db";
import { deliverAlerts, SMS_PER_PERSON_PER_DAY, SMS_SHARE_PER_BOSS } from "@/lib/alerts";
import { todayIso, addDays } from "@/lib/util";

type Got = { path: string; headers: http.IncomingHttpHeaders; body: Buffer };
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const swallow = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { if (!String((e as { digest?: string })?.digest).includes("NEXT_REDIRECT")) throw e; } };

/** Push services are HTTPS-only, so the stand-in is too: a throwaway self-signed cert, trusted only inside this test process. */
function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onsite-push-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
  const pair = { key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) };
  fs.rmSync(dir, { recursive: true, force: true });
  return pair;
}

describe.skipIf(!process.env.DATABASE_URL)("alerts reach the phone", () => {
  let server: https.Server, port = 0, got: Got[] = [], brokenStatus = 410;
  let dave: string, other: string, bat: string, nima: string, site: string, otherSite: string;
  // Everyone here is ours alone: bat has a phone subscribed, nima doesn't; dave/other are bosses whose SMS budget nothing else spends.
  const OURS = { bat: "+61400009901", nima: "+61400009902", dave: "+61400009903", other: "+61400009904" };
  const PEOPLE = Object.values(OURS);
  const phoneKey = crypto.createECDH("prime256v1"); phoneKey.generateKeys();   // what a browser makes when it subscribes
  const authSecret = crypto.randomBytes(16);
  const made: string[] = [];
  const env = { ...process.env };
  let logs: string[] = [];

  const subscribe = (userId: string, p: string) => sql`
    INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth)
    VALUES (${`https://127.0.0.1:${port}${p}`}, ${userId}, ${phoneKey.getPublicKey().toString("base64url")}, ${authSecret.toString("base64url")})
    ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id`;
  const at = (p: string) => got.filter((g) => g.path === p);
  const decrypt = (g: Got) => JSON.parse(ece.decrypt(g.body, { version: "aes128gcm", privateKey: phoneKey, authSecret: authSecret.toString("base64url") }).toString());
  const texts = (phone: string) => logs.filter((l) => l.includes(`[sms:stub] to=${phone} `));
  /** Run with a stand-in Twilio so texts really "send" (sendSms uses fetch; web-push uses https, so it's untouched). */
  const withTwilio = async (fn: () => Promise<void>) => {
    const real = globalThis.fetch;
    const sent: string[] = [];
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "token", TWILIO_FROM: "+61400000000" });
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      if (!u.includes("api.twilio.com")) return real(url as Parameters<typeof fetch>[0], init);
      const body = init?.body;
      sent.push(String((body instanceof URLSearchParams ? body : new URLSearchParams(String(body))).get("To")));
      return new Response("{}", { status: 201 });
    });
    try { await fn(); } finally {
      vi.unstubAllGlobals();
      for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"]) delete process.env[k];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    }
    return sent;
  };
  const postDirect = async (workerId: string, day: string, start: string, asBoss = "", inProject = "") => {
    const bossId = asBoss || dave;
    process.env.TEST_USER_ID = bossId;
    await swallow(() => boss.createShift(fd({ project_id: inProject || site, day, start_time: start, hours: "8", role: "Alert test", rate: "40", direct_worker_id: workerId })));
    const [s] = await sql`SELECT id FROM shifts WHERE boss_id = ${bossId} AND role = 'Alert test' ORDER BY created_at DESC LIMIT 1`;
    made.push(s.id);
    process.env.TEST_USER_ID = dave;
    return s.id as string;
  };
  const note = async (userId: string, kind: string, body: string) =>
    (await sql`INSERT INTO notifications (user_id, kind, body) VALUES (${userId}, ${kind}, ${body}) RETURNING id`)[0].id as string;

  beforeAll(async () => {
    server = https.createServer(selfSignedCert(), (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        got.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(req.url?.includes("broken") ? brokenStatus : 201).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    const v = webpush.generateVAPIDKeys();
    Object.assign(process.env, { VAPID_PUBLIC_KEY: v.publicKey, VAPID_PRIVATE_KEY: v.privateKey, VAPID_SUBJECT: "mailto:test@onsite.invalid",
      PUSH_ENDPOINT_HOSTS: `127.0.0.1:${port}`, NEXT_PUBLIC_BASE_URL: "http://localhost:3000", SMS_ALERTS_PER_HOUR: "100000" });   // the app-wide ceiling is its own test
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";                              // trust the throwaway cert above, in this process only
    delete process.env.TWILIO_ACCOUNT_SID;                                       // SMS stays a stub: logged, never sent
    await sql`DELETE FROM users WHERE phone = ANY(${PEOPLE})`;
    [bat, nima] = await Promise.all([OURS.bat, OURS.nima].map(async (phone, i) => {
      const [u] = await sql`INSERT INTO users (phone, name, role) VALUES (${phone}, ${`Alert Tester ${i + 1}`}, 'worker') RETURNING id`;
      await sql`INSERT INTO workers (user_id, invite_code, tickets) VALUES (${u.id}, ${`ALRT0${i + 1}`}, '{WC}')`;
      return u.id as string;
    }));
    [[dave, site], [other, otherSite]] = await Promise.all([OURS.dave, OURS.other].map(async (phone, i) => {
      const [u] = await sql`INSERT INTO users (phone, name, role) VALUES (${phone}, ${`Alert Boss ${i + 1}`}, 'boss') RETURNING id`;
      await sql`INSERT INTO bosses (user_id, company) VALUES (${u.id}, ${`Alert Test Co ${i + 1}`})`;
      const [p] = await sql`INSERT INTO projects (boss_id, name, location) VALUES (${u.id}, ${`Alert Test Site ${i + 1}`},
                            ST_SetSRID(ST_MakePoint(151.155, -33.911),4326)::geography) RETURNING id`;
      return [u.id as string, p.id as string];
    })) as [string, string][];
    await sql`DELETE FROM rate_limits WHERE key LIKE 'shift-post:%'`;
  });

  beforeEach(async () => {
    got = []; logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    await sql`UPDATE notifications SET sent_at = COALESCE(sent_at, now()), sent_via = 'test-skip' WHERE sent_via IS NULL AND user_id IN (${bat}, ${nima}, ${dave}, ${other})`;
    await sql`DELETE FROM push_subscriptions WHERE endpoint LIKE 'https://127.0.0.1:%'`;
    await sql`DELETE FROM rate_limits WHERE key LIKE 'sms:%'`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (made.length) await sql`DELETE FROM shifts WHERE id = ANY(${made})`;
    await sql`DELETE FROM push_subscriptions WHERE endpoint LIKE 'https://127.0.0.1:%'`;
    await sql`DELETE FROM notifications WHERE body LIKE 'alert-test%'`;
    await sql`DELETE FROM rate_limits WHERE key LIKE 'sms:%' OR key LIKE 'shift-post:%'`;
    await sql`DELETE FROM users WHERE phone = ANY(${PEOPLE})`;
    process.env = env;
    await new Promise((r) => server.close(r));
    await sql.end();
  });

  it("a shift booked for someone is pushed to their phone, encrypted, signed, and opens their calendar", async () => {
    await subscribe(bat, "/push/bat");
    const shiftId = await postDirect(bat, addDays(todayIso(), 9), "06:30");
    await deliverAlerts();
    expect(at("/push/bat")).toHaveLength(1);
    const g = at("/push/bat")[0];
    expect(g.headers["content-encoding"]).toBe("aes128gcm");
    expect(g.headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(g.headers.ttl).toBe("1800");
    expect(g.headers.urgency).toBe("normal");
    const msg = decrypt(g);
    expect(msg).toMatchObject({ title: "Shift near you", url: "/worker", tag: `shift_match:${shiftId}` });
    expect(msg.body).toContain("Booked directly for you");                        // push carries the full message
    expect(texts(OURS.bat)).toHaveLength(0);                                // push landed, no text needed
    const [n] = await sql`SELECT sent_via FROM notifications WHERE shift_id = ${shiftId} AND user_id = ${bat}`;
    expect(n.sent_via).toBe("push");
  });

  it("no phone subscribed → the offer goes by text, in fixed words with nothing the boss typed", async () => {
    const [project] = await sql`SELECT name FROM projects WHERE id = ${site}`;
    await postDirect(nima, addDays(todayIso(), 10), "06:30");
    await deliverAlerts();
    const t = texts(OURS.nima);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatch(/OnSite: a new shift offer for \w{3} \d{2} \w{3}, 6:30am\. Open the app to see it: http:\/\/localhost:3000\/worker$/);
    expect(t[0]).not.toContain(project.name);                                      // boss-authored text never reaches an SMS
    expect(t[0]).not.toContain("Alert test");
  });

  it("a shift starting within 3 hours is pushed as urgent AND texted", async () => {
    const sydney = new Date(Date.now() + 60 * 60_000).toLocaleTimeString("en-GB", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit", hour12: false });
    if (sydney < "01:00") return;                                                 // an hour from now is tomorrow — nothing to test tonight
    await subscribe(bat, "/push/bat-urgent");
    await postDirect(bat, todayIso(), sydney);
    await deliverAlerts();
    expect(at("/push/bat-urgent")).toHaveLength(1);
    expect(at("/push/bat-urgent")[0].headers.urgency).toBe("high");
    expect(decrypt(at("/push/bat-urgent")[0]).title).toBe("Starts soon — shift near you");
    expect(texts(OURS.bat).some((l) => l.includes("a shift starting soon"))).toBe(true);
  });

  it(`texts are capped at ${SMS_PER_PERSON_PER_DAY} a day per person — a boss can't SMS-bomb a worker`, async () => {
    for (let i = 0; i < SMS_PER_PERSON_PER_DAY + 3; i++) await note(nima, "shift_match", `alert-test offer ${i}`);
    await deliverAlerts();
    expect(texts(OURS.nima)).toHaveLength(SMS_PER_PERSON_PER_DAY);
    const rows = await sql`SELECT sent_via FROM notifications WHERE body LIKE 'alert-test offer %' AND user_id = ${nima}`;
    expect(rows.every((r) => r.sent_via === "none")).toBe(true);                   // the stub never "sends"; every row is still stamped
  });

  it("one boss can't drain the app's whole texting budget and silence everyone else", async () => {
    process.env.SMS_ALERTS_PER_HOUR = "10";                                        // this boss's share is 20% of it
    // park other files' unsent rows: with the ceiling this low, their texts would drain it first
    await sql`UPDATE notifications SET sent_at = COALESCE(sent_at, now()), sent_via = 'test-skip' WHERE sent_via IS NULL AND user_id <> ALL(${[bat, nima, dave, other]})`;
    try {
      const share = Math.ceil(10 * SMS_SHARE_PER_BOSS);
      for (let i = 0; i < share + 2; i++) await postDirect(nima, addDays(todayIso(), 20 + i), "06:30");
      await deliverAlerts();
      expect(texts(OURS.nima)).toHaveLength(share);                                // this boss stops at their share
      logs = [];
      await postDirect(nima, addDays(todayIso(), 19), "06:30", other, otherSite);   // a different boss still gets through
      await deliverAlerts();
      expect(texts(OURS.nima)).toHaveLength(1);
    } finally {
      process.env.SMS_ALERTS_PER_HOUR = "100000";
      process.env.TEST_USER_ID = dave;
    }
  });

  it("a text nobody sent costs nobody their allowance", async () => {
    process.env.SMS_ALERTS_PER_HOUR = "5";                                         // this boss's share is 1
    await sql`UPDATE notifications SET sent_at = COALESCE(sent_at, now()), sent_via = 'test-skip' WHERE sent_via IS NULL AND user_id <> ALL(${[bat, nima, dave, other]})`;
    try {
      await postDirect(nima, addDays(todayIso(), 26), "06:30");
      await postDirect(nima, addDays(todayIso(), 27), "06:30");
      await deliverAlerts();
      expect(texts(OURS.nima)).toHaveLength(1);                                    // one went, one was refused by the share
      const [person] = await sql`SELECT hits FROM rate_limits WHERE key = ${`sms:user:${nima}`}`;
      expect(person.hits).toBe(1);                                                 // the refused one was handed back
      const [boss1] = await sql`SELECT hits FROM rate_limits WHERE key = ${`sms:boss:${dave}`}`;
      expect(boss1.hits).toBe(1);                                                  // including the gate that did the refusing
    } finally {
      process.env.SMS_ALERTS_PER_HOUR = "100000";
    }
  });

  it("a retried alert never buys a second text", async () => {
    const id = await note(nima, "shift_match", "alert-test retry");               // nima has no push: this goes by text
    const first = await withTwilio(async () => { await deliverAlerts(); });
    expect(first.filter((to) => PEOPLE.includes(to))).toEqual([OURS.nima]);
    const [sent] = await sql`SELECT sms_at, sent_via FROM notifications WHERE id = ${id}`;
    expect(sent.sms_at).toBeTruthy();
    expect(sent.sent_via).toBe("sms");
    // the run "dies" after texting but before stamping, so the row is claimed again
    await sql`UPDATE notifications SET sent_via = NULL, sent_at = now() - interval '3 minutes' WHERE id = ${id}`;
    const second = await withTwilio(async () => { await deliverAlerts(); });
    expect(second.filter((to) => PEOPLE.includes(to))).toEqual([]);                 // the text isn't sent twice
    const [after] = await sql`SELECT sent_via FROM notifications WHERE id = ${id}`;
    expect(after.sent_via).toBe("none");
  });

  it("a text the provider refused is retried, not silently dropped", async () => {
    const id = await note(nima, "shift_match", "alert-test twilio down");
    const real = globalThis.fetch;
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: "AC_test", TWILIO_AUTH_TOKEN: "token", TWILIO_FROM: "+61400000000" });
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      return u.includes("api.twilio.com") ? new Response("busy", { status: 503 }) : real(url as Parameters<typeof fetch>[0], init);
    });
    try {
      await deliverAlerts();
      const [row] = await sql`SELECT sent_via, sms_at FROM notifications WHERE id = ${id}`;
      expect(row.sent_via).toBeNull();                                             // left for the next run
      expect(row.sms_at).toBeNull();
      // and it cost nobody their allowance: every budget it charged was handed back
      const spent = await sql`SELECT key, hits FROM rate_limits WHERE key IN (${`sms:user:${nima}`}, 'sms:all') ORDER BY key`;
      expect(spent.map((r) => r.key)).toEqual(["sms:all", `sms:user:${nima}`]);    // both were charged…
      expect(spent.map((r) => r.hits)).toEqual([0, 0]);                            // …and both were handed back
    } finally {
      vi.unstubAllGlobals();
      for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM"]) delete process.env[k];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
      await sql`UPDATE notifications SET sent_via = 'test-skip' WHERE id = ${id}`;
    }
  });

  it("a phone that uninstalled (410 Gone) is forgotten", async () => {
    await subscribe(bat, "/push/broken-gone");
    await postDirect(bat, addDays(todayIso(), 11), "06:30");
    await deliverAlerts();
    const left = await sql`SELECT 1 FROM push_subscriptions WHERE endpoint LIKE ${`%:${port}/push/broken-gone`}`;
    expect(left).toHaveLength(0);
  });

  it("a push service that keeps erroring (not gone) is dropped after 5 failed sends", async () => {
    brokenStatus = 500;
    await subscribe(bat, "/push/broken-500");
    for (let i = 0; i < 5; i++) {
      await note(bat, "test", `alert-test broken ${i}`);
      await deliverAlerts();
    }
    brokenStatus = 410;
    const left = await sql`SELECT failures FROM push_subscriptions WHERE endpoint LIKE ${`%:${port}/push/broken-500`}`;
    expect(left).toHaveLength(0);
  });

  it("the boss gets a push that opens that shift", async () => {
    await subscribe(dave, "/push/dave");
    const shiftId = await postDirect(bat, addDays(todayIso(), 12), "06:30");
    await sql`UPDATE notifications SET sent_at = now(), sent_via = 'test-skip' WHERE shift_id = ${shiftId} AND user_id = ${bat}`;
    await sql`INSERT INTO notifications (user_id, shift_id, kind, body) VALUES (${dave}, ${shiftId}, 'approve', 'alert-test: Batbayar clocked out: 8h. Approve hours.')`;
    await deliverAlerts();
    const mine = at("/push/dave").map(decrypt).filter((m) => m.tag === `approve:${shiftId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: "Hours to approve", url: `/boss/shifts/${shiftId}` });
  });

  it("old news isn't sent: anything unsent for 30 minutes expires", async () => {
    await subscribe(bat, "/push/bat-old");
    const [row] = await sql`INSERT INTO notifications (user_id, kind, body, created_at) VALUES (${bat}, 'test', 'alert-test old', now() - interval '31 minutes') RETURNING id`;
    await deliverAlerts();
    expect(at("/push/bat-old")).toHaveLength(0);
    const [n] = await sql`SELECT sent_via FROM notifications WHERE id = ${row.id}`;
    expect(n.sent_via).toBe("expired");
  });

  it("rows another run has locked are skipped, not waited on and not sent twice", async () => {
    await subscribe(bat, "/push/bat-lock");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await note(bat, "test", `alert-test lock ${i}`));
    const other = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 1 });
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await other.begin(async (tx) => {
        await tx`SELECT id FROM notifications WHERE id = ANY(${ids}) FOR UPDATE`;   // "another run" holds these rows
        pending = deliverAlerts();
        const outcome = await Promise.race([pending.then(() => "done"), new Promise((r) => setTimeout(() => r("blocked"), 4000))]);
        expect(outcome).toBe("done");                                              // it didn't wait for the lock
        const claimed = await sql`SELECT 1 FROM notifications WHERE id = ANY(${ids}) AND sent_at IS NOT NULL`;
        expect(claimed).toHaveLength(0);                                           // and didn't touch the locked rows
      });
    } finally {
      await pending.catch(() => {});
      await other.end();
    }
    await deliverAlerts();                                                         // lock released: now they go, once each
    expect(at("/push/bat-lock")).toHaveLength(5);
    const rows = await sql`SELECT sent_via FROM notifications WHERE id = ANY(${ids})`;
    expect(rows.every((r) => r.sent_via === "push")).toBe(true);
  });

  it("three delivery runs at once still send each alert once", async () => {
    await subscribe(bat, "/push/bat-once");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await note(bat, "test", `alert-test once ${i}`));
    await Promise.all([deliverAlerts(), deliverAlerts(), deliverAlerts()]);
    expect(at("/push/bat-once")).toHaveLength(5);
    expect(new Set(at("/push/bat-once").map((g) => decrypt(g).body)).size).toBe(5);
  });

  it("a run that died after claiming is picked up again after 2 minutes — but not one still in flight", async () => {
    await subscribe(bat, "/push/bat-reclaim");
    const stuck = await note(bat, "test", "alert-test stuck");
    const inFlight = await note(bat, "test", "alert-test in flight");
    await sql`UPDATE notifications SET sent_at = now() - interval '3 minutes' WHERE id = ${stuck}`;
    await sql`UPDATE notifications SET sent_at = now() - interval '20 seconds' WHERE id = ${inFlight}`;
    await deliverAlerts();
    const bodies = at("/push/bat-reclaim").map((g) => decrypt(g).body);
    expect(bodies).toEqual(["alert-test stuck"]);
    const [s] = await sql`SELECT sent_via FROM notifications WHERE id = ${stuck}`;
    expect(s.sent_via).toBe("push");
    await sql`UPDATE notifications SET sent_via = 'test-skip' WHERE id = ${inFlight}`;
  });

  it("broken push settings don't swallow the batch — texts still go and every row is stamped", async () => {
    process.env.VAPID_SUBJECT = "ops@example.com";                                // web-push rejects this (not a URL)
    try {
      await subscribe(bat, "/push/bat-badvapid");
      const id = await note(bat, "shift_match", "alert-test bad vapid");
      await expect(deliverAlerts()).resolves.toBeTruthy();
      expect(at("/push/bat-badvapid")).toHaveLength(0);
      expect(texts(OURS.bat)).toHaveLength(1);                               // push off → text instead
      const [n] = await sql`SELECT sent_via FROM notifications WHERE id = ${id}`;
      expect(n.sent_via).toBe("none");
    } finally {
      process.env.VAPID_SUBJECT = "mailto:test@onsite.invalid";
    }
  });
});
