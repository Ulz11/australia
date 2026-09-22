/**
 * Everything the worker's Today screen (`app/worker/page.tsx`) needs, counted once, here.
 *
 * Two rules run through it:
 *
 *  - **Money goes through `payForShift()` and nowhere else.** The same 10 h shift at $34 was showing three
 *    different day totals to the same worker: `Calendar.tsx:167` rounds `rate × hours`, `ShiftLive.tsx:73`
 *    multiplies `hours_worked × rate`, `ShiftOffers` asks `payForShift`. Only the last one applies the Award
 *    floor and the overtime split, so the other two are wrong on any day over 8 h or under $35.55 — and a
 *    worker who reads $340 on one screen and $391 on the next has no way to know which one to believe.
 *  - **A count is counted from the rows the rest of the app already reads.** The free-day and card figures
 *    are taken from `openShiftsNear()`'s rows rather than from a second SELECT with its own idea of which
 *    shifts are near, so this screen and the map can never disagree about how many jobs are out there.
 *
 * The day is the *site's* day wherever a site is on the row (lib/siteClock.ts): a Perth job rolls over three
 * hours after a Sydney one, and CURRENT_DATE here was yesterday until 10am. The free-day window is the
 * worker's own week, because it spans every site at once and belongs to the person, not to a job.
 */
import { sql } from "./db";
import { TICKETS } from "./award";
import { payForShift, hoursUntil, type OtTerms } from "./rules";
import { siteToday, APP_TZ } from "./siteClock";
import { todayIso } from "./util";
import { offersFor } from "./workerQueries";

/** One window for both free-day figures: cell 4 counts the days, cell 6 says the same number in words. */
export const WEEK_DAYS = 7;
/** A card is worth a cell this far out. Past the day itself it stays, and turns from soft to warn. */
export const CARD_SOON_DAYS = 30;
/** Three offers, because the fourth is below the fold on a 375×667 phone and the race is decided above it. */
export const MAX_OFFERS = 3;
/** An offer this close to its start is drawn `.cell-soft` — it is nearly not an offer any more. */
export const OFFER_SOON_HOURS = 1;

// ─────────────────────────────────────────────────────────────── today's and tomorrow's shift

type BookingRow = {
  id: string; status: string; day: string; start_time: string;
  hours: string; rate: string; role: string; note: string | null;
  ot_mode: OtTerms["ot_mode"]; ot_after_hours: string; ot_multiplier: string | null;
  site: string; address: string; tz: string; lat: number; lng: number; dist_m: number | null;
  boss_id: string; boss_name: string; boss_phone: string; company: string | null;
  clock_in_at: Date | null; clock_out_at: Date | null; clock_in_dist_m: number | null;
  hours_worked: string | null; hours_approved: string | null;
  is_today: boolean;
};

export type Shift = {
  id: string; status: string; day: string; start: string; hours: number; rate: number;
  role: string; note: string | null; site: string; address: string; lat: number; lng: number;
  distM: number | null; bossId: string; bossName: string; bossPhone: string; company: string | null;
  clockInAt: Date | null; clockOutAt: Date | null; clockInDistM: number | null;
  hoursWorked: number | null; hoursApproved: number | null;
  /** The site's zone, and the city out of it — "Perth" — for the screens that have to name the clock. */
  tz: string; clockCity: string | null;
  /** What this day is worth on the terms agreed when the shift was posted. Never hours × rate. */
  pay: number;
};

/**
 * "Australia/Perth" → "Perth", and null when the site keeps the same clock as the app. A start time is
 * read as the reader's own clock unless something says otherwise, so a 6:30 start on a Perth job has to
 * carry the word "Perth" or it is three hours wrong to everyone reading it in Sydney.
 */
export const clockCity = (tz: string, appTz = APP_TZ): string | null =>
  !tz || tz === appTz ? null : (tz.split("/").pop() ?? tz).split("_").join(" ");

const num = (v: string | number | null | undefined) => (v == null ? 0 : Number(v));

