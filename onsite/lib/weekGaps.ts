import { sql } from "./db";
import { SMALL_N, type Level } from "./profileStats";
import { APP_TZ, siteToday } from "./siteClock";
import { addDays, fmtDay } from "./util";

/**
 * The fortnight ahead, one row per day — the data behind `/boss/week` (spec 2.3), and nothing else.
 *
 * The richest calendar query in the app already existed and had nowhere to go: `eveningBosses()`
 * (lib/reminders.ts:138) sums spots and bookings per job per day and spends the whole thing on one SMS
 * sentence. This is that shape given a calendar to render into. It is deliberately **not** a reuse of it:
 * `eveningBosses` is one day, every boss, for the cron, and widening it to a fortnight for one boss would
 * make the nightly send carry fourteen times the rows it needs.
 *
 * A FORTNIGHT, NOT A WEEK. The boss's bill closes on `bosses.period_started_at .. period_ends_at`, so a
 * seven-day calendar shows a boss half the window the money is counted over, and every "am I covered?"
 * question asked about the second week is answered by a screen that cannot see it. The seven-column strip
 * at the top of the screen is free to draw the first seven of these days; the list below it has all
 * fourteen.
 *
 * EVERY DAY HERE IS THE SITE'S DAY. Not one date in this file comes from CURRENT_DATE or from the session
 * clock. Neon's pooler drops lib/db.ts's TimeZone startup parameter and the session really runs in GMT
 * (lib/siteClock.ts has the post-mortem), so a bare CURRENT_DATE would shift the whole calendar one column
 * to the left from midnight until 10am every morning — the fortnight would start on the day that had just
 * ended, and the "fill Thursday" button would post a job for Wednesday.
 *
 * BOOK-AGAINS ARE OUT OF EVERY COUNT. A shift with `direct_worker_id` skips matching and fills by
 * definition, so counting its spots as filled flatters the fortnight and hides the hole next to it. They
 * stay in the jobs list (the boss posted them and wants to see them) and in who is on site (a book-again
 * is a real person on a real site), and they are out of spots, taken and the gap. That is the same line
 * lib/bossToday.ts draws before handing shifts to lib/rank.ts.
 *
 * NULL MEANS WE COULD NOT CHECK — IT NEVER MEANS AN EMPTY FORTNIGHT. `days` is null when the statement
 * threw, so a screen can say "we couldn't check just now" rather than drawing fourteen clear days over a
 * timeout and sending a boss home with a hole still in Thursday.
 *
 * No React, no colour, no dollars. The screen decides what to draw; `needsBoss` marks every day with
 * something on it and `totals.worstDay` names the single day that may be drawn orange, because orange
 * means "this needs you, now" and fourteen orange columns mean nothing at all.
 */

/** The window. The boss's bill closes on a fortnight, so the calendar that answers "am I covered?" does too. */
export const FORTNIGHT_DAYS = 14;

/**
 * As far ahead as this will ever look. Not a policy, a fuse: `days` reaches `generate_series`, and a caller
 * that passes 400 by accident asks Postgres for 400 rows per boss on a screen that opens on a tap.
 */
export const MAX_DAYS = 60;

/**
 * One line of one job. A post for "2 carpenters and 1 forklift driver" is three of these sharing a
 * `postId` (migration 009), which is why `totals.jobs` counts posts and `totals.shifts` counts lines.
 */
export type WeekJob = {
  shiftId: string;
  postId: string | null;
  projectId: string;
  site: string;
  role: string;
  /** "06:30:00", on the site's own clock. Through `fmtTime()` before it reaches a screen. */
  start: string;
  spots: number;
  taken: number;
  /** Spots still to fill. Always 0 on a book-again — see the file comment. */
  gap: number;
  /** A "book again": it skips matching, so it is out of spots, taken and the gap. */
  direct: boolean;
  /** Hours clocked out on this job and waiting on a yes. Only today's column can have any. */
  toApprove: number;
  /** A worker disagreeing about hours on this job. Both numbers stay on record. */
  disputed: number;
  /** "Perth time", and only when the site's clock is not the app's — otherwise every job carries a zone. */
  tzWords: string | null;
};

