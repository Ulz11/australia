import { sql } from "./db";
import { fmtTime, km } from "./util";

/**
 * Shift reminders. A worker who has taken a shift is reminded the **evening before** and again **an hour
 * before it starts**; a boss is told the evening before what tomorrow looks like on each of their jobs.
 *
 * They are notifications rows like any other, written by the 20-minute cron and delivered by lib/alerts.ts —
 * so they go to whatever phones the person turned alerts on for and nowhere else. **Reminders are never a
 * text** (they are not in SMS_KINDS): a text costs money and is for a shift someone might otherwise miss out
 * on, not for one they have already taken.
 *
 * Idempotent on purpose. The cron lands whenever it lands, so instead of trying to catch a moment, each rule
 * is a window wider than 20 minutes and `notif_reminder_once` (migration 018) makes the second pass write
 * nothing. "The first pass at or after 6pm" needs no memory of the last run: any pass from 6pm onwards
 * inserts, and the index turns the rest into no-ops.
 *
 * Everything to do with the day is Sydney's, not the server's (`AT TIME ZONE 'Australia/Sydney'`).
 */

/** From this hour, Sydney time, the evening-before reminders go out. */
export const EVENING_HOUR = 18;
/** How long before the start the "starts in an hour" reminder goes out. Wider than one cron gap, on purpose. */
export const SOON_FROM_MIN = 60;
export const SOON_TO_MIN = 80;

export type ReminderCounts = { eve: number; soon: number; boss: number };

type WorkerRow = { user_id: string; shift_id: string; start_time: string; role: string; site: string; dist_m: number | null };
type BossRow = { user_id: string; shift_id: string; start_time: string; site: string; spots: number; taken: number };
type NewRow = { user_id: string; shift_id: string; kind: string; body: string; urgent: boolean };

/** "Tomorrow 6:30am · Steel fixer at Parramatta Rd · 3.1 km from home" — the distance only when we know home. */
export const eveWords = (r: { start_time: string; role: string; site: string; dist_m: number | null }) =>
  `Tomorrow ${fmtTime(r.start_time)} · ${r.role} at ${r.site}${r.dist_m == null ? "" : ` · ${km(r.dist_m)} from home`}`;

/** "Starts in an hour · Parramatta Rd · Clock in when you're at the gate" */
export const soonWords = (r: { site: string }) => `Starts in an hour · ${r.site} · Clock in when you're at the gate`;

/**
 * What the boss reads. A job that is full is information: "Tomorrow 6:30am at Parramatta Rd · 3 of 3 booked".
 * A job that isn't leads with the gap, because that is the bit they can still do something about tonight.
 */
export const bossWords = (r: { start_time: string; site: string; spots: number; taken: number }) => {
  const open = Math.max(0, r.spots - r.taken);
  return open > 0
    ? `${open} spot${open === 1 ? "" : "s"} still open at ${r.site} tomorrow · ${fmtTime(r.start_time)} start · ${r.taken} of ${r.spots} booked`
    : `Tomorrow ${fmtTime(r.start_time)} at ${r.site} · ${r.taken} of ${r.spots} booked`;
};

/** The card at the top of worker home: "Tomorrow 6:30am · Parramatta Rd · 3.1 km". */
export const nextShiftWords = (b: { day: string; start_time: string; site: string; dist_m: number | null }, today: string) =>
  `${b.day === today ? "Today" : "Tomorrow"} ${fmtTime(b.start_time)} · ${b.site}${b.dist_m == null ? "" : ` · ${km(b.dist_m)}`}`;

/**
 * One pass. Called by /api/cron/expand before it delivers alerts, so anything written here goes out in the
 * same run. `now` is only ever passed by tests; the cron uses the clock.
 */
