/**
 * The live AUD → MNT rate, against a real DB (needs DATABASE_URL): the order of the sources, the 6-hour cache in
 * fx_rates, the plausible band, the manual override — and an invoice paid at that rate, through the real page,
 * action and cron route.
 *
 * Every network call is a stub: the Bank of Mongolia, ExchangeRate-API and QPay each answer in the shapes they
 * really used on 17 Sept 2026. Nothing here reaches the internet.
 *
 * This is the one test file that reads or writes fx_rates (tests/integration/invoiceQpay.test.ts pins its rate with
 * AUD_MNT_RATE_OVERRIDE=1 for that reason), so it may empty the table before each test. Its people are
 * +614000085xx and its invoices OS-2099-0085xx; the cron's other jobs are stubbed so calling the route here
 * can't touch another file's shifts, invoices, cards or alerts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/matching", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/matching")>()), expandStaleShifts: async () => ({ expanded: 0 }) }));
vi.mock("@/lib/billing", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/billing")>()), reconcileOpenInvoices: async () => ({ checked: 0, paid: 0, errors: 0 }) }));
vi.mock("@/lib/invoicing", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/invoicing")>()), closeBillingPeriods: async () => ({ trials_ended: 0, closed: 0, invoiced: 0, lapsed: 0 }) }));
vi.mock("@/lib/licenceRecheck", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/licenceRecheck")>()), recheckLicences: async () => ({}) }));
vi.mock("@/lib/alerts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/alerts")>()), deliverAlerts: async () => ({ claimed: 0, push: 0, sms: 0, expired: 0, gone: 0 }) }));
vi.mock("@/lib/ratelimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ratelimit")>()), sweepRateLimits: async () => null }));

import * as billing from "@/actions/billing";
import { sql } from "@/lib/db";
import { resetQpayToken } from "@/lib/qpay";
import { FALLBACK_RATES_URL, MONGOLBANK_RATES_URL, audToMnt, warmAudToMnt } from "@/lib/fxRate";
import { FX_AT_TAP, FX_UNAVAILABLE } from "@/lib/subscription";
import { todayIso } from "@/lib/util";
import Invoice from "@/app/boss/billing/[number]/page";
import { GET as cron } from "@/app/api/cron/expand/route";

const PHONES = { boss: "+61400008501" };
const NUMBERS = { a: "OS-2099-008501", b: "OS-2099-008502", c: "OS-2099-008503" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DAY = 24 * 60 * 60 * 1000;
const OFFICIAL = { rate: 2559.03, source: "mongolbank", asOf: "2026-09-17" };
const FALLBACK = { rate: 2570.3, source: "fallback", asOf: "2026-09-17" };

// ───────────────────────────────────────────────────────────── stand-ins for the Bank of Mongolia, ExchangeRate-API and QPay
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const mongolbankSays = (aud = "2,559.03", day = "2026-09-17") =>
  json(200, { success: true, data: [{ RATE_DATE: day, USD: "3,595.66", EUR: "4,125.48", AUD: aud, CAD: "2,570.99" }], langData: {} });
const exchangeRateApiSays = (mnt = 2570.295114) =>
  json(200, { result: "success", time_last_update_unix: 1789603351, base_code: "AUD", rates: { AUD: 1, MNT: mnt, USD: 0.710998 } });

type Call = { url: string; method: string; path: string; body: Record<string, unknown> | null; timed: boolean };
let calls: Call[] = [];
let answer: { mongolbank: () => Response | Promise<Response>; fallback: () => Response | Promise<Response> };

function standIns() {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url), method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    const path = new URL(u).pathname.replace(/^\/v2/, "");
    calls.push({ url: u, method, path, body, timed: init.signal instanceof AbortSignal });
    if (u === MONGOLBANK_RATES_URL) return answer.mongolbank();
    if (u === FALLBACK_RATES_URL) return answer.fallback();
    if (!u.startsWith("https://merchant.qpay.mn/")) return new Response("unexpected call", { status: 500 });
    if (path === "/auth/token") return json(200, { access_token: "T1", expires_in: 3600 });
    if (method === "POST" && path === "/invoice") {
      const id = randomUUID();
      return json(200, { invoice_id: id, qr_text: "0002010102", qr_image: PNG, qPay_shortUrl: `https://s.qpay.mn/${id.slice(0, 8)}`,
        urls: [{ name: "Khan bank", description: "Хаан банк", logo: "https://qpay.mn/q/logo/khanbank.png", link: `khanbank://q?qPay_QRcode=${id}` }] });
    }
    if (method === "DELETE" && path.startsWith("/invoice/")) return json(200, { message: "invoice cancelled" });
    if (method === "POST" && path === "/payment/check") return json(200, { count: 0, paid_amount: 0, rows: [] });
    return new Response("unexpected call", { status: 500 });
  }));
}

const rateCalls = () => calls.filter((c) => c.url === MONGOLBANK_RATES_URL || c.url === FALLBACK_RATES_URL).map((c) => c.url === MONGOLBANK_RATES_URL ? "mongolbank" : "fallback");
const qpayCalls = () => calls.filter((c) => c.url.startsWith("https://merchant.qpay.mn/")).map((c) => `${c.method} ${c.path}`);
const cached = () => sql<{ rate: string; source: string; as_of: string }[]>`SELECT rate::text AS rate, source, as_of FROM fx_rates WHERE pair = 'AUD/MNT' ORDER BY source, as_of`;
const ageCache = (hours: number) => sql`UPDATE fx_rates SET fetched_at = now() - make_interval(hours => ${hours}) WHERE pair = 'AUD/MNT'`;
const quietErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

function rateEnv(over: Record<string, string> = {}) {
  vi.stubEnv("AUD_MNT_RATE", "");
  vi.stubEnv("AUD_MNT_RATE_OVERRIDE", "");
  for (const [k, v] of Object.entries(over)) vi.stubEnv(k, v);
}
function qpayOn() {
  vi.stubEnv("QPAY_BASE_URL", "https://merchant.qpay.mn/v2");
  vi.stubEnv("QPAY_USERNAME", "TEST_USER");
  vi.stubEnv("QPAY_PASSWORD", "test-pass");
  vi.stubEnv("QPAY_INVOICE_CODE", "TEST_INVOICE");
  vi.stubEnv("QPAY_CALLBACK_SECRET", "test-callback-secret");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://onsite.test");
}

// ───────────────────────────────────────────────────────────── the invoice page and the Pay button
const as = (id: string) => { process.env.TEST_USER_ID = id; };
const tap = (number: string) => { const f = new FormData(); f.append("number", number); return billing.payWithQpay({ error: null }, f); };
const render = async (number: string) => {
  const out = { parts: [] as string[], text: [] as string[] };
  const walk = (node: unknown): void => {
    if (node == null || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") { out.text.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function") {
      const name = (el.type as { name: string }).name;
      out.parts.push(name);
      if (name === "OpenInvoice") { walk((el.type as (p: unknown) => unknown)(el.props)); return; }
    }
    for (const [k, v] of Object.entries(el.props ?? {}))
      if (typeof v === "string") { if (["children", "title", "sub", "alt", "src", "href"].includes(k)) out.text.push(v); }
      else if (typeof v === "object") walk(v);
  };
  walk(await Invoice({ params: Promise.resolve({ number }) }));
  return out;
};
const invoice = async (number: string) => (await sql<{ qpay_sender_invoice_no: string | null; qpay_amount_mnt: string | null; qpay_rate: string | null; qpay_rate_source: string | null; qpay_rate_as_of: string | null; qpay_raised_on: string | null }[]>`
  SELECT qpay_sender_invoice_no, qpay_amount_mnt, qpay_rate, qpay_rate_source, qpay_rate_as_of, qpay_raised_on FROM invoices WHERE number = ${number}`)[0];

describe.skipIf(!process.env.DATABASE_URL)("the AUD → MNT rate", () => {
  const ids = { boss: "" };

  const cleanup = async () => {
    const users = (await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ${PHONES.boss}`).map((u) => u.id);
    const raised = users.length ? (await sql<{ s: string }[]>`
      SELECT sender_invoice_no AS s FROM qpay_invoices WHERE user_id = ANY(${users})
      UNION SELECT qpay_sender_invoice_no FROM invoices WHERE boss_id = ANY(${users}) AND qpay_sender_invoice_no IS NOT NULL`).map((r) => r.s) : [];
    await sql`DELETE FROM users WHERE phone = ${PHONES.boss}`;
    await sql`DELETE FROM invoices WHERE number = ANY(${Object.values(NUMBERS)})`;
    if (raised.length) await sql`DELETE FROM qpay_invoices WHERE sender_invoice_no = ANY(${raised})`;
    await sql`DELETE FROM fx_rates WHERE pair = 'AUD/MNT'`;
  };

  beforeAll(async () => {
    await cleanup();
    [{ id: ids.boss }] = await sql<{ id: string }[]>`INSERT INTO users (phone, name, role) VALUES (${PHONES.boss}, 'Rate boss', 'boss') RETURNING id`;
    await sql`INSERT INTO bosses (user_id, company, abn, trial_ends_at, period_started_at, period_ends_at)
              VALUES (${ids.boss}, 'Rate boss Pty Ltd', '11222333444', now() + interval '3 days', now() + interval '3 days', now() + interval '33 days')`;
    let n = 0;
    for (const number of Object.values(NUMBERS)) {
      const start = new Date(Date.now() - (60 + ++n) * DAY);
      await sql`INSERT INTO invoices (number, boss_id, period_start, period_end, issued_at, due_at, subtotal_cents, gst_cents, total_cents)
                VALUES (${number}, ${ids.boss}, ${start}, ${new Date(start.getTime() + 30 * DAY)}, now(), now() + interval '14 days', 3300, 0, 3300)`;
    }
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM fx_rates WHERE pair = 'AUD/MNT'`;
    calls = [];
    answer = { mongolbank: () => mongolbankSays(), fallback: () => exchangeRateApiSays() };
    resetQpayToken();
    rateEnv();
    standIns();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  // ─────────────────────────────────────────────────────────── where it comes from
  describe("the sources", () => {
    it("asks the Bank of Mongolia first, with an 8-second limit, keeps its AUD rate for 6 hours, then asks again", async () => {
      expect(await audToMnt()).toEqual(OFFICIAL);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: MONGOLBANK_RATES_URL, method: "POST", timed: true });
      expect(calls[0].body).toEqual({ startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      expect(await cached()).toEqual([{ rate: "2559.03", source: "mongolbank", as_of: "2026-09-17" }]);

      expect(await audToMnt()).toEqual(OFFICIAL);                          // from the cache: nobody is asked
      expect(await audToMnt()).toEqual(OFFICIAL);
      expect(calls).toHaveLength(1);

      await ageCache(5);
      expect(await audToMnt()).toEqual(OFFICIAL);                          // five hours on, still fresh
      expect(calls).toHaveLength(1);

      await ageCache(7);
      answer.mongolbank = () => mongolbankSays("2,561.00", "2026-09-18");
      expect(await audToMnt()).toEqual({ rate: 2561, source: "mongolbank", asOf: "2026-09-18" });
      expect(rateCalls()).toEqual(["mongolbank", "mongolbank"]);
    });

    it("falls back to ExchangeRate-API, then to AUD_MNT_RATE, then to nothing — without ever throwing", async () => {
      const errors = quietErrors();
      answer.mongolbank = () => json(503, { message: "down" });
      expect(await audToMnt()).toEqual(FALLBACK);
      expect(rateCalls()).toEqual(["mongolbank", "fallback"]);
      expect(calls.every((c) => c.timed)).toBe(true);
      expect(await cached()).toEqual([{ rate: "2570.3", source: "fallback", as_of: "2026-09-17" }]);

      await sql`DELETE FROM fx_rates WHERE pair = 'AUD/MNT'`;
      calls = [];
      answer.mongolbank = () => { throw new TypeError("fetch failed"); };
      answer.fallback = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
      expect(await audToMnt()).toBeNull();
      expect(rateCalls()).toEqual(["mongolbank", "fallback"]);

      vi.stubEnv("AUD_MNT_RATE", "2250");
      expect(await audToMnt()).toEqual({ rate: 2250, source: "env", asOf: todayIso() });

      answer.mongolbank = () => new Response("<html>maintenance</html>", { status: 200 });     // not JSON
      answer.fallback = () => json(200, { result: "error", "error-type": "unsupported-code" });
      expect(await audToMnt()).toEqual({ rate: 2250, source: "env", asOf: todayIso() });
      expect(await cached()).toEqual([]);

      // What was logged says which source and why — never a URL, a response body or an error message.
      for (const args of errors.mock.calls) expect(JSON.stringify(args)).not.toMatch(/https?:|maintenance|down|unsupported|fetch failed|aborted/);
    });

    it("keeps using a fresh fallback rate rather than asking a Bank of Mongolia that is down on every tap — the cron still asks", async () => {
      quietErrors();
      answer.mongolbank = () => json(503, {});
      expect(await audToMnt()).toEqual(FALLBACK);
      expect(await audToMnt()).toEqual(FALLBACK);
      expect(rateCalls()).toEqual(["mongolbank", "fallback"]);

      expect(await warmAudToMnt()).toEqual(FALLBACK);                      // still down: the cron gets the fallback too
      expect(rateCalls()).toEqual(["mongolbank", "fallback", "mongolbank"]);

      answer.mongolbank = () => mongolbankSays();
      expect(await warmAudToMnt()).toEqual(OFFICIAL);                      // back: the official rate is cached…
      expect(await audToMnt()).toEqual(OFFICIAL);                          // …and wins over the fresh fallback from then on
      expect(rateCalls()).toEqual(["mongolbank", "fallback", "mongolbank", "mongolbank"]);
    });

    it("treats a rate outside ₮1,000–₮5,000 per A$1 as a broken source, and logs only the numbers", async () => {
      const errors = quietErrors();
      vi.stubEnv("AUD_MNT_RATE", "9999");
      answer.mongolbank = () => mongolbankSays("25.59");                  // a decimal point in the wrong place
      answer.fallback = () => exchangeRateApiSays(360000);
      expect(await audToMnt()).toBeNull();
      expect(errors.mock.calls).toEqual([
        ["fx: AUD_MNT_RATE out of range", 9999, [1000, 5000]],
        ["fx: rate out of range from", "mongolbank", 25.59, [1000, 5000]],
        ["fx: rate out of range from", "fallback", 360000, [1000, 5000]],
      ]);
      expect(await cached()).toEqual([]);                                  // nothing implausible is kept

      // and a bad row that got into the cache some other way is passed over
      await sql`INSERT INTO fx_rates (pair, rate, source, as_of) VALUES ('AUD/MNT', 35956.6, 'mongolbank', '2026-09-18')`;
      answer.mongolbank = () => mongolbankSays();
      expect(await audToMnt()).toEqual(OFFICIAL);
    });

    it("uses AUD_MNT_RATE ahead of every source with AUD_MNT_RATE_OVERRIDE=1, and asks nobody", async () => {
      expect(await audToMnt()).toEqual(OFFICIAL);
      calls = [];
      rateEnv({ AUD_MNT_RATE: "2300", AUD_MNT_RATE_OVERRIDE: "1" });
      expect(await audToMnt()).toEqual({ rate: 2300, source: "env", asOf: todayIso() });
      expect(await audToMnt({ cachedOnly: true })).toEqual({ rate: 2300, source: "env", asOf: todayIso() });
      expect(await warmAudToMnt()).toEqual({ rate: 2300, source: "env", asOf: todayIso() });
      expect(calls).toEqual([]);

      rateEnv({ AUD_MNT_RATE: "2300" });                                   // without the override it is only the last resort
      expect(await audToMnt()).toEqual(OFFICIAL);

      quietErrors();
      rateEnv({ AUD_MNT_RATE: "3595.66", AUD_MNT_RATE_OVERRIDE: "1" });    // plausible, so it wins — README warns it is per A$1, not US$1
      expect(await audToMnt()).toMatchObject({ rate: 3595.66, source: "env" });
      rateEnv({ AUD_MNT_RATE: "35956", AUD_MNT_RATE_OVERRIDE: "1" });      // implausible: ignored
      expect(await audToMnt()).toEqual(OFFICIAL);
      rateEnv({ AUD_MNT_RATE_OVERRIDE: "1" });                              // the switch with no rate: ignored
      expect(await audToMnt()).toEqual(OFFICIAL);
      expect(calls).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────── paying at it
  describe("an invoice paid at the live rate", () => {
    beforeEach(() => { qpayOn(); as(ids.boss); });

    it("shows an estimate at the cached rate on page load, and never asks a rate source or QPay to show it", async () => {
      await audToMnt();
      calls = [];

      let page = await render(NUMBERS.a);
      expect(page.parts).toContain("PayWithQpay");
      expect(page.text).toEqual(expect.arrayContaining(["A$33.00", "≈ ₮84,448 · Bank of Mongolia rate for 17 Sept: ₮2,559.03 per A$1"]));

      await ageCache(30);                                                  // stale: still the estimate — the tap is what refreshes it
      page = await render(NUMBERS.a);
      expect(page.text).toContain("≈ ₮84,448 · Bank of Mongolia rate for 17 Sept: ₮2,559.03 per A$1");

      await sql`DELETE FROM fx_rates WHERE pair = 'AUD/MNT'`;
      await sql`INSERT INTO fx_rates (pair, rate, source, as_of) VALUES ('AUD/MNT', 2570.3, 'fallback', '2026-09-17')`;
      page = await render(NUMBERS.a);
      expect(page.text).toEqual(expect.arrayContaining(["≈ ₮84,820 · ExchangeRate-API rate for 17 Sept: ₮2,570.30 per A$1", "Rates By Exchange Rate API"]));

      await sql`DELETE FROM fx_rates WHERE pair = 'AUD/MNT'`;               // no rate known at all: the button, and what the tap will do
      page = await render(NUMBERS.a);
      expect(page.parts).toContain("PayWithQpay");
      expect(page.text).toContain(FX_AT_TAP);
      expect(page.text.some((t) => t.startsWith("≈ ₮"))).toBe(false);

      expect(calls).toEqual([]);
    });

    it("raises the QR at the rate looked up at the tap, and keeps that rate, its source and its day on the invoice", async () => {
      expect(await tap(NUMBERS.b)).toEqual({ error: null });
      expect(rateCalls()).toEqual(["mongolbank"]);
      expect(qpayCalls()).toEqual(["POST /auth/token", "POST /invoice"]);
      expect(calls.find((c) => c.path === "/invoice")!.body).toMatchObject({ amount: 84448 });   // ceil(33 × 2559.03)
      const inv = await invoice(NUMBERS.b);
      expect(inv).toMatchObject({ qpay_rate: "2559.03", qpay_rate_source: "mongolbank", qpay_rate_as_of: "2026-09-17", qpay_raised_on: todayIso() });
      expect(Number(inv.qpay_amount_mnt)).toBe(84448);

      // The Bank of Mongolia moves and the cache runs out: the same day, the QR stays as it was raised.
      calls = [];
      await ageCache(7);
      answer.mongolbank = () => mongolbankSays("2,600.00", "2026-09-18");
      const page = await render(NUMBERS.b);
      expect(page.parts).toContain("QpayWatch");
      expect(page.text).toContain("≈ ₮84,448 · Bank of Mongolia rate for 17 Sept: ₮2,559.03 per A$1");
      expect(await tap(NUMBERS.b)).toEqual({ error: null });
      expect(calls).toEqual([]);                                           // no rate looked up, nothing raised
      expect((await invoice(NUMBERS.b)).qpay_sender_invoice_no).toBe(inv.qpay_sender_invoice_no);

      // The next day it is replaced at the new rate.
      await sql`UPDATE invoices SET qpay_raised_on = qpay_raised_on - 1 WHERE number = ${NUMBERS.b}`;
      expect(await tap(NUMBERS.b)).toEqual({ error: null });
      expect(rateCalls()).toEqual(["mongolbank"]);
      expect(calls.find((c) => c.method === "POST" && c.path === "/invoice")!.body).toMatchObject({ amount: 85800 });
      expect(await invoice(NUMBERS.b)).toMatchObject({ qpay_rate: "2600", qpay_rate_as_of: "2026-09-18", qpay_raised_on: todayIso() });
    });

    it("says the rate is briefly unavailable when no source answers, and raises nothing on QPay", async () => {
      quietErrors();
      answer.mongolbank = () => json(502, {});
      answer.fallback = () => json(429, {});
      expect(await tap(NUMBERS.c)).toEqual({ error: FX_UNAVAILABLE });
      expect(rateCalls()).toEqual(["mongolbank", "fallback"]);
      expect(qpayCalls()).toEqual([]);
      expect((await invoice(NUMBERS.c)).qpay_sender_invoice_no).toBeNull();
      expect((await render(NUMBERS.c)).text).toContain(FX_AT_TAP);
    });
  });

  // ─────────────────────────────────────────────────────────── the cron
  describe("the cron", () => {
    const run = async () => {
      const res = await cron(new Request("http://localhost/api/cron/expand", { headers: { authorization: "Bearer test-cron-secret-for-fx" } }));
      expect(res.status).toBe(200);
      return (await res.json()) as { fx: unknown };
    };
    beforeEach(() => { vi.stubEnv("CRON_SECRET", "test-cron-secret-for-fx"); });

    it("warms the rate only when the cached official one is over 6 hours old, and says which it has", async () => {
      qpayOn();
      expect((await run()).fx).toEqual({ source: "mongolbank", as_of: "2026-09-17" });
      expect((await run()).fx).toEqual({ source: "mongolbank", as_of: "2026-09-17" });
      expect(rateCalls()).toEqual(["mongolbank"]);
      await ageCache(7);
      expect((await run()).fx).toEqual({ source: "mongolbank", as_of: "2026-09-17" });
      expect(rateCalls()).toEqual(["mongolbank", "mongolbank"]);

      quietErrors();
      await ageCache(7);
      answer.mongolbank = () => json(503, {});
      answer.fallback = () => json(503, {});
      expect((await run()).fx).toEqual({ source: null, as_of: null });     // nothing to be had: said, not thrown
    });

    it("asks nobody for a rate while QPay isn't set up", async () => {
      qpayOn();
      vi.stubEnv("QPAY_USERNAME", "");
      expect((await run()).fx).toEqual({ source: null, as_of: null });
      expect(calls).toEqual([]);
    });
  });
});
