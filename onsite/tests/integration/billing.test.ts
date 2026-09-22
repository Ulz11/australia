/**
 * What the boss pays, through the real actions against a real DB (needs DATABASE_URL): who counts as an
 * introduction, when a match becomes billable, and how a period turns into an invoice.
 *
 * Everyone here is ours alone: +614000088xx (90xx session, 91xx home, 92xx posts, 93xx beta, 94xx consent,
 * 95xx recheck, 96xx licences, 97xx–98xx otp, 99xx alerts/bugs), on sites at Mount Isa so no seeded worker
 * and no other file's worker is ever in range. Self-cleaning.
 *
 * The cron's billing run walks every boss, so it must not touch anyone else's: a boss whose period end was
 * never set — which is every boss another test file inserts straight into the table — is not due, and the
 * seeded ones are three days off. Only the bosses this file deliberately makes due are picked up.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as boss from "@/actions/boss";
import * as worker from "@/actions/worker";
import * as auth from "@/actions/auth";
import { sql } from "@/lib/db";
import {
  bossBilling, closeBillingPeriods, closePeriod, invoiceWithLines, listInvoices,
  markInvoicePaid, unbilledIntroduction,
} from "@/lib/invoicing";
import { FORTNIGHT_DAYS, addDays } from "@/lib/subscription";
import { GET as exportCsv } from "@/app/boss/pay/export/route";
import Pay from "@/app/boss/pay/page";

const PHONES = {
  boss: "+61400008801", onboard: "+61400008802", first: "+61400008803", period: "+61400008804",
  quiet: "+61400008805", open: "+61400008806", gst: "+61400008807", numbers: "+61400008808",
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

  /** Put a boss's fortnight where a test needs it, so nothing has to wait fourteen days. */
  const setBilling = (bossId: string, p: { start: Date | null; end: Date | null }) =>
    sql`UPDATE bosses SET period_started_at = ${p.start}, period_ends_at = ${p.end} WHERE user_id = ${bossId}`;

  /** One introduction, already billable, at a moment of the test's choosing. */
  const billed = (bossId: string, workerId: string, at: Date) =>
    sql`INSERT INTO introductions (boss_id, worker_id, via, billed_at) VALUES (${bossId}, ${workerId}, 'match', ${at})`;

  beforeAll(async () => {
    await sql`DELETE FROM users WHERE phone = ANY(${EVERYONE})`;    // bosses, sites, shifts, bookings, introductions, invoices all cascade
    const person = async (phone: string, name: string, role: "boss" | "worker") =>
      (await sql<{ id: string }[]>`INSERT INTO users (phone, name, role) VALUES (${phone}, ${name}, ${role}) RETURNING id`)[0].id;

    for (const key of ["boss", "first", "period", "quiet", "open", "gst", "numbers"] as const) {
      ids[key] = await person(PHONES[key], `Billing ${key}`, "boss");
      await sql`INSERT INTO bosses (user_id, company, abn, period_started_at, period_ends_at)
                VALUES (${ids[key]}, ${`Billing ${key} Pty Ltd`}, '11222333444', now() - interval '11 days', now() + interval '3 days')`;
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

    // Brought in by the boss off a phone number: not OnSite finding anyone.
    as(ids.boss);
    expect(await boss.importCrew("0" + PHONES.w3.slice(3))).toMatchObject({ ok: true, added: 1, invited: 0 });
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

  // ──────────────────────────────────────────────────────── the fortnight a boss is on

  it("opens a fortnight the moment an account becomes a boss — nothing to try, nothing to lapse", async () => {
    const [u] = await sql<{ id: string }[]>`INSERT INTO users (phone) VALUES (${PHONES.onboard}) RETURNING id`;
    as(u.id);
    await swallow(() => auth.completeOnboarding(fd({ role: "boss", name: "Onboard Boss", company: "Onboard Pty Ltd", privacy: "yes" })));
    const b = await bossBilling(u.id);
    expect(b).toBeTruthy();

    // The period starts now and runs exactly fourteen days. There is no trial end and no status, because
    // there is nothing to try and nothing to be in: the first invoice only exists if somebody is introduced.
    const start = new Date(b!.period_started_at!);
    expect(Math.abs(start.getTime() - Date.now())).toBeLessThan(60_000);
    expect(new Date(b!.period_ends_at!).getTime() - start.getTime()).toBe(FORTNIGHT_DAYS * DAY);
    expect(await listInvoices(u.id)).toHaveLength(0);
  });

  it("sends the first invoice when the fortnight ends, through the cron's own sweep", async () => {
    const end = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await setBilling(ids.first, { start: addDays(end, -FORTNIGHT_DAYS), end });
    await billed(ids.first, ids.w8, new Date(Date.now() - 3 * 60 * 60 * 1000));

    // Another test file may call the cron at the same moment (recheck.test.ts hits the route) and close this
    // fortnight first; the sweep is idempotent, so assert the end state rather than which run got there.
    await closeBillingPeriods();

    const b = await bossBilling(ids.first);
    expect(new Date(b!.period_started_at!).toISOString()).toBe(end.toISOString());
    expect(new Date(b!.period_ends_at!).toISOString()).toBe(addDays(end, FORTNIGHT_DAYS).toISOString());

    const [inv] = await listInvoices(ids.first);
    expect(inv).toBeTruthy();
    const { lines } = (await invoiceWithLines(inv.number))!;
    expect(lines.map((l) => l.kind)).toEqual(["match"]);       // introductions are the only kind of line there is
    expect(inv.total_cents).toBe(200);
    expect((await intro(ids.first, ids.w8))!.invoice_line_id).toBeTruthy();
  });

  // ───────────────────────────────────────────────────────────── closing a fortnight

  it("bills exactly the fortnight's own introductions, and moves on by another fourteen days", async () => {
    const end = new Date(Date.now() - 60 * 1000), start = addDays(end, -FORTNIGHT_DAYS);
    await setBilling(ids.period, { start, end });
    // Two inside the fortnight, one after it — the third belongs to the fortnight that has just begun.
    // The straggler is a second PAST `end`, not a minute in the future: it has to be outside this fortnight
    // and already behind us, or the next test's cut-off would have to wait for the clock to catch up to it.
    await billed(ids.period, ids.w1, new Date(Date.now() - 10 * DAY));
    await billed(ids.period, ids.w2, new Date(Date.now() - 2 * DAY));
    await billed(ids.period, ids.w3, new Date(end.getTime() + 1000));

    const r = await closePeriod(ids.period);
    expect(r).toMatchObject({ closed: true });
    const { lines } = (await invoiceWithLines(r.invoiced!.number))!;
    expect(lines.map((l) => l.worker_id).sort()).toEqual([ids.w1, ids.w2].sort());
    expect(lines.every((l) => l.kind === "match")).toBe(true);
    expect(r.invoiced!.total_cents).toBe(2 * 200);
    expect((await intro(ids.period, ids.w3))!.invoice_line_id).toBeNull();   // waits for the next invoice

    const b = await bossBilling(ids.period);
    expect(new Date(b!.period_started_at!).toISOString()).toBe(end.toISOString());
    expect(new Date(b!.period_ends_at!).toISOString()).toBe(addDays(end, FORTNIGHT_DAYS).toISOString());
  });

  it("does nothing at all when the same fortnight is closed again", async () => {
    const before = await listInvoices(ids.period);
    expect(await closePeriod(ids.period)).toMatchObject({ closed: false, invoiced: null });
    expect(await listInvoices(ids.period)).toHaveLength(before.length);
  });

  it("picks the straggler up on the next invoice, once its own fortnight is over", async () => {
    // End this one a second ago: past, so closePeriod will act on it, and later than the straggler's
    // billed_at, so `matchLines` picks it up. `matchLines` has no lower bound — that is what stops an
    // introduction that missed its own invoice being forgotten rather than merely being late.
    const b = await bossBilling(ids.period);
    await setBilling(ids.period, { start: new Date(b!.period_started_at!), end: new Date(Date.now() - 1000) });

    const r = await closePeriod(ids.period);
    expect(r.closed).toBe(true);
    const { lines } = (await invoiceWithLines(r.invoiced!.number))!;
    expect(lines.map((l) => l.worker_id)).toEqual([ids.w3]);   // the one that missed the last invoice, billed once
    expect((await intro(ids.period, ids.w3))!.invoice_line_id).toBeTruthy();
  });

  it("writes no invoice at all for a quiet fortnight, but still moves the fortnight on", async () => {
    const end = new Date(Date.now() - 60 * 1000);
    await setBilling(ids.quiet, { start: addDays(end, -FORTNIGHT_DAYS), end });

    // `closed` and `invoiced` are separate for exactly this case: a boss who was introduced to nobody owes
    // nothing, and an empty invoice is not a record of anything. A caller reading "no invoice" as "nothing
    // happened" would close this same fortnight again on the next run.
    const r = await closePeriod(ids.quiet);
    expect(r).toMatchObject({ closed: true, invoiced: null });
    expect(await listInvoices(ids.quiet)).toHaveLength(0);
    expect(new Date((await bossBilling(ids.quiet))!.period_ends_at!).toISOString())
      .toBe(addDays(end, FORTNIGHT_DAYS).toISOString());
  });

  // ─────────────────────────────────────────────── what the price gates: nothing

  it("opens the pay run and the export to every boss, whatever they owe", async () => {
    const payScreen = async (bossId: string) => { as(bossId); return partsOf(await Pay({ searchParams: Promise.resolve({}) })); };
    const csv = async (bossId: string) => { as(bossId); return exportCsv(new Request("http://onsite.invalid/boss/pay/export")); };

    // Nothing switches off, ever — so there is no upsell to render and no gate to bounce off. Not for a boss
    // whose fortnight has just closed, and not for one with an invoice still sitting open and overdue.
    for (const key of ["first", "open", "quiet"] as const) {
      expect(await payScreen(ids[key])).not.toContain("Upsell");
      expect((await csv(ids[key])).status).toBe(200);
    }

    await sql`UPDATE invoices SET due_at = now() - interval '40 days' WHERE boss_id = ${ids.first} AND status = 'open'`;
    expect(await payScreen(ids.first)).not.toContain("Upsell");
    expect((await csv(ids.first)).status).toBe(200);
  });

  // ───────────────────────────────────────────────────────────── the invoices themselves

  it("numbers invoices uniquely, counting up within the year", async () => {
    const numbers: string[] = [];
    // One introduction per fortnight, because an invoice only exists where there is something to charge for.
    for (const [i, w] of (["w1", "w2", "w3"] as const).entries()) {
      const end = new Date(Date.now() - (9 + i) * DAY);
      await setBilling(ids.numbers, { start: addDays(end, -FORTNIGHT_DAYS), end });
      await billed(ids.numbers, ids[w], addDays(end, -1));
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
    /** A fortnight with two introductions in it: $4.00 all up, whichever way GST falls. */
    const closeOne = async (pair: readonly ["w4" | "w6", "w5" | "w7"]) => {
      const end = new Date(Date.now() - 60 * 1000);
      await setBilling(ids.gst, { start: addDays(end, -FORTNIGHT_DAYS), end });
      for (const w of pair) await billed(ids.gst, ids[w], addDays(end, -1));
      return (await closePeriod(ids.gst)).invoiced!;
    };

    vi.stubEnv("GST_REGISTERED", "1");
    const withGst = await closeOne(["w4", "w5"]);
    expect(withGst.total_cents).toBe(400);
    expect(withGst.gst_cents).toBe(36);                                      // one eleventh of $4.00, already inside it
    expect(withGst.subtotal_cents + withGst.gst_cents).toBe(withGst.total_cents);

    vi.stubEnv("GST_REGISTERED", "");
    const without = await closeOne(["w6", "w7"]);
    expect(without.total_cents).toBe(400);                                   // the boss pays the same either way
    expect(without.gst_cents).toBe(0);
    expect(without.subtotal_cents).toBe(400);
    vi.unstubAllEnvs();
  });

  it("marks an invoice paid by hand, and says so plainly about one it doesn't know", async () => {
    const [inv] = await listInvoices(ids.first);
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
