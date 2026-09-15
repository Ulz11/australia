/**
 * Regression tests — one per bug found in the strict review. Each of these failed
 * against the code as it was. Needs DATABASE_URL + a seeded DB. Self-cleaning.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as boss from "@/actions/boss";
import * as worker from "@/actions/worker";
import * as auth from "@/actions/auth";
import { sql } from "@/lib/db";
import { bookWorker, recomputeTickets } from "@/lib/booking";

const as = (id: string) => { process.env.TEST_USER_ID = id; };
const swallow = async <T,>(fn: () => Promise<T>) => { try { return await fn(); } catch (e: unknown) { if (String((e as { digest?: string })?.digest ?? (e as Error)?.message).includes("NEXT_REDIRECT")) return null; throw e; } };
const fd = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => f.append(k, x)); return f; };

describe.skipIf(!process.env.DATABASE_URL)("regressions from the strict review", () => {
  let dave: string, bat: string, nima: string, site: string;
  let day = "";                 // each post() moves a day forward so "already booked that day" never trips
  let offset = 5;
  const made: string[] = [];

  beforeAll(async () => {
    [dave, bat, nima] = (await sql`SELECT id FROM users WHERE phone IN ('+61400000001','+61400000101','+61400000102') ORDER BY phone`).map((r) => r.id);
    site = (await sql`SELECT id FROM projects WHERE boss_id = ${dave} ORDER BY name LIMIT 1`)[0].id;
    await sql`DELETE FROM shifts WHERE boss_id = ${dave} AND day >= CURRENT_DATE + 3`;
    await sql`DELETE FROM bookings b USING shifts s WHERE s.id = b.shift_id AND s.day >= CURRENT_DATE + 3 AND b.worker_id IN (${bat}, ${nima})`;
    await sql`DELETE FROM blocks WHERE boss_id = ${dave}`;
    await sql`DELETE FROM otp_codes WHERE phone = '+61400009999'`;
  });
  afterAll(async () => {
    if (made.length) await sql`DELETE FROM shifts WHERE id = ANY(${made})`;
    await sql`DELETE FROM blocks WHERE boss_id = ${dave}`;
    await sql`DELETE FROM otp_codes WHERE phone = '+61400009999'`;
  });

  async function post(extra: Record<string, string> = {}) {
    day = (await sql`SELECT (CURRENT_DATE + ${offset++}::int)::text AS d`)[0].d;
    as(dave);
    await swallow(() => boss.createShift(fd({ project_id: site, day, start_time: "06:30", hours: "8", spots: "1", role: "General labourer", rate: "36", ...extra })));
    const [s] = await sql`SELECT id FROM shifts WHERE boss_id = ${dave} AND day = ${day} ORDER BY created_at DESC LIMIT 1`;
    made.push(s.id);
    return s.id as string;
  }

  it("saving radius no longer wipes licences from matching", async () => {
    as(bat);
    const before = (await sql`SELECT tickets FROM workers WHERE user_id = ${bat}`)[0].tickets as string[];
    expect(before).toContain("LF");
    await worker.updateMe(fd({ radius_km: "30", name: "Batbayar Erdene", visa_type: "" }));
    const after = (await sql`SELECT tickets FROM workers WHERE user_id = ${bat}`)[0].tickets as string[];
    expect(after).toEqual(before);
  });

  it("White Card stays on for matching unless a WC card was entered and failed", async () => {
    await sql`DELETE FROM licences WHERE worker_id = ${nima}`;
    await recomputeTickets(nima);
    expect((await sql`SELECT tickets FROM workers WHERE user_id = ${nima}`)[0].tickets).toEqual(["WC"]);
    // add a forklift ticket — WC must survive
    as(nima);
    await worker.saveLicence(fd({ kind: "LF", number: "LF-1", issued_state: "VIC", holder_name: "Nima Sherpa" }));
    expect((await sql`SELECT tickets FROM workers WHERE user_id = ${nima}`)[0].tickets).toEqual(["LF", "WC"]);
    // an expired WC entered explicitly knocks WC out
    await worker.saveLicence(fd({ kind: "WC", number: "1", issued_state: "VIC", holder_name: "Nima Sherpa", expires_on: "2020-01-01" }));
    expect((await sql`SELECT tickets FROM workers WHERE user_id = ${nima}`)[0].tickets).toEqual(["LF"]);
    await sql`DELETE FROM licences WHERE worker_id = ${nima}`;
    await recomputeTickets(nima);
  });

  it("two workers can't both take the last spot", async () => {
    const id = await post({ spots: "1" });
    const [r1, r2] = await Promise.all([
      bookWorker({ shiftId: id, workerId: bat, workerName: "Bat", notify: null }),
      bookWorker({ shiftId: id, workerId: nima, workerName: "Nima", notify: null }),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM bookings WHERE shift_id = ${id} AND status = 'accepted'`;
    expect(n).toBe(1);
  });

  it("a worker the boss removed can't quietly rejoin", async () => {
    const id = await post({ spots: "2" });
    as(bat); await swallow(() => worker.takeShift(id));
    const [b] = await sql`SELECT id FROM bookings WHERE shift_id = ${id} AND worker_id = ${bat}`;
    as(dave); await boss.removeBooking(b.id);
    as(bat);
    const r = await worker.takeShift(id);
    expect(r && "error" in r && r.error).toMatch(/took you off/);
  });

  it("cancelling a shift takes booked workers off it and closes open offers", async () => {
    const id = await post({ spots: "2" });
    as(bat); await swallow(() => worker.takeShift(id));
    as(nima); await worker.makeOffer(fd({ shift_id: id, rate: "40", message: "" }));
    as(dave); await swallow(() => boss.cancelShift(id));
    const [bk] = await sql`SELECT status FROM bookings WHERE shift_id = ${id} AND worker_id = ${bat}`;
    const [of] = await sql`SELECT status FROM offers WHERE shift_id = ${id} AND worker_id = ${nima}`;
    expect(bk.status).toBe("removed");
    expect(of.status).toBe("expired");
    // and it no longer shows as a live shift for the worker
    const live = await sql`SELECT 1 FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.worker_id = ${bat} AND s.id = ${id} AND b.status IN ('accepted','clocked_in')`;
    expect(live).toHaveLength(0);
  });

  it("boss counter → worker accepts, on the countered terms", async () => {
    const id = await post({ spots: "1", allow_offers: "1" });
    as(bat); await worker.makeOffer(fd({ shift_id: id, rate: "45", message: "worth it" }));
    const [o] = await sql`SELECT id FROM offers WHERE shift_id = ${id} AND worker_id = ${bat} AND status = 'pending'`;
    as(dave);
    const c = await boss.counterOffer(fd({ offer_id: o.id, rate: "40", message: "best I can do" }));
    expect(c && "ok" in c && c.ok).toBe(true);
    const [counter] = await sql`SELECT id, rate FROM offers WHERE shift_id = ${id} AND worker_id = ${bat} AND from_role = 'boss' AND status = 'pending'`;
    expect(Number(counter.rate)).toBe(40);
    as(bat); await swallow(() => worker.acceptCounter(counter.id));
    const [bk] = await sql`SELECT status, agreed_rate FROM bookings WHERE shift_id = ${id} AND worker_id = ${bat}`;
    expect(bk.status).toBe("accepted");
    expect(Number(bk.agreed_rate)).toBe(40);
  });

  it("hours approved with overtime: the worker is told the same dollars the Pay screen shows", async () => {
    const id = await post({ spots: "1", ot_mode: "custom", ot_after_hours: "8", ot_multiplier: "2" });
    as(bat); await swallow(() => worker.takeShift(id));
    const [b] = await sql`SELECT id FROM bookings WHERE shift_id = ${id} AND worker_id = ${bat}`;
    await sql`UPDATE bookings SET status = 'clocked_out', clock_in_at = now() - interval '10 hours', clock_out_at = now(), hours_worked = 10 WHERE id = ${b.id}`;
    as(dave); await boss.approveHours(fd({ booking_id: b.id, hours: "10" }));
    const [n] = await sql`SELECT body FROM notifications WHERE user_id = ${bat} AND shift_id = ${id} AND kind = 'hours_approved'`;
    // 8h × $36 + 2h × $72 = $432 — not the flat 10 × 36 = $360 it used to say
    expect(n.body).toMatch(/\$432\.00/);
  });

  it("'same again tomorrow' keeps the overtime terms and the agreed deal", async () => {
    const id = await post({ spots: "1", ot_mode: "custom", ot_after_hours: "9", ot_multiplier: "1.75" });
    as(bat); await swallow(() => worker.takeShift(id));
    const [b] = await sql`SELECT id FROM bookings WHERE shift_id = ${id} AND worker_id = ${bat}`;
    await sql`UPDATE bookings SET status = 'approved', hours_approved = 8, agreed_rate = 41 WHERE id = ${b.id}`;
    as(dave); await swallow(() => boss.sameAgainTomorrow(b.id));
    const [ns] = await sql`SELECT id, ot_mode, ot_after_hours, ot_multiplier, rate FROM shifts WHERE direct_worker_id = ${bat} AND day = ${day}::date + 1 ORDER BY created_at DESC LIMIT 1`;
    made.push(ns.id);
    expect(ns.ot_mode).toBe("custom");
    expect(Number(ns.ot_after_hours)).toBe(9);
    expect(Number(ns.ot_multiplier)).toBe(1.75);
    expect(Number(ns.rate)).toBe(41);
  });

  it("blocking a worker takes them off your upcoming shifts", async () => {
    const id = await post({ spots: "1" });
    as(bat); await swallow(() => worker.takeShift(id));
    as(dave); await swallow(() => boss.blockWorker(bat));
    const [bk] = await sql`SELECT status FROM bookings WHERE shift_id = ${id} AND worker_id = ${bat}`;
    expect(bk.status).toBe("removed");
    await sql`DELETE FROM blocks WHERE boss_id = ${dave} AND worker_id = ${bat}`;
  });

  it("a site with shifts coming up refuses to be hidden", async () => {
    await post({ spots: "1" });
    as(dave);
    let where = "";
    try { await boss.archiveProject(site); } catch (e: unknown) { where = String((e as { digest?: string }).digest ?? ""); }
    expect(where).toContain("err=");
    expect((await sql`SELECT archived FROM projects WHERE id = ${site}`)[0].archived).toBe(false);
  });

  it("garbage input returns nothing instead of a 500", async () => {
    as(dave);
    await expect(boss.approveHours(fd({ booking_id: "not-a-uuid", hours: "abc" }))).resolves.toBeUndefined();
    await expect(boss.setCrewTarget(fd({ project_id: site, crew_target: "lots" }))).resolves.toBeUndefined();
    await expect(boss.markWeather(fd({ shift_id: made[0], weather_stop: "locusts" }))).resolves.toBeUndefined();
    as(bat);
    await expect(worker.setAvailability("next tuesday", "free")).resolves.toBeUndefined();
    await expect(worker.clockIn("nope", null, null)).resolves.toMatchObject({ ok: false });
  });

  it("OTP: one code a minute per number", async () => {
    const first = await auth.requestCode({ step: "phone" }, fd({ phone: "0400009999" }));
    expect(first.step).toBe("code");
    const second = await auth.requestCode({ step: "phone" }, fd({ phone: "0400009999" }));
    expect(second.step).toBe("phone");
    expect(second.error).toMatch(/minute/);
  });
}, 240_000);

describe.skipIf(!process.env.DATABASE_URL)("matching engine after the simulation", () => {
  it("a worker with no history gets a seat in a multi-spot batch instead of being ranked last", async () => {
    const [dave] = await sql`SELECT id FROM users WHERE phone = '+61400000001'`;
    const [enkhjin] = await sql`SELECT id FROM users WHERE phone = '+61400000118'`;   // seeded as brand new, no shifts
    const [site] = await sql`SELECT id FROM projects WHERE boss_id = ${dave.id} ORDER BY name LIMIT 1`;
    const [{ day }] = await sql`SELECT (CURRENT_DATE + 20)::text AS day`;
    await sql`INSERT INTO availability (worker_id, day, status) VALUES (${enkhjin.id}, ${day}, 'free') ON CONFLICT (worker_id, day) DO UPDATE SET status = 'free'`;
    // plenty of experienced, free, nearby workers so the newbie would never make the top 6 on score alone
    process.env.TEST_USER_ID = dave.id;
    const { createShift } = await import("@/actions/boss");
    try { await createShift(fd({ project_id: site.id, day, start_time: "06:30", hours: "8", spots: "2", role: "General labourer", rate: "36" })); } catch { /* redirect */ }
    const [sh] = await sql`SELECT id, notify_round FROM shifts WHERE boss_id = ${dave.id} AND day = ${day} ORDER BY created_at DESC LIMIT 1`;
    const asked = await sql`SELECT n.user_id, COALESCE(st.past_shifts,0)::int AS past FROM notifications n LEFT JOIN worker_stats st ON st.worker_id = n.user_id WHERE n.shift_id = ${sh.id} AND n.kind = 'shift_match'`;
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.some((a) => a.past < 3)).toBe(true);          // someone new got a seat
    await sql`DELETE FROM shifts WHERE id = ${sh.id}`;
  }, 60_000);
});

afterAll(async () => { if (process.env.DATABASE_URL) await sql.end(); });
