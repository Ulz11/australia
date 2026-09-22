/**
 * The record: what a worker and a boss have actually done, counted once, in one place.
 *
 * Two halves. The top half is arithmetic with no database in it — shades, weeks, streaks, the on-time
 * rule, the small-number rule — so the rules can be read and argued with on their own (tests/unit/record.test.ts).
 * The bottom half is the queries: workerRecord, bossRecord, and the money-free workerRecordForBoss.
 * A page calls one of them and lays out what comes back; no page counts anything itself.
 *
 * Two rules run through all of it:
 *  - a percentage needs a denominator worth one. Under five it is "3 of 4", which nobody can argue with.
 *  - money is worked out one way, by payForShift on the terms agreed when the shift was posted. Never twice.
 */
import { sql } from "./db";
import { siteToday } from "./siteClock";
import { ON_TIME_GRACE_MIN, payForShift, type OtTerms } from "./rules";
import { addDays, TZ, todayIso, weekStart } from "./util";
import { myBookings } from "./workerQueries";

// ─────────────────────────────────────────────────────────────── what counts

/** Worked and on the record: the hours are in, whatever is still owed on them. */
export const WORKED = ["clocked_out", "approved", "paid"];
/** Turned up: clocked in, and everything that comes after. */
export const ON_SITE = ["clocked_in", ...WORKED];
/** Money is settled: the boss approved the hours. */
export const SETTLED = ["approved", "paid"];

/** Percentages need a denominator worth a percentage. Under this it is a count. */
export const SMALL_N = 5;

/** "96%", or "4 of 4" while there are too few to talk in percentages, or a dash for nothing at all. */
export const share = (n: number, of: number): string =>
  of >= SMALL_N ? `${Math.round((100 * n) / of)}%` : of > 0 ? `${n} of ${of}` : "—";

// ────────────────────────────────────────────────── days on the tools (grid)

export const HEATMAP_WEEKS = 52;

/** How dark a day is drawn. A shade is an amount, never a state — orange stays out of it. */
export type Level = 0 | 1 | 2 | 3;
export type Day = { day: string; level: Level };
export type Week = { start: string; days: (Day | null)[] };

/** A worker's day: nothing, a short one, a normal one, a long one. */
export const hoursLevel = (hours: number): Level => (!(hours > 0) ? 0 : hours < 4 ? 1 : hours <= 8 ? 2 : 3);

/** A boss's day: how many of their people were on site at all. */
export const peopleLevel = (people: number): Level => (!(people > 0) ? 0 : people === 1 ? 1 : people <= 3 ? 2 : 3);

/**
 * The last 52 Mon–Sun weeks, oldest first, ending with the week `today` falls in. Seven slots a week;
 * a day still to come is null, so the grid stops where the record does instead of drawing empty future.
 */
export function heatmapGrid(levels: Map<string, Level>, today: string, weeks = HEATMAP_WEEKS): Week[] {
  const first = addDays(weekStart(today), -(weeks - 1) * 7);
  const out: Week[] = [];
  for (let w = 0; w < weeks; w++) {
    const start = addDays(first, w * 7);
    out.push({
      start,
      days: Array.from({ length: 7 }, (_, d) => {
        const day = addDays(start, d);
        return day > today ? null : { day, level: levels.get(day) ?? 0 };
      }),
    });
  }
  return out;
}

/** Days with something on them, for the grid's spoken summary. */
export const daysOn = (weeks: Week[]) => weeks.reduce((a, w) => a + w.days.filter((d) => d != null && d.level > 0).length, 0);

/**
 * Weeks in a row with at least one day worked, counted back from the week we are in — or from last week
 * when this one hasn't started yet, so Monday morning doesn't wipe out a run. One week is not a streak.
 */
export function weekStreak(weeks: Week[]): number {
  const on = weeks.map((w) => w.days.some((d) => d != null && d.level > 0));
  let i = on.length - 1;
  if (i >= 0 && !on[i]) i--;                 // nothing this week yet: the run is last week's
  let n = 0;
  for (; i >= 0 && on[i]; i--) n++;
  return n;
}

/** Day → shade, in the shape heatmapGrid wants. */
const shades = (totals: Map<string, number>, level: (n: number) => Level): Map<string, Level> =>
  new Map([...totals].map(([day, n]) => [day, level(n)] as [string, Level]));

// ──────────────────────────────────────────────────────── clocking in on time

/**
 * Ten minutes at the gate, read in site time, not the phone's idea of the time.
 *
 * The number itself belongs to lib/rules.ts and is only passed on from here, so the record and the boss's
 * clock-in label can never drift apart again. Re-exported because the record is where people look for it.
 */
