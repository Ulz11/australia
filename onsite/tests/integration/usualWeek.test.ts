/**
 * The usual week (migration 017): one definition of "free", read by every query that asks.
 * Against a real DB (needs DATABASE_URL). Own +614000081xx numbers, self-cleaning.
 *
 * Before this, a day nobody had tapped meant busy, so most workers were invisible to every boss most days.
 * Now a worker says which weekdays they normally work, once — and a day they answered themselves still wins.
 */
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from "vitest";
import { sql } from "@/lib/db";
import { findCandidates } from "@/lib/matching";
import { setAvailability, setUsualDays } from "@/actions/worker";

const PHONES = { pattern: "+61400008101", quiet: "+61400008102", says: "+61400008103", boss: "+61400008104" };
const ids: Record<string, string> = {};
let project = "", shiftDay = "", shift = "";

/** A Monday well clear of today, so the fixture never depends on what day the test runs. */
const MONDAY = "2026-11-02";       // ISO weekday 1
const SATURDAY = "2026-11-07";     // ISO weekday 6

const free = async (who: string, day: string) =>
  (await sql<{ f: boolean | null }[]>`SELECT worker_free(${ids[who]}, ${day}::date) AS f`)[0].f;

describe.skipIf(!process.env.DATABASE_URL)("the usual week", () => {
  const clean = async () => {
    await sql`DELETE FROM projects WHERE name = 'Usual week fixture site'`;
    await sql`DELETE FROM users WHERE phone = ANY(${Object.values(PHONES)})`;
  };

  beforeAll(async () => {
    await clean();
    for (const [k, phone] of Object.entries(PHONES)) {
      const role = k === "boss" ? "boss" : "worker";
      ids[k] = (await sql`INSERT INTO users (phone, name, role, last_seen_at) VALUES (${phone}, ${`Usual ${k} fixture`}, ${role}, now()) RETURNING id`)[0].id;
    }
    await sql`INSERT INTO bosses (user_id, company) VALUES (${ids.boss}, 'Usual Week Fixtures')`;
    for (const k of ["pattern", "quiet", "says"])
      await sql`INSERT INTO workers (user_id, home, home_label, radius_km, tickets, invite_code, usual_days)
                VALUES (${ids[k]}, ST_SetSRID(ST_MakePoint(151.155, -33.910),4326)::geography, 'Marrickville', 25, '{WC}',
                        ${"UW" + k.slice(0, 4).toUpperCase()}, '{1,2,3,4,5}')`;
    const [p] = await sql`INSERT INTO projects (boss_id, name, address, location)
      VALUES (${ids.boss}, 'Usual week fixture site', 'Marrickville', ST_SetSRID(ST_MakePoint(151.155, -33.910),4326)::geography) RETURNING id`;
    project = p.id;
    shiftDay = MONDAY;
    const [s] = await sql`INSERT INTO shifts (project_id, boss_id, day, start_time, hours, spots, role, tickets_required, rate)
      VALUES (${project}, ${ids.boss}, ${shiftDay}, '06:30', 8, 3, 'General labourer', '{WC}', 40) RETURNING id`;
    shift = s.id;
  });
  afterEach(async () => { vi.unstubAllEnvs(); });
  afterAll(async () => { await clean(); await sql.end(); });

  it("with no answer for the day, the usual week decides — and only on the weekdays in it", async () => {
    expect(await free("pattern", MONDAY)).toBe(true);
    expect(await free("pattern", SATURDAY)).toBe(false);
  });

  it("a day the worker answered themselves always wins, whichever way round", async () => {
    await sql`INSERT INTO availability (worker_id, day, status) VALUES (${ids.pattern}, ${MONDAY}, 'busy')
              ON CONFLICT (worker_id, day) DO UPDATE SET status = 'busy'`;
    expect(await free("pattern", MONDAY)).toBe(false);
    await sql`UPDATE availability SET status = 'free' WHERE worker_id = ${ids.pattern} AND day = ${SATURDAY}`;
    await sql`INSERT INTO availability (worker_id, day, status) VALUES (${ids.pattern}, ${SATURDAY}, 'free')
              ON CONFLICT (worker_id, day) DO UPDATE SET status = 'free'`;
    expect(await free("pattern", SATURDAY)).toBe(true);
    await sql`DELETE FROM availability WHERE worker_id = ${ids.pattern}`;
    expect(await free("pattern", MONDAY)).toBe(true);               // back to the usual week
  });

  it("a pattern stops after 14 quiet days, and comes back the moment they open the app", async () => {
    await sql`UPDATE users SET last_seen_at = now() - interval '15 days' WHERE id = ${ids.quiet}`;
    expect(await free("quiet", MONDAY)).toBe(false);
    await sql`UPDATE users SET last_seen_at = now() - interval '13 days 23 hours' WHERE id = ${ids.quiet}`;
    expect(await free("quiet", MONDAY)).toBe(true);
    await sql`UPDATE users SET last_seen_at = NULL WHERE id = ${ids.quiet}`;
    expect(await free("quiet", MONDAY)).toBe(false);
    // …but a day they answered themselves is still their answer, quiet or not.
    await sql`INSERT INTO availability (worker_id, day, status) VALUES (${ids.quiet}, ${MONDAY}, 'free')`;
    expect(await free("quiet", MONDAY)).toBe(true);
    await sql`DELETE FROM availability WHERE worker_id = ${ids.quiet}`;
    await sql`UPDATE users SET last_seen_at = now() WHERE id = ${ids.quiet}`;
  });

  it("an empty usual week is nobody's promise", async () => {
    await sql`UPDATE workers SET usual_days = '{}' WHERE user_id = ${ids.quiet}`;
    expect(await free("quiet", MONDAY)).toBe(false);
    await sql`UPDATE workers SET usual_days = '{1,2,3,4,5}' WHERE user_id = ${ids.quiet}`;
  });

  it("matching finds a worker on their usual week, and skips the one who said busy for that day", async () => {
    await sql`DELETE FROM availability WHERE worker_id = ANY(${[ids.pattern, ids.quiet, ids.says]})`;
    await sql`DELETE FROM notifications WHERE shift_id = ${shift}`;
    await sql`INSERT INTO availability (worker_id, day, status) VALUES (${ids.says}, ${MONDAY}, 'busy')`;
    const found = (await findCandidates(shift, 50)).map((c) => c.user_id);
    expect(found).toContain(ids.pattern);                            // never tapped a thing, still gets the offer
    expect(found).toContain(ids.quiet);
    expect(found).not.toContain(ids.says);
    await sql`DELETE FROM availability WHERE worker_id = ${ids.says}`;
  });

  it("the worker's own actions write the pattern and one day at a time, and 'clear' hands the day back", async () => {
    vi.stubEnv("TEST_USER_ID", ids.says);
    await setUsualDays([3, 1, 1, 9, 2.5, 7]);                        // deduped, sorted, and nonsense dropped
    expect((await sql`SELECT usual_days FROM workers WHERE user_id = ${ids.says}`)[0].usual_days).toEqual([1, 3, 7]);

    await setAvailability(MONDAY, "busy");
    expect(await free("says", MONDAY)).toBe(false);
    await setAvailability(MONDAY, "clear");
    expect((await sql`SELECT 1 FROM availability WHERE worker_id = ${ids.says} AND day = ${MONDAY}`).length).toBe(0);
    expect(await free("says", MONDAY)).toBe(true);                   // Monday is in the pattern again

    await setAvailability(SATURDAY, "free");
    expect(await free("says", SATURDAY)).toBe(true);
    await setAvailability("not-a-day", "free");                      // rubbish changes nothing
    await setUsualDays([1, 2, 3, 4, 5]);
  });
});
