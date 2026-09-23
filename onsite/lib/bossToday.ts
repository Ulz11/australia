import { money, round2 } from "./award";
import { sql } from "./db";
import { payRunTotals, type PayRunShift } from "./payRun";
import {
  rankUrgency, type Approvals, type Deal, type Dispute, type InputName,
  type Invoice, type OnSite, type RankedItem, type ShortShift, type Urgency,
} from "./rank";
import { payForShift, type OtTerms } from "./rules";
import { APP_TZ, siteToday } from "./siteClock";
import { matchFeeCents } from "./subscription";

/**
 * Everything /boss needs to answer one question — what needs you today — and the money maths behind it.
 *
 * The page is a layout. Nothing in it multiplies an hour by a rate or divides cents by a hundred; all of
 * that happens here, once, next to the comment that says which way round the units go. That rule is not
 * taste: commit 8f912ee printed $3,300.00 for a $33 charge because a cents figure reached a dollars
 * helper on a screen, and the screen was the only place that knew which it had.
 *
 * ONE ROUND TRIP. Every statement below is issued before any of them is awaited, so postgres.js pipelines
 * them down the one connection (lib/db.ts). Eleven statements in one trip is the deal this screen makes:
 * it is the only screen a boss opens without a reason, so it answers everything at once or it is a page
 * of spinners.
 *
 * NULL MEANS WE COULD NOT CHECK — IT NEVER MEANS ZERO. lib/rank.ts refuses to draw the green "No." unless
 * all six of its inputs answered, and that guarantee is only worth something if the caller keeps its side:
 * a query that throws becomes `null`, never `[]`. An empty array is a statement about the world ("nothing
 * is waiting"); a timeout is a statement about us. The one exception is the site list, which takes the
 * whole page down with it: a boss with twelve sites whose site query failed would otherwise be shown the
 * first-run "Start with a site" screen, which is the same lie one level up and a great deal louder.
 */

/** As far as the matcher ever looks (lib/matching.ts), so as far as this screen ever counts. */
export const NEAR_M = 40000;

export type SiteRow = { id: string; name: string; address: string | null; upcoming: number };

export type ShiftLine = {
  id: string; post_id: string | null; day: string; start_time: string; hours: string;
  spots: number; role: string; status: string; site: string; project_id: string; tz: string;
  taken: number; to_approve: number; disputed: number; direct: boolean; names: string | null;
};

/**
 * A ranked item, plus the shift it is about and a link that exists today.
 *
 * lib/rank.ts names the routes the redesign is heading for. /boss/approve, /boss/week and /boss/money are
 * now built and `LIVE` points at them; /boss/post, /boss/crew/[id] and /boss/deals are not, and shipping
 * rank's own hrefs for those would put a 404 behind the most important cell on the screen. So `href` here
 * stays what it always was — where a boss can actually go today — and it is one map to change when the
 * rest land. `shiftId` saves the hero parsing its own URL to find the job it needs.
 */
export type TodayItem = RankedItem & { shiftId: string | null };

/** Still to pay, counted per shift. `oldest` is in days, and null when nothing is owed. */
export type OwedNow = {
  dollars: number; workers: number; oldest: number | null;
  from: string; to: string; sr: string;
};

/**
 * The next invoice, in the three states it really has. "building" is the common one now: with the
 * subscription gone, `writeInvoice` returns null on zero lines (lib/invoicing.ts:105), so a fortnight with
 * introductions in it has a running total and no invoice row at all until the period closes.
 */
export type NextInvoice =
  | { kind: "open"; dollars: number; more: number; dueDay: string; days: number; matches: number; sr: string }
  | { kind: "building"; dollars: number; matches: number; sr: string }
  | { kind: "none"; sr: string };

/** Who could take the next job that is still short. Counts and a histogram only — never a worker row. */
export type NearJob = {
  shiftId: string; site: string; day: string; start: string; openSpots: number; ready: number;
  states: { key: string; label: string; n: number }[];
  sentence: string;
};