/** One day of the fortnight, whether or not anything is on it. */
export type WeekDay = {
  /** "2026-09-25". The site's day, never the server's. */
  day: string;
  /** "Thursday", "Thu", "T" — the last one for the seven-column strip. */
  weekday: string;
  short: string;
  letter: string;
  /** "today", "tomorrow", "Thursday", or "Thu 2 Oct" once a weekday name would name two days in the window. */
  when: string;
  isToday: boolean;
  /** Every line of every job that day, earliest start first. Book-agains included, and flagged. */
  jobs: WeekJob[];
  spots: number;
  taken: number;
  gap: number;
  /** How dark the column is drawn, scaled against the worst day in the window. An amount, never a state. */
  level: Level;
  /** People, not spots: someone booked on two jobs in one day is one person on site. */
  onSite: number;
  /** The sites with someone booked that day, named. A site with a job and nobody on it is not one of them. */
  sites: string[];
  toApprove: number;
  disputed: number;
  /** Something on this day needs the boss. Only `totals.worstDay` may be drawn orange. */
  needsBoss: boolean;
  /** The one thing, in the words a boss would use, or null. */
  need: string | null;
  /** `/boss/post`, prefilled with this day, and with the site and role that have the biggest hole in them. */
  href: string;
  sr: string;
};

/** The strip across the top of the screen: the whole fortnight in four numbers and a sentence. */
export type WeekTotals = {
  from: string;
  to: string;
  /** How many day rows there are. 14 unless the caller asked for something else. */
  days: number;
  /** Posts, not lines. Three kinds of worker posted together is one job a boss remembers posting. */
  jobs: number;
  /** Lines. */
  shifts: number;
  spots: number;
  taken: number;
  gap: number;
  /** The day to ring about. Ties go to the earlier day: it is the one that runs out of time first. */
  worstDay: string | null;
  worstGap: number;
  /** Days with work on them and no hole left. An empty day is not a covered one — see the comment below. */
  covered: number;
  withJobs: number;
  /** "78%" once there are SMALL_N jobs to say it about, "3 of 4" until then. Never a bare percentage. */
  fill: string;
  sentence: string;
  sr: string;
};

export type WeekGaps = {
  from: string;
  to: string;
  /** null when the statement threw. An empty fortnight and an unreadable one are not the same claim. */
  days: WeekDay[] | null;
  totals: WeekTotals | null;
  /** Plain words for what did not answer. Empty is the only state that may claim the fortnight is covered. */
  couldNotCheck: string[];
};

/** One row of the statement: a day, and one line of one job on it — or nulls, for a day with nothing on it. */
export type GapRow = {
  day: string;
  shift_id: string | null;
  post_id: string | null;
  project_id: string | null;
  site: string | null;
  tz: string | null;
  role: string | null;
  start_time: string | null;
  spots: number | null;
  taken: number | null;
  to_approve: number | null;
  disputed: number | null;
  direct: boolean | null;
  /** Repeated on every row of the day by the join: distinct people booked that day, counted once in SQL. */
  on_site: number | null;
};

// ───────────────────────────────────────────────────────────────────────────── words

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * "Thursday". A plain date has no zone of its own, so it is anchored at UTC midnight and read back in UTC —
 * the only way it can't slide a day either side of midnight in Sydney (the same trick as util.fmtDay).
 */
const named = (day: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(day + "T00:00:00Z").toLocaleDateString("en-AU", { ...opts, timeZone: "UTC" });

/** "25 September" — for the sr-only sentence, where a bare "Thursday" is two different days in a fortnight. */
const longDay = (day: string) => named(day, { day: "numeric", month: "long" });

const daysApart = (from: string, to: string) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);

