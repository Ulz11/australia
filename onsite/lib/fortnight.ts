import { money, round2 } from "./award";
import { sql } from "./db";
import { payRunTotals, type PayRunShift } from "./payRun";
import { INVOICE_SOON_DAYS } from "./rank";
import { payForShift, type OtTerms } from "./rules";
import { APP_TZ, siteToday } from "./siteClock";
import { FORTNIGHT_DAYS, matchFeeCents, moneyCents } from "./subscription";
import { todayIso } from "./util";

/**
 * One fortnight of a boss's money — the pay run and the invoices on the SAME window.
 *
 * /boss/pay is week-locked: `weekStart(week)..addDays(ws,6)`, with Last week / Next week chevrons. The
 * invoice cycle is 14 days (lib/subscription.ts nextPeriod). So a boss reconciling one invoice against
 * what he paid his workers had to page two weeks and add them up in his head, and the two halves of the
 * same fortnight never appeared on one screen. This module is the window both halves share.
 *
 * THE WINDOW IS THE BOSS'S OWN BILLING FORTNIGHT, not a calendar one. Migration 021 anchors each boss to
 * a 14-day grid starting on their signup day, so two bosses' fortnights start on different days of the
 * week — which is the point of it (it spreads the cron's closes across the calendar instead of bunching
 * the whole book onto one morning). Snapping this screen to Monday would put half of one invoice beside
 * half of another, which is the reconciliation bug it exists to end.
 *
 * ONE ROUND TRIP. All four statements are issued before any is awaited, so postgres.js pipelines them
 * down the one connection (lib/db.ts). The window itself is a CTE that every statement carries, rather
 * than a value fetched first and fed to the rest — fetching it first would make this screen two trips.
 *
 * NULL MEANS WE COULD NOT CHECK — IT NEVER MEANS ZERO. The same rule lib/rank.ts and lib/weekGaps.ts
 * keep. A pay run that failed to load must not render as "Nothing to pay this fortnight", because the
 * boss puts the phone down and four people are still unpaid on Friday. A failed statement becomes null
 * and lands in `couldNotCheck`; it never becomes an empty list.
 *
 * MONEY UNITS. Wages and super are DOLLARS — they come out of payForShift().gross, and lib/award's
 * money() takes dollars. Introductions are CENTS — lib/subscription's matchFeeCents(), printed with
 * moneyCents(). The two are never added together anywhere in this file, and the cost cell prints three
 * separate figures rather than one total, because a cents figure reaching a dollars helper is exactly
 * how commit 8f912ee shipped "$3,300.00 a month" for a $33 charge.
 */

/** Which fortnight. `on` is a day the boss picked; the window that contains it wins over `back`. */
export type PeriodPick = { back?: number; on?: string | null };

/** How far back the picker will go. A boss who asks for 1990 gets a neighbouring fortnight, not a 70-year loop. */
export const MAX_BACK = 26;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A day out of a URL. Anything that is not a real ISO date becomes null and the screen shows this
 * fortnight — a garbage `?on=` reaching the statement as a date cast would throw, and taking the money
 * screen down over a mistyped URL is worse than quietly showing the fortnight the boss is in.
 */
export const readDay = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim();
  if (!DAY.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
};

/** `?back=` out of a URL, clamped. Anything that is not a positive number means the current fortnight. */
export const readBack = (v: string | null | undefined): number => {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_BACK, Math.round(n)) : 0;
};

export type FortnightWindow = {
  /** Both inclusive, and exactly fourteen days apart. */
  from: string;
  to: string;
  /** 0 is the fortnight the boss is in now. */
  back: number;
  /** "This fortnight" · "Last fortnight" · "14 – 27 Sept" */
  label: string;
  isCurrent: boolean;
};

/** One day of work, already priced. `gross` and `superAmt` are dollars. */
export type PayShift = {
  id: string;
  workerId: string;
  name: string;
  day: string;
  site: string;
  status: "approved" | "paid" | "clocked_out";
  hours: number;
  gross: number;
  superAmt: number;
  otHours: number;
  appliedFloor: boolean;
  reason: string | null;
  disputed: boolean;
};