const toShift = (r: BookingRow): Shift => {
  const hours = num(r.hours), rate = num(r.rate);
  const terms: OtTerms = { ot_mode: r.ot_mode, ot_after_hours: r.ot_after_hours, ot_multiplier: r.ot_multiplier };
  return {
    id: r.id, status: r.status, day: r.day, start: r.start_time.slice(0, 5), hours, rate,
    role: r.role, note: r.note, site: r.site, address: r.address, lat: r.lat, lng: r.lng,
    distM: r.dist_m, bossId: r.boss_id, bossName: r.boss_name, bossPhone: r.boss_phone, company: r.company,
    clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, clockInDistM: r.clock_in_dist_m,
    hoursWorked: r.hours_worked == null ? null : num(r.hours_worked),
    hoursApproved: r.hours_approved == null ? null : num(r.hours_approved),
    tz: r.tz, clockCity: clockCity(r.tz),
    pay: payForShift(hours, rate, terms).gross,
  };
};

/**
 * The two days this screen is about, on each site's own clock. `myBookings()` would do it, but it hands
 * back every booking this worker has ever had to answer a question about two days, and it can't see
 * `projects.tz` — which is the column that decides which two days those are.
 *
 * `agreed_*` beats the posted shift: a worker who asked for $42 and got it is owed $42, and the screen
 * that tells them what tomorrow is worth has to use the number they agreed on.
 */
async function twoDays(workerId: string) {
  return sql<BookingRow[]>`
    SELECT b.id, b.status, s.day::text AS day, COALESCE(b.agreed_start, s.start_time)::text AS start_time,
           COALESCE(b.agreed_hours, s.hours) AS hours, COALESCE(b.agreed_rate, s.rate) AS rate,
           s.role, s.note, s.ot_mode, s.ot_after_hours, s.ot_multiplier,
           p.name AS site, p.address, p.tz, ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng,
           CASE WHEN w.home IS NULL THEN NULL ELSE ST_Distance(p.location, w.home)::int END AS dist_m,
           s.boss_id, us.name AS boss_name, us.phone AS boss_phone, bo.company,
           b.clock_in_at, b.clock_out_at, b.clock_in_dist_m, b.hours_worked, b.hours_approved,
           s.day = ${siteToday(sql`p.tz`)} AS is_today
    FROM bookings b
    JOIN shifts s ON s.id = b.shift_id
    JOIN projects p ON p.id = s.project_id
    JOIN workers w ON w.user_id = b.worker_id
    JOIN users us ON us.id = s.boss_id JOIN bosses bo ON bo.user_id = s.boss_id
    WHERE b.worker_id = ${workerId}
      AND b.status IN ('accepted','clocked_in','clocked_out')
      AND s.day >= ${siteToday(sql`p.tz`)} AND s.day <= ${siteToday(sql`p.tz`)} + 1
    ORDER BY s.day, start_time`;
}

// ───────────────────────────────────────────────────────────────────────────── owed to me

export type Owed = {
  /** Dollars, through payForShift — the sum a boss has approved and not yet paid. */
  dollars: number;
  bosses: number;
  /** When the oldest of them approved the hours, so the cell can say how long it has been sitting there. */
  since: Date | null;
};

type OwedRow = {
  hours_approved: string | null; rate: string; approved_at: Date | null; boss_id: string;
  ot_mode: OtTerms["ot_mode"]; ot_after_hours: string; ot_multiplier: string | null;
};

/**
 * Approved and not yet paid. `paid` is its own status, so "approved" already means the money is still
 * owed — and every row is priced by the terms on its own shift, not by one rate applied to a total,
 * which is how a fortnight with one long day comes out short.
 */
async function owedToMe(workerId: string): Promise<Owed> {
  const rows = await sql<OwedRow[]>`
    SELECT b.hours_approved, COALESCE(b.agreed_rate, s.rate) AS rate, b.approved_at, s.boss_id,
           s.ot_mode, s.ot_after_hours, s.ot_multiplier
    FROM bookings b JOIN shifts s ON s.id = b.shift_id
    WHERE b.worker_id = ${workerId} AND b.status = 'approved'`;
  let dollars = 0, since: Date | null = null;
  const bosses = new Set<string>();
  for (const r of rows) {
    dollars += payForShift(num(r.hours_approved), num(r.rate),
      { ot_mode: r.ot_mode, ot_after_hours: r.ot_after_hours, ot_multiplier: r.ot_multiplier }).gross;
    bosses.add(r.boss_id);
    if (r.approved_at && (!since || r.approved_at < since)) since = r.approved_at;
  }
  return { dollars: Math.round(dollars * 100) / 100, bosses: bosses.size, since };
}

