import { money, round2 } from "./award";
import { sql } from "./db";
import { payForShift, weatherSuggestion, type OtTerms } from "./rules";
import { APP_TZ, siteToday } from "./siteClock";
import { fmtDay } from "./util";

/**
 * Every hour waiting on a yes, across all of this boss's sites, in one list.
 *
 * Approving hours today means opening the job, scrolling past the status block and every worker's profile
 * to reach that worker's own form: six workers is about eight phone screens and eight form posts, and the
 * hours sit there another day because nobody has the thumb for it. A day of waiting is a day of not
 * trusting, and it is the same worker who turns the next job down. This is the query that puts the whole
 * lot on one screen.
 *
 * It is also the screen that bills. More than zero approved hours is what turns a pair OnSite introduced
 * into a billable match — $2, once, ever (actions/boss.ts approveHours, lib/invoicing.ts matchLines) — so
 * every line carries whether approving it costs anything, and `introductions` is the only number the
 * confirm sheet may print. A sheet that promises $2 and invoices $6 ends the pricing story this whole
 * product is sold on.
 *
 * NO MONEY IS ADDED UP IN SQL. What a day is worth depends on the overtime terms the shift was posted
 * under, and those live in payForShift(). A SUM(hours * rate) in the statement silently drops every
 * overtime hour, and it would drop them out of the biggest figure on the screen.
 *
 * AND IT THROWS RATHER THAN COMING BACK EMPTY. An empty queue draws "Nothing to approve", which is an
 * assertion of absence — the same claim lib/rank.ts refuses to make unless all six of its inputs
 * answered. A query that failed has not established that nobody is waiting on their money, so it is not
 * allowed to say so. Let it throw, and let the page say it could not check.
 */

/**
 * The ceiling on a day, shared by the stepper and by approveMany. Sixteen, not MAX_SHIFT_HOURS (14),
 * because that is what approveHours has always accepted — `num(form.get("hours"), 0, 16, NaN)` — and a
 * bulk approve that refused a 15-hour day the single form allows would send the boss back to the eight
 * screens this queue exists to replace.
 */
export const MAX_APPROVE_HOURS = 16;

/** One booking waiting on a yes. Every number is already a number; nothing here is a postgres string. */
export type QueueLine = {
  bookingId: string;
  shiftId: string;
  workerId: string;
  name: string;
  photo: string | null;
  site: string;
  /** The site's own calendar day, "2026-09-18". Two sites three hours apart can disagree about today. */
  day: string;
  /** "06:30" — the start actually agreed, which is not always the shift's. */
  start: string;
  /** "Perth time", and only when this site's clock is not the app's. */
  tzWords: string | null;
  /** What the worker recorded when they clocked out. */
  worked: number;
  /** Where the stepper starts: the weather suggestion on a rained-off shift, otherwise what they recorded. */
  hours: number;
  rate: number;
  /** The agreed terms in the boss's own words, from payForShift — "8h at $38.00, then time and a half". */
  terms: string;
  /** What `hours` comes to under those terms. Recomputed on the client as the stepper moves. */
  gross: number;
  /** Hours since they clocked out. Null only if a clocked-out booking somehow has no clock-out time. */
  waitingHours: number | null;
  /** "19 h", "3 days" — the duration on its own, so the screen can phrase it. */
  waitingWords: string;
  /**
   * True when approving this line bills the $2. False for a worker this boss has already been billed for,
   * and for their own crew, who were never an introduction and are never charged.
   */
  unbilledIntroduction: boolean;
  /** 'rain' | 'wind' | 'heat' | 'storm' | 'other' when the shift was stopped, else null. */
  weatherStop: string | null;
  /** Why the pre-filled hours are what they are — weatherSuggestion's own sentence. */
  weatherWhy: string | null;
  /** The reason to send back with the approval, so a bulk-approved rain day still explains itself. */
  payReason: string | null;
};

export type QueueDay = { day: string; heading: string; lines: QueueLine[] };

export type QueueTotals = {
  workers: number;
  sites: number;
  hours: number;
  dollars: number;
  /** How many of these lines cost $2 — one per worker. Never a raw count of `unbilledIntroduction`. */
  introductions: number;
  oldestHours: number | null;
  /** "oldest waiting 19 h", or "" when nothing is waiting. */
  oldestWords: string;
  sr: string;
};

export type ApproveQueue = { days: QueueDay[]; lines: QueueLine[]; totals: QueueTotals };

