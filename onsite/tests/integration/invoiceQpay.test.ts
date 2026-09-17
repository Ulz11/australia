/**
 * Paying an OnSite invoice through QPay, end to end against a real DB (needs DATABASE_URL), with QPay itself
 * stood in for by a fetch stub answering in the shapes tests/unit/qpay.test.ts pins down. Through the real
 * action, the real invoice page, the real status route, QPay's real callback route and the cron's reconcile.
 *
 * Everyone here is ours alone: +614000087xx. Invoices are numbered OS-2099-0087xx so they can't meet a real
 * year's count. Self-cleaning — including the qpay_invoices rows, which outlive a deleted user.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as billing from "@/actions/billing";
import { sql } from "@/lib/db";
import { callbackSig, resetQpayToken, type QpayPaymentRow } from "@/lib/qpay";
import { reconcileOpenInvoices } from "@/lib/billing";
import { markInvoicePaid } from "@/lib/invoicing";
import { QPAY_HOW_TO, QPAY_NOT_SET_UP } from "@/lib/subscription";
import Invoice from "@/app/boss/billing/[number]/page";
import { GET as status } from "@/app/boss/billing/[number]/status/route";
import { GET as callback } from "@/app/api/qpay/callback/[invoice]/[sig]/route";

const PHONES = { boss: "+61400008701", other: "+61400008702" };
const EVERYONE = Object.values(PHONES);
const NUMBERS = { a: "OS-2099-008701", b: "OS-2099-008702", c: "OS-2099-008703", d: "OS-2099-008704", e: "OS-2099-008705", f: "OS-2099-008706" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DAY = 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────── a stand-in QPay
type Call = { method: string; path: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
const paidRows: Record<string, QpayPaymentRow[]> = {};
let createDelayMs = 0;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function standInQpay() {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/v2/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ method, path, body });
    if (path === "/auth/token") return json(200, { access_token: "T1", expires_in: 3600 });
    if (method === "POST" && path === "/invoice") {
      if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
      const id = randomUUID();
      return json(200, {
        invoice_id: id, qr_text: "0002010102", qr_image: PNG, qPay_shortUrl: `https://s.qpay.mn/${id.slice(0, 8)}`,
        urls: [{ name: "Khan bank", description: "Хаан банк", logo: "https://qpay.mn/q/logo/khanbank.png", link: `khanbank://q?qPay_QRcode=${id}` }],
      });
    }
    if (method === "DELETE" && path.startsWith("/invoice/")) return json(200, { message: "invoice cancelled" });
    if (method === "POST" && path === "/payment/check") {
      const rows = paidRows[String(body?.object_id)] ?? [];
      return json(200, { count: rows.length, paid_amount: rows.reduce((s, r) => s + Number(r.payment_amount), 0), rows });
    }
    return new Response("unexpected call", { status: 500 });
  }));
}

function qpayOn() {
  vi.stubEnv("QPAY_BASE_URL", "https://merchant.qpay.mn/v2");
  vi.stubEnv("QPAY_USERNAME", "TEST_USER");
  vi.stubEnv("QPAY_PASSWORD", "test-pass");
  vi.stubEnv("QPAY_INVOICE_CODE", "TEST_INVOICE");
  vi.stubEnv("QPAY_CALLBACK_SECRET", "test-callback-secret");
  vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://onsite.test");
  vi.stubEnv("AUD_MNT_RATE", "2250");
}

// ───────────────────────────────────────────────────────────── helpers
const as = (id: string) => { process.env.TEST_USER_ID = id; };
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.append(k, v); return f; };
const tap = (number: string) => billing.payWithQpay({ error: null }, fd({ number }));
const created = () => calls.filter((c) => c.method === "POST" && c.path === "/invoice");
const checks = () => calls.filter((c) => c.path === "/payment/check");

type InvoiceNow = { status: string; paid_at: Date | null; paid_note: string | null; qpay_sender_invoice_no: string | null; qpay_amount_mnt: string | null; qpay_rate: string | null; qpay_claimed_at: Date | null };
const invoice = async (number: string) => (await sql<InvoiceNow[]>`
  SELECT status, paid_at, paid_note, qpay_sender_invoice_no, qpay_amount_mnt, qpay_rate, qpay_claimed_at FROM invoices WHERE number = ${number}`)[0];
type QpayNow = { status: string; purpose: string; qpay_invoice_id: string; amount_mnt: number; paid_amount_mnt: number | null; payment_id: string | null; qr: { qr_image: string; short_url: string | null; urls: { name: string; logo: string | null; link: string }[] } | null };
const qpayRow = async (sender: string) => (await sql<QpayNow[]>`
  SELECT status, purpose, qpay_invoice_id, amount_mnt, paid_amount_mnt, payment_id, qr FROM qpay_invoices WHERE sender_invoice_no = ${sender}`)[0];
const told = (bossId: string, number: string) => sql<{ kind: string; body: string; shift_id: string | null }[]>`
  SELECT kind, body, shift_id FROM notifications WHERE user_id = ${bossId} AND kind = 'invoice_paid' AND body LIKE ${`%${number}%`}`;
const paidInFull = (q: QpayNow, paymentId: string, less = 0): QpayPaymentRow[] =>
  [{ payment_id: paymentId, payment_status: "PAID", payment_amount: String(q.amount_mnt - less), payment_currency: "MNT" }];
const nudge = (sender: string) => callback(new Request("https://onsite.test/api/qpay/callback"), { params: Promise.resolve({ invoice: sender, sig: callbackSig(sender) }) });
const poll = async (number: string) => {
  const res = await status(new Request("https://onsite.test/status"), { params: Promise.resolve({ number }) });
  return { code: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
};

/** The invoice page as the signed-in boss sees it: which components it uses, and every piece of text it shows. */
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
      if (name === "OpenInvoice") { walk((el.type as (p: unknown) => unknown)(el.props)); return; }   // the page's own server helper
    }
    for (const [k, v] of Object.entries(el.props ?? {}))
      if (typeof v === "string") { if (["children", "title", "sub", "alt", "src", "href"].includes(k)) out.text.push(v); }
      else if (typeof v === "object") walk(v);
  };
  walk(await Invoice({ params: Promise.resolve({ number }) }));
  return { ...out, all: out.text.join("\n") };
};