export type CrewAgain = {
  people: { bookingId: string; workerId: string; name: string; photo: string | null }[];
  more: number; site: string; rate: number; start: string;
};

export type BossToday = {
  projects: SiteRow[];
  /** null when the query failed. The list says so rather than drawing an empty week. */
  shifts: ShiftLine[] | null;
  urgency: Urgency & { items: TodayItem[] };
  owed: OwedNow | null;
  invoice: NextInvoice | null;
  near: NearJob | null;
  crew: CrewAgain | null;
  /** Plain words for everything that did not answer. Empty is the only state that may claim "nothing". */
  couldNotCheck: string[];
};

// ───────────────────────────────────────────────────────────────────────── the maths

/** Every shift carries the terms agreed when it was posted; numerics come back from pg as strings. */
const terms = (r: { ot_mode?: string | null; ot_after_hours?: string | number | null; ot_multiplier?: string | number | null }): OtTerms =>
  ({ ot_mode: (r.ot_mode ?? "award") as OtTerms["ot_mode"], ot_after_hours: r.ot_after_hours ?? 8, ot_multiplier: r.ot_multiplier ?? null });

const daysApart = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);
/** "22 September" — a plain date, anchored and read back in UTC, for the reason lib/util's fmtDay gives. */
const longDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "long", timeZone: "UTC" });
const weekdayOf = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { weekday: "long", timeZone: "UTC" });
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** An invoice is stored in cents and `money()` takes dollars. The one division lives here, named, out loud. */
const dollarsOf = (cents: number) => round2(cents / 100);

export type OwedRow = {
  status: string; worker_id: string; day: string; hours_approved: string | null; rate: string;
  ot_mode: string | null; ot_after_hours: string | null; ot_multiplier: string | null;
};

/**
 * What is still owed this fortnight, a shift at a time.
 *
 * Per shift, never per worker. `app/boss/pay/page.tsx` used to roll the fortnight up per person and ask
 * "is this worker square?", which dragged Sam's whole fortnight back into the total the moment one
 * Wednesday went unpaid — the figure said $1,400 when the debt was $320, and the boss went looking for
 * money that had already left his account. lib/payRun.ts is that fix, and this cell uses it rather than
 * keeping a second copy of the same sum.
 */
export function fortnightOwed(rows: OwedRow[], today: string, from: string, to: string): OwedNow {
  const lines: PayRunShift[] = rows.map((r) => {
    const p = payForShift(Number(r.hours_approved), Number(r.rate), terms(r));
    return { status: r.status, gross: p.gross, superAmt: p.superAmt };
  });
  const { owed } = payRunTotals(lines);
  const unpaid = rows.filter((r) => r.status !== "paid");
  const workers = new Set(unpaid.map((r) => r.worker_id)).size;
  // How long the oldest one has been waiting. A day that hasn't happened yet cannot be overdue.
  const oldest = unpaid.length === 0 ? null : Math.max(0, ...unpaid.map((r) => daysApart(r.day, today)));
  const sr = owed <= 0
    ? `Nothing owed for ${longDay(from)} to ${longDay(to)}. Everyone's square.`
    : `${money(owed)} owed across ${plural(workers, "worker")}, ${longDay(from)} to ${longDay(to)}.`
      + (oldest ? ` The oldest has been waiting ${plural(oldest, "day")}.` : "");
  return { dollars: owed, workers, oldest, from, to, sr };
}

export type OpenInvoice = { total_cents: number; due_day: string; matches: number };

/**
 * The next invoice: the open one if there is one, otherwise what this fortnight has run up so far.
 *
 * It never shows $0.00. A fortnight with no introductions in it gets a sentence, because nothing owed is
 * not a bill — it is the absence of one, and a money tile reading $0.00 is read as a broken query by
 * anyone holding the phone at arm's length in the sun.
 */
