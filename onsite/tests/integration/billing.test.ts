/**
 * What the boss pays, through the real actions against a real DB (needs DATABASE_URL): who counts as an
 * introduction, when a match becomes billable, and how a period turns into an invoice.
 *
 * Everyone here is ours alone: +614000088xx (90xx session, 91xx home, 92xx posts, 93xx beta, 94xx consent,
 * 95xx recheck, 96xx licences, 97xx–98xx otp, 99xx alerts/bugs), on sites at Mount Isa so no seeded worker
 * and no other file's worker is ever in range. Self-cleaning.
 *
 * The cron's billing run walks every boss, so it must not touch anyone else's: a boss whose trial end was
 * never set — which is every boss another test file inserts straight into the table — is not due, and the
 * seeded ones are three days off. Only the bosses this file deliberately makes due are picked up.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as boss from "@/actions/boss";
import * as worker from "@/actions/worker";
import * as auth from "@/actions/auth";
import { sql } from "@/lib/db";
import {
  bossBilling, cancelSubscription, closeBillingPeriods, closePeriod, invoiceWithLines, listInvoices,
  markInvoicePaid, payToolsAllowed, startSubscription, unbilledIntroduction,
} from "@/lib/invoicing";
import { addMonths, trialDays } from "@/lib/subscription";
import { GET as exportCsv } from "@/app/boss/pay/export/route";
import Pay from "@/app/boss/pay/page";

const PHONES = {
  boss: "+61400008801", onboard: "+61400008802", trial: "+61400008803", period: "+61400008804",
  cancel: "+61400008805", lapsed: "+61400008806", gst: "+61400008807", numbers: "+61400008808",
  w1: "+61400008811", w2: "+61400008812", w3: "+61400008813", w4: "+61400008814",
  w5: "+61400008815", w6: "+61400008816", w7: "+61400008817", w8: "+61400008818",
};
const EVERYONE = Object.values(PHONES);
const MOUNT_ISA = { lat: -20.7256, lng: 139.4927 };
const DAY = 24 * 60 * 60 * 1000;

const as = (id: string) => { process.env.TEST_USER_ID = id; };
const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => f.append(k, x)); return f; };
/** Run an action that ends in redirect() and swallow the redirect; anything else still throws. */
const swallow = async <T,>(fn: () => Promise<T>) => {
  try { return await fn(); } catch (e) {
    if (!String((e as { digest?: string })?.digest ?? (e as Error)?.message).includes("NEXT_REDIRECT")) throw e;
    return null;
  }
};
/** Every component name in a rendered element tree — enough to say which screen came back. */
const partsOf = (node: unknown, out: string[] = []): string[] => {
  if (Array.isArray(node)) { for (const n of node) partsOf(n, out); return out; }
  if (!node || typeof node !== "object") return out;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type) out.push(typeof el.type === "function" ? (el.type as { name: string }).name : String(el.type));
  if (el.props) for (const v of Object.values(el.props)) partsOf(v, out);
  return out;
};