/** One row of the pay run. `ids` is every booking the Paid toggle flips — including days already paid. */
export type WorkerRun = {
  workerId: string;
  name: string;
  ids: string[];
  days: number;
  hours: number;
  gross: number;
  superAmt: number;
  /** What is still owed to this person in this fortnight. Zero when every day of theirs is paid. */
  owed: number;
  paid: boolean;
  partPaid: boolean;
  otHours: number;
  toppedUp: boolean;
  disputed: boolean;
  notes: string[];
  sr: string;
};

/** The three states of one pile of money, in dollars. States, not categories — so they may share one bar. */
export type MoneySplit = {
  paid: number;
  approved: number;
  waiting: number;
  waitingHours: number;
  waitingWorkers: number;
};

export type SiteSpend = { name: string; dollars: number };

export type OpenInvoice = {
  id: string;
  number: string;
  /** Dollars. The one division out of cents happens in this file, named and on its own. */
  dollars: number;
  dueDay: string;
  days: number;
  overdue: boolean;
  soon: boolean;
  matches: number;
  words: string;
  sr: string;
};

export type FortnightRun = {
  totals: { owed: number; wages: number; superAmt: number };
  split: MoneySplit;
  workers: WorkerRun[];
  sites: SiteSpend[];
  shifts: number;
  unpaidShifts: number;
  unpaidWorkers: number;
  /** Days the oldest unpaid shift has been waiting, counted from the day worked. Null when nothing is owed. */
  oldest: number | null;
  sr: string;
};

export type FortnightMoney = {
  window: FortnightWindow;
  /** Null when the pay run could not be read. Never an empty run standing in for a failed one. */
  run: FortnightRun | null;
  /** Introductions OnSite made inside this window, and what they cost in CENTS. Null when unreadable. */
  introductions: { n: number; cents: number; feeCents: number } | null;
  /** Every open invoice, oldest first. A stack, never a sum — see invoicesFrom. */
  invoices: OpenInvoice[] | null;
  couldNotCheck: string[];
};

// ───────────────────────────────────────────────────────────────────────────── the maths

/** Every shift carries the terms agreed when it was posted; pg hands numerics back as strings. */
const terms = (r: { ot_mode?: string | null; ot_after_hours?: string | number | null; ot_multiplier?: string | number | null }): OtTerms =>
  ({ ot_mode: (r.ot_mode ?? "award") as OtTerms["ot_mode"], ot_after_hours: r.ot_after_hours ?? 8, ot_multiplier: r.ot_multiplier ?? null });

const daysApart = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);
/** "22 September" — anchored and read back in UTC, so a plain date can't slide a day either side of midnight. */
const longDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "long", timeZone: "UTC" });
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
/** Hours the way a boss writes them: 9, not 9.00. */
const hrs = (n: number) => String(Number(n.toFixed(2)));
const first = (name: string) => String(name ?? "").trim().split(/\s+/)[0] || "";
/** An invoice is stored in cents and money() takes dollars. The one division lives here, out loud. */
const dollarsOf = (cents: number) => round2(cents / 100);
/** Days added to a plain date, in UTC, so the arithmetic can't slide across a Sydney daylight-saving change. */
const addIso = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

export type PayRow = {
  id: string;
  worker_id: string;
  name: string;
  day: string;
  site: string;
  status: string;
  hours_approved: string | null;
  hours_worked: string | null;
  rate: string;
  ot_mode: string | null;
  ot_after_hours: string | null;
  ot_multiplier: string | null;
  disputed_at: string | null;
  pay_reason: string | null;
};

/**
 * Price every row. A clocked-out day is priced on what the WORKER recorded, because nothing has been
 * agreed about it yet — it is the "still to approve" segment, an estimate and not a debt.
 *
 * Money is never summed in SQL. A SUM(hours * rate) silently drops every overtime hour and every Award
 * top-up in the list, so payForShift() prices each line and the adding up happens here.
 */