/**
 * How a boss says a day out loud — and why it stops saying weekday names after the first week.
 *
 * A fortnight contains two Thursdays. "Fill Thursday" on a seven-day screen is unambiguous; on this one it
 * is a coin toss, and the boss who guesses wrong posts a job for a day that was already full. So past day
 * six the words become a date: "Thu 2 Oct".
 */
const whenWords = (day: string, from: string): string => {
  const out = daysApart(from, day);
  if (out === 0) return "today";
  if (out === 1) return "tomorrow";
  return out < 7 ? named(day, { weekday: "long" }) : fmtDay(day);
};

/** "on Thursday", but "today" and "tomorrow" take no preposition. */
const onWhen = (day: string, from: string) => {
  const w = whenWords(day, from);
  return w === "today" || w === "tomorrow" ? w : `on ${w}`;
};

/** "Perth time", and only when the site's clock is not the app's. The same rule lib/bossToday.ts uses. */
const tzWordsOf = (tz: string | null) =>
  !tz || tz === APP_TZ ? null : `${tz.split("/").pop()!.replace(/_/g, " ")} time`;

/**
 * How dark a day's column is drawn: how big its hole is against the worst hole in the window.
 *
 * Relative, not absolute, because "4 short" means something different to a boss running two jobs and to
 * one running forty, and a fixed scale would paint the first one black every week. Level 0 is reserved for
 * a day with no hole at all, so the strip never draws a shade over a day that is fine.
 */
const gapLevel = (gap: number, worst: number): Level =>
  gap <= 0 ? 0 : worst <= 1 || gap >= worst ? 3 : gap * 2 >= worst ? 2 : 1;

/**
 * The fill figure, and the one guard on it.
 *
 * The percentage is over **spots**, but the floor is over **jobs**, and they are different numbers on
 * purpose: a boss with two 5-spot jobs has made two posting decisions, not ten, and a "40%" built on two
 * decisions is noise wearing a percentage's clothes. That is the same correction spec 3.5 makes to
 * `bossRecord().pulse`. Under the floor it prints what was actually counted and claims nothing more.
 */
const fillWords = (taken: number, spots: number, jobs: number): string =>
  spots <= 0 ? "—" : jobs >= SMALL_N ? `${Math.round((100 * taken) / spots)}%` : `${taken} of ${spots}`;

/**
 * The one thing that day needs, in the order a day cell should say it.
 *
 * The hole comes first even though lib/rank.ts ranks waiting hours above the rest of the week. That is not
 * a disagreement: rank.ts is ordering six different things against each other on /boss, where a hole eight
 * days out really can wait until lunchtime. Here every row already *is* a day, and the day itself is the
 * fuse — once it arrives the hole cannot be filled at all, while hours can still be approved on Friday.
 */
const needWords = (gap: number, disputed: number, toApprove: number): string | null => {
  if (gap > 0) return `${plural(gap, "spot")} still to fill`;
  if (disputed > 0) return disputed === 1 ? "A worker disagrees about hours" : `${disputed} workers disagree about hours`;
  if (toApprove > 0) return toApprove === 1 ? "Hours waiting on you" : `${toApprove} lots of hours waiting on you`;
  return null;
};

/** "this fortnight" is what the window is for; anything else says how long it is rather than pretending. */
const windowWords = (days: number) =>
  days === FORTNIGHT_DAYS ? "this fortnight" : days === 7 ? "this week" : `in the next ${plural(days, "day")}`;

// ─────────────────────────────────────────────────────────────────────────── the maths

/**
 * Rows in, calendar out. Pure: no database, no clock, no React.
 *
 * `from` is the first day in the rows rather than anything this process thinks today is, because the rows
 * were built on the site's clock and this process's clock is the pooler's GMT (lib/siteClock.ts). Reading
 * today off `new Date()` here would undo the whole point of the statement below on the one morning it
 * mattered — and this function is the one piece of the module a test can run without a database, so it is
 * also the piece most likely to be handed rows from a fixture and a clock from somewhere else.
 */