describe.skipIf(!process.env.DATABASE_URL)("billing: introductions, match fees and invoices", () => {
  const ids: Record<string, string> = {};
  let site = "", offset = 40;                     // days well clear of every other file's shifts

  const clearPostLimits = () => sql`DELETE FROM rate_limits WHERE key = ANY(${Object.values(ids).map((i) => `shift-post:${i}`)})`;

  /** A day nobody else is using, with every worker of ours free on it. */
  const nextDay = async () => {
    const [{ d }] = await sql<{ d: string }[]>`SELECT (CURRENT_DATE + ${offset++}::int)::text AS d`;
    const workers = ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"].map((k) => ({ worker_id: ids[k], day: d, status: "free" }));
    await sql`INSERT INTO availability ${sql(workers, "worker_id", "day", "status")} ON CONFLICT (worker_id, day) DO UPDATE SET status = 'free'`;
    return d;
  };

  /** Post one shift as a boss and hand back its id. `direct` books one named worker: never an introduction. */
  const post = async (bossId: string, day: string, direct?: string) => {
    as(bossId);
    await clearPostLimits();
    await swallow(() => boss.createShift(fd({
      project_id: site, day, start_time: "06:30", hours: "8", spots: "1", role: "General labourer",
      rate: "40", note: "Billing test", ...(direct ? { direct_worker_id: direct } : {}),
    })));
    const [s] = await sql<{ id: string }[]>`SELECT id FROM shifts WHERE boss_id = ${bossId} AND day = ${day} ORDER BY created_at DESC LIMIT 1`;
    return s.id;
  };

  /** The whole ordinary path: boss posts, worker takes it. Returns the booking. */
  const bookThrough = async (bossId: string, workerId: string, direct?: boolean) => {
    const day = await nextDay();
    const shiftId = await post(bossId, day, direct ? workerId : undefined);
    as(workerId);
    await swallow(() => worker.takeShift(shiftId));
    const [b] = await sql<{ id: string }[]>`SELECT id FROM bookings WHERE shift_id = ${shiftId} AND worker_id = ${workerId}`;
    return { shiftId, bookingId: b?.id, day };
  };

  const approve = async (bossId: string, bookingId: string, hours: number) => {
    as(bossId);
    await boss.approveHours(fd({ booking_id: bookingId, hours: String(hours) }));
  };

  const intro = async (bossId: string, workerId: string) =>
    (await sql<{ via: string; first_booking_id: string | null; billed_at: string | null; billed_booking_id: string | null; invoice_line_id: string | null }[]>`
      SELECT via, first_booking_id, billed_at, billed_booking_id, invoice_line_id
      FROM introductions WHERE boss_id = ${bossId} AND worker_id = ${workerId}`)[0] ?? null;

  const introCount = async (bossId: string, workerId: string) =>
    (await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM introductions WHERE boss_id = ${bossId} AND worker_id = ${workerId}`)[0].n;

  /** Put a boss straight into the billing state a test needs, so nothing has to wait a month. */
  const setBilling = (bossId: string, p: { status: string; trialEnds?: Date | null; start?: Date | null; end?: Date | null }) =>
    sql`UPDATE bosses SET subscription_status = ${p.status},
          trial_ends_at = ${p.trialEnds === undefined ? sql`trial_ends_at` : p.trialEnds},
          period_started_at = ${p.start === undefined ? sql`period_started_at` : p.start},
          period_ends_at = ${p.end === undefined ? sql`period_ends_at` : p.end},
          subscription_cancelled_at = NULL
        WHERE user_id = ${bossId}`;

  beforeAll(async () => {
    await sql`DELETE FROM users WHERE phone = ANY(${EVERYONE})`;    // bosses, sites, shifts, bookings, introductions, invoices all cascade
    const person = async (phone: string, name: string, role: "boss" | "worker") =>
      (await sql<{ id: string }[]>`INSERT INTO users (phone, name, role) VALUES (${phone}, ${name}, ${role}) RETURNING id`)[0].id;

    for (const key of ["boss", "trial", "period", "cancel", "lapsed", "gst", "numbers"] as const) {
      ids[key] = await person(PHONES[key], `Billing ${key}`, "boss");
      await sql`INSERT INTO bosses (user_id, company, abn, trial_ends_at, period_started_at, period_ends_at)
                VALUES (${ids[key]}, ${`Billing ${key} Pty Ltd`}, '11222333444', now() + interval '3 days', now() + interval '3 days', now() + interval '33 days')`;
    }
    const [p] = await sql<{ id: string }[]>`INSERT INTO projects (boss_id, name, address, location)
      VALUES (${ids.boss}, 'Billing Site', 'Mount Isa QLD', ST_SetSRID(ST_MakePoint(${MOUNT_ISA.lng}, ${MOUNT_ISA.lat}),4326)::geography) RETURNING id`;
    site = p.id;

    let n = 0;
    for (const key of ["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"] as const) {
      ids[key] = await person(PHONES[key], `Billing Worker ${++n}`, "worker");
      await sql`INSERT INTO workers (user_id, home, home_label, radius_km, tickets, invite_code)
        VALUES (${ids[key]}, ST_SetSRID(ST_MakePoint(${MOUNT_ISA.lng + 0.01}, ${MOUNT_ISA.lat}),4326)::geography, 'Mount Isa', 25, '{WC}', ${`BILL${n}`})`;
    }
  });

  afterAll(async () => {
    await clearPostLimits();
    await sql`DELETE FROM users WHERE phone = ANY(${EVERYONE})`;
    await sql.end();
  });

  // ───────────────────────────────────────────────────────────── who counts as an introduction

  it("writes an introduction when OnSite found the worker, and never when the boss already knew them", async () => {
    // Found in the pool: an introduction.
    const taken = await bookThrough(ids.boss, ids.w1);
    expect(await intro(ids.boss, ids.w1)).toMatchObject({ via: "match", first_booking_id: taken.bookingId, billed_at: null });

    // Booked straight to one named worker ("Book again"): the boss already knew them.
    await bookThrough(ids.boss, ids.w2, true);
    expect(await intro(ids.boss, ids.w2)).toBeNull();

    // Typed into Workers off a phone number: not OnSite finding anyone.
    as(ids.boss);
    await swallow(() => boss.addCrewByPhone(fd({ phone: "0" + PHONES.w3.slice(3) })));
    expect(await sql`SELECT 1 FROM crew WHERE boss_id = ${ids.boss} AND worker_id = ${ids.w3}`).toHaveLength(1);
    expect(await intro(ids.boss, ids.w3)).toBeNull();
  });

  it("writes one for a deal either side agreed to", async () => {
    const day = await nextDay();
    const shiftId = await post(ids.boss, day);
    as(ids.w4);
    expect(await worker.makeOffer(fd({ shift_id: shiftId, rate: "45", message: "I can start at 7" }))).toMatchObject({ ok: true });
    const [o] = await sql<{ id: string }[]>`SELECT id FROM offers WHERE shift_id = ${shiftId} AND worker_id = ${ids.w4}`;
    as(ids.boss);
    expect(await boss.acceptOffer(o.id)).toMatchObject({ ok: true });
    expect(await intro(ids.boss, ids.w4)).toMatchObject({ via: "offer", billed_at: null });
  });

  it("writes nothing new for 'same again tomorrow' — that shift goes to one named worker", async () => {
    const first = await bookThrough(ids.boss, ids.w5);
    await approve(ids.boss, first.bookingId, 8);
    const before = await intro(ids.boss, ids.w5);
    as(ids.boss);
    await swallow(() => boss.sameAgainTomorrow(first.bookingId));
    const [clone] = await sql<{ id: string; direct_worker_id: string }[]>`
      SELECT id, direct_worker_id FROM shifts WHERE boss_id = ${ids.boss} AND direct_worker_id = ${ids.w5} ORDER BY created_at DESC LIMIT 1`;
    expect(clone.direct_worker_id).toBe(ids.w5);
    expect(await introCount(ids.boss, ids.w5)).toBe(1);
    expect(await intro(ids.boss, ids.w5)).toMatchObject({ first_booking_id: before!.first_booking_id });
  });

  it("keeps one row per pair however many shifts they do together", async () => {
    const before = await intro(ids.boss, ids.w1);
    const again = await bookThrough(ids.boss, ids.w1);
    expect(again.bookingId).toBeTruthy();
    expect(await introCount(ids.boss, ids.w1)).toBe(1);
    expect(await intro(ids.boss, ids.w1)).toMatchObject({ first_booking_id: before!.first_booking_id });   // still the first
  });

  // ───────────────────────────────────────────────────────────── when the $2 lands

  it("bills the match on the first approved shift, once, and never again", async () => {
    const first = await sql<{ id: string }[]>`
      SELECT b.id FROM bookings b JOIN shifts s ON s.id = b.shift_id
      WHERE s.boss_id = ${ids.boss} AND b.worker_id = ${ids.w1} ORDER BY b.created_at LIMIT 1`;
    await approve(ids.boss, first[0].id, 8);
    const billed = await intro(ids.boss, ids.w1);
    expect(billed!.billed_at).toBeTruthy();
    expect(billed!.billed_booking_id).toBe(first[0].id);

    // Approving the same shift again — a correction — doesn't bill a second time, and doesn't un-bill it.
    await approve(ids.boss, first[0].id, 7);
    expect((await intro(ids.boss, ids.w1))!.billed_at).toStrictEqual(billed!.billed_at);

    // Even correcting it down to nothing leaves the match billed: the introduction still happened.
    await approve(ids.boss, first[0].id, 0);
    expect((await intro(ids.boss, ids.w1))!.billed_at).toStrictEqual(billed!.billed_at);

    // Nor does the next shift with the same worker: repeat shifts are free forever.
    const second = await bookThrough(ids.boss, ids.w1);
    await approve(ids.boss, second.bookingId, 8);
    expect(await intro(ids.boss, ids.w1)).toMatchObject({ billed_at: billed!.billed_at, billed_booking_id: first[0].id });
  });

  it("bills nothing for a shift approved at no hours", async () => {
    const rained = await bookThrough(ids.boss, ids.w6);
    await approve(ids.boss, rained.bookingId, 0);
    expect((await intro(ids.boss, ids.w6))!.billed_at).toBeNull();
    expect(await unbilledIntroduction(ids.boss, ids.w6)).toBe(true);

    // and still bills on the first shift that is worth something
    const worked = await bookThrough(ids.boss, ids.w6);
    await approve(ids.boss, worked.bookingId, 6);
    expect((await intro(ids.boss, ids.w6))!.billed_booking_id).toBe(worked.bookingId);
    expect(await unbilledIntroduction(ids.boss, ids.w6)).toBe(false);
  });

  it("still bills an introduced pair when the boss books them directly next time", async () => {
    await bookThrough(ids.boss, ids.w7);                      // OnSite found them; no hours approved yet
    expect((await intro(ids.boss, ids.w7))!.billed_at).toBeNull();
    const direct = await bookThrough(ids.boss, ids.w7, true); // now booked straight to them
    await approve(ids.boss, direct.bookingId, 8);
    expect((await intro(ids.boss, ids.w7))!.billed_booking_id).toBe(direct.bookingId);
  });

  // ───────────────────────────────────────────────────────────── the trial

  it("puts a brand new boss on a three-day free trial", async () => {
    const [u] = await sql<{ id: string }[]>`INSERT INTO users (phone) VALUES (${PHONES.onboard}) RETURNING id`;
    as(u.id);
    await swallow(() => auth.completeOnboarding(fd({ role: "boss", name: "Onboard Boss", company: "Onboard Pty Ltd", privacy: "yes" })));
    const b = await bossBilling(u.id);
    expect(b).toMatchObject({ subscription_status: "trialing" });
    const days = (new Date(b!.trial_ends_at!).getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(trialDays() - 0.1);
    expect(days).toBeLessThan(trialDays() + 0.1);
    expect(await payToolsAllowed(u.id)).toMatchObject({ allowed: true });   // the pay tools work from minute one
  });

  it("starts the subscription and sends the first invoice when the trial runs out", async () => {
    const trialEnd = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await setBilling(ids.trial, { status: "trialing", trialEnds: trialEnd, start: null, end: null });
    // one match, billed while the trial was still running
    await sql`INSERT INTO introductions (boss_id, worker_id, via, billed_at) VALUES (${ids.trial}, ${ids.w8}, 'match', ${new Date(Date.now() - 3 * 60 * 60 * 1000)})`;

    const counts = await closeBillingPeriods();
    expect(counts.trials_ended).toBeGreaterThanOrEqual(1);

    const b = await bossBilling(ids.trial);
    expect(b).toMatchObject({ subscription_status: "active" });
    expect(new Date(b!.period_started_at!).toISOString()).toBe(trialEnd.toISOString());
    expect(new Date(b!.period_ends_at!).toISOString()).toBe(addMonths(trialEnd, 1).toISOString());

    const [inv] = await listInvoices(ids.trial);
    expect(inv).toBeTruthy();
    const { lines } = (await invoiceWithLines(inv.number))!;
    expect(lines.map((l) => l.kind).sort()).toEqual(["match", "subscription"]);
    expect(inv.total_cents).toBe(3300 + 200);                 // this month in advance + the trial's one match
    expect((await intro(ids.trial, ids.w8))!.invoice_line_id).toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────── closing a period

  it("bills exactly the period's own matches, plus next month in advance", async () => {
    const start = new Date(Date.now() - 31 * DAY), end = new Date(Date.now() - 60 * 1000);
    await setBilling(ids.period, { status: "active", start, end });
    // two inside the period, one after it — the third belongs to the period that has just begun
    await sql`INSERT INTO introductions (boss_id, worker_id, via, billed_at) VALUES
      (${ids.period}, ${ids.w1}, 'match', ${new Date(Date.now() - 20 * DAY)}),
      (${ids.period}, ${ids.w2}, 'offer', ${new Date(Date.now() - 2 * DAY)}),
      (${ids.period}, ${ids.w3}, 'match', ${new Date(Date.now() + 60 * 1000)})`;

    const r = await closePeriod(ids.period);
    expect(r.invoiced).toBeTruthy();
    const { lines } = (await invoiceWithLines(r.invoiced!.number))!;
    expect(lines.filter((l) => l.kind === "match").map((l) => l.worker_id).sort()).toEqual([ids.w1, ids.w2].sort());
    expect(lines.filter((l) => l.kind === "subscription")).toHaveLength(1);
    expect(r.invoiced!.total_cents).toBe(3300 + 2 * 200);
    expect((await intro(ids.period, ids.w3))!.invoice_line_id).toBeNull();   // waits for the next invoice

    // the period moved on by exactly a month, from where the last one ended
    const b = await bossBilling(ids.period);
    expect(new Date(b!.period_started_at!).toISOString()).toBe(end.toISOString());
    expect(new Date(b!.period_ends_at!).toISOString()).toBe(addMonths(end, 1).toISOString());
  });

  it("does nothing at all when the same period is closed again", async () => {
    const before = await listInvoices(ids.period);
    expect(await closePeriod(ids.period)).toMatchObject({ closed: false, invoiced: null });
    expect(await listInvoices(ids.period)).toHaveLength(before.length);
  });

  it("makes no invoice for nothing: a last period with no matches and no next month", async () => {
    const start = new Date(Date.now() - 31 * DAY), end = new Date(Date.now() - 60 * 1000);
    await setBilling(ids.cancel, { status: "active", start, end });
    expect(await cancelSubscription(ids.cancel)).toBe(true);
    expect((await bossBilling(ids.cancel))!.subscription_status).toBe("cancelling");

    const r = await closePeriod(ids.cancel);
    expect(r).toMatchObject({ lapsed: true, invoiced: null });               // nothing to charge for, so no record of one
    expect(await listInvoices(ids.cancel)).toHaveLength(0);
    expect((await bossBilling(ids.cancel))!.subscription_status).toBe("lapsed");
  });

  it("charges a cancelling boss for the matches they made, but never for the month ahead", async () => {
    const start = new Date(Date.now() - 31 * DAY), end = new Date(Date.now() - 60 * 1000);
    await setBilling(ids.lapsed, { status: "active", start, end });
    await sql`INSERT INTO introductions (boss_id, worker_id, via, billed_at) VALUES (${ids.lapsed}, ${ids.w4}, 'match', ${new Date(Date.now() - 5 * DAY)})`;
    await cancelSubscription(ids.lapsed);

    const r = await closePeriod(ids.lapsed);
    expect(r.lapsed).toBe(true);
    const { lines } = (await invoiceWithLines(r.invoiced!.number))!;
    expect(lines.map((l) => l.kind)).toEqual(["match"]);                     // no subscription line
    expect(r.invoiced!.total_cents).toBe(200);
  });

  it("invoices at once when a lapsed boss starts again, from a period beginning now", async () => {
    expect((await bossBilling(ids.lapsed))!.subscription_status).toBe("lapsed");
    const before = (await listInvoices(ids.lapsed)).length;
    const r = await startSubscription(ids.lapsed);
    expect(r.invoiced).toBeTruthy();
    expect((await invoiceWithLines(r.invoiced!.number))!.lines.map((l) => l.kind)).toEqual(["subscription"]);
    expect(await listInvoices(ids.lapsed)).toHaveLength(before + 1);

    const b = await bossBilling(ids.lapsed);
    expect(b!.subscription_status).toBe("active");
    expect(new Date(b!.period_ends_at!).getTime() - new Date(b!.period_started_at!).getTime()).toBeGreaterThan(27 * DAY);
    // and starting again on top of a running subscription changes nothing
    expect(await startSubscription(ids.lapsed)).toMatchObject({ closed: false, invoiced: null });
  });

  // ───────────────────────────────────────────────────────────── what the subscription gates

  it("holds the pay run and the export behind the subscription, and nothing else", async () => {
    const payScreen = async (bossId: string) => { as(bossId); return partsOf(await Pay({ searchParams: Promise.resolve({}) })); };
    const csv = async (bossId: string) => { as(bossId); return exportCsv(new Request("http://onsite.invalid/boss/pay/export")); };

    for (const key of ["trial", "lapsed"] as const) expect((await bossBilling(ids[key]))!.subscription_status).toBe("active");
    expect(await payScreen(ids.trial)).not.toContain("Upsell");
    expect((await csv(ids.trial)).status).toBe(200);

    await setBilling(ids.gst, { status: "lapsed", trialEnds: new Date(Date.now() - 40 * DAY) });
    expect(await payScreen(ids.gst)).toContain("Upsell");
    const blocked = await csv(ids.gst);
    expect(blocked.status).toBe(307);
    expect(blocked.headers.get("location")).toMatch(/\/boss\/pay$/);

    // a boss still on the free trial has the lot
    await setBilling(ids.gst, { status: "trialing", trialEnds: new Date(Date.now() + 2 * DAY) });
    expect(await payScreen(ids.gst)).not.toContain("Upsell");
    expect((await csv(ids.gst)).status).toBe(200);

    // and so does one who is on the way out but still inside the period they paid for
    await setBilling(ids.gst, { status: "cancelling", start: new Date(Date.now() - DAY), end: new Date(Date.now() + 10 * DAY) });
    expect(await payScreen(ids.gst)).not.toContain("Upsell");
    expect((await csv(ids.gst)).status).toBe(200);
  });

  // ───────────────────────────────────────────────────────────── the invoices themselves

  it("numbers invoices uniquely, counting up within the year", async () => {
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) {
      await setBilling(ids.numbers, { status: "active", start: new Date(Date.now() - (40 + i) * DAY), end: new Date(Date.now() - (9 + i) * DAY) });
      const r = await closePeriod(ids.numbers);
      if (r.invoiced) numbers.push(r.invoiced.number);
    }
    expect(numbers.length).toBeGreaterThanOrEqual(3);
    expect(new Set(numbers).size).toBe(numbers.length);
    const year = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" }).slice(0, 4);
    for (const n of numbers) expect(n).toMatch(new RegExp(`^OS-${year}-\\d{6}$`));
    const seq = numbers.map((n) => Number(n.slice(-6)));
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(seq[seq.length - 1] - seq[0]).toBe(seq.length - 1);               // consecutive, no gaps
  });

  it("shows GST inside the total only when OnSite is registered for it", async () => {
    const closeOne = async () => {
      await setBilling(ids.gst, { status: "active", start: new Date(Date.now() - 31 * DAY), end: new Date(Date.now() - 60 * 1000) });
      return (await closePeriod(ids.gst)).invoiced!;
    };

    vi.stubEnv("GST_REGISTERED", "1");
    const withGst = await closeOne();
    expect(withGst.total_cents).toBe(3300);
    expect(withGst.gst_cents).toBe(300);                                     // one eleventh, already inside the $33
    expect(withGst.subtotal_cents + withGst.gst_cents).toBe(withGst.total_cents);

    vi.stubEnv("GST_REGISTERED", "");
    const without = await closeOne();
    expect(without.total_cents).toBe(3300);                                  // the boss pays the same either way
    expect(without.gst_cents).toBe(0);
    expect(without.subtotal_cents).toBe(3300);
    vi.unstubAllEnvs();
  });

  it("marks an invoice paid by hand, and says so plainly about one it doesn't know", async () => {
    const [inv] = await listInvoices(ids.trial);
    expect(inv.status).toBe("open");

    const paid = await markInvoicePaid(inv.number, "Transfer, cleared today");
    expect(paid).toMatchObject({ ok: true });
    const after = (await invoiceWithLines(inv.number))!.invoice;
    expect(after).toMatchObject({ status: "paid", paid_note: "Transfer, cleared today" });
    expect(after.paid_at).toBeTruthy();

    expect(await markInvoicePaid(inv.number, null)).toMatchObject({ ok: false, reason: "already_paid" });
    expect(await markInvoicePaid("OS-2099-000001", null)).toMatchObject({ ok: false, reason: "unknown" });
  });
});