export function priceRows(rows: PayRow[]): PayShift[] {
  return rows.map((r) => {
    const status = (r.status === "paid" ? "paid" : r.status === "clocked_out" ? "clocked_out" : "approved") as PayShift["status"];
    const hours = Number(status === "clocked_out" ? r.hours_worked : r.hours_approved) || 0;
    const p = payForShift(hours, Number(r.rate), terms(r));
    return {
      id: r.id, workerId: r.worker_id, name: r.name, day: r.day, site: r.site, status,
      hours, gross: p.gross, superAmt: p.superAmt, otHours: round2(p.ot150 + p.ot200),
      appliedFloor: p.appliedFloor, reason: r.pay_reason, disputed: !!r.disputed_at,
    };
  });
}

/**
 * The pay run, assembled. Pure: no database and no clock of its own — `today` comes in, so a fortnight
 * that ended six weeks ago can be tested without waiting six weeks.
 *
 * STILL TO PAY IS COUNTED PER SHIFT, NEVER PER WORKER. payRunTotals (lib/payRun.ts) is the only thing
 * that computes it, and it is handed approved and paid days ONLY. Two things are deliberately kept out:
 *  - clocked-out days, because money the boss has not agreed to yet is not a debt. Putting it in the
 *    hero would send him hunting for a figure no worker has been promised.
 *  - the per-worker roll-up, because asking "is this worker square?" drags a part-paid worker's whole
 *    fortnight back into the total — the figure said $1,400 when the real debt was $320.
 * Each worker row carries its own `owed` for the second reason: a row that shows a man his whole
 * fortnight's gross when one Wednesday of it is outstanding is the same lie, one level down.
 */
export function runFrom(shifts: PayShift[], today: string, w: FortnightWindow): FortnightRun {
  const settled = shifts.filter((s) => s.status !== "clocked_out");
  const waitingRows = shifts.filter((s) => s.status === "clocked_out");
  const lines: PayRunShift[] = settled.map((s) => ({ status: s.status, gross: s.gross, superAmt: s.superAmt }));
  const totals = payRunTotals(lines);

  const split: MoneySplit = {
    paid: round2(settled.filter((s) => s.status === "paid").reduce((a, s) => a + s.gross, 0)),
    approved: totals.owed,
    waiting: round2(waitingRows.reduce((a, s) => a + s.gross, 0)),
    waitingHours: round2(waitingRows.reduce((a, s) => a + s.hours, 0)),
    waitingWorkers: new Set(waitingRows.map((s) => s.workerId)).size,
  };

  const by = new Map<string, WorkerRun>();
  for (const s of settled) {
    const row: WorkerRun = by.get(s.workerId) ?? {
      workerId: s.workerId, name: s.name, ids: [] as string[], days: 0, hours: 0, gross: 0, superAmt: 0,
      owed: 0, paid: true, partPaid: false, otHours: 0, toppedUp: false, disputed: false, notes: [] as string[], sr: "",
    };
    row.ids.push(s.id);
    row.days += 1;
    row.hours = round2(row.hours + s.hours);
    row.gross = round2(row.gross + s.gross);
    row.superAmt = round2(row.superAmt + s.superAmt);
    row.owed = round2(row.owed + (s.status === "paid" ? 0 : s.gross));
    row.paid = row.paid && s.status === "paid";
    row.otHours = round2(row.otHours + s.otHours);
    row.toppedUp = row.toppedUp || s.appliedFloor;
    row.disputed = row.disputed || s.disputed;
    if (s.reason && !row.notes.includes(s.reason)) row.notes.push(s.reason);
    by.set(s.workerId, row);
  }
  for (const row of by.values()) {
    row.partPaid = !row.paid && row.owed < row.gross;
    row.sr = row.paid
      ? `${row.name}: ${plural(row.days, "day")}, ${hrs(row.hours)} hours, ${money(row.gross)}, all paid.`
      : `${row.name}: ${money(row.owed)} still to pay${row.partPaid ? ` of ${money(row.gross)}` : ""} for `
        + `${plural(row.days, "day")}, ${hrs(row.hours)} hours. ${money(row.superAmt)} super on top.`
        + (row.disputed ? ` ${first(row.name)} disagrees with these hours.` : "");
  }

  // Still owed first, alphabetically inside each block, then the ones already squared away. It is the
  // list you work down — and it only reshuffles once a toggle has actually run, never under the thumb.
  const workers = [...by.values()].sort((a, b) => Number(a.paid) - Number(b.paid) || a.name.localeCompare(b.name));

  // Per-site spend is WAGES — every settled day in the window, paid or not. It answers "which site is
  // eating the fortnight", which is a question about the work, not about which cheques have cleared.
  const siteMap = new Map<string, number>();
  for (const s of settled) siteMap.set(s.site, round2((siteMap.get(s.site) ?? 0) + s.gross));
  const sites = [...siteMap.entries()].map(([name, dollars]) => ({ name, dollars })).sort((a, b) => b.dollars - a.dollars);

  const unpaid = settled.filter((s) => s.status !== "paid");
  // How long the oldest unpaid one has been waiting, from the day worked. A day in the future can't be late.
  const oldest = unpaid.length === 0 ? null : Math.max(0, ...unpaid.map((s) => daysApart(s.day, today)));
  const sr = totals.owed <= 0
    ? `Nothing still to pay for ${longDay(w.from)} to ${longDay(w.to)}.`
      + (settled.length ? ` ${money(totals.gross)} in wages, all paid.` : " No approved hours in this fortnight.")
    : `${money(totals.owed)} still to pay for ${longDay(w.from)} to ${longDay(w.to)}, across `
      + `${plural(new Set(unpaid.map((s) => s.workerId)).size, "worker")} and ${plural(unpaid.length, "shift")}.`
      + (oldest ? ` The oldest has been waiting ${plural(oldest, "day")}.` : "");

  return {
    totals: { owed: totals.owed, wages: totals.gross, superAmt: totals.sup },
    split, workers, sites,
    shifts: settled.length,
    unpaidShifts: unpaid.length,
    unpaidWorkers: new Set(unpaid.map((s) => s.workerId)).size,
    oldest, sr,
  };
}

