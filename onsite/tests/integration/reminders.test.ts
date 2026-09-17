/**
 * Shift reminders (lib/reminders.ts, migration 018) against a real DB (needs DATABASE_URL).
 * Own +614000082xx numbers, self-cleaning.
 *
 * The cron lands whenever it lands, so every rule here is a window wider than one 20-minute gap and the
 * unique index is what stops a second pass repeating itself. These tests run overlapping passes on purpose.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { sql } from "@/lib/db";
import { remindShifts, bossWords, eveWords, soonWords, nextShiftWords } from "@/lib/reminders";
import { alertFor, SMS_KINDS } from "@/lib/alerts";

const PHONES = { boss: "+61400008201", worker: "+61400008202", quitter: "+61400008203" };
const ids: Record<string, string> = {};
let project = "";

/** A day, and an instant, both fixed: reminders are about Sydney's clock, not the test runner's. */
const DAY = "2026-11-04";                                   // a Wednesday
const EVE = new Date("2026-11-03T07:20:00Z");               // 6:20pm Sydney on the 3rd (Sydney is UTC+11 in November)
const AFTERNOON = new Date("2026-11-03T04:00:00Z");         // 3pm Sydney on the 3rd — too early for the evening pass
const START = "06:30";

const notes = (userKey: string, kind: string) =>
  sql`SELECT body, urgent, shift_id FROM notifications WHERE user_id = ${ids[userKey]} AND kind = ${kind}`;

async function makeShift(opts: { spots?: number; postId?: string | null } = {}) {
  const [s] = await sql`
    INSERT INTO shifts (post_id, project_id, boss_id, day, start_time, hours, spots, role, tickets_required, rate)
    VALUES (${opts.postId ?? null}, ${project}, ${ids.boss}, ${DAY}::date, ${START}::time, 8, ${opts.spots ?? 1}, 'Steel fixer', '{WC}', 42)
    RETURNING id`;
  return s.id as string;
}
const book = (shiftId: string, who: string, status = "accepted") =>
  sql`INSERT INTO bookings (shift_id, worker_id, status) VALUES (${shiftId}, ${ids[who]}, ${status})
      ON CONFLICT (shift_id, worker_id) DO UPDATE SET status = EXCLUDED.status`;