export function weekFrom(rows: GapRow[]): { days: WeekDay[]; totals: WeekTotals } | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const order: string[] = [];
  const byDay = new Map<string, { jobs: WeekJob[]; onSite: number }>();
  for (const r of rows) {
    if (!r || typeof r.day !== "string") continue;
    let d = byDay.get(r.day);
    if (!d) {
      d = { jobs: [], onSite: 0 };
      byDay.set(r.day, d);
      order.push(r.day);
    }
    // Repeated on every row of the day by the join, so the last one wins and they are all the same one.
    d.onSite = Number(r.on_site ?? 0) || 0;
    if (!r.shift_id) continue; // the spine's empty day: a date with no job on it
    const spots = Number(r.spots ?? 0) || 0;
    const taken = Number(r.taken ?? 0) || 0;
    const direct = r.direct === true;
    d.jobs.push({
      shiftId: r.shift_id,
      postId: r.post_id,
      projectId: r.project_id ?? "",
      site: r.site ?? "",
      role: r.role ?? "",
      start: r.start_time ?? "",
      spots,
      taken,
      gap: direct ? 0 : Math.max(0, spots - taken),
      direct,
      toApprove: Number(r.to_approve ?? 0) || 0,
      disputed: Number(r.disputed ?? 0) || 0,
      tzWords: tzWordsOf(r.tz),
    });
  }
  if (order.length === 0) return null;

  order.sort();
  const from = order[0];
  const to = order[order.length - 1];

  // First pass: the numbers. The shade each column is drawn at needs the worst day, so it waits for pass two.
  const raw = order.map((day) => {
    const { jobs, onSite } = byDay.get(day)!;
    // Book-agains are out of the arithmetic and in the list. See the file comment.
    const counted = jobs.filter((j) => !j.direct);
    const spots = counted.reduce((a, j) => a + j.spots, 0);
    const taken = counted.reduce((a, j) => a + j.taken, 0);
    const gap = counted.reduce((a, j) => a + j.gap, 0);
    const toApprove = jobs.reduce((a, j) => a + j.toApprove, 0);
    const disputed = jobs.reduce((a, j) => a + j.disputed, 0);
    // Only sites with someone actually booked on them: a site with a job and nobody on it is a hole, not a crew.
    const sites = [...new Set(jobs.filter((j) => j.taken > 0 && j.site).map((j) => j.site))];
    return { day, jobs, onSite, spots, taken, gap, toApprove, disputed, sites, counted: counted.length };
  });

  const gap = raw.reduce((a, d) => a + d.gap, 0);
  // Ties go to the earlier day: it is the one that runs out of time first. (lib/rank.ts tenant 5, same rule.)
  const worst = raw.filter((d) => d.gap > 0).sort((a, b) => b.gap - a.gap || a.day.localeCompare(b.day))[0] ?? null;

  const days: WeekDay[] = raw.map((d) => {
    // The job to prefill the post form with: the biggest hole that day, earliest start on a tie.
    const lead =
      d.jobs.filter((j) => j.gap > 0).sort((a, b) => b.gap - a.gap || a.start.localeCompare(b.start))[0] ??
      d.jobs[0] ??
      null;
    const href =
      "/boss/post?day=" + d.day +
      (lead?.projectId ? `&project=${lead.projectId}` : "") +
      (lead?.role ? `&role=${encodeURIComponent(lead.role)}` : "");
    const need = needWords(d.gap, d.disputed, d.toApprove);
    const weekday = named(d.day, { weekday: "long" });
    const head = `${weekday} ${longDay(d.day)}`;
    const sr =
      d.jobs.length === 0
        ? `${head}: nothing booked.`
        : `${head}: ${plural(d.jobs.length, "job")}, ${d.taken} of ${d.spots} spots filled` +
          (d.gap > 0 ? `, ${plural(d.gap, "spot")} still to fill` : "") +
          "." +
          (d.onSite > 0
            ? ` ${plural(d.onSite, "worker")} on site${d.sites.length ? ` at ${d.sites.join(", ")}` : ""}.`
            : "") +
          (need && d.gap === 0 ? ` ${need}.` : "");
    return {
      day: d.day,
      weekday,
      short: named(d.day, { weekday: "short" }),
      letter: weekday.slice(0, 1),
      when: whenWords(d.day, from),
      isToday: d.day === from,
      jobs: d.jobs,
      spots: d.spots,
      taken: d.taken,
      gap: d.gap,
      level: gapLevel(d.gap, worst?.gap ?? 0),
      onSite: d.onSite,
      sites: d.sites,
      toApprove: d.toApprove,
      disputed: d.disputed,
      needsBoss: need != null,
      need,
      href,
      sr,
    };
  });

  const shifts = raw.reduce((a, d) => a + d.counted, 0);
  const jobs = new Set(raw.flatMap((d) => d.jobs.filter((j) => !j.direct).map((j) => j.postId ?? j.shiftId))).size;
  const spots = raw.reduce((a, d) => a + d.spots, 0);
  const taken = raw.reduce((a, d) => a + d.taken, 0);
  // A day with nothing booked is empty, not covered. Counting it would tell a boss with no jobs at all that
  // all fourteen of his days were covered, which is true in the way that an empty diary is a quiet week.
  const withJobs = raw.filter((d) => d.jobs.length > 0).length;
  const covered = raw.filter((d) => d.jobs.length > 0 && d.gap === 0).length;

  const sentence =
    gap > 0 && worst
      ? `${plural(gap, "spot")} still to fill ${windowWords(days.length)}.` +
        ` ${worst.gap === gap ? "All of them" : `${worst.gap} of them`} ${onWhen(worst.day, from)}.`
      : withJobs === 0
        ? `Nothing booked ${windowWords(days.length)}.`
        : `Every day with work on it ${windowWords(days.length)} is covered.`;

  return {
    days,
    totals: {
      from,
      to,
      days: days.length,
      jobs,
      shifts,
      spots,
      taken,
      gap,
      worstDay: worst?.day ?? null,
      worstGap: worst?.gap ?? 0,
      covered,
      withJobs,
      fill: fillWords(taken, spots, jobs),
      sentence,
      sr:
        sentence +
        (withJobs === 0
          ? ""
          : ` ${covered} of the ${plural(withJobs, "day")} with work on them ${covered === 1 ? "is" : "are"} full.`) +
        ` ${longDay(from)} to ${longDay(to)}.`,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────── the round trip

/**
 * The fortnight ahead for one boss: one statement, one round trip.
 *
 * The spine is `generate_series` off the **earliest** today across the boss's own sites — not CURRENT_DATE,
 * and not this process's clock. Two reasons it is the earliest rather than the app's:
 *
 *  - a boss with a Perth site and a Sydney one has two todays for three hours every night, and anchoring on
 *    Sydney's would drop the Perth job that is still today in Perth off the front of the calendar;
 *  - each job is then filtered against **its own** site's today, so a day that has genuinely ended in Sydney
 *    still ends there. The two rules together mean the fortnight starts at the earliest live day and every
 *    column holds exactly the jobs still ahead where they are being worked.
 *
 * The cost of that choice, stated rather than hidden: the window is always `days` rows, so for a boss whose
 * sites straddle three hours, Sydney's fourteenth day can fall one outside it. Fourteen rows that all mean
 * something beats fifteen where the last one is half a day.
 *
 * `generate_series` is fed `::timestamp`, not the bare dates spec 3.2's sketch uses, so no zone is involved
 * in building the spine at all — a timestamptz series would be read back out through the session clock,
 * which is the GMT that lib/siteClock.ts exists to route around.
 */
export async function weekGaps(bossId: string, days: number = FORTNIGHT_DAYS): Promise<WeekGaps> {
  // `days` reaches generate_series. Clamp it here rather than trusting every future caller with a number.
  const span = Math.max(1, Math.min(MAX_DAYS, Math.round(Number(days) || FORTNIGHT_DAYS)));
  const fallbackFrom = new Date().toLocaleDateString("en-CA", { timeZone: APP_TZ });
  const blank: WeekGaps = {
    from: fallbackFrom,
    to: addDays(fallbackFrom, span - 1),
    days: null,
    totals: null,
    couldNotCheck: ["the fortnight ahead"],
  };

  let rows: GapRow[];
  try {
    rows = await sql<GapRow[]>`
      WITH win AS (
        SELECT z.day0, (z.day0 + ${span - 1}::int) AS day1 FROM (
          SELECT COALESCE(MIN(${siteToday(sql`p.tz`)}), ${siteToday()}) AS day0
          FROM projects p WHERE p.boss_id = ${bossId} AND NOT p.archived
        ) z
      ),
      d AS (
        SELECT generate_series(w.day0::timestamp, w.day1::timestamp, '1 day')::date AS day FROM win w
      ),
      j AS (
        SELECT s.day, s.id, s.post_id, s.project_id, s.role, s.start_time::text AS start_time, s.spots,
               (s.direct_worker_id IS NOT NULL) AS direct, p.name AS site, p.tz,
               t.taken, t.to_approve, t.disputed
        FROM shifts s
        JOIN projects p ON p.id = s.project_id AND NOT p.archived
        CROSS JOIN win w
        CROSS JOIN LATERAL (
          SELECT COUNT(*) FILTER (WHERE b.status NOT IN ('removed','cancelled'))::int AS taken,
                 COUNT(*) FILTER (WHERE b.status = 'clocked_out')::int AS to_approve,
                 COUNT(*) FILTER (WHERE b.disputed_at IS NOT NULL AND b.status IN ('approved','paid'))::int AS disputed
          FROM bookings b WHERE b.shift_id = s.id
        ) t
        WHERE s.boss_id = ${bossId} AND s.status IN ('open','filled')
          AND s.day >= ${siteToday(sql`p.tz`)} AND s.day <= w.day1
      ),
      o AS (
        -- People, not spots and not bookings: a worker on two of the day's jobs is one worker on site.
        -- Book-agains count here — they are a real person on a real site — which is why this is its own
        -- aggregate rather than a sum over j.
        SELECT s.day, COUNT(DISTINCT b.worker_id)::int AS on_site
        FROM bookings b
        JOIN shifts s ON s.id = b.shift_id AND s.boss_id = ${bossId} AND s.status IN ('open','filled')
        JOIN projects p ON p.id = s.project_id AND NOT p.archived
        CROSS JOIN win w
        WHERE b.status NOT IN ('removed','cancelled')
          AND s.day >= ${siteToday(sql`p.tz`)} AND s.day <= w.day1
        GROUP BY s.day
      )
      SELECT d.day::text AS day, j.id AS shift_id, j.post_id, j.project_id, j.site, j.tz, j.role,
             j.start_time, j.spots, j.taken, j.to_approve, j.disputed, j.direct,
             COALESCE(o.on_site, 0) AS on_site
      FROM d
      LEFT JOIN j ON j.day = d.day
      LEFT JOIN o ON o.day = d.day
      ORDER BY d.day, j.start_time NULLS LAST, j.site, j.id`;
  } catch (e) {
    console.error("week gaps:", (e as Error)?.message);
    return blank;
  }

  const built = weekFrom(rows);
  // The spine always returns `span` rows, so an empty result is not a statement about an empty fortnight:
  // it means the shape came back wrong, and that is the white "we couldn't check", never the green one.
  if (!built) return blank;
  return { from: built.totals.from, to: built.totals.to, days: built.days, totals: built.totals, couldNotCheck: [] };
}