export type InvoiceRow = { id: string; number: string; total_cents: number; due_day: string; matches: number };

/**
 * Open invoices, oldest first — a stack, one target each, never a sum. Two open invoices have two
 * numbers, two due dates and two QPay payments behind them, so one combined figure is a number the boss
 * cannot actually pay.
 *
 * `soon` is what buys the orange upstairs. Inside INVOICE_SOON_DAYS (lib/rank.ts) or already past due is
 * the only time money OnSite is owed may shout on a screen that is otherwise about money the boss owes
 * his workers.
 */
export function invoicesFrom(rows: InvoiceRow[], today: string): OpenInvoice[] {
  return [...rows].sort((a, b) => a.due_day.localeCompare(b.due_day)).map((i) => {
    const days = daysApart(today, i.due_day);
    const dollars = dollarsOf(i.total_cents);
    const when = days < 0 ? `${plural(-days, "day")} overdue` : days === 0 ? "due today"
      : days === 1 ? "due tomorrow" : `due in ${plural(days, "day")}`;
    return {
      id: i.id, number: i.number, dollars, dueDay: i.due_day, days,
      overdue: days < 0, soon: days <= INVOICE_SOON_DAYS, matches: i.matches,
      words: `Pay ${money(dollars)} — ${when}`,
      sr: `Invoice ${i.number}, ${money(dollars)}, ${when}, for ${plural(i.matches, "introduction")}. Opens the invoice.`,
    };
  });
}

/**
 * "17 introductions × $2" — the multiplication spelled out rather than a total dropped on the screen, so
 * the $2 promise is checkable by anyone holding the phone. CENTS in: this is the only figure on the
 * money screen that is not dollars, and moneyCents says which it is in its own name.
 */
export const introWords = (n: number, feeCents: number) =>
  n === 0 ? "No introductions this fortnight"
    : `${plural(n, "introduction")} × ${feeCents % 100 === 0 ? `$${feeCents / 100}` : moneyCents(feeCents)}`;

// ───────────────────────────────────────────────────────────────────────── the round trip