type Row = {
  booking_id: string; shift_id: string; worker_id: string; name: string; photo: string | null;
  site: string; tz: string; day: string; start_time: string;
  scheduled_hours: string; hours_worked: string | null; clock_in_at: string | null; clock_out_at: string | null;
  rate: string; ot_mode: string | null; ot_after_hours: string | null; ot_multiplier: string | null;
  weather_stop: string | null; weather_note: string | null;
  waiting_hours: string | null; is_today: boolean; is_yesterday: boolean; unbilled_intro: boolean;
};

/** Every shift carries the terms agreed when it was posted; numerics come back from pg as strings. */
const terms = (r: Row): OtTerms =>
  ({ ot_mode: (r.ot_mode ?? "award") as OtTerms["ot_mode"], ot_after_hours: r.ot_after_hours ?? 8, ot_multiplier: r.ot_multiplier ?? null });

/**
 * "(Perth time)", and only when the site's clock is not the app's — otherwise every Sydney shift carries a
 * zone nobody needed to be told, and the one that mattered reads like all the rest.
 */
const tzWords = (tz: string | null) => (!tz || tz === APP_TZ ? null : `${tz.split("/").pop()!.replace(/_/g, " ")} time`);

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** How long it has been sitting there, short enough for a row: "40 min", "19 h", "3 days". */
const waitingWords = (h: number | null): string => {
  if (h == null) return "";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return plural(Math.round(h / 24), "day");
};

/**
 * The reason that rides along with a rained-off approval, word for word the one the single-booking form
 * already sends (app/boss/shifts/[id]/page.tsx). The worker's notification quotes it, so approving six
 * people in one tap has to explain itself exactly as approving them one at a time does — otherwise the
 * fast path is the one that produces "why am I paid 6 hours when I worked 2", which is the argument this
 * queue exists to stop.
 */
const weatherReason = (stop: string, note: string | null) =>
  `${stop === "rain" ? "Rained out" : "Weather stopped work"}${note ? ` — ${note}` : ""}`;

function lineOf(r: Row): QueueLine {
  const rate = Number(r.rate);
  const scheduled = Number(r.scheduled_hours);
  // hours_worked is nullable even on a clocked-out booking — approveHours COALESCEs it for the same
  // reason. Falling back to the hours agreed is the number the boss expected to pay anyway.
  const worked = r.hours_worked == null ? scheduled : Number(r.hours_worked);
  const suggestion = r.weather_stop
    ? weatherSuggestion({ scheduled, worked, clockedIn: !!r.clock_in_at })
    : null;
  const hours = suggestion ? suggestion.hours : worked;
  const pay = payForShift(hours, rate, terms(r));
  const waiting = r.waiting_hours == null ? null : Number(r.waiting_hours);
  return {
    bookingId: r.booking_id, shiftId: r.shift_id, workerId: r.worker_id, name: r.name, photo: r.photo,
    site: r.site, day: r.day, start: String(r.start_time).slice(0, 5), tzWords: tzWords(r.tz),
    worked, hours, rate, terms: pay.words, gross: pay.gross,
    waitingHours: waiting, waitingWords: waitingWords(waiting),
    unbilledIntroduction: r.unbilled_intro,
    weatherStop: r.weather_stop,
    weatherWhy: suggestion ? suggestion.why : null,
    payReason: r.weather_stop ? weatherReason(r.weather_stop, r.weather_note) : null,
  };
}

/**
 * The $2 is charged per worker, not per day.
 *
 * `unbilled_intro` is true on every line belonging to a worker this boss has not been billed for yet, so a
 * worker with Monday and Tuesday both waiting sets it twice — and approving both still bills once, because
 * approveHours' `billed_at IS NULL` guard fires on the first and never again. Counting the flag would put
 * "$4" on a confirm sheet for a $2 charge. So only the oldest line for each worker keeps it: that is the
 * one the transaction actually bills, in the order approveMany performs them.
 */
function billOnlyOnce(lines: QueueLine[]): QueueLine[] {
  const seen = new Set<string>();
  return lines.map((l) => {
    if (!l.unbilledIntroduction) return l;
    if (seen.has(l.workerId)) return { ...l, unbilledIntroduction: false };
    seen.add(l.workerId);
    return l;
  });
}

/**
 * The date heading, and why it is not simply "Today" whenever the date matches.
 *
 * A Perth site and a Sydney site can hold different opinions about whether 2026-09-21 is today, and they
 * arrive here in the same group because the group is a date. "Today" printed over a Perth row that is
 * still yesterday in Perth misdates the work on the one screen where the day is the evidence, so the short
 * word is only used when every line under it agrees.
 */
const headingFor = (day: string, rows: Row[]): string =>
  rows.every((r) => r.is_today) ? "Today" : rows.every((r) => r.is_yesterday) ? "Yesterday" : fmtDay(day);