export function nextInvoice(open: OpenInvoice[], matches: number, today: string): NextInvoice {
  if (open.length > 0) {
    const [first, ...rest] = [...open].sort((a, b) => a.due_day.localeCompare(b.due_day));
    const days = daysApart(today, first.due_day);
    const when = days < 0 ? `${plural(-days, "day")} overdue` : days === 0 ? "due today"
      : days === 1 ? "due tomorrow" : `due in ${plural(days, "day")}`;
    return {
      kind: "open", dollars: dollarsOf(first.total_cents), more: rest.length,
      dueDay: first.due_day, days, matches: first.matches,
      sr: `${money(dollarsOf(first.total_cents))} ${when}, for ${plural(first.matches, "introduction")}.`
        + (rest.length ? ` ${plural(rest.length, "more invoice")} open.` : ""),
    };
  }
  if (matches > 0) {
    // Nothing is payable yet: this is what the fortnight has run up, at the fee in force now.
    const dollars = dollarsOf(matches * matchFeeCents());
    return {
      kind: "building", dollars, matches,
      sr: `${plural(matches, "introduction")} this fortnight, ${money(dollars)} so far. Nothing to pay until the fortnight closes.`,
    };
  }
  return { kind: "none", sr: "No introductions this fortnight. Nothing to pay." };
}

/**
 * Why the next job is not filling, in the four states a nearby worker can be in.
 *
 * Four counts of one population — everyone within 40 km — so they are states, not categories, and may
 * share one bar (hard colour law 2). Counts, never percentages: "0 of 31" claims nothing beyond what was
 * counted, so there is no small-n guard to get wrong.
 */
export function nearWords(
  n: { ready: number; busy: number; wrong_cards: number; too_far: number },
  dayWords: string,
): { states: NearJob["states"]; sentence: string } {
  const states = [
    { key: "ready", label: `free for ${dayWords}`, n: n.ready },
    { key: "busy", label: "already busy that day", n: n.busy },
    { key: "cards", label: "haven't got the cards it asks for", n: n.wrong_cards },
    { key: "far", label: "close by, but their own travel limit stops short", n: n.too_far },
  ];
  const canSee = n.ready + n.busy;
  const sentence = canSee === 0 && n.wrong_cards === 0 && n.too_far === 0
    ? "Nobody within 40 km has this job's cards."
    : [
      `${plural(n.ready, "worker")} free for ${dayWords}.`,
      canSee > 0 ? `${canSee} can see this job${n.busy > 0 ? ` — ${n.busy} already busy that day` : ""}.` : "",
      n.too_far > 0 ? `${n.too_far} more are close enough, but their own travel limit stops short of you.` : "",
      n.wrong_cards > 0 ? `${plural(n.wrong_cards, "other")} nearby without the cards this job asks for.` : "",
    ].filter(Boolean).join(" ");
  return { states, sentence };
}

/**
 * "(Perth time)", and only when the site's clock is not the app's — otherwise every Sydney shift carries
 * a zone nobody needed to be told, and the one that mattered reads like all the rest.
 */
const tzWords = (tz: string | null) => (!tz || tz === APP_TZ ? null : `${tz.split("/").pop()!.replace(/_/g, " ")} time`);

// ─────────────────────────────────────────────────── where a ranked item can actually go today

/** The screens spec 2.0 is heading for, against the ones a boss can open this week. */
const LIVE = {
  shift: "/boss/shifts",        // already real
  approve: "/boss/approve",     // built
  disputed: "/boss/workers",    // /boss/crew/[id] (38)
  deal: "/boss/offers",         // /boss/deals (38)
  week: "/boss/week",           // built — the calendar, which names the short days and posts from one
  invoice: "/boss/money",       // built
} as const;

/** The last path segment of a rank href: the id it was built from, without re-querying for it. */
const idIn = (href: string | null) => (href ? href.split("?")[0].split("/").filter(Boolean).pop() ?? null : null);