/**
 * The window, as a CTE every statement carries.
 *
 * `anchor` is the start of the fortnight the boss is in now, read off bosses.period_started_at in the
 * app's zone — never CURRENT_DATE, which Neon's pooler leaves running in GMT and which is therefore
 * yesterday from midnight until 10am in Sydney (lib/siteClock.ts). MAX() over what is at most one row is
 * what makes this CTE return a row even for a boss with no billing row yet: an aggregate with no GROUP
 * BY always answers, so the fallback fourteen days can fire instead of the whole screen coming back empty
 * and reading as "nothing to pay".
 *
 * `back` steps whole fortnights, and a picked day resolves to the fortnight that CONTAINS it: CEIL, not
 * FLOOR, because a day one week before the anchor belongs to the fortnight that ended yesterday, not to
 * the one that started today. The end is `from + 13`, so the window is exactly fourteen days and does
 * not overlap its neighbour — period_ends_at is the NEXT period's start (subscription.nextPeriod), so
 * including it would put the same Wednesday in two fortnights and a boss reconciling both would count
 * that day's wages twice.
 *
 * Every number is cast. An untyped parameter beside `date - $1` leaves Postgres choosing between
 * `date - integer` and `date - date`, and it does not always choose the one you meant.
 */
const windowCte = (bossId: string, back: number, on: string | null) => sql`
  anchor AS (
    SELECT COALESCE(MAX((bo.period_started_at AT TIME ZONE ${APP_TZ})::date),
                    ${siteToday()} - ${FORTNIGHT_DAYS - 1}::int) AS d
    FROM bosses bo WHERE bo.user_id = ${bossId}
  ),
  step AS (
    SELECT d, (CASE WHEN ${on}::date IS NULL THEN ${back}::int
                    ELSE GREATEST(0, CEIL((d - ${on}::date)::numeric / ${FORTNIGHT_DAYS}::int))::int END) AS back
    FROM anchor
  ),
  win AS (
    SELECT (d - ${FORTNIGHT_DAYS}::int * back) AS from_day,
           (d - ${FORTNIGHT_DAYS}::int * back) + ${FORTNIGHT_DAYS - 1}::int AS to_day,
           back
    FROM step
  )`;

/** "This fortnight" while you are in it; a date range once you have paged off it, because "2 back" is not a date. */
const labelFor = (back: number, from: string, to: string): string => {
  if (back === 0) return "This fortnight";
  if (back === 1) return "Last fortnight";
  const a = new Date(from + "T00:00:00Z"), b = new Date(to + "T00:00:00Z");
  const part = (d: Date, month: boolean) =>
    d.toLocaleDateString("en-AU", { day: "numeric", ...(month ? { month: "short" } : {}), timeZone: "UTC" });
  return `${part(a, a.getUTCMonth() !== b.getUTCMonth())} – ${part(b, true)}`;
};

/**
 * Everything /boss/money needs, in one round trip.
 *
 * A statement that throws becomes null and says so in `couldNotCheck`. It never becomes an empty list:
 * "Nothing to pay this fortnight" is an assertion about the world, and a timeout has not earned it.
 */
