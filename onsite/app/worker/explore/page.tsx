import { MapPin } from "lucide-react";
import Link from "next/link";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Cell, Say } from "@/components/ui";
import { RangeBar } from "@/components/cells";
import { AWARD_CASUAL_FLOOR, money, TICKETS } from "@/lib/award";
import { median, SMALL_N } from "@/lib/profileStats";
import { siteToday } from "@/lib/siteClock";
import { numOrNull } from "@/lib/util";
import { openShiftsNear } from "@/lib/workerQueries";
import { getT } from "@/lib/i18n/server";
import { plural } from "@/lib/i18n";
import { Explore } from "./Explore";
export const dynamic = "force-dynamic";

/**
 * MAP — the tab a worker opens to answer one question: is there work near me, and if not, why not.
 *
 * THE MAP IS NOT THE SCREEN. NEXT_PUBLIC_TILE_URL is unset, so components/MapPicker.tsx draws from
 * tile.openstreetmap.org, whose usage policy rules out being the first paint of a commercial app — and a
 * raster tile on a lunch-shed 3G phone is 300 kB of map library loaded before a single job is named. So
 * every answer on this screen is a cell, the map stays exactly where it was inside Explore.tsx as an
 * opt-in below them, and nothing here needs a tile to be read.
 *
 * THE THREE CELLS ABOVE IT ARE THE THREE REASONS THE LIST IS SHORT, which is the whole point:
 *  - the rate you were last paid, against what jobs near you are actually being paid;
 *  - how many more jobs one more step of travel would put in the list, counted rather than guessed;
 *  - the card a nearby job asks for and you do not hold, which is the silent one — a ticket-blocked shift
 *    is subtracted from the list with nothing on screen ever saying that it happened.
 *
 * NULLS, NEVER ZEROES. Each of the three extra statements answers `null` when it throws, and its cell says
 * "Couldn't check just now." A zero and a query that fell over look identical on a tile and mean opposite
 * things: "nobody near you is paid more than you" and "we have no idea what anybody is paid" must not
 * share a pixel. Nothing here renders a range it could not reach as a confident one.
 *
 * ONE ORANGE, AND IT IS THE CARD. Orange goes to the missing-card cell because that is the only thing on
 * this screen quietly costing the worker jobs that no other line can tell them; it is drawn only when a job
 * near them is genuinely blocked, so most workers see no orange here at all. An offered shift is real, but
 * it is already in the list with its own words, so it takes the volume step down (`cell-soft`) — a list of
 * six oranges is six things that all claim to mean "now" and therefore none that does.
 */

/** The market window, and the cell says it in words ("the last two months"). These two move together. */
const RATE_WINDOW_DAYS = 60;

/** One press of the lever, and the label is literally "+5 km". This number and that word move together. */
const STEP_KM = 5;

/** What actions/worker.ts clamps radius_km to. At the ceiling the lever has nowhere to go and says so. */
const MAX_RADIUS_KM = 100;