describe.skipIf(!process.env.DATABASE_URL)("paying an invoice through QPay", () => {
  const ids = { boss: "", other: "" };

  const cleanup = async () => {
    const users = (await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ANY(${EVERYONE})`).map((u) => u.id);
    const raised = users.length ? (await sql<{ s: string }[]>`
      SELECT sender_invoice_no AS s FROM qpay_invoices WHERE user_id = ANY(${users})
      UNION SELECT qpay_sender_invoice_no FROM invoices WHERE boss_id = ANY(${users}) AND qpay_sender_invoice_no IS NOT NULL`).map((r) => r.s) : [];
    await sql`DELETE FROM users WHERE phone = ANY(${EVERYONE})`;                      // bosses, invoices, notifications cascade
    await sql`DELETE FROM invoices WHERE number = ANY(${Object.values(NUMBERS)})`;    // in case a boss row was ever orphaned
    if (raised.length) await sql`DELETE FROM qpay_invoices WHERE sender_invoice_no = ANY(${raised})`;
  };

  beforeAll(async () => {
    await cleanup();
    for (const key of ["boss", "other"] as const) {
      [{ id: ids[key] }] = await sql<{ id: string }[]>`INSERT INTO users (phone, name, role) VALUES (${PHONES[key]}, ${`QPay ${key}`}, 'boss') RETURNING id`;
      // trial days away, so the cron's billing run in another file never picks these bosses up
      await sql`INSERT INTO bosses (user_id, company, abn, trial_ends_at, period_started_at, period_ends_at)
                VALUES (${ids[key]}, ${`QPay ${key} Pty Ltd`}, '11222333444', now() + interval '3 days', now() + interval '3 days', now() + interval '33 days')`;
    }
    const cents: Record<keyof typeof NUMBERS, number> = { a: 3300, b: 3300, c: 200, d: 3500, e: 3300, f: 3300 };
    let n = 0;
    for (const [key, number] of Object.entries(NUMBERS) as [keyof typeof NUMBERS, string][]) {
      const start = new Date(Date.now() - (60 + ++n) * DAY);
      await sql`INSERT INTO invoices (number, boss_id, period_start, period_end, issued_at, due_at, subtotal_cents, gst_cents, total_cents)
                VALUES (${number}, ${ids.boss}, ${start}, ${new Date(start.getTime() + 30 * DAY)}, now(), now() + interval '14 days', ${cents[key]}, 0, ${cents[key]})`;
    }
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  beforeEach(() => {
    calls = [];
    createDelayMs = 0;
    resetQpayToken();
    qpayOn();
    standInQpay();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("has no Pay button, and raises nothing, until QPay has both its credentials and a rate", async () => {
    as(ids.boss);
    for (const [name, value] of [["AUD_MNT_RATE", ""], ["QPAY_USERNAME", ""], ["AUD_MNT_RATE", "not a rate"]] as const) {
      qpayOn();
      vi.stubEnv(name, value);
      const page = await render(NUMBERS.a);
      expect(page.parts, name).not.toContain("PayWithQpay");
      expect(page.parts, name).not.toContain("QpayWatch");
      expect(page.text, name).toContain(QPAY_NOT_SET_UP);
      expect(await tap(NUMBERS.a), name).toEqual({ error: QPAY_NOT_SET_UP });
    }
    expect(calls).toEqual([]);
    expect((await invoice(NUMBERS.a)).qpay_sender_invoice_no).toBeNull();

    qpayOn();
    const page = await render(NUMBERS.a);
    expect(page.parts).toContain("PayWithQpay");
    expect(page.text).toContain("≈ ₮74,250 at ₮2,250 per $1");
    expect(page.all).not.toContain(QPAY_NOT_SET_UP);
    expect(calls).toEqual([]);                                             // showing the page never talks to QPay
  });

  it("won't let another boss pay, see or poll someone else's invoice", async () => {
    as(ids.other);
    expect(await tap(NUMBERS.a)).toEqual({ error: "We couldn't find that invoice." });
    await expect(render(NUMBERS.a)).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    expect((await poll(NUMBERS.a)).code).toBe(404);
    expect(calls).toEqual([]);
    expect((await invoice(NUMBERS.a)).qpay_sender_invoice_no).toBeNull();
  });

  it("raises one QPay invoice when Pay is tapped twice at once, and both taps get its QR", async () => {
    as(ids.boss);
    createDelayMs = 300;                                                  // QPay is slow: the second tap arrives mid-raise
    expect(await Promise.all([tap(NUMBERS.a), tap(NUMBERS.a)])).toEqual([{ error: null }, { error: null }]);
    expect(created()).toHaveLength(1);
    const body = created()[0].body!;
    expect(body).toMatchObject({ amount: 74250, invoice_description: `OnSite invoice ${NUMBERS.a}`, invoice_code: "TEST_INVOICE" });
    expect(JSON.stringify(body)).not.toMatch(/QPay boss|Pty Ltd|11222333444/);   // no names, no ABN
    expect(String(body.callback_url)).toMatch(/^https:\/\/onsite\.test\/api\/qpay\/callback\/OS-[\w-]+\/[0-9a-f]{32}$/);

    const inv = await invoice(NUMBERS.a);
    expect(inv).toMatchObject({ status: "open", qpay_rate: "2250", qpay_claimed_at: null });
    expect(Number(inv.qpay_amount_mnt)).toBe(74250);
    expect(await qpayRow(inv.qpay_sender_invoice_no!)).toMatchObject({ status: "open", purpose: "onsite_invoice", amount_mnt: 74250 });
    expect((await sql`SELECT 1 FROM qpay_invoices WHERE user_id = ${ids.boss}`).length).toBe(1);

    const page = await render(NUMBERS.a);
    expect(page.parts).toContain("QpayWatch");
    expect(page.parts).not.toContain("PayWithQpay");
    expect(page.text).toEqual(expect.arrayContaining([
      "$33.00", "≈ ₮74,250 at ₮2,250 per $1", QPAY_HOW_TO, "Khan bank", `data:image/png;base64,${PNG}`,
    ]));
    expect(page.text.some((t) => t.startsWith("khanbank://q?qPay_QRcode="))).toBe(true);
    expect(page.text.some((t) => t.startsWith("https://s.qpay.mn/"))).toBe(true);
  });

  it("reuses the QR while the rate gives the same tögrög, and cancels and replaces it when the rate moves", async () => {
    as(ids.boss);
    const before = await invoice(NUMBERS.a);
    expect(await tap(NUMBERS.a)).toEqual({ error: null });
    expect(calls).toEqual([]);                                             // QPay isn't asked anything at all
    expect((await invoice(NUMBERS.a)).qpay_sender_invoice_no).toBe(before.qpay_sender_invoice_no);

    vi.stubEnv("AUD_MNT_RATE", "2300");
    const old = await qpayRow(before.qpay_sender_invoice_no!);
    expect((await render(NUMBERS.a)).parts).toContain("PayWithQpay");       // the old QR isn't shown at a rate it doesn't match
    expect(await tap(NUMBERS.a)).toEqual({ error: null });
    // cancelled first, checked for money second (a cancelled invoice can't take any), and only then a new one
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /auth/token", `DELETE /invoice/${old.qpay_invoice_id}`, "POST /payment/check", "POST /invoice"]);
    expect(checks()[0].body).toMatchObject({ object_type: "INVOICE", object_id: old.qpay_invoice_id });
    expect(created()[0].body).toMatchObject({ amount: 75900 });

    const after = await invoice(NUMBERS.a);
    expect(after.qpay_sender_invoice_no).not.toBe(before.qpay_sender_invoice_no);
    expect(after).toMatchObject({ qpay_rate: "2300", status: "open" });
    expect(Number(after.qpay_amount_mnt)).toBe(75900);
    expect(await qpayRow(before.qpay_sender_invoice_no!)).toMatchObject({ status: "cancelled", qr: null });
    expect(await qpayRow(after.qpay_sender_invoice_no!)).toMatchObject({ status: "open", amount_mnt: 75900 });
  });

  it("marks the invoice paid when QPay's callback confirms it, tells the boss once, and a second callback changes nothing", async () => {
    as(ids.boss);
    vi.stubEnv("AUD_MNT_RATE", "2300");
    const { qpay_sender_invoice_no: sender } = await invoice(NUMBERS.a);
    const q = await qpayRow(sender!);
    paidRows[q.qpay_invoice_id] = paidInFull(q, "PAY-8701");

    const res = await nudge(sender!);
    expect([res.status, await res.text()]).toEqual([200, "SUCCESS"]);
    const paid = await invoice(NUMBERS.a);
    expect(paid).toMatchObject({ status: "paid", paid_note: "QPay payment PAY-8701" });
    expect(paid.paid_at).toBeTruthy();
    expect(await qpayRow(sender!)).toMatchObject({ status: "paid", payment_id: "PAY-8701", paid_amount_mnt: 75900, qr: null });
    expect(await told(ids.boss, NUMBERS.a)).toEqual([{ kind: "invoice_paid", body: `Invoice ${NUMBERS.a} paid — thanks.`, shift_id: null }]);

    await sql`UPDATE qpay_invoices SET last_checked_at = NULL WHERE sender_invoice_no = ${sender}`;   // not even the throttle in the way
    const again = await nudge(sender!);
    expect([again.status, await again.text()]).toEqual([200, "SUCCESS"]);
    expect((await invoice(NUMBERS.a)).paid_at).toEqual(paid.paid_at);
    expect(await told(ids.boss, NUMBERS.a)).toHaveLength(1);

    const page = await render(NUMBERS.a);
    expect(page.text).toContain("QPay payment PAY-8701");
    expect(page.parts).not.toContain("PayWithQpay");
    expect(page.parts).not.toContain("QpayWatch");
    expect(await tap(NUMBERS.a)).toEqual({ error: null });                  // tapping a stale button on a paid invoice raises nothing
    expect(created()).toHaveLength(0);
  });

  it("leaves the invoice open when QPay received less than it asked for", async () => {
    as(ids.boss);
    expect(await tap(NUMBERS.b)).toEqual({ error: null });
    const { qpay_sender_invoice_no: sender } = await invoice(NUMBERS.b);
    const q = await qpayRow(sender!);
    paidRows[q.qpay_invoice_id] = paidInFull(q, "PAY-8702", 1);

    const res = await nudge(sender!);
    expect(res.status).toBe(409);                                         // not settled: QPay may try again
    expect(await invoice(NUMBERS.b)).toMatchObject({ status: "open", paid_at: null, paid_note: null });
    expect(await qpayRow(sender!)).toMatchObject({ status: "open", paid_amount_mnt: q.amount_mnt - 1 });
    expect(await told(ids.boss, NUMBERS.b)).toHaveLength(0);
  });

  it("answers the page's poll with open until QPay has the money, then paid — asking QPay at most once per 10 s", async () => {
    as(ids.boss);
    expect(await tap(NUMBERS.c)).toEqual({ error: null });
    const { qpay_sender_invoice_no: sender } = await invoice(NUMBERS.c);
    const q = await qpayRow(sender!);
    expect(q.amount_mnt).toBe(4500);                                       // $2 at 2250

    expect(await poll(NUMBERS.c)).toEqual({ code: 200, body: { status: "open" }, cache: "no-store" });
    expect(checks()).toHaveLength(1);
    paidRows[q.qpay_invoice_id] = paidInFull(q, "PAY-8703");
    expect((await poll(NUMBERS.c)).body).toEqual({ status: "open" });      // inside 10 s: QPay isn't asked again
    expect(checks()).toHaveLength(1);

    await sql`UPDATE qpay_invoices SET last_checked_at = now() - interval '11 seconds' WHERE sender_invoice_no = ${sender}`;
    expect(await poll(NUMBERS.c)).toEqual({ code: 200, body: { status: "paid" }, cache: "no-store" });
    expect(await invoice(NUMBERS.c)).toMatchObject({ status: "paid", paid_note: "QPay payment PAY-8703" });
    expect(await told(ids.boss, NUMBERS.c)).toHaveLength(1);
    expect((await poll(NUMBERS.c)).body).toEqual({ status: "paid" });
  });

  it("is settled by the cron's reconcile too, when no callback ever came", async () => {
    as(ids.boss);
    expect(await tap(NUMBERS.d)).toEqual({ error: null });
    const { qpay_sender_invoice_no: sender } = await invoice(NUMBERS.d);
    const q = await qpayRow(sender!);
    paidRows[q.qpay_invoice_id] = paidInFull(q, "PAY-8704");
    await sql`UPDATE qpay_invoices SET created_at = now() - interval '5 minutes' WHERE sender_invoice_no = ${sender}`;   // old enough for the sweep

    await reconcileOpenInvoices(50);
    expect(await invoice(NUMBERS.d)).toMatchObject({ status: "paid", paid_note: "QPay payment PAY-8704" });
    expect(await told(ids.boss, NUMBERS.d)).toHaveLength(1);
  });

  it("settles a QR that was paid just before the rate moved, rather than raising a second one beside it", async () => {
    as(ids.boss);
    expect(await tap(NUMBERS.e)).toEqual({ error: null });
    const { qpay_sender_invoice_no: sender } = await invoice(NUMBERS.e);
    const q = await qpayRow(sender!);
    paidRows[q.qpay_invoice_id] = paidInFull(q, "PAY-8705");

    vi.stubEnv("AUD_MNT_RATE", "2400");
    calls = [];
    expect(await tap(NUMBERS.e)).toEqual({ error: null });
    expect(created()).toHaveLength(0);
    expect(await invoice(NUMBERS.e)).toMatchObject({ status: "paid", paid_note: "QPay payment PAY-8705", qpay_sender_invoice_no: sender });
    expect(await told(ids.boss, NUMBERS.e)).toHaveLength(1);
  });

  it("still lets a person mark one paid by hand — and says a QPay invoice is still open for it", async () => {
    as(ids.boss);
    expect(await tap(NUMBERS.f)).toEqual({ error: null });
    const { qpay_sender_invoice_no: sender } = await invoice(NUMBERS.f);
    expect(await markInvoicePaid(NUMBERS.f, "Cash at the site office")).toMatchObject({ ok: true, qpayStillOpen: sender });
    expect(await invoice(NUMBERS.f)).toMatchObject({ status: "paid", paid_note: "Cash at the site office" });

    // If the boss pays the QR anyway, the money is recorded on the QPay row but the invoice keeps its own note,
    // and the boss isn't told twice.
    const q = await qpayRow(sender!);
    paidRows[q.qpay_invoice_id] = paidInFull(q, "PAY-8706");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await (await nudge(sender!)).text()).toBe("SUCCESS");
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining("wasn't open"), sender);
    quiet.mockRestore();
    expect(await qpayRow(sender!)).toMatchObject({ status: "paid" });
    expect(await invoice(NUMBERS.f)).toMatchObject({ paid_note: "Cash at the site office" });
    expect(await told(ids.boss, NUMBERS.f)).toHaveLength(0);
  });
});
