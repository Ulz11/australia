/**
 * One job post, several kinds of worker: createShift with lines, the posting limit counted per line, matching per line,
 * and "Cancel the whole job" — through the real actions against a real DB (needs DATABASE_URL).
 *
 * Everyone here is ours alone: +614000092xx bosses and workers (90xx session, 91xx home, 93xx beta, 94xx consent, 95xx recheck, 96xx licences,
 * 97xx–98xx otp, 99xx alerts/bugs), on sites at Broken Hill so no seeded worker is ever in range and every notification
 * is one of ours. Other files clear only their own bosses' posting limits, so the counts here are exact. Self-cleaning.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as boss from "@/actions/boss";
import * as worker from "@/actions/worker";
import { sql } from "@/lib/db";
import { bookWorker } from "@/lib/booking";
import { SHIFT_POSTS_PER_HOUR } from "@/lib/ratelimit";

const PHONES = { boss: "+61400009201", other: "+61400009202", forky: "+61400009211", lab: "+61400009212", asker: "+61400009213" };
const EVERYONE = Object.values(PHONES);
const BROKEN_HILL = { lat: -31.9539, lng: 141.4675 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Fields = Record<string, string | string[]>;
type Line = { role: string; spots: number | string; rate: number | string; tickets?: string[] };
const fd = (o: Fields) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => f.append(k, x)); return f; };
/** The form's parallel arrays for these lines. */
const lineFields = (lines: Line[]): Fields => Object.assign(
  { line_role: lines.map((l) => l.role), line_spots: lines.map((l) => String(l.spots)), line_rate: lines.map((l) => String(l.rate)) },
  ...lines.map((l, i) => (l.tickets ? { [`line_tickets_${i}`]: l.tickets } : {})),
);
/** Run an action that ends in redirect() and say where it went; null when it returned instead. */
const landing = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try { await fn(); return null; } catch (e) {
    const digest = String((e as { digest?: string })?.digest ?? "");
    if (!digest.startsWith("NEXT_REDIRECT")) throw e;
    return digest.split(";")[2];
  }
};
const errOf = (to: string | null) => (to ? new URL(to, "http://onsite.invalid").searchParams.get("err") : null);