export async function remindShifts(now: Date = new Date()): Promise<ReminderCounts> {
  const [when] = await sql<{ tomorrow: string; hour: number }[]>`
    SELECT ((${now}::timestamptz AT TIME ZONE 'Australia/Sydney') + interval '1 day')::date::text AS tomorrow,
           EXTRACT(HOUR FROM (${now}::timestamptz AT TIME ZONE 'Australia/Sydney'))::int AS hour`;
  const evening = when.hour >= EVENING_HOUR;

  const [eve, soon, boss] = await Promise.all([
    evening ? eveningWorkers(when.tomorrow) : Promise.resolve([] as WorkerRow[]),
    soonWorkers(now),
    evening ? eveningBosses(when.tomorrow) : Promise.resolve([] as BossRow[]),
  ]);

  const rows: NewRow[] = [
    ...eve.map((r) => ({ user_id: r.user_id, shift_id: r.shift_id, kind: "reminder_eve", body: eveWords(r), urgent: false })),
    ...soon.map((r) => ({ user_id: r.user_id, shift_id: r.shift_id, kind: "reminder_soon", body: soonWords(r), urgent: false })),
    ...boss.map((r) => ({ user_id: r.user_id, shift_id: r.shift_id, kind: "tomorrow", body: bossWords(r), urgent: r.taken < r.spots })),
  ];
  if (!rows.length) return { eve: 0, soon: 0, boss: 0 };

  // One statement, and the unique index does the deciding: whatever a previous pass already wrote is dropped
  // here rather than counted, so the numbers in the cron's answer are reminders that really went out.
  // No type parameter on this one: postgres.js's row-set helper and a typed result can't be used together.
  const written = (await sql`
    INSERT INTO notifications ${sql(rows, "user_id", "shift_id", "kind", "body", "urgent")}
    ON CONFLICT DO NOTHING RETURNING kind`) as unknown as { kind: string }[];
  const count = (kind: string) => written.filter((w) => w.kind === kind).length;
  return { eve: count("reminder_eve"), soon: count("reminder_soon"), boss: count("tomorrow") };
}

/** Every worker with a shift tomorrow they are still on. A cancelled booking or a called-off shift is not one. */
const eveningWorkers = (tomorrow: string) => sql<WorkerRow[]>`
  SELECT b.worker_id AS user_id, s.id AS shift_id, COALESCE(b.agreed_start, s.start_time)::text AS start_time,
         s.role, p.name AS site,
         CASE WHEN w.home IS NULL THEN NULL ELSE ST_Distance(p.location, w.home)::int END AS dist_m
  FROM bookings b
  JOIN shifts s ON s.id = b.shift_id AND s.status IN ('open','filled') AND s.day = ${tomorrow}::date
  JOIN projects p ON p.id = s.project_id AND NOT p.archived
  JOIN workers w ON w.user_id = b.worker_id
  WHERE b.status = 'accepted'`;

/** The same people, between 60 and 80 minutes before their shift starts — in Sydney, whatever the server thinks. */
const soonWorkers = (now: Date) => sql<WorkerRow[]>`
  SELECT b.worker_id AS user_id, s.id AS shift_id, COALESCE(b.agreed_start, s.start_time)::text AS start_time,
         s.role, p.name AS site,
         CASE WHEN w.home IS NULL THEN NULL ELSE ST_Distance(p.location, w.home)::int END AS dist_m
  FROM bookings b
  JOIN shifts s ON s.id = b.shift_id AND s.status IN ('open','filled')
  JOIN projects p ON p.id = s.project_id AND NOT p.archived
  JOIN workers w ON w.user_id = b.worker_id
  WHERE b.status = 'accepted'
    AND ((s.day + COALESCE(b.agreed_start, s.start_time)) AT TIME ZONE 'Australia/Sydney') - ${now}::timestamptz
        BETWEEN make_interval(mins => ${SOON_FROM_MIN}) AND make_interval(mins => ${SOON_TO_MIN})`;

/**
 * One line per job, not per line of a job: "2 carpenters and 1 forklift driver" was posted once and is read
 * once. The shift the reminder is filed under is the job's first line, which is also what makes the unique
 * index one-per-job. A shift posted before post_id existed is its own job.
 */
const eveningBosses = (tomorrow: string) => sql<BossRow[]>`
  SELECT s.boss_id AS user_id,
         (ARRAY_AGG(s.id ORDER BY s.created_at, s.id))[1] AS shift_id,
         MIN(s.start_time)::text AS start_time,
         MIN(p.name) AS site,
         SUM(s.spots)::int AS spots,
         SUM((SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled')))::int AS taken
  FROM shifts s
  JOIN projects p ON p.id = s.project_id AND NOT p.archived
  WHERE s.day = ${tomorrow}::date AND s.status IN ('open','filled')
  GROUP BY s.boss_id, COALESCE(s.post_id, s.id)`;