export { ON_TIME_GRACE_MIN };

/**
 * Minutes late at the gate: the clock-in against the agreed start, both read in site time.
 * The same trick clockInLooks uses (lib/rules.ts) — compare minutes of the day in Sydney, never in UTC,
 * or on a server running in UTC every early start reads as the day before.
 */
export function minutesLate(day: string, startTime: string, at: string | Date, tz = TZ): number {
  const t = new Date(at);
  const hm = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t);
  const h = Number(hm.find((p) => p.type === "hour")!.value), m = Number(hm.find((p) => p.type === "minute")!.value);
  const on = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(t);
  const days = Math.round((Date.parse(`${on}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  const [sh, sm] = startTime.slice(0, 5).split(":").map(Number);
  return days * 1440 + (h * 60 + m) - (sh * 60 + sm);
}

export const onTime = (lateMin: number) => lateMin <= ON_TIME_GRACE_MIN;

// ────────────────────────────────────────────────────────── how long to fill

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * "41 min", "3 h", "2 days" — one number and the unit that suits it. Minutes run to two hours before hours
 * take over, so an hour and a half is never rounded up into "2 h", which would flatter the number.
 */
export function fillWords(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return "—";
  if (minutes < 120) return `${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

// ──────────────────────────────────────────────────────────────────── months

/** The last 12 calendar months, oldest first: "2026-09" and the "Sept" that goes over the bar. */
export function lastMonths(today: string, n = 12): { key: string; label: string }[] {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return { key: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" }) };
  });
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);
const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
const num = (v: unknown) => Number(v ?? 0) || 0;
/** Each shift carries the overtime terms agreed when it was posted; a missing one is the Award. */
const terms = (r: { ot_mode?: string | null; ot_after_hours?: number | string | null; ot_multiplier?: number | string | null }): OtTerms =>
  ({ ot_mode: (r.ot_mode ?? "award") as OtTerms["ot_mode"], ot_after_hours: r.ot_after_hours ?? 8, ot_multiplier: r.ot_multiplier ?? null });

// ───────────────────────────────────────────────────── a worker's own shifts

/** The neutral half of a booking: hours, rhythm and trade, with no money and nobody's name in it. */
export type WorkerShift = {
  day: string; start_time: string; status: string;
  hours: number | string; hours_worked: number | string | null; hours_approved: number | string | null;
  clock_in_at: Date | string | null; disputed_at: Date | string | null;
  role: string; project_id: string;
};
export type WorkerStats = { past_shifts?: number | null; showed?: number | null; cancels?: number | null };

/**
 * Everything a shift list says about a worker that a boss is also allowed to see. Pure, so the worker's
 * own page and the boss's view of them can't drift apart, and so no earnings can leak into the boss's copy.
 */
export function workerFacts(rows: WorkerShift[], stats: WorkerStats, today = todayIso()) {
  const worked = rows.filter((r) => WORKED.includes(r.status));
  const totals = new Map<string, number>();
  for (const r of rows.filter((r) => ON_SITE.includes(r.status)))
    add(totals, r.day, num(r.hours_approved ?? r.hours_worked ?? r.hours));
  const weeks = heatmapGrid(shades(totals, hoursLevel), today);

  const months = new Map<string, number>(), trades = new Map<string, number>(), sites = new Set<string>();
  let hours = 0;
  for (const r of worked) {
    const h = num(r.hours_approved ?? r.hours_worked);
    hours += h;
    add(months, r.day.slice(0, 7), h);
    add(trades, r.role, h);
    sites.add(r.project_id);
  }

  const clockIns = rows.filter((r) => r.clock_in_at != null);
  return {
    shifts: worked.length,
    hours: round1(hours),
    sites: sites.size,
    weeks,
    days: daysOn(weeks),
    streak: weekStreak(weeks),
    months: lastMonths(today).map((m) => ({ ...m, hours: round1(months.get(m.key) ?? 0) })),
    trades: top(trades, 5).map(([role, h]) => ({ role, hours: round1(h) })),
    reliability: {
      showed: num(stats.showed), past: num(stats.past_shifts),
      onTime: clockIns.filter((r) => onTime(minutesLate(r.day, r.start_time, r.clock_in_at!))).length,
      clockIns: clockIns.length,
      pulled: num(stats.cancels),
      disagreed: worked.filter((r) => r.disputed_at != null).length,
      ofWorked: worked.length,
    },
  };
}

export type WorkerFacts = ReturnType<typeof workerFacts>;

/** Bosses who would have this worker back: their own crew, or a shift posted straight at them. */
async function rehireCount(workerId: string) {
  const [r] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM (
      SELECT boss_id FROM crew WHERE worker_id = ${workerId}
      UNION
      SELECT boss_id FROM shifts WHERE direct_worker_id = ${workerId}
    ) x`;
  return r?.n ?? 0;
}

/** The history rows the worker's own screens draw — myBookings, named. */
export type HistoryRow = WorkerShift & {
  id: string; rate: string; boss_id: string; boss_name: string; boss_phone: string; company: string | null;
  site: string; ot_mode: string; ot_after_hours: string; ot_multiplier: string | null;
};
type WorkerRow = { name: string; phone: string; created_at: Date; photo: string | null; years_exp: number | null; trades: string[]; invite_code: string } & WorkerStats;
export type LicenceRow = { kind: string; issued_state: string | null; expires_on: string | null; status: string; checked_at: string | null };

/**
 * The worker's own record. Money is here — the tiles, the history rows — and it never leaves this object:
 * a boss gets workerRecordForBoss, a different query with no rate in it at all.
 */
export async function workerRecord(workerId: string) {
  const today = todayIso();
  const [[me], bookings, licences, rehires, [views], mates] = await Promise.all([
    sql<WorkerRow[]>`SELECT us.name, us.phone, us.created_at, w.photo, w.years_exp, w.trades, w.invite_code,
               st.past_shifts, st.showed, st.cancels
        FROM users us JOIN workers w ON w.user_id = us.id
        LEFT JOIN worker_stats st ON st.worker_id = us.id
        WHERE us.id = ${workerId}`,
    myBookings(workerId) as unknown as Promise<HistoryRow[]>,
    sql<LicenceRow[]>`SELECT kind, issued_state, expires_on::text, status, checked_at::text
        FROM licences WHERE worker_id = ${workerId} ORDER BY kind`,
    rehireCount(workerId),
    // Distinct bosses, never which ones — that is the whole promise made on /privacy.
    sql<{ n: number }[]>`SELECT COUNT(DISTINCT boss_id)::int AS n FROM profile_views
        WHERE worker_id = ${workerId} AND day >= ${siteToday()} - 6`,
    sql<{ name: string; completed: number | null }[]>`
        SELECT us.name, st.completed FROM workers x JOIN users us ON us.id = x.user_id
        LEFT JOIN worker_stats st ON st.worker_id = x.user_id WHERE x.invited_by = ${workerId}`,
  ]);

  const facts = workerFacts(bookings, me ?? {}, today);
  // The same gross the owed line and the Pay screen use: the terms agreed when the shift was posted.
  const gross = (b: HistoryRow) => (b.hours_approved == null ? 0 : payForShift(num(b.hours_approved), num(b.rate), terms(b)).gross);
  const worked = bookings.filter((r) => WORKED.includes(r.status));
  const settled = bookings.filter((r) => SETTLED.includes(r.status));
  const span = (keep: (day: string) => boolean) => {
    const w = worked.filter((r) => keep(r.day));
    return {
      hours: round1(w.reduce((a, r) => a + num(r.hours_approved ?? r.hours_worked), 0)),
      shifts: w.length,
      sites: new Set(w.map((r) => r.project_id)).size,
      earned: round1(settled.filter((r) => keep(r.day)).reduce((a, r) => a + gross(r), 0)),
    };
  };

  return {
    ...facts,
    name: me?.name ?? "", phone: me?.phone ?? "", photo: me?.photo ?? null,
    years_exp: me?.years_exp ?? null, ticked: me?.trades ?? [], invite_code: me?.invite_code ?? "",
    since: me?.created_at ?? null,
    licences, rehires, lookers: views?.n ?? 0,
    mates: mates.map((m) => ({ name: m.name, done: m.completed ?? 0 })),
    tiles: { year: span((d) => d.slice(0, 4) === today.slice(0, 4)), all: span(() => true) },
    /** Newest first — the same rows /worker/me and /worker/me/shifts both draw. */
    history: worked,
    owed: bookings.filter((r) => r.status === "approved"),
    gross,
  };
}

export type WorkerRecord = Awaited<ReturnType<typeof workerRecord>>;

/**
 * What a boss may see of a worker's record: the same figures, none of the money. Columns are listed by
 * hand for the same reason lib/bossQueries.ts lists them — a rate that is never selected can never be shown.
 */
export async function workerRecordForBoss(workerId: string) {
  const [rows, [stats], rehires] = await Promise.all([
    sql<WorkerShift[]>`
      SELECT s.day::text AS day, COALESCE(b.agreed_start, s.start_time)::text AS start_time, b.status,
             s.hours, b.hours_worked, b.hours_approved, b.clock_in_at, b.disputed_at, s.role, s.project_id
      FROM bookings b JOIN shifts s ON s.id = b.shift_id
      WHERE b.worker_id = ${workerId} AND b.status <> 'removed'`,
    sql<WorkerStats[]>`SELECT past_shifts, showed, cancels FROM worker_stats WHERE worker_id = ${workerId}`,
    rehireCount(workerId),
  ]);
  return { ...workerFacts(rows, stats ?? {}), rehires };
}

// ────────────────────────────────────────────────────────────────── the boss

/** How far back "the hiring pulse" looks. */
export const WINDOW_DAYS = 90;

/**
 * No subscription fields. There is no status to be in and nothing to expire: the boss pays $2 per
 * introduction on a fortnightly invoice, so `subscription_status` and `trial_ends_at` are read by
 * nothing. `period_ends_at` went with them — /boss/billing reads the billing row directly.
 */
type BossRow = {
  company: string | null; abn: string | null;
  approved_count: number | null; approve_hours_avg: string | null; pay_days_avg: string | null;
};
type BookingRow = {
  worker_id: string; status: string; hours_worked: string | null; hours_approved: string | null;
  clock_in_at: Date | null; disputed_at: Date | null; created_at: Date; rate: string;
  ot_mode: string; ot_after_hours: string; ot_multiplier: string | null;
  day: string; project_id: string; weather_stop: string | null; site: string; worker_name: string;
};
type ShiftRow = { id: string; post_id: string | null; spots: number; created_at: Date; day: string; filled: number; first_at: Date | null };

/** What the boss has actually built: who worked, how fast shifts fill, and what it cost. */
export async function bossRecord(bossId: string) {
  const today = todayIso();
  const [[me], rows, shifts] = await Promise.all([
    sql<BossRow[]>`SELECT b.company, b.abn,
               st.approved_count, st.approve_hours_avg, st.pay_days_avg
        FROM bosses b LEFT JOIN boss_stats st ON st.boss_id = b.user_id WHERE b.user_id = ${bossId}`,
    sql<BookingRow[]>`SELECT b.worker_id, b.status, b.hours_worked, b.hours_approved, b.clock_in_at, b.disputed_at, b.created_at,
               COALESCE(b.agreed_rate, s.rate) AS rate, s.ot_mode, s.ot_after_hours, s.ot_multiplier,
               s.day::text AS day, s.project_id, s.weather_stop, p.name AS site, us.name AS worker_name
        FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id
        JOIN users us ON us.id = b.worker_id
        WHERE s.boss_id = ${bossId} AND b.status <> 'removed'`,
    sql<ShiftRow[]>`SELECT s.id, s.post_id, s.spots, s.created_at, s.day::text AS day,
               (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS filled,
               (SELECT MIN(b.created_at) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled')) AS first_at
        FROM shifts s
        WHERE s.boss_id = ${bossId} AND s.status <> 'cancelled'
          AND s.day BETWEEN ${siteToday()} - ${WINDOW_DAYS}::int AND ${siteToday()}`,
  ]);

  const live = rows.filter((r) => r.status !== "cancelled");
  const gross = (r: BookingRow) => (r.hours_approved == null ? 0 : payForShift(num(r.hours_approved), num(r.rate), terms(r)).gross);
  const settled = live.filter((r) => SETTLED.includes(r.status));
  const onSite = live.filter((r) => ON_SITE.includes(r.status));
  const span = (keep: (day: string) => boolean) => ({
    shifts: onSite.filter((r) => keep(r.day)).length,
    hours: round1(settled.filter((r) => keep(r.day)).reduce((a, r) => a + num(r.hours_approved), 0)),
    wages: round1(settled.filter((r) => keep(r.day)).reduce((a, r) => a + gross(r), 0)),
    workers: new Set(live.filter((r) => keep(r.day)).map((r) => r.worker_id)).size,
  });

  // People on site: how many different workers were on the tools that day, across every site.
  const perDay = new Map<string, Set<string>>();
  for (const r of onSite) {
    const at = perDay.get(r.day) ?? new Set<string>();
    at.add(r.worker_id);
    perDay.set(r.day, at);
  }
  const weeks = heatmapGrid(shades(new Map([...perDay].map(([d, s]) => [d, s.size])), peopleLevel), today);

  const from = addDays(today, -WINDOW_DAYS);
  const inWindow = (day: string) => day >= from && day <= today;
  // "Returning" is a worker who had already worked for this boss before this booking's day.
  const firstWorked = new Map<string, string>();
  for (const r of live.filter((r) => WORKED.includes(r.status)))
    if (!firstWorked.has(r.worker_id) || r.day < firstWorked.get(r.worker_id)!) firstWorked.set(r.worker_id, r.day);
  const recent = live.filter((r) => inWindow(r.day));
  const returning = recent.filter((r) => (firstWorked.get(r.worker_id) ?? "9999-99-99") < r.day).length;

  // No-shows read exactly as worker_stats does: a past day that never turned into a clock-in. Rain is not a no-show.
  const past = rows.filter((r) => inWindow(r.day) && r.day < today && !r.weather_stop);
  const noShows = past.length - past.filter((r) => ON_SITE.includes(r.status)).length;

  const fillMin = median(shifts.filter((s) => s.filled >= s.spots && s.first_at)
    .map((s) => (new Date(s.first_at!).getTime() - new Date(s.created_at).getTime()) / 60_000));

  /**
   * A JOB is a posting decision, not a headcount. One post that expanded into five days is five shift lines
   * but one decision, and a shift asking for five people is still one decision — so counting `spots` makes
   * two 5-spot jobs look like ten. `spots`/`taken` below stay, because a day's roster is a question about
   * people; "did my jobs fill" is a question about the decision, and this is the denominator that answers it.
   */
  const jobs = new Map<string, { spots: number; filled: number }>();
  for (const s of shifts) {
    const j = jobs.get(s.post_id ?? s.id) ?? { spots: 0, filled: 0 };
    j.spots += s.spots;
    j.filled += Math.min(s.filled, s.spots);
    jobs.set(s.post_id ?? s.id, j);
  }
  const jobsPosted = jobs.size;
  const jobsFilled = [...jobs.values()].filter((j) => j.spots > 0 && j.filled >= j.spots).length;

  /**
   * How fast the FIRST yes came — over every shift that ever got one, filled or not. `fillMin` above asks the
   * same question of fully-filled shifts only, which gets *more* flattering the worse a boss's fill rate is:
   * the slow ones that never filled drop out of their own denominator. Shifts nobody ever said yes to are
   * censored, not zero, so they are counted separately rather than folded in.
   */
  const firstYesMin = median(shifts.filter((s) => s.first_at)
    .map((s) => (new Date(s.first_at!).getTime() - new Date(s.created_at).getTime()) / 60_000));
  const neverAnswered = shifts.filter((s) => !s.first_at).length;

  const hoursBy = new Map<string, number>(), wagesBy = new Map<string, number>();
  const names = new Map<string, string>(), siteNames = new Map<string, string>();
  for (const r of live.filter((r) => WORKED.includes(r.status))) {
    add(hoursBy, r.worker_id, num(r.hours_approved ?? r.hours_worked));
    names.set(r.worker_id, r.worker_name);
  }
  for (const r of settled.filter((r) => r.day.slice(0, 7) === today.slice(0, 7))) {
    add(wagesBy, r.project_id, gross(r));
    siteNames.set(r.project_id, r.site);
  }

  return {
    company: me?.company ?? null, abn: me?.abn ?? null,
    approved: num(me?.approved_count),
    approveHours: me?.approve_hours_avg == null ? null : Number(me.approve_hours_avg),
    payDays: me?.pay_days_avg == null ? null : Number(me.pay_days_avg),
    tiles: { year: span((d) => d.slice(0, 4) === today.slice(0, 4)), all: span(() => true) },
    weeks, days: daysOn(weeks),
    pulse: {
      spots: shifts.reduce((a, s) => a + s.spots, 0),
      taken: shifts.reduce((a, s) => a + Math.min(s.filled, s.spots), 0),
      shifts: shifts.length,
      jobsPosted, jobsFilled,
      fillMin, firstYesMin, neverAnswered,
      noShows, pastShifts: past.length,
      returning, bookings: recent.length,
    },
    regulars: top(hoursBy, 5).map(([id, hours]) => ({ id, name: names.get(id) ?? "", hours: round1(hours) })),
    sites: top(wagesBy, 5).map(([id, wages]) => ({ id, name: siteNames.get(id) ?? "", wages: round1(wages) })),
    disputes: { n: settled.filter((r) => r.disputed_at != null).length, of: settled.length },
  };
}

export type BossRecord = Awaited<ReturnType<typeof bossRecord>>;