describe.skipIf(!process.env.DATABASE_URL)("shift reminders", () => {
  const clean = async () => {
    await sql`DELETE FROM projects WHERE name = 'Reminder fixture site'`;
    await sql`DELETE FROM users WHERE phone = ANY(${Object.values(PHONES)})`;
  };

  beforeEach(async () => {
    await clean();
    for (const [k, phone] of Object.entries(PHONES))
      ids[k] = (await sql`INSERT INTO users (phone, name, role, last_seen_at) VALUES (${phone}, ${`Reminder ${k} fixture`}, ${k === "boss" ? "boss" : "worker"}, now()) RETURNING id`)[0].id;
    await sql`INSERT INTO bosses (user_id, company) VALUES (${ids.boss}, 'Reminder Fixtures')`;
    for (const k of ["worker", "quitter"])
      await sql`INSERT INTO workers (user_id, home, home_label, radius_km, tickets, invite_code)
                VALUES (${ids[k]}, ST_SetSRID(ST_MakePoint(151.1400, -33.9000),4326)::geography, 'Dulwich Hill', 25, '{WC}', ${"RM" + k.slice(0, 4).toUpperCase()})`;
    const [p] = await sql`INSERT INTO projects (boss_id, name, address, location)
      VALUES (${ids.boss}, 'Reminder fixture site', '550 Parramatta Rd, Petersham', ST_SetSRID(ST_MakePoint(151.1550, -33.8935),4326)::geography) RETURNING id`;
    project = p.id;
  });
  afterAll(async () => { await clean(); await sql.end(); });

  it("each reminder fires exactly once across three overlapping passes", async () => {
    const shift = await makeShift({ spots: 1 });
    await book(shift, "worker");

    const passes = [await remindShifts(EVE), await remindShifts(new Date(EVE.getTime() + 20 * 60_000)), await remindShifts(new Date(EVE.getTime() + 40 * 60_000))];
    expect(passes.map((p) => p.eve)).toEqual([1, 0, 0]);
    expect(passes.map((p) => p.boss)).toEqual([1, 0, 0]);
    expect(passes.every((p) => p.soon === 0)).toBe(true);           // the start is half a day away

    const [eve] = await notes("worker", "reminder_eve");
    expect(eve.body).toMatch(/^Tomorrow 6:30am · Steel fixer at Reminder fixture site · [\d.]+ km from home$/);
    expect(eve.urgent).toBe(false);
    expect((await notes("boss", "tomorrow")).length).toBe(1);
  });

  it("nothing goes out before six in the evening, Sydney time", async () => {
    const shift = await makeShift();
    await book(shift, "worker");
    expect(await remindShifts(AFTERNOON)).toEqual({ eve: 0, soon: 0, boss: 0 });
    expect(await remindShifts(EVE)).toMatchObject({ eve: 1, boss: 1 });
  });

  it("the morning reminder only fires inside its window, and only once", async () => {
    const shift = await makeShift();
    await book(shift, "worker");
    const startUtc = Date.parse("2026-11-03T19:30:00Z");             // 6:30am Sydney on the 4th
    const at = (minsBefore: number) => new Date(startUtc - minsBefore * 60_000);

    expect((await remindShifts(at(90))).soon).toBe(0);               // too early
    expect((await remindShifts(at(80))).soon).toBe(1);               // the far edge of the window
    expect((await remindShifts(at(70))).soon).toBe(0);               // already sent
    expect((await remindShifts(at(30))).soon).toBe(0);

    await sql`DELETE FROM notifications WHERE user_id = ${ids.worker} AND kind = 'reminder_soon'`;
    expect((await remindShifts(at(59))).soon).toBe(0);               // past the near edge: nothing new
    expect((await remindShifts(at(60))).soon).toBe(1);

    const [soon] = await notes("worker", "reminder_soon");
    expect(soon.body).toBe("Starts in an hour · Reminder fixture site · Clock in when you're at the gate");
    expect(soon.urgent).toBe(false);
  });

  it("a worker who pulled out, and a cancelled shift, get nothing", async () => {
    const shift = await makeShift({ spots: 2 });
    await book(shift, "worker");
    await book(shift, "quitter", "cancelled");
    await remindShifts(EVE);
    expect((await notes("quitter", "reminder_eve")).length).toBe(0);
    expect((await notes("worker", "reminder_eve")).length).toBe(1);

    const other = await makeShift();
    await book(other, "quitter");
    await sql`UPDATE shifts SET status = 'cancelled' WHERE id = ${other}`;
    await sql`DELETE FROM notifications WHERE user_id = ${ids.quitter}`;
    await remindShifts(new Date(EVE.getTime() + 60 * 60_000));
    expect((await notes("quitter", "reminder_eve")).length).toBe(0);
  });

  it("the boss gets one line per job, and an unfilled one is the orange kind", async () => {
    const post = (await sql`SELECT gen_random_uuid() AS id`)[0].id as string;
    const a = await makeShift({ spots: 2, postId: post });
    await makeShift({ spots: 1, postId: post });                     // second line of the same job
    await book(a, "worker");

    expect((await remindShifts(EVE)).boss).toBe(1);                  // one job, one reminder
    const [note] = await notes("boss", "tomorrow");
    expect(note.body).toBe("2 spots still open at Reminder fixture site tomorrow · 6:30am start · 1 of 3 booked");
    expect(note.urgent).toBe(true);
    expect(note.shift_id).toBe(a);                                   // filed under the job's first line
    expect(alertFor({ id: "x", kind: "tomorrow", body: note.body, shift_id: a, role: "boss", urgent: note.urgent }))
      .toMatchObject({ urgent: true, url: `/boss/shifts/${a}` });
  });

  it("a full job is information, not attention", async () => {
    const shift = await makeShift({ spots: 1 });
    await book(shift, "worker");
    await remindShifts(EVE);
    const [note] = await notes("boss", "tomorrow");
    expect(note.body).toBe("Tomorrow 6:30am at Reminder fixture site · 1 of 1 booked");
    expect(note.urgent).toBe(false);
    expect(alertFor({ id: "x", kind: "tomorrow", body: note.body, shift_id: shift, role: "boss", urgent: false }).urgent).toBe(false);
  });

  it("a reminder is never a text, and goes to the right screen", () => {
    for (const kind of ["reminder_eve", "reminder_soon", "tomorrow"]) expect(SMS_KINDS.has(kind)).toBe(false);
    for (const kind of ["reminder_eve", "reminder_soon"])
      expect(alertFor({ id: "n", kind, body: "b", shift_id: "s", role: "worker" }).url).toBe("/worker/shift");
  });

  it("the words, on their own", () => {
    expect(eveWords({ start_time: "06:30", role: "Steel fixer", site: "Parramatta Rd", dist_m: 3100 }))
      .toBe("Tomorrow 6:30am · Steel fixer at Parramatta Rd · 3.1 km from home");
    expect(eveWords({ start_time: "06:30", role: "Steel fixer", site: "Parramatta Rd", dist_m: null }))
      .toBe("Tomorrow 6:30am · Steel fixer at Parramatta Rd");
    expect(soonWords({ site: "Parramatta Rd" })).toBe("Starts in an hour · Parramatta Rd · Clock in when you're at the gate");
    expect(bossWords({ start_time: "06:30", site: "Parramatta Rd", spots: 3, taken: 3 })).toBe("Tomorrow 6:30am at Parramatta Rd · 3 of 3 booked");
    expect(bossWords({ start_time: "06:30", site: "Parramatta Rd", spots: 3, taken: 2 })).toBe("1 spot still open at Parramatta Rd tomorrow · 6:30am start · 2 of 3 booked");
    // The card at the top of worker home.
    expect(nextShiftWords({ day: "2026-11-04", start_time: "06:30", site: "Parramatta Rd", dist_m: 3100 }, "2026-11-03"))
      .toBe("Tomorrow 6:30am · Parramatta Rd · 3.1 km");
    expect(nextShiftWords({ day: "2026-11-03", start_time: "06:30", site: "Parramatta Rd", dist_m: null }, "2026-11-03"))
      .toBe("Today 6:30am · Parramatta Rd");
  });
});