// ────────────────────────────────────────────────────────────────── free days, and being seen

export type FreeDay = { day: string; free: boolean; booked: boolean; jobs: number };
export type FreeDays = {
  /** Days in the next week this worker is free on and has nothing booked. */
  free: number;
  /** Open shifts near them, on those days, that they hold the cards for. The reason a free day matters. */
  jobs: number;
  /** Whether a boss can find them at all: matching needs a home on the row before anything else. */
  hasHome: boolean;
  days: FreeDay[];
};

type FreeRow = { day: string; free: boolean | null; booked: boolean; has_home: boolean };

/** The shape this file needs out of `openShiftsNear()` — a row of it, and nothing it doesn't read. */
export type NearShift = {
  day: string; spots: number; taken: number; mine: boolean; tickets_ok: boolean; tickets_required: string[];
};

/** Still going: a spot left, and not one this worker is already on. */
const takeable = (s: NearShift) => !s.mine && Number(s.taken) < Number(s.spots);

/**
 * `worker_free()` (migration 017) and nothing else decides whether a day is free — an explicit answer, or
 * the usual week while the worker is still opening the app. A second implementation of that rule is how
 * the calendar, the map and matching would start showing three different answers for one Tuesday.
 */
const freeRows = (workerId: string, today: string) => sql<FreeRow[]>`
    SELECT d::date::text AS day,
           worker_free(${workerId}, d::date) AS free,
           EXISTS (SELECT 1 FROM bookings b JOIN shifts s ON s.id = b.shift_id
                   WHERE b.worker_id = ${workerId} AND s.day = d::date
                     AND b.status IN ('accepted','clocked_in','clocked_out','approved','paid')) AS booked,
           w.home IS NOT NULL AS has_home
    -- ::int, and it is not decoration. An untyped parameter beside \`date + $n\` leaves Postgres choosing
    -- between date + integer and date + interval, and it refuses: "operator is not unique: date + unknown".
    -- Uncast, this threw on every load and took the whole worker home screen down with it.
    FROM generate_series(${today}::date, ${today}::date + ${WEEK_DAYS - 1}::int, interval '1 day') d, workers w
    WHERE w.user_id = ${workerId}
    ORDER BY d`;

function countFree(rows: FreeRow[], near: NearShift[]): FreeDays {
  const jobsOn = new Map<string, number>();
  for (const s of near) if (takeable(s) && s.tickets_ok) jobsOn.set(s.day, (jobsOn.get(s.day) ?? 0) + 1);
  const days = rows.map((r) => ({
    day: r.day, free: r.free === true, booked: r.booked, jobs: jobsOn.get(r.day) ?? 0,
  }));
  const open = days.filter((d) => d.free && !d.booked);
  return {
    free: open.length,
    jobs: open.reduce((a, d) => a + d.jobs, 0),
    hasHome: rows[0]?.has_home ?? false,
    days,
  };
}

// ──────────────────────────────────────────────────────────────────────────────── your card

export type CardDue = {
  kind: string;
  /** "White Card" — the name printed on it, which stays in English in every language. */
  name: string;
  expiresOn: string;
  /** Days until it runs out; negative once it has. */
  days: number;
  expired: boolean;
  /** Open jobs near them that ask for this card — what the expiry actually costs. */
  jobs: number;
};

type LicenceRow = { kind: string; expires_on: string };

/**
 * The card that runs out first, inside a month, or one that already has. Nothing here is a warning about
 * paperwork: the sentence it carries is how many jobs near this worker ask for that card, because that is
 * what an expired card is — work that stops being offered, quietly, by a query.
 */
const licenceDue = (workerId: string, today: string) => sql<LicenceRow[]>`
    SELECT kind, expires_on::text AS expires_on FROM licences
    WHERE worker_id = ${workerId} AND expires_on IS NOT NULL
      AND expires_on <= ${today}::date + ${CARD_SOON_DAYS}::int
    ORDER BY expires_on LIMIT 1`;

