/**
 * The record, against a real database (needs DATABASE_URL): the numbers workerRecord and bossRecord put on
 * the two Me screens, the once-a-day rule on who looked at a profile, and the line that matters most — a boss
 * never sees what a worker earned.
 *
 * Everyone here is ours alone: +614000084xx (85xx–86xx passkeys, 87xx QPay, 88xx billing, 90xx session,
 * 91xx home, 92xx posts, 93xx beta, 94xx consent, 95xx recheck, 96xx licences, 97xx–98xx otp, 99xx alerts),
 * on a site at Mount Isa so no seeded worker and no other file's worker is ever near it. Self-cleaning.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { sql } from "@/lib/db";
import { bossRecord, workerRecord, workerRecordForBoss } from "@/lib/profileStats";
import { todayIso } from "@/lib/util";

const PHONES = { boss: "+61400008401", mate: "+61400008402", worker: "+61400008403", other: "+61400008404" };
const EVERYONE = Object.values(PHONES);
const RATE = 50;                                   // $50/h: every dollar below is a round, checkable number

describe.skipIf(!process.env.DATABASE_URL)("the record", () => {
  const id: Record<keyof typeof PHONES, string> = { boss: "", mate: "", worker: "", other: "" };
  let siteA = "", siteB = "";

  const clean = () => sql`DELETE FROM users WHERE phone = ANY(${EVERYONE})`;   // everything else cascades

  const person = async (key: keyof typeof PHONES, name: string, role: "boss" | "worker") => {
    const [u] = await sql<{ id: string }[]>`INSERT INTO users (phone, name, role) VALUES (${PHONES[key]}, ${name}, ${role}) RETURNING id`;
    if (role === "boss") await sql`INSERT INTO bosses (user_id, company) VALUES (${u.id}, ${name + " Pty"})`;
    else await sql`INSERT INTO workers (user_id, invite_code) VALUES (${u.id}, ${"TSTREC" + u.id.slice(0, 6)})`;
    id[key] = u.id;
  };

  const site = async (name: string) => (await sql<{ id: string }[]>`
    INSERT INTO projects (boss_id, name, address, location)
    VALUES (${id.boss}, ${name}, 'Mount Isa', ST_SetSRID(ST_MakePoint(139.4927, -20.7256),4326)::geography)
    RETURNING id`)[0].id;

  /** A shift posted two days before it runs, so "time to fill" has something to measure. */
  const shift = async (project: string, daysAgo: number, role: string) => (await sql<{ id: string }[]>`
    INSERT INTO shifts (project_id, boss_id, day, start_time, hours, spots, role, rate, created_at)
    VALUES (${project}, ${id.boss}, CURRENT_DATE - ${daysAgo}::int, '06:30', 8, 1, ${role}, ${RATE},
            ((CURRENT_DATE - ${daysAgo + 2}::int) + time '09:00') AT TIME ZONE 'Australia/Sydney')
    RETURNING id`)[0].id;

  /** `late` is minutes either side of the agreed start; null means they never clocked in. */
  const book = (shiftId: string, workerId: string, o: { status: string; worked?: number | null; approved?: number | null; late?: number | null; disputed?: boolean }) => sql`
    INSERT INTO bookings (shift_id, worker_id, status, hours_worked, hours_approved, clock_in_at, disputed_at, created_at)
    SELECT ${shiftId}, ${workerId}, ${o.status}, ${o.worked ?? null}, ${o.approved ?? null},
      ${o.late == null ? null : sql`((s.day + s.start_time) AT TIME ZONE 'Australia/Sydney') + (${o.late}::int * interval '1 minute')`},
      ${o.disputed ? sql`now()` : null},
      s.created_at + interval '30 minutes'
    FROM shifts s WHERE s.id = ${shiftId}`;

  beforeAll(async () => {
    await clean();
    await person("boss", "Record Boss", "boss");
    await person("other", "Other Boss", "boss");
    await person("mate", "Record Worker", "worker");
    await person("worker", "Record Mate", "worker");
    siteA = await site("Record Site A");
    siteB = await site("Record Site B");

    // Four worked shifts, one they pulled out of; two sites; one set of hours they disagreed with.
    await book(await shift(siteA, 10, "Formwork"), id.mate, { status: "approved", worked: 8, approved: 8, late: 5 });
    await book(await shift(siteA, 9, "Formwork"), id.mate, { status: "paid", worked: 9.5, approved: 9, late: 30, disputed: true });
    await book(await shift(siteA, 8, "Concreting"), id.mate, { status: "clocked_out", worked: 4, late: 0 });
    await book(await shift(siteA, 7, "Formwork"), id.mate, { status: "cancelled" });
    await book(await shift(siteB, 6, "Concreting"), id.mate, { status: "approved", worked: 6, approved: 6, late: 10 });
    // A second worker, so "your regulars" has an order to it
    await book(await shift(siteB, 5, "Formwork"), id.worker, { status: "approved", worked: 8, approved: 8, late: 0 });
    await sql`INSERT INTO crew (boss_id, worker_id, rate) VALUES (${id.boss}, ${id.mate}, ${RATE})`;
  });

  afterAll(async () => {
    await clean();
    await sql.end();
  });

  it("counts a worker's hours, shifts, sites and earnings the way the tiles show them", async () => {
    const r = await workerRecord(id.mate);
    // Approved hours where there are any, the worker's own where there aren't: 8 + 9 + 4 + 6.
    expect(r.tiles.all).toEqual({ hours: 27, shifts: 4, sites: 2, earned: 1175 });   // 400 + 475 (an hour of overtime) + 300
    expect(r.tiles.year.shifts).toBe(4);                                             // every fixture shift is this year
    expect(r.shifts).toBe(4);
    expect(r.history).toHaveLength(4);
    expect(r.owed).toHaveLength(2);
    expect(r.rehires).toBe(1);                                                       // in this boss's crew
    expect(r.trades).toEqual([{ role: "Formwork", hours: 17 }, { role: "Concreting", hours: 10 }]);
  });

  it("reads reliability the way a boss will", async () => {
    const { reliability: rel, days, weeks } = await workerRecord(id.mate);
    expect(rel).toEqual({ showed: 4, past: 5, onTime: 3, clockIns: 4, pulled: 1, disagreed: 1, ofWorked: 4 });
    expect(days).toBe(4);                                                            // the shift they pulled out of isn't a day on the tools
    expect(weeks).toHaveLength(52);
  });

  it("counts a boss's shifts, hours, wages, workers and hiring pulse", async () => {
    const r = await bossRecord(id.boss);
    expect(r.company).toBe("Record Boss Pty");
    expect(r.tiles.all).toEqual({ shifts: 5, hours: 31, wages: 1575, workers: 2 });
    expect(r.days).toBe(5);                                                          // five days with somebody on site
    expect(r.regulars).toEqual([
      { id: id.mate, name: "Record Worker", hours: 27 },
      { id: id.worker, name: "Record Mate", hours: 8 },
    ]);
    expect(r.disputes).toEqual({ n: 1, of: 4 });
    expect(r.pulse).toMatchObject({ spots: 6, taken: 5, shifts: 6, fillMin: 30, noShows: 1, pastShifts: 6, returning: 3, bookings: 5 });
  });

  it("wages by site are this month's only, and name the boss's own sites", async () => {
    const r = await bossRecord(id.boss);
    const thisMonth = (await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM shifts WHERE boss_id = ${id.boss} AND to_char(day, 'YYYY-MM') = ${todayIso().slice(0, 7)}`)[0].n;
    // Fixture days land inside this month unless the run is in the first ten days of one; either is right.
    if (thisMonth === 6) expect(r.sites.map((s) => s.name).sort()).toEqual(["Record Site A", "Record Site B"]);
    else expect(r.sites.every((s) => s.name.startsWith("Record Site"))).toBe(true);
  });

  it("the same boss looking twice in a day is one look, and two bosses are two", async () => {
    const day = todayIso();
    // The same statement app/boss/workers/[id]/page.tsx runs after the response.
    const look = (boss: string) => sql`INSERT INTO profile_views (boss_id, worker_id, day)
                                       VALUES (${boss}, ${id.mate}, ${day}) ON CONFLICT DO NOTHING`;
    await look(id.boss);
    await look(id.boss);
    expect((await sql`SELECT 1 FROM profile_views WHERE worker_id = ${id.mate}`).length).toBe(1);
    expect((await workerRecord(id.mate)).lookers).toBe(1);

    await look(id.other);
    expect((await workerRecord(id.mate)).lookers).toBe(2);

    // A look from long enough ago has dropped out of "this week"
    await sql`UPDATE profile_views SET day = CURRENT_DATE - 8 WHERE worker_id = ${id.mate} AND boss_id = ${id.other}`;
    expect((await workerRecord(id.mate)).lookers).toBe(1);
  });

  it("the boss's view of a worker is the same record with no money anywhere in it", async () => {
    const own = await workerRecord(id.mate);
    const view = await workerRecordForBoss(id.mate);

    // Same figures…
    expect(view.hours).toBe(own.hours);
    expect(view.shifts).toBe(own.shifts);
    expect(view.sites).toBe(own.sites);
    expect(view.trades).toEqual(own.trades);
    expect(view.reliability).toEqual(own.reliability);
    expect(view.days).toBe(own.days);
    expect(view.rehires).toBe(own.rehires);

    // …and nothing that could add up to a wage.
    for (const k of ["tiles", "history", "owed", "gross", "licences", "lookers", "phone", "invite_code", "mates"])
      expect(Object.keys(view)).not.toContain(k);
    const json = JSON.stringify(view);
    for (const secret of [String(own.tiles.all.earned), "1175", "475", String(RATE) + ".00", "Record Boss"])
      expect(json, secret).not.toContain(secret);
  });

  it("the boss's worker page records the look itself, after the response, and only when there is a worker", () => {
    const src = fs.readFileSync("app/boss/workers/[id]/page.tsx", "utf8");
    expect(src).toMatch(/after\(\(\) => sql`INSERT INTO profile_views/);
    expect(src).toMatch(/ON CONFLICT DO NOTHING/);
    // the insert comes after the 404, so a profile that doesn't exist is never recorded as looked at
    expect(src.indexOf("if (!w) notFound();")).toBeLessThan(src.indexOf("INSERT INTO profile_views"));
  });
});