function reroute(item: RankedItem, approveShift: string | null): TodayItem {
  switch (item.key) {
    case "clear": return { ...item, shiftId: null, href: null };
    case "hole": return { ...item, shiftId: idIn(item.href), href: item.href };
    // The queue, not one job. It carries every clocked-out booking across every site, prices each one on the
    // terms that shift was posted on, and says what the introductions will cost before any of it is approved —
    // so it answers the whole of "3 lots of hours waiting" rather than the oldest sixth of it. `shiftId` still
    // comes back so /boss can offer the single job as the ghost, for a boss who only wants to do that one.
    case "approve": return { ...item, shiftId: approveShift, href: LIVE.approve };
    case "disputed": return { ...item, shiftId: null, href: `${LIVE.disputed}/${idIn(item.href) ?? ""}` };
    case "deal": return { ...item, shiftId: null, href: LIVE.deal };
    // rank.ts's href is /boss/post?day=&project=&role=, which is build order 39. /boss/week is the fortnight
    // those holes are in: it names the short days and carries a labelled Post button per day, so the boss
    // lands on the question rather than on a blank form with no day in it.
    case "week": return { ...item, shiftId: null, href: LIVE.week };
    default: return { ...item, shiftId: null, href: LIVE.invoice };
  }
}

// ──────────────────────────────────────────────────────────────────────── the round trip

const INPUT_WORDS: Record<InputName, string> = {
  shifts: "the jobs coming up",
  approvals: "hours waiting on you",
  disputes: "disagreements about hours",
  deals: "deal requests",
  invoices: "the invoice",
  onSite: "who is on site",
};