function totalsOf(lines: QueueLine[]): QueueTotals {
  const hours = round2(lines.reduce((a, l) => a + l.hours, 0));
  const dollars = round2(lines.reduce((a, l) => a + l.gross, 0));
  const workers = new Set(lines.map((l) => l.workerId)).size;
  const sites = new Set(lines.map((l) => l.site)).size;
  const introductions = lines.filter((l) => l.unbilledIntroduction).length;
  const waits = lines.map((l) => l.waitingHours).filter((h): h is number => h != null);
  const oldestHours = waits.length ? Math.max(...waits) : null;
  const oldestWords = oldestHours == null ? "" : `oldest waiting ${waitingWords(oldestHours)}`;
  const sr = lines.length === 0
    ? "Nothing to approve. When someone clocks out, their hours land here."
    : `${hours.toFixed(1)} hours waiting, ${money(dollars)}, across ${plural(workers, "worker")}`
      + ` and ${plural(sites, "site")}.`
      + (oldestWords ? ` The ${oldestWords}.` : "")
      + (introductions ? ` ${plural(introductions, "introduction")} at $2 in this lot.` : " No introduction fee in this lot.");
  return { workers, sites, hours, dollars, introductions, oldestHours, oldestWords, sr };
}

/**
 * Everything with status 'clocked_out' on any of this boss's shifts, grouped by day, oldest first.
 *
 * One statement. `waiting_hours` is measured off clock_out_at, a timestamptz, so that subtraction means
 * the same instant in Perth as in Sydney and is safe against now(). The day arithmetic is not: `is_today`
 * and `is_yesterday` compare s.day, a bare date, and so go through siteToday(p.tz) for the reason
 * lib/siteClock.ts spells out — the pooler runs the session in GMT, so CURRENT_DATE calls this morning
 * "yesterday" until 10am and would misdate every fresh row on the screen a boss opens first thing.
 */
export async function approveQueue(bossId: string): Promise<ApproveQueue> {
  const rows = await sql<Row[]>`
    SELECT b.id AS booking_id, b.shift_id, b.worker_id, us.name, w.photo,
           p.name AS site, p.tz, s.day::text AS day,
           COALESCE(b.agreed_start, s.start_time)::text AS start_time,
           COALESCE(b.agreed_hours, s.hours) AS scheduled_hours,
           b.hours_worked, b.clock_in_at, b.clock_out_at,
           COALESCE(b.agreed_rate, s.rate) AS rate,
           s.ot_mode, s.ot_after_hours, s.ot_multiplier, s.weather_stop, s.weather_note,
           EXTRACT(EPOCH FROM (now() - b.clock_out_at)) / 3600 AS waiting_hours,
           s.day = ${siteToday(sql`p.tz`)}     AS is_today,
           s.day = ${siteToday(sql`p.tz`)} - 1 AS is_yesterday,
           EXISTS (SELECT 1 FROM introductions i
                   WHERE i.boss_id = ${bossId} AND i.worker_id = b.worker_id AND i.billed_at IS NULL) AS unbilled_intro
    FROM bookings b
    JOIN shifts s ON s.id = b.shift_id
    JOIN projects p ON p.id = s.project_id
    JOIN users us ON us.id = b.worker_id
    JOIN workers w ON w.user_id = b.worker_id
    WHERE s.boss_id = ${bossId} AND b.status = 'clocked_out'
    ORDER BY s.day, b.clock_out_at NULLS LAST, us.name`;

  const lines = billOnlyOnce(rows.map(lineOf));

  const byDay = new Map<string, { rows: Row[]; lines: QueueLine[] }>();
  rows.forEach((r, i) => {
    const g = byDay.get(r.day) ?? { rows: [], lines: [] };
    g.rows.push(r);
    g.lines.push(lines[i]);
    byDay.set(r.day, g);
  });

  return {
    days: [...byDay.entries()].map(([day, g]) => ({ day, heading: headingFor(day, g.rows), lines: g.lines })),
    lines,
    totals: totalsOf(lines),
  };
}

/** One line of a bulk approve: the booking, and the hours the boss settled on for it. */
export type ApproveItem = {
  bookingId: string;
  hours: number;
  /** Why the hours differ from what was recorded — the queue hands back `payReason` for a rained-off day. */
  reason?: string | null;
};

/** What a bulk approve did. `skipped` names every booking it did not approve, so a row can say so out loud. */
export type ApproveManyResult = {
  approved: number;
  /** How many $2 introductions this call billed. The confirm sheet promised this number. */
  billed: number;
  /**
   * Bookings that were not approved: bad hours, or no longer 'clocked_out' on one of this boss's shifts
   * (another tab got there first). Never silently dropped — a booking that quietly stays unapproved is the
   * pay dispute the queue was built to prevent.
   */
  skipped: string[];
};