export async function fortnightMoney(bossId: string, pick: PeriodPick = {}): Promise<FortnightMoney> {
  const back = Math.min(MAX_BACK, Math.max(0, Math.round(pick.back ?? 0)));
  const on = readDay(pick.on);
  const today = todayIso();
  const couldNotCheck: string[] = [];
  const ask = async <T>(name: string, q: Promise<T>): Promise<T | null> => {
    try { return await q; } catch (e) {
      couldNotCheck.push(name);
      console.error("boss money:", name, (e as Error)?.message);
      return null;
    }
  };

  const cte = windowCte(bossId, back, on);
  const [winRow, payRows, invoiceRows, introRow] = await Promise.all([
    ask("which fortnight you are in", sql<{ from_day: string; to_day: string; back: number }[]>`
      WITH ${cte} SELECT from_day, to_day, back FROM win`),

    // The pay run. Rows, not a SUM: what a day is worth depends on the terms it was posted under, and
    // that belongs to payForShift(). Clocked-out days ride along so the bar can show what is still to
    // approve beside what is still to pay; they are priced on the worker's own recorded hours.
    ask("the pay run", sql<PayRow[]>`
      WITH ${cte}
      SELECT b.id, b.worker_id, us.name, s.day, p.name AS site, b.status,
             b.hours_approved, b.hours_worked, COALESCE(b.agreed_rate, s.rate) AS rate,
             s.ot_mode, s.ot_after_hours, s.ot_multiplier, b.disputed_at, b.pay_reason
      FROM win w
      CROSS JOIN bookings b
      JOIN shifts s ON s.id = b.shift_id
      JOIN projects p ON p.id = s.project_id
      JOIN users us ON us.id = b.worker_id
      WHERE s.boss_id = ${bossId}
        AND b.status IN ('approved','paid','clocked_out')
        AND s.day >= w.from_day AND s.day <= w.to_day
      ORDER BY us.name, s.day`),

    // Open invoices are open whatever fortnight the boss is looking at — a bill does not stop being due
    // because he paged back a page. So this one carries no window.
    ask("your invoices", sql<InvoiceRow[]>`
      SELECT i.id, i.number, i.total_cents, (i.due_at AT TIME ZONE ${APP_TZ})::date AS due_day,
             (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.kind = 'match')::int AS matches
      FROM invoices i WHERE i.boss_id = ${bossId} AND i.status = 'open' ORDER BY i.due_at`),

    // Two counts, because the honest answer differs by which fortnight you are looking at.
    //
    // `in_window` is what became billable inside these fourteen days, counted on the same moment
    // lib/invoicing.ts's matchLines() bills on. That is the right answer for a fortnight that has closed:
    // it is the history of what happened.
    //
    // `will_bill` is every introduction still carrying no invoice_line_id — which is exactly what
    // matchLines() takes when the period closes, because it has NO lower bound. For the OPEN fortnight
    // that is the only honest number: an introduction that became billable before this window opened but
    // has never been invoiced is still going to land on this invoice. Showing in_window there told Dave
    // Carter $2.00 for one introduction while the invoice about to be written said $4.00 for two — and a
    // bill understated on the screen that promises the price is the one error this screen must not make.
    ask("this fortnight's introductions", sql<{ in_window: number; will_bill: number }[]>`
      WITH ${cte}
      SELECT (SELECT COUNT(*) FROM introductions i
              WHERE i.boss_id = ${bossId} AND i.billed_at IS NOT NULL
                AND (i.billed_at AT TIME ZONE ${APP_TZ})::date BETWEEN w.from_day AND w.to_day)::int AS in_window,
             (SELECT COUNT(*) FROM introductions i
              WHERE i.boss_id = ${bossId} AND i.billed_at IS NOT NULL AND i.invoice_line_id IS NULL)::int AS will_bill
      FROM win w`),
  ]);

  // The fourteen days ending today, when the window itself could not be read. It is labelled by its dates
  // rather than "This fortnight", because we no longer know that it is one — and couldNotCheck says so.
  const row = winRow?.[0];
  const from = row?.from_day ?? addIso(today, -(FORTNIGHT_DAYS - 1));
  const to = row?.to_day ?? today;
  const gotBack = row ? Number(row.back) : back;
  const window: FortnightWindow = {
    from, to, back: gotBack,
    label: row ? labelFor(gotBack, from, to) : labelFor(-1, from, to),
    isCurrent: !!row && gotBack === 0,
  };

  const feeCents = matchFeeCents();
  // The open fortnight answers with what the invoice will charge; a closed one with what it did charge.
  // Both come off the same row, so the two can never drift the way the home screen and this one just did.
  const counts = introRow?.[0];
  const n = !counts ? 0 : window.isCurrent ? Number(counts.will_bill) : Number(counts.in_window);
  return {
    window,
    run: payRows ? runFrom(priceRows(payRows), today, window) : null,
    introductions: introRow ? { n, cents: n * feeCents, feeCents } : null,
    invoices: invoiceRows ? invoicesFrom(invoiceRows, today) : null,
    couldNotCheck,
  };
}