export async function bossToday(bossId: string, now: Date = new Date()): Promise<BossToday> {
  const failed: string[] = [];
  /** A query that throws becomes null and says so in words. It never becomes an empty list. */
  const ask = async <T>(name: string | null, q: Promise<T>): Promise<T | null> => {
    try { return await q; } catch (e) {
      if (name) failed.push(name);
      console.error("boss today:", name ?? "a rank input", (e as Error)?.message);
      return null;
    }
  };

  const [projects, shifts, waiting, disputeRows, dealRows, invoiceRows, fortnight, onSiteRow, owedRows, nearRow, crewRows] =
    await Promise.all([
      // The site list. The only query allowed to take the page down with it: see the file comment.
      sql<SiteRow[]>`SELECT p.id, p.name, p.address,
            (SELECT COUNT(*) FROM shifts s WHERE s.project_id = p.id AND s.day >= ${siteToday(sql`p.tz`)} AND s.status IN ('open','filled'))::int AS upcoming
          FROM projects p WHERE p.boss_id = ${bossId} AND NOT p.archived ORDER BY p.created_at DESC`,

      // The first 30 jobs, with every line of each: a job posted for three kinds of worker is three shifts.
      // It feeds the list at the bottom of the screen and ranks 1 and 5 at the top of it.
      ask(null, sql<ShiftLine[]>`WITH j AS (
            SELECT id, dense_rank() OVER (ORDER BY day, start_time, COALESCE(post_id, id)) AS job
            FROM shifts WHERE boss_id = ${bossId} AND status IN ('open','filled') AND day >= ${siteToday()} - 1
          )
          SELECT s.id, s.post_id, s.day, s.start_time, s.hours, s.spots, s.role, s.status, s.project_id, p.name AS site, p.tz,
            s.direct_worker_id IS NOT NULL AS direct,
            (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken,
            (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status = 'clocked_out')::int AS to_approve,
            (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.disputed_at IS NOT NULL AND b.status IN ('approved','paid'))::int AS disputed,
            (SELECT string_agg(split_part(us.name,' ',1), ', ') FROM bookings b JOIN users us ON us.id = b.worker_id WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled')) AS names
          FROM j JOIN shifts s ON s.id = j.id JOIN projects p ON p.id = s.project_id
          WHERE j.job <= 30
          ORDER BY j.job, s.created_at`),

      // Rank 2. Rows, not a SUM: what a day is worth depends on the terms it was posted under, and that
      // belongs to payForShift — a SUM(hours * rate) in SQL quietly drops every overtime hour in the list.
      ask(null, sql<{
        shift_id: string; worker_id: string; name: string; hours_worked: string | null; clock_out_at: string | null;
        rate: string; ot_mode: string | null; ot_after_hours: string | null; ot_multiplier: string | null;
      }[]>`
          SELECT b.shift_id, b.worker_id, us.name, b.hours_worked, b.clock_out_at, COALESCE(b.agreed_rate, s.rate) AS rate,
                 s.ot_mode, s.ot_after_hours, s.ot_multiplier
          FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN users us ON us.id = b.worker_id
          WHERE s.boss_id = ${bossId} AND b.status = 'clocked_out'
          ORDER BY b.clock_out_at NULLS LAST`),

      // Rank 3.
      ask(null, sql<{ worker: string; worker_id: string; their_hours: string | null; your_hours: string | null; day: string; site: string }[]>`
          SELECT us.name AS worker, b.worker_id, b.hours_worked AS their_hours, b.hours_approved AS your_hours, s.day, p.name AS site
          FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id JOIN users us ON us.id = b.worker_id
          WHERE s.boss_id = ${bossId} AND b.disputed_at IS NOT NULL AND b.status IN ('approved','paid')
          ORDER BY s.day`),

      // Rank 4.
      ask(null, sql<{ id: string; worker: string; rate: string | null; shift_rate: string; hours: string; day: string; site: string }[]>`
          SELECT o.id, us.name AS worker, o.rate, s.rate AS shift_rate, COALESCE(o.hours, s.hours) AS hours, s.day, p.name AS site
          FROM offers o JOIN shifts s ON s.id = o.shift_id JOIN projects p ON p.id = s.project_id JOIN users us ON us.id = o.worker_id
          WHERE s.boss_id = ${bossId} AND o.from_role = 'worker' AND o.status = 'pending'
          ORDER BY s.day, o.created_at`),

      // Rank 6 and cell 4. One row per open invoice — the cell stacks them rather than adding them up.
      ask(null, sql<{ total_cents: number; due_day: string; matches: number }[]>`
          SELECT i.total_cents, (i.due_at AT TIME ZONE ${APP_TZ})::date AS due_day,
                 (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.kind = 'match')::int AS matches
          FROM invoices i WHERE i.boss_id = ${bossId} AND i.status = 'open' ORDER BY i.due_at`),

      // Cell 4's other half: what this fortnight has run up and not been billed for yet — the same rows
      // lib/invoicing.ts's matchLines() will pick up when the period closes.
      ask("this fortnight's introductions", sql<{ matches: number }[]>`
          SELECT (SELECT COUNT(*) FROM introductions i
                  WHERE i.boss_id = ${bossId} AND i.billed_at IS NOT NULL AND i.invoice_line_id IS NULL)::int AS matches`),

      // The green cell's first clause. Today is the site's own day: a Perth job rolls over three hours late.
      ask(null, sql<{ workers: number; sites: number }[]>`
          SELECT COUNT(DISTINCT b.worker_id)::int AS workers, COUNT(DISTINCT s.project_id)::int AS sites
          FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id
          WHERE s.boss_id = ${bossId} AND b.status = 'clocked_in' AND s.day = ${siteToday(sql`p.tz`)}`),

      // Cell 3. The window is the boss's own billing fortnight, worked out inside the statement so the page
      // never has to wait on one query before it can issue the next.
      ask("still to pay", sql<(OwedRow & { period_start: string; period_end: string })[]>`
          SELECT b.status, b.worker_id, s.day, b.hours_approved, COALESCE(b.agreed_rate, s.rate) AS rate,
                 s.ot_mode, s.ot_after_hours, s.ot_multiplier,
                 COALESCE((bo.period_started_at AT TIME ZONE ${APP_TZ})::date, (now() AT TIME ZONE ${APP_TZ})::date - 13) AS period_start,
                 COALESCE((bo.period_ends_at   AT TIME ZONE ${APP_TZ})::date, (now() AT TIME ZONE ${APP_TZ})::date)      AS period_end
          FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN bosses bo ON bo.user_id = s.boss_id
          WHERE s.boss_id = ${bossId} AND b.status IN ('approved','paid')
            AND s.day >= COALESCE((bo.period_started_at AT TIME ZONE ${APP_TZ})::date, (now() AT TIME ZONE ${APP_TZ})::date - 13)
            AND s.day <= COALESCE((bo.period_ends_at   AT TIME ZONE ${APP_TZ})::date, (now() AT TIME ZONE ${APP_TZ})::date)`),

      // Cell 6. The soonest job still short, and who is near it — counts and a histogram only, never a
      // worker row, so the hand-listed-column privacy seam in lib/bossQueries.ts holds on this screen too.
      ask("who is near the next job", sql<{
        id: string; site: string; day: string; start_time: string; open_spots: number;
        ready: number; busy: number; wrong_cards: number; too_far: number;
      }[]>`
          WITH pick AS (
            SELECT sh.id, sh.spots, sh.tickets_required, sh.day, sh.start_time, p.location, p.name AS site, t.taken
            FROM shifts sh JOIN projects p ON p.id = sh.project_id
            CROSS JOIN LATERAL (SELECT COUNT(*)::int AS taken FROM bookings b
                                WHERE b.shift_id = sh.id AND b.status NOT IN ('removed','cancelled')) t
            WHERE sh.boss_id = ${bossId} AND sh.status = 'open' AND sh.direct_worker_id IS NULL AND NOT p.archived
              AND ((sh.day + sh.start_time) AT TIME ZONE p.tz) > now()
              AND t.taken < sh.spots
            ORDER BY ((sh.day + sh.start_time) AT TIME ZONE p.tz)
            LIMIT 1
          ), near AS (
            SELECT ST_Distance(w.home, pick.location)::int               AS dist_m,
                   ST_DWithin(w.home, pick.location, w.radius_km * 1000) AS covers,
                   worker_free(w.user_id, pick.day)                      AS free,
                   (pick.tickets_required <@ w.tickets)                  AS tix
            FROM pick JOIN workers w ON w.home IS NOT NULL AND ST_DWithin(w.home, pick.location, ${NEAR_M})
            WHERE w.user_id <> ${bossId}
              AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.boss_id = ${bossId} AND bl.worker_id = w.user_id)
          )
          SELECT pick.id, pick.site, pick.day, pick.start_time, (pick.spots - pick.taken)::int AS open_spots,
                 (SELECT COUNT(*) FILTER (WHERE covers AND tix AND free)     FROM near)::int AS ready,
                 (SELECT COUNT(*) FILTER (WHERE covers AND tix AND NOT free) FROM near)::int AS busy,
                 (SELECT COUNT(*) FILTER (WHERE covers AND NOT tix)          FROM near)::int AS wrong_cards,
                 (SELECT COUNT(*) FILTER (WHERE NOT covers AND tix AND free) FROM near)::int AS too_far
          FROM pick`),

      // Cell 7. Whoever was on the tools yesterday and is not already booked for tomorrow — a cell that
      // offers to book someone who is already booked is worse than no cell at all.
      ask("yesterday's crew", sql<{
        booking_id: string; worker_id: string; name: string; photo: string | null;
        site: string; rate: string; start_time: string;
      }[]>`
          SELECT DISTINCT ON (b.worker_id) b.id AS booking_id, b.worker_id, us.name, w.photo, p.name AS site,
                 COALESCE(b.agreed_rate, s.rate) AS rate, COALESCE(b.agreed_start, s.start_time)::text AS start_time
          FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN projects p ON p.id = s.project_id
          JOIN users us ON us.id = b.worker_id JOIN workers w ON w.user_id = b.worker_id
          WHERE s.boss_id = ${bossId} AND b.status IN ('clocked_out','approved','paid')
            AND s.day = ${siteToday(sql`p.tz`)} - 1
            AND NOT EXISTS (SELECT 1 FROM bookings b2 JOIN shifts s2 ON s2.id = b2.shift_id
                            WHERE b2.worker_id = b.worker_id AND s2.boss_id = ${bossId}
                              AND s2.day = ${siteToday(sql`p.tz`)} + 1 AND b2.status NOT IN ('removed','cancelled'))
          ORDER BY b.worker_id, s.start_time`),
    ]);

  // ── the six inputs the order is built from. Every one of them is null when we could not read it.
  const shortShifts: ShortShift[] | null = shifts && shifts
    // A "book again" always fills, so counting it as a gap flatters the week and hides a real hole.
    .filter((s) => !s.direct)
    .map((s) => ({
      id: s.id, day: s.day, start_time: s.start_time, spots: s.spots, taken: s.taken,
      site: s.site, project_id: s.project_id, role: s.role, tz_words: tzWords(s.tz),
    }));

  const approvals: Approvals | null = waiting && {
    workers: new Set(waiting.map((r) => r.worker_id)).size,
    hours: waiting.reduce((a, r) => a + Number(r.hours_worked), 0),
    dollars: round2(waiting.reduce((a, r) => a + payForShift(Number(r.hours_worked), Number(r.rate), terms(r)).gross, 0)),
    names: [...new Map(waiting.map((r) => [r.worker_id, r.name])).values()],
    since: waiting[0]?.clock_out_at ?? null,
  };

  // Numerics come back from postgres.js as strings. Number() them here and let rank judge what it gets:
  // a NaN arrives as a NaN and marks its whole input unchecked, which is the honest answer to a bad row.
  const disputes: Dispute[] | null = disputeRows?.map((d) => ({
    worker: d.worker, worker_id: d.worker_id,
    their_hours: Number(d.their_hours), your_hours: Number(d.your_hours), day: d.day, site: d.site,
  })) ?? null;
  const deals: Deal[] | null = dealRows?.map((o) => ({
    id: o.id, worker: o.worker, rate: o.rate == null ? null : Number(o.rate),
    shift_rate: Number(o.shift_rate), hours: Number(o.hours), day: o.day, site: o.site,
  })) ?? null;
  const invoices: Invoice[] | null = invoiceRows?.map((i) => ({
    cents: i.total_cents, due_day: i.due_day, matches: i.matches,
  })) ?? null;
  const onSite: OnSite | null = onSiteRow ? (onSiteRow[0] ?? { workers: 0, sites: 0 }) : null;

  const ranked = rankUrgency({ now, tz: APP_TZ, shifts: shortShifts, approvals, disputes, deals, invoices, onSite });

  // The job the oldest hours were worked on: where a boss actually approves them until /boss/approve exists.
  const approveShift = waiting?.[0]?.shift_id ?? null;
  const urgency = { ...ranked, items: ranked.items.map((i) => reroute(i, approveShift)) };

  const today = now.toLocaleDateString("en-CA", { timeZone: APP_TZ });
  const owed = owedRows
    ? fortnightOwed(owedRows, today, owedRows[0]?.period_start ?? today, owedRows[0]?.period_end ?? today)
    : null;
  const invoice = invoiceRows && fortnight ? nextInvoice(invoiceRows, fortnight[0]?.matches ?? 0, today) : null;

  const n = nearRow?.[0] ?? null;
  const near: NearJob | null = n && n.ready < n.open_spots
    ? {
      shiftId: n.id, site: n.site, day: n.day, start: n.start_time, openSpots: n.open_spots, ready: n.ready,
      ...nearWords(n, n.day === today ? "today" : weekdayOf(n.day)),
    }
    : null;

  const crew: CrewAgain | null = crewRows && crewRows.length > 0
    ? {
      people: crewRows.slice(0, 3).map((r) => ({ bookingId: r.booking_id, workerId: r.worker_id, name: r.name, photo: r.photo })),
      more: Math.max(0, crewRows.length - 3),
      site: crewRows[0].site, rate: Number(crewRows[0].rate), start: crewRows[0].start_time,
    }
    : null;

  return {
    projects, shifts, urgency, owed, invoice, near, crew,
    couldNotCheck: [...new Set([...ranked.unchecked.map((u) => INPUT_WORDS[u]), ...failed])],
  };
}