export default async function ExplorePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const u = await requireRole("worker");
  const t = await getT();
  const { q } = await searchParams;
  const [[w], shifts, sites, nearPaid, lastPaid, ring] = await Promise.all([
    sql`SELECT ST_Y(home::geometry) AS lat, ST_X(home::geometry) AS lng, radius_km, tickets FROM workers WHERE user_id = ${u.id}`,
    openShiftsNear(u.id, { q }),
    sql`SELECT p.id, p.name, ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng
        FROM projects p, workers w WHERE w.user_id = ${u.id} AND NOT p.archived AND w.home IS NOT NULL AND ST_DWithin(w.home, p.location, w.radius_km * 1000)`,

    /**
     * What jobs near this worker were ACCEPTED at — never what open shifts are asking.
     *
     * Open shifts are systematically the unattractive tail of the market: the well-paid ones fill and leave
     * the pool, so a range built from them would tell a worker the market pays less than it does, on this
     * of all screens. `COALESCE(b.agreed_rate, s.rate)` is the figure the two sides actually shook on.
     *
     * Their own bookings are left out. A worker with four jobs on the record would otherwise be compared
     * largely against themselves, and the bar would confirm whatever they already ask for.
     *
     * Roles: the trades they have been booked for, plus the ones they ticked. A worker with neither gets
     * the unfiltered market rather than an empty cell — the honest reading of "we don't know your trade".
     */
    sql<{ rate: string }[]>`
      WITH me AS (SELECT home, radius_km FROM workers WHERE user_id = ${u.id} AND home IS NOT NULL),
           my_roles AS (
             SELECT DISTINCT s.role AS role FROM bookings b JOIN shifts s ON s.id = b.shift_id
              WHERE b.worker_id = ${u.id} AND b.status NOT IN ('removed','cancelled')
             UNION
             SELECT DISTINCT unnest(trades) FROM workers WHERE user_id = ${u.id})
      SELECT COALESCE(b.agreed_rate, s.rate)::text AS rate
        FROM bookings b
        JOIN shifts s ON s.id = b.shift_id
        JOIN projects p ON p.id = s.project_id AND NOT p.archived
        CROSS JOIN me
       WHERE b.worker_id <> ${u.id} AND b.status NOT IN ('removed','cancelled')
         AND ST_DWithin(me.home, p.location, me.radius_km * 1000)
         -- Today on the SITE's clock, both ends: CURRENT_DATE here is yesterday until 10am (lib/siteClock.ts).
         AND s.day <= ${siteToday(sql`p.tz`)}
         AND s.day >= ${siteToday(sql`p.tz`)} - ${RATE_WINDOW_DAYS}::int
         AND (NOT EXISTS (SELECT 1 FROM my_roles) OR s.role IN (SELECT role FROM my_roles))`
      .catch(() => null),

    /**
     * The worker's own mark on that bar: the rate on their most recent job, agreed rate first.
     *
     * The most recent rather than their median, because it is the one figure they can check against their
     * own memory — and there is no asking-rate column on `workers` to read instead. A worker who has never
     * been booked gets no mark and is told so, rather than being parked on the median, which would be both
     * an invented number and the exact nudge this cell is forbidden to make.
     */
    sql<{ rate: string }[]>`
      SELECT COALESCE(b.agreed_rate, s.rate)::text AS rate
        FROM bookings b JOIN shifts s ON s.id = b.shift_id
       WHERE b.worker_id = ${u.id} AND b.status NOT IN ('removed','cancelled')
       ORDER BY s.day DESC, b.created_at DESC LIMIT 1`
      .catch(() => null),

    /**
     * The lever's consequence, counted: the jobs in the ring between today's radius and five more km.
     *
     * Every gate `openShiftsNear()` applies is repeated here — open, site not archived, not somebody else's
     * direct booking, on or after the site's own today, no block between that boss and this worker — because
     * a count looser than the list promises jobs the list would then refuse to show. It is a second
     * statement rather than a second call because `openShiftsNear()` takes no radius, and widening it is
     * lib/workerQueries.ts's decision to make, not this screen's. Shifts they are already on are excluded:
     * "4 more jobs" has to mean four they could take.
     */
    sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
        FROM workers w
        JOIN projects p ON NOT p.archived
        JOIN shifts s ON s.project_id = p.id AND s.status = 'open'
                     AND (s.direct_worker_id IS NULL OR s.direct_worker_id = w.user_id)
       WHERE w.user_id = ${u.id} AND w.home IS NOT NULL
         AND s.day >= ${siteToday(sql`p.tz`)}
         AND ST_DWithin(w.home, p.location, (w.radius_km + ${STEP_KM}::int) * 1000)
         AND NOT ST_DWithin(w.home, p.location, w.radius_km * 1000)
         AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE bl.boss_id = s.boss_id AND bl.worker_id = w.user_id)
         AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.shift_id = s.id AND b.worker_id = w.user_id
                                                    AND b.status NOT IN ('removed','cancelled'))`
      .catch(() => null),
  ]);
  if (!w?.lat) return (<><Header title={t("Map")} /><Page><Link href="/worker/me/settings" className="block"><Say tone="orange" icon={MapPin} title={t("Tell us where you live")} sub={t("Tap here. Then the map shows jobs near you.")} /></Link></Page></>);

  const radiusKm = Number(w.radius_km);
  const have: string[] = w.tickets ?? [];

  // ── your rate, against what is actually being paid around you ───────────────
  const paid = nearPaid?.map((r) => Number(r.rate)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b) ?? null;
  const you = lastPaid?.length ? Number(lastPaid[0].rate) : null;
  const low = paid?.length ? paid[0] : null;
  const high = paid?.length ? paid[paid.length - 1] : null;
  const med = paid ? median(paid) : null;
  /**
   * A band and a midpoint need a denominator worth one. Four figures are listed as four figures instead —
   * drawn as a range they would be a band two numbers wide with its own median sitting on one of them, and
   * the drawing would be the claim however carefully the caption was worded.
   */
  const band = paid != null && paid.length >= SMALL_N && low != null && high != null && med != null;
  const yourLine = you == null
    ? <span className="c-prose">{t("You haven't been booked yet.")}</span>
    : <span className="num">{t("Your last job: {rate} an hour", { rate: money(you) })}</span>;

  // ── the lever, and what pulling it would actually do ────────────────────────
  const more = ring ? Number(ring[0]?.n ?? 0) : null;
  const atCeiling = radiusKm >= MAX_RADIUS_KM;

  // ── the cards nearby jobs ask for and this worker does not hold ─────────────
  // Counted off the rows openShiftsNear() already returned rather than by a query of its own, so this cell
  // and the list below it can never end up disagreeing about which jobs are out there.
  const blocking = new Map<string, number>();
  for (const s of shifts)
    if (!s.mine && !s.tickets_ok)
      for (const k of s.tickets_required ?? []) if (!have.includes(k)) blocking.set(k, (blocking.get(k) ?? 0) + 1);
  const cards = [...blocking].sort((a, b) => b[1] - a[1]);
  const worst = cards[0];

  return (
    <>
      <Header title={t("Map")} />
      <Page>
        {/*
          THREE ANSWERS, THREE SHAPES. The rate band is the hero and takes the full width, because it is the
          only one of the three that is a drawing and a 139px column cannot hold a range. The lever and the
          blocking card are a 1x1 pair beneath it, interlocked into one grid row instead of stacking two more
          full-width slabs. Both of them keep their whole sentence rather than being cut to a bare figure:
          "3" under the label "+5 km" is a number whose noun the reader has to guess, and this is the screen
          a worker opens to find out why the list is short. Size carries the hierarchy here; the words stay.
        */}
        <div className="bento">
          {/*
            YOUR RATE VS JOBS NEAR YOU. `viz` flips the tile: the label sits on top and the band takes every
            pixel underneath, so the drawing IS the tile rather than a strip under a caption. The median tick
            is information and is never said as advice — nothing here tells a worker what to ask for. Quietly
            walking every labourer on the app toward the middle of their own suburb is the single worst thing
            this screen could do to the people reading it.
          */}
          {paid === null ? (
            <Cell span={2} label={t("Your rate vs jobs near you")}
              sub={<span className="c-prose">{t("Couldn't check just now.")}</span>} />
          ) : (
            <Cell viz span={2} rows={1} label={t("Your rate vs jobs near you")}
              sub={band ? (
                <>
                  <div className="num">{t("Paid near you: {low} to {high}", { low: money(low!), high: money(high!) })}</div>
                  {yourLine}
                </>
              ) : yourLine}
              /* The sentence replaces the bar, so it is set only where there IS a bar: under five figures the
                 cell is already words, and aria-hiding them would leave a screen reader only the label. */
              sr={band && you != null
                ? t("Your last job paid {you} an hour. {n} jobs like yours near you were paid {low} to {high} in the last two months; half were above {med}.",
                  { you: money(you), n: paid.length, low: money(low!), high: money(high!), med: money(med!) })
                : undefined}>
              {band && you != null ? (
                <RangeBar className="w-full" low={low!} med={med!} high={high!} you={you} floor={AWARD_CASUAL_FLOOR} n={paid.length} />
              ) : band ? null : (
                <div className="c-sub num">
                  {paid.length === 0
                    ? t("No jobs like yours near you in the last two months.")
                    : t("Paid near you lately: {list}", { list: paid.map(money).join(", ") })}
                </div>
              )}
            </Cell>
          )}

          {/*
            +5 KM — a setting that states, on itself, what changes if you press it, counted, in jobs.
            No href when the answer is nought: a lever that opens a settings screen to achieve nothing is
            worse than no lever at all, because the worker spends the whole trip finding that out.
          */}
          {more === null ? (
            <Cell label={t("+5 km")} sub={<span className="c-prose">{t("Couldn't check just now.")}</span>} />
          ) : atCeiling ? (
            <Cell label={t("As far as it goes")}
              sub={<span className="num c-prose">{t("You look {km} km out now.", { km: radiusKm })}</span>} />
          ) : (
            <Cell href={more > 0 ? "/worker/me/settings" : undefined} label={t("+5 km")}
              sub={
                <>
                  <div className="num">
                    {more > 0
                      ? plural(t, more, "{n} more job would show up", "{n} more jobs would show up")
                      : t("No more jobs out that far.")}
                  </div>
                  <div className="num c-prose">{t("You look {km} km out now.", { km: radiusKm })}</div>
                </>
              } />
          )}

          {/*
            THE ONE ORANGE. A ticket-blocked shift is the commonest silent reason a worker sees no work: it
            is quietly subtracted from the list and nothing else on the screen admits that it happened.
            One column, because the count of jobs it is costing them and the name of the card is the whole
            message — and because a full-width orange slab beside nothing reads as the screen's banner rather
            than as one of its answers.
          */}
          {worst && (
            <Cell tone="needs" href="/worker/me/settings" label={t("A card is blocking work")}
              sub={
                <>
                  <div className="num">
                    {plural(t, worst[1], "{n} job near you needs {card}", "{n} jobs near you need {card}",
                      { card: TICKETS[worst[0]] ?? worst[0] })}
                  </div>
                  {cards.length > 1 && (
                    <div className="num">{plural(t, cards.length - 1, "and {n} more card", "and {n} more cards")}</div>
                  )}
                </>
              } />
          )}
        </div>

        <Explore home={[w.lng, w.lat]} radiusKm={radiusKm} q={q ?? ""}
          sites={sites.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }))}
          shifts={shifts.map((s) => ({ id: s.id, project_id: s.project_id, day: s.day, start_time: s.start_time, hours: Number(s.hours), rate: Number(s.rate), role: s.role, site: s.site, dist_m: s.dist_m, boss: s.company || s.boss_name, spots: s.spots, taken: s.taken, tickets_ok: s.tickets_ok, notified: s.notified, mine: s.mine, tickets_required: s.tickets_required, approve_h: numOrNull(s.approve_hours_avg), pay_d: numOrNull(s.pay_days_avg), ot_mode: s.ot_mode, ot_after_hours: Number(s.ot_after_hours), ot_multiplier: s.ot_multiplier == null ? null : Number(s.ot_multiplier), allow_offers: s.allow_offers, offered: s.offered, avail: s.avail }))} />
      </Page>
    </>
  );
}