function cardDue(l: LicenceRow | undefined, near: NearShift[], today: string): CardDue | null {
  if (!l) return null;
  const days = Math.round((Date.parse(l.expires_on + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);
  return {
    kind: l.kind, name: TICKETS[l.kind] ?? l.kind, expiresOn: l.expires_on, days, expired: days < 0,
    jobs: near.filter((s) => takeable(s) && s.tickets_required.includes(l.kind)).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────── the screen

export type TodayOffer = {
  id: string; day: string; start: string; hours: number; rate: number; role: string;
  site: string; suburb: string; distM: number | null;
  /** The day's money, through payForShift, so the offer and the shift screen agree before it is taken. */
  pay: number;
  spots: number; taken: number; lastSpot: boolean;
  ticketsOk: boolean; missing: string[]; clash: boolean;
  /** Starting inside the hour: the offer is nearly gone, and the cell says so in words as well as colour. */
  soon: boolean;
};

export type WorkerToday = {
  /** On site today, or about to be: the screen becomes this one shift and nothing else. */
  live: Shift | null;
  tomorrow: Shift | null;
  offers: TodayOffer[];
  /** Offers past the three that fit, so the heading can still count them all. */
  offersTotal: number;
  /** Every shift still offered to this worker, three shown or not — see the `gone` note in the page. */
  offerIds: string[];
  owed: Owed;
  free: FreeDays;
  card: CardDue | null;
};

/**
 * `near` is `openShiftsNear()`'s rows, which the page already has for its calendar. Passing them in rather
 * than asking again means the "11 jobs near you" on this screen is the same eleven jobs the map draws —
 * and costs nothing, because the query has already run. It takes the promise as happily as the rows, so
 * every statement on this screen still leaves in one batch (lib/db.ts) instead of waiting its turn.
 */
export async function workerToday(
  workerId: string, nearIn: NearShift[] | Promise<NearShift[]>, today = todayIso(),
): Promise<WorkerToday> {
  const now = new Date();
  const [days, owed, freeD, licence, offers, near] = await Promise.all([
    twoDays(workerId),
    owedToMe(workerId),
    freeRows(workerId, today),
    licenceDue(workerId, today),
    offersFor(workerId),
    nearIn,
  ]);
  const free = countFree(freeD, near);
  const card = cardDue(licence[0], near, today);

  const shifts = days.map(toShift);
  const rows = days.map((d, i) => ({ row: d, shift: shifts[i] }));
  // "Live" stops at clock-out on purpose. A shift that is done no longer owns the screen, because the
  // offers under it are a race a worker can still win at two in the afternoon — and the hours that just
  // went to the boss are already said on /worker/shift.
  const live = rows.find((r) => r.row.is_today && ["accepted", "clocked_in"].includes(r.shift.status))?.shift ?? null;
  const tomorrow = rows.find((r) => !r.row.is_today)?.shift ?? null;

  const all: TodayOffer[] = offers.map((o) => {
    const hours = num(o.hours), rate = num(o.rate);
    const terms: OtTerms = { ot_mode: o.ot_mode as OtTerms["ot_mode"], ot_after_hours: o.ot_after_hours, ot_multiplier: o.ot_multiplier };
    return {
      id: o.id, day: o.day, start: o.start_time.slice(0, 5), hours, rate, role: o.role,
      site: o.site,
      // A worker knows the suburb, not the street: "212 Marrickville Rd, Marrickville" → "Marrickville".
      suburb: (o.address ?? "").split(",").pop()?.trim() || o.site,
      distM: o.dist_m, pay: payForShift(hours, rate, terms).gross,
      spots: o.spots, taken: o.taken, lastSpot: o.spots - o.taken === 1 && o.spots > 1,
      ticketsOk: o.tickets_ok, missing: o.missing, clash: o.clash,
      // The site's own clock arrives with projects.tz on this query (build order 28-30); until then an
      // offer's countdown is read on the app's clock, which is right for everything east of Adelaide.
      soon: hoursUntil({ day: o.day, start_time: o.start_time }, now) <= OFFER_SOON_HOURS,
    };
  });

  return {
    live, tomorrow, offers: all.slice(0, MAX_OFFERS), offersTotal: all.length,
    offerIds: all.map((o) => o.id), owed, free, card,
  };
}
