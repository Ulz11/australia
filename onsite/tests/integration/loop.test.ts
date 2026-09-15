/**
 * Integration: the whole core loop through the real server actions against a seeded DB.
 *   DATABASE_URL=… npm run db:seed && npm test
 * Skips itself when DATABASE_URL is not set.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import * as boss from "@/actions/boss";
import * as worker from "@/actions/worker";
import { sql } from "@/lib/db";
import { runMatchingRound, findCandidates } from "@/lib/matching";
import { payForDay } from "@/lib/award";

const as = (id: string) => { process.env.TEST_USER_ID = id; };
const swallowRedirect = async <T,>(fn: () => Promise<T>) => { try { return await fn(); } catch (e: any) { if (String(e?.digest || e?.message).includes("NEXT_REDIRECT")) return null; throw e; } };
function ok(cond: unknown, msg: string) { expect(cond, msg).toBeTruthy(); }
const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => f.append(k, x)); return f; };

describe.skipIf(!process.env.DATABASE_URL)("core loop: post → match → take → clock → approve → pay", () => {
  const created: string[] = [];
  // Seed only gives Dave a shift tomorrow; anything of his 3+ days out is ours from an earlier run.
  beforeAll(async () => {
    await sql`DELETE FROM shifts WHERE day >= CURRENT_DATE + 3 AND boss_id = (SELECT id FROM users WHERE phone = '+61400000001')`;
    await sql`DELETE FROM blocks WHERE boss_id = (SELECT id FROM users WHERE phone = '+61400000001')`;
  });
  afterAll(async () => {
    if (created.length) await sql`DELETE FROM shifts WHERE id = ANY(${created})`;
    await sql.end();
  });

  it("walks the whole loop with the real actions", async () => {
      const [dave] = await sql`SELECT id FROM users WHERE phone = '+61400000001'`;
    const [bat] = await sql`SELECT id FROM users WHERE phone = '+61400000101'`;
    const [pemba] = await sql`SELECT id FROM users WHERE phone = '+61400000111'`; // Auburn, too far
    const [site] = await sql`SELECT id FROM projects WHERE boss_id = ${dave.id} ORDER BY name LIMIT 1`;
    const [{ day }] = await sql`SELECT (CURRENT_DATE + 3)::text AS day`;

    // 1. Boss posts a 2-spot forklift shift.
    as(dave.id);
    await swallowRedirect(() => boss.createShift(fd({ project_id: site.id, day, start_time: "06:30", hours: "8", spots: "2", role: "Forklift driver", tickets: ["LF"], rate: "30" })));
    const [sh] = await sql`SELECT * FROM shifts WHERE boss_id = ${dave.id} AND day = ${day} AND role = 'Forklift driver'`;
    ok(sh, "shift created");
    ok(Number(sh.rate) === 35.55, `rate floored to Award ($${sh.rate})`);
    ok(sh.tickets_required.includes("WC") && sh.tickets_required.includes("LF"), "White Card always required + LF");

    // 2. Matching: only LF holders, free that day, within radius, not blocked.
    const notified = await sql`SELECT n.user_id, w.tickets, u.name FROM notifications n JOIN workers w ON w.user_id = n.user_id JOIN users u ON u.id = n.user_id WHERE n.shift_id = ${sh.id} AND n.kind = 'shift_match'`;
    ok(notified.length > 0 && notified.length <= 6, `round 1 notified ${notified.length} (≤ 3 × 2 spots): ${notified.map((n) => n.name.split(" ")[0]).join(", ")}`);
    ok(notified.every((n) => n.tickets.includes("LF")), "everyone notified holds LF");
    ok(!notified.some((n) => n.user_id === pemba.id), "Pemba (Auburn, no LF) not notified");
    const free = await sql`SELECT a.worker_id FROM availability a WHERE a.day = ${day} AND a.status = 'free' AND a.worker_id = ANY(${notified.map((n) => n.user_id)})`;
    ok(free.length === notified.length, "everyone notified is free that day");
    const more = await findCandidates(sh.id, 50);
    console.log(`  (${more.length} more in the pool for later rounds)`);

    // Blocked worker never appears.
    const [someone] = await sql`SELECT user_id FROM workers WHERE user_id = ANY(${more.map((m) => m.user_id)}) LIMIT 1`;
    if (someone) {
      await sql`INSERT INTO blocks (boss_id, worker_id, by_role) VALUES (${dave.id}, ${someone.user_id}, 'boss')`;
      const after = await findCandidates(sh.id, 50);
      ok(!after.some((c) => c.user_id === someone.user_id), "blocked worker drops out of the pool");
      await sql`DELETE FROM blocks WHERE boss_id = ${dave.id} AND worker_id = ${someone.user_id}`;
    }

    // 3. Worker takes it (Batbayar has LF; ensure he's free that day).
    as(bat.id);
    await worker.setAvailability(day, "busy");
    const r1 = await swallowRedirect(() => worker.takeShift(sh.id));
    ok(r1 === null, "Batbayar takes it even from a 'busy' day (clear, not strict)");
    const [av] = await sql`SELECT status FROM availability WHERE worker_id = ${bat.id} AND day = ${day}`;
    ok(av.status === "free", "his day flipped to free");
    const dup = await worker.takeShift(sh.id);
    ok(dup && "error" in dup, `can't take twice: "${dup?.error}"`);
    const [bk] = await sql`SELECT * FROM bookings WHERE shift_id = ${sh.id} AND worker_id = ${bat.id}`;
    ok(bk?.status === "accepted", "booking accepted");
    const [bn] = await sql`SELECT body FROM notifications WHERE user_id = ${dave.id} AND shift_id = ${sh.id} AND kind = 'booking'`;
    ok(bn, `boss notified: "${bn?.body}"`);

    // 4. The day arrives (clock-in is refused before the day of the shift), clock in near site, clock out.
    await sql`UPDATE shifts SET day = CURRENT_DATE WHERE id = ${sh.id}`;
    const [loc] = await sql`SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM projects WHERE id = ${site.id}`;
    await worker.clockIn(bk.id, loc.lat + 0.001, loc.lng);
    const [ci] = await sql`SELECT status, clock_in_dist_m FROM bookings WHERE id = ${bk.id}`;
    ok(ci.status === "clocked_in" && ci.clock_in_dist_m < 300, `clocked in ${ci.clock_in_dist_m} m from site (green)`);
    await sql`UPDATE bookings SET clock_in_at = now() - interval '8 hours 30 minutes' WHERE id = ${bk.id}`;
    await worker.clockOut(bk.id);
    const [co] = await sql`SELECT status, hours_worked FROM bookings WHERE id = ${bk.id}`;
    ok(co.status === "clocked_out" && Number(co.hours_worked) === 8.5, `clocked out, ${co.hours_worked}h recorded`);

    // 5. Boss approves 8h (edit), worker lands in crew, sees the edit, can disagree.
    as(dave.id);
    await boss.approveHours(fd({ booking_id: bk.id, hours: "8" }));
    const [ap] = await sql`SELECT status, hours_approved, hours_worked FROM bookings WHERE id = ${bk.id}`;
    ok(ap.status === "approved" && Number(ap.hours_approved) === 8 && Number(ap.hours_worked) === 8.5, "approved 8h; recorded 8.5h kept alongside");
    const [cr] = await sql`SELECT type, rate FROM crew WHERE boss_id = ${dave.id} AND worker_id = ${bat.id}`;
    ok(cr?.type === "casual" && Number(cr.rate) === 35.55, "Batbayar auto-added to Dave's casual crew at shift rate");
    const [hn] = await sql`SELECT body FROM notifications WHERE user_id = ${bat.id} AND shift_id = ${sh.id} AND kind = 'hours_approved'`;
    ok(hn?.body.includes("you recorded 8.5h"), `worker told about the edit: "${hn?.body}"`);
    as(bat.id);
    await worker.disagree(bk.id);
    const [dn] = await sql`SELECT body FROM notifications WHERE user_id = ${dave.id} AND shift_id = ${sh.id} AND kind = 'dispute'`;
    ok(dn, `boss told to call: "${dn?.body}"`);

    // 6. Pay maths, mark paid, worker sees paid.
    const award = payForDay(9.5, 40, "award"), flat = payForDay(9.5, 40, "flat");
    ok(award.gross === 8 * 40 + 1.5 * 40 * 1.5 && award.superAmt === Math.round(award.gross * 12) / 100, `award 9.5h @ $40 = $${award.gross} (+$${award.superAmt} super)`);
    ok(flat.gross === 380, `flat 9.5h @ $40 = $${flat.gross}`);
    as(dave.id);
    await boss.markPaid(bk.id, true);
    const [pd] = await sql`SELECT status, paid_at FROM bookings WHERE id = ${bk.id}`;
    ok(pd.status === "paid" && pd.paid_at, "marked paid");
    const [pn] = await sql`SELECT body FROM notifications WHERE user_id = ${bat.id} AND shift_id = ${sh.id} AND kind = 'paid'`;
    ok(pn, `worker sees paid: "${pn?.body}"`);

    // 7. Same again tomorrow → direct shift to Batbayar, no pool.
    const before = await sql`SELECT COUNT(*)::int AS n FROM shifts`;
    await swallowRedirect(() => boss.sameAgainTomorrow(bk.id));
    const [ns] = await sql`SELECT s.*, (SELECT COUNT(*) FROM notifications n WHERE n.shift_id = s.id)::int AS notified FROM shifts s WHERE s.direct_worker_id = ${bat.id} AND s.day = CURRENT_DATE + 1 ORDER BY s.created_at DESC LIMIT 1`;
    ok(ns && ns.notified === 1 && ns.spots === 1, "same-again shift went only to Batbayar");
    void before;

    // 8. Cancel by worker reopens + rematches.
    as(bat.id);
    await swallowRedirect(() => worker.takeShift(ns.id));
    const [nb] = await sql`SELECT id FROM bookings WHERE shift_id = ${ns.id} AND worker_id = ${bat.id}`;
    await swallowRedirect(() => worker.cancelBooking(nb.id));
    const [cs] = await sql`SELECT status FROM shifts WHERE id = ${ns.id}`;
    ok(cs.status === "open", "worker pulled out → shift back to open");
    const [st] = await sql`SELECT cancels FROM worker_stats WHERE worker_id = ${bat.id}`;
    ok(Number(st.cancels) >= 1, "cancellation on his record");

    // 9. Cron expansion picks up stale open shifts.
    await sql`UPDATE shifts SET last_notified_at = now() - interval '25 minutes' WHERE id = ${sh.id}`;
    const r = await runMatchingRound(sh.id);
    ok(r.remaining === 1, `1 spot still open after round 2 (notified ${r.notified} more)`);
    created.push(sh.id, ns.id);
    await sql`DELETE FROM crew WHERE boss_id = ${dave.id} AND worker_id = ${bat.id}`;
  }, 180_000); // ~80 round trips to the DB
});