describe.skipIf(!process.env.DATABASE_URL)("one job post, several kinds of worker", () => {
  let bossId: string, other: string, site: string, otherSite: string, forky: string, lab: string, asker: string;
  let offset = 20;                           // every test gets a day of its own, well clear of other files' shifts

  const key = (id: string) => `shift-post:${id}`;
  const used = async (id = bossId) => ((await sql`SELECT hits FROM rate_limits WHERE key = ${key(id)}`)[0]?.hits ?? 0) as number;
  const setUsed = (n: number, id = bossId) => sql`INSERT INTO rate_limits (key, window_start, hits) VALUES (${key(id)}, now(), ${n})
    ON CONFLICT (key) DO UPDATE SET window_start = now(), hits = EXCLUDED.hits`;
  const nextDay = async () => {
    const [{ d }] = await sql`SELECT (CURRENT_DATE + ${offset++}::int)::text AS d`;
    await sql`INSERT INTO availability ${sql([forky, lab, asker].map((w) => ({ worker_id: w, day: d, status: "free" })), "worker_id", "day", "status")}
              ON CONFLICT (worker_id, day) DO UPDATE SET status = 'free'`;
    return d as string;
  };
  const post = (day: string, extra: Fields, as = bossId) => {
    process.env.TEST_USER_ID = as;
    return landing(() => boss.createShift(fd({ project_id: site, day, start_time: "06:30", hours: "8", note: "Posts test", ...extra })));
  };
  const shiftsOn = (day: string) => sql`
    SELECT id, post_id, role, spots, rate, tickets_required, day::text, start_time::text, hours, note, ot_mode, ot_after_hours, ot_multiplier,
           allow_offers, direct_worker_id, status, notify_round
    FROM shifts WHERE boss_id = ${bossId} AND day = ${day} ORDER BY created_at`;
  const told = async (shiftId: string) =>
    (await sql`SELECT user_id, body FROM notifications WHERE shift_id = ${shiftId} AND kind = 'shift_match' ORDER BY user_id`);

  beforeAll(async () => {
    await sql`DELETE FROM users WHERE phone = ANY(${EVERYONE})`;   // bosses, sites, shifts, workers, bookings all cascade
    const person = async (phone: string, name: string, role: "boss" | "worker") =>
      (await sql`INSERT INTO users (phone, name, role) VALUES (${phone}, ${name}, ${role}) RETURNING id`)[0].id as string;
    const bossWithSite = async (phone: string, name: string) => {
      const id = await person(phone, name, "boss");
      await sql`INSERT INTO bosses (user_id, company) VALUES (${id}, ${`${name} Co`})`;
      const [p] = await sql`INSERT INTO projects (boss_id, name, address, location)
        VALUES (${id}, ${`${name} Site`}, 'Broken Hill NSW', ST_SetSRID(ST_MakePoint(${BROKEN_HILL.lng}, ${BROKEN_HILL.lat}),4326)::geography) RETURNING id`;
      return [id, p.id as string];
    };
    const workerNearby = async (phone: string, name: string, tickets: string[], code: string) => {
      const id = await person(phone, name, "worker");
      await sql`INSERT INTO workers (user_id, home, home_label, radius_km, tickets, invite_code)
        VALUES (${id}, ST_SetSRID(ST_MakePoint(${BROKEN_HILL.lng + 0.01}, ${BROKEN_HILL.lat}),4326)::geography, 'Broken Hill', 25, ${tickets}, ${code})`;
      return id;
    };
    [bossId, site] = await bossWithSite(PHONES.boss, "Posts Boss");
    [other, otherSite] = await bossWithSite(PHONES.other, "Posts Other");
    forky = await workerNearby(PHONES.forky, "Posts Forky", ["LF", "WC"], "POSTS1");
    lab = await workerNearby(PHONES.lab, "Posts Labourer", ["WC"], "POSTS2");
    asker = await workerNearby(PHONES.asker, "Posts Asker", ["WC"], "POSTS3");
  });

  afterAll(async () => {
    await sql`DELETE FROM rate_limits WHERE key IN (${key(bossId)}, ${key(other)})`;
    await sql`DELETE FROM users WHERE phone = ANY(${EVERYONE})`;
  });

  it("three kinds of worker make three shifts sharing one post_id, each on its own terms", async () => {
    await setUsed(0);
    const day = await nextDay();
    const to = await post(day, {
      ...lineFields([
        { role: "Carpenter", spots: 2, rate: "42.50" },
        { role: "Forklift driver", spots: 1, rate: "30", tickets: ["LF"] },
        { role: "General labourer", spots: 3, rate: "", tickets: ["WC", "SB", "SB"] },
      ]),
      ot_mode: "custom", ot_after_hours: "9", ot_multiplier: "1.75", allow_offers: "0",
    });
    const rows = await shiftsOn(day);
    expect(rows).toHaveLength(3);
    expect(rows[0].post_id).toMatch(UUID);
    expect(rows.every((r) => r.post_id === rows[0].post_id)).toBe(true);
    // in the order they were written; White Card always; rates floored to the Award per line
    expect(rows.map((r) => [r.role, r.spots, Number(r.rate), r.tickets_required])).toEqual([
      ["Carpenter", 2, 42.5, ["WC"]],
      ["Forklift driver", 1, 35.55, ["WC", "LF"]],
      ["General labourer", 3, 35.55, ["WC", "SB"]],
    ]);
    // everything else is set once for the job
    for (const r of rows) {
      expect([r.day, r.start_time, Number(r.hours), r.note, r.ot_mode, Number(r.ot_after_hours), Number(r.ot_multiplier), r.allow_offers, r.direct_worker_id, r.status])
        .toEqual([day, "06:30:00", 8, "Posts test", "custom", 9, 1.75, false, null, "open"]);
    }
    expect(to).toBe(`/boss/shifts/${rows[0].id}`);   // the first line's page
    expect(await used()).toBe(3);                     // one post, three lines, three off the hourly limit
  });

  it("each line gets its own first round: the forklift line reaches only LF holders, the labourer line doesn't need LF", async () => {
    await setUsed(0);
    const day = await nextDay();
    await post(day, lineFields([{ role: "General labourer", spots: 1, rate: 38 }, { role: "Forklift driver", spots: 1, rate: 45, tickets: ["LF"] }]));
    const [labouring, forklift] = await shiftsOn(day);
    expect([labouring.notify_round, forklift.notify_round]).toEqual([1, 1]);

    const forkliftTold = await told(forklift.id);
    expect(forkliftTold.map((n) => n.user_id)).toEqual([forky]);
    expect(forkliftTold[0].body).toMatch(/^Forklift driver at Posts Boss Site .* \$45\.00\/h$/);
    const holders = await sql`SELECT tickets FROM workers WHERE user_id = ANY(${forkliftTold.map((n) => n.user_id)})`;
    expect(holders.every((w) => w.tickets.includes("LF"))).toBe(true);

    const labouringTold = (await told(labouring.id)).map((n) => n.user_id);
    expect(labouringTold).toEqual(expect.arrayContaining([lab, asker]));   // no LF, still asked: 1 spot × 3
    expect(labouringTold).toHaveLength(3);

    process.env.TEST_USER_ID = lab;                                          // and the take-it gate agrees, per line
    expect(await worker.takeShift(forklift.id)).toEqual({ error: "You need: LF" });
  });

  it("a post that doesn't add up is refused whole: nothing inserted, nothing spent", async () => {
    await setUsed(5);
    const day = await nextDay();
    const good: Line = { role: "Carpenter", spots: 1, rate: 40 };
    const cases: [string, Fields][] = [
      ["arrays of different lengths", { line_role: ["Carpenter", "Concreter"], line_spots: ["1"], line_rate: ["40", "40"] }],
      ["a role that isn't on the list", lineFields([good, { ...good, role: "Astronaut" }])],
      ["nobody on a line", lineFields([good, { ...good, spots: 0 }])],
      ["21 on a line", lineFields([{ ...good, spots: 21 }])],
      ["seven kinds of worker", lineFields(Array(7).fill(good))],
      ["a licence we don't know", lineFields([{ ...good, tickets: ["LF", "XX"] }])],
      ["licences for a line that isn't there", { ...lineFields([good]), line_tickets_1: ["LF"] }],
    ];
    for (const [why, fields] of cases) {
      const to = await post(day, fields);
      expect(to, why).toMatch(/^\/boss\/shifts\/new\?/);
      expect(errOf(to), why).toBeTruthy();
      expect(await shiftsOn(day), why).toHaveLength(0);
      expect(await used(), why).toBe(5);
    }
    expect(errOf(await post(day, lineFields([{ ...good, spots: 21 }])))).toBe("Each kind of worker needs between 1 and 20 people.");
  });

  it("the posting limit counts lines, and a refused post hands its lines back", async () => {
    await setUsed(SHIFT_POSTS_PER_HOUR - 2);
    const day = await nextDay();
    const three: Line[] = [{ role: "Carpenter", spots: 1, rate: 40 }, { role: "Concreter", spots: 1, rate: 40 }, { role: "Formworker", spots: 1, rate: 40 }];

    expect(errOf(await post(day, lineFields(three)))).toMatch(/limit for posting/);
    expect(await shiftsOn(day)).toHaveLength(0);
    expect(await used()).toBe(SHIFT_POSTS_PER_HOUR - 2);        // refused, so not spent: a smaller post still fits

    expect(await post(day, lineFields(three.slice(0, 2)))).toMatch(/^\/boss\/shifts\/[0-9a-f-]{36}$/);
    expect(await shiftsOn(day)).toHaveLength(2);
    expect(await used()).toBe(SHIFT_POSTS_PER_HOUR);

    expect(errOf(await post(day, lineFields(three.slice(2))))).toMatch(/limit for posting/);
    expect(await shiftsOn(day)).toHaveLength(2);
    expect(await used()).toBe(SHIFT_POSTS_PER_HOUR);
    await setUsed(0);
  });

  it("'Cancel the whole job' calls off this boss's open lines of that post and nothing else", async () => {
    await setUsed(0);
    const day = await nextDay();
    await post(day, { ...lineFields([
      { role: "Carpenter", spots: 1, rate: 40 },
      { role: "Forklift driver", spots: 1, rate: 40, tickets: ["LF"] },
      { role: "General labourer", spots: 2, rate: 40 },
    ]), allow_offers: "1" });
    const [carpentry, forklift, labouring] = await shiftsOn(day);
    // the forklift line fills, the labourers are half booked, someone's asking about the carpentry
    expect((await bookWorker({ shiftId: forklift.id, workerId: forky, workerName: "Posts Forky", notify: null })).ok).toBe(true);
    expect((await bookWorker({ shiftId: labouring.id, workerId: lab, workerName: "Posts Labourer", notify: null })).ok).toBe(true);
    process.env.TEST_USER_ID = asker;
    expect(await worker.makeOffer(fd({ shift_id: carpentry.id, rate: "45", message: "" }))).toEqual({ ok: true });
    // a separate job of this boss's the same day, and another boss's shift that carries the same post_id
    await post(day, lineFields([{ role: "Concreter", spots: 1, rate: 40 }]));
    const [separate] = (await shiftsOn(day)).filter((r) => r.post_id !== carpentry.post_id);
    const [stranger] = await sql`INSERT INTO shifts (project_id, boss_id, day, rate, post_id) VALUES (${otherSite}, ${other}, ${day}, 40, ${carpentry.post_id}) RETURNING id`;
    const status = async () => Object.fromEntries((await sql`SELECT id, status FROM shifts WHERE id = ANY(${[carpentry.id, forklift.id, labouring.id, separate.id, stranger.id]})`).map((r) => [r.id, r.status]));
    const before = { [carpentry.id]: "open", [forklift.id]: "filled", [labouring.id]: "open", [separate.id]: "open", [stranger.id]: "open" };
    expect(await status()).toEqual(before);

    process.env.TEST_USER_ID = other;                          // not his job: nothing happens
    expect(await landing(() => boss.cancelPost(carpentry.id))).toBe("/boss");
    expect(await status()).toEqual(before);

    process.env.TEST_USER_ID = bossId;                         // from any line of the job
    expect(await landing(() => boss.cancelPost(labouring.id))).toBe("/boss");
    expect(await status()).toEqual({ ...before, [carpentry.id]: "cancelled", [labouring.id]: "cancelled" });

    const bookings = Object.fromEntries((await sql`SELECT worker_id, status FROM bookings WHERE shift_id = ANY(${[forklift.id, labouring.id]})`).map((b) => [b.worker_id, b.status]));
    expect(bookings).toEqual({ [forky]: "accepted", [lab]: "removed" });     // the full line keeps its driver
    const [offer] = await sql`SELECT status FROM offers WHERE shift_id = ${carpentry.id} AND worker_id = ${asker}`;
    expect(offer.status).toBe("expired");
    const cancelled = await sql`SELECT user_id, shift_id, body FROM notifications WHERE kind = 'cancelled' AND user_id = ANY(${[forky, lab, asker]}) ORDER BY body`;
    const [{ dy }] = await sql`SELECT to_char(${day}::date, 'Dy DD Mon') AS dy`;
    expect(cancelled.map((n) => [n.user_id, n.shift_id, n.body])).toEqual([
      [lab, labouring.id, `Posts Boss cancelled the ${dy} shift.`],
      [asker, carpentry.id, "The shift you asked about was cancelled."],
    ]);
  });

  it("one kind of worker, an older form, and booking one of your crew all go out exactly as before", async () => {
    await setUsed(0);
    // the old single-role fields, no lines: free-text role, unknown tickets dropped, rate floored — as it always was
    const oldDay = await nextDay();
    const oldTo = await post(oldDay, { start_time: "07:00", hours: "6", spots: "2", role: "Traffic controller", tickets: ["LF", "ZZ"], rate: "20" });
    const [old] = await shiftsOn(oldDay);
    expect([old.role, old.spots, Number(old.rate), old.tickets_required, old.start_time, Number(old.hours), old.direct_worker_id, old.notify_round])
      .toEqual(["Traffic controller", 2, 35.55, ["WC", "LF"], "07:00:00", 6, null, 1]);
    expect(oldTo).toBe(`/boss/shifts/${old.id}`);

    // the new form with one line is the same shift
    const oneDay = await nextDay();
    const oneTo = await post(oneDay, lineFields([{ role: "Concreter", spots: 2, rate: "20", tickets: ["LF"] }]));
    const oneRows = await shiftsOn(oneDay);
    expect(oneRows).toHaveLength(1);
    expect([oneRows[0].role, oneRows[0].spots, Number(oneRows[0].rate), oneRows[0].tickets_required, oneRows[0].notify_round]).toEqual(["Concreter", 2, 35.55, ["WC", "LF"], 1]);
    expect(oneRows[0].post_id).toMatch(UUID);
    expect(oneTo).toBe(`/boss/shifts/${oneRows[0].id}`);

    // booking one of your crew: one person, one role, one rate — a line list riding along changes nothing
    const directDay = await nextDay();
    const directTo = await post(directDay, {
      direct_worker_id: lab, spots: "1", role: "Carpenter", tickets: ["DG"], rate: "41",
      ...lineFields([{ role: "Carpenter", spots: 3, rate: 50 }, { role: "Concreter", spots: 4, rate: 50 }]),
    });
    const direct = await shiftsOn(directDay);
    expect(direct.map((r) => [r.direct_worker_id, r.spots, r.role, Number(r.rate), r.tickets_required])).toEqual([[lab, 1, "Carpenter", 41, ["WC", "DG"]]]);
    expect((await told(direct[0].id)).map((n) => n.user_id)).toEqual([lab]);
    expect(directTo).toBe(`/boss/shifts/${direct[0].id}`);
    expect(await used()).toBe(3);                              // one each
  });
});

afterAll(async () => { if (process.env.DATABASE_URL) await sql.end(); });
