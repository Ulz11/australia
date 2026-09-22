import { CircleAlert } from "lucide-react";
import { requireRole } from "@/lib/session";
import { Empty, Header, Page } from "@/components/Header";
import { Avatar, BigMoney, Cell, Flag, Row, Section, type CellTone, type Tone } from "@/components/ui";
import { AgeBar, Pips, SegmentBar, type Segment } from "@/components/cells";
import { Heatmap } from "@/components/Heatmap";
import { MonthBars, bestMonth } from "@/components/MonthBars";
import { RecordTiles } from "@/components/RecordTiles";
import { Facts } from "@/components/Facts";
import { Milestones } from "@/components/Milestones";
import { CallLink } from "@/components/CallLink";
import { InviteLink } from "./InviteLink";
import { ShiftRow, wantsAnAnswer } from "./ShiftRow";
import { workerLogCall } from "@/actions/worker";
import { money, TICKETS } from "@/lib/award";
import { payForShift, type OtTerms } from "@/lib/rules";
import { addDays, fmtDay, todayIso, TZ } from "@/lib/util";
import { daysOn, median, SETTLED, SMALL_N, weekStreak, workerRecord, type HistoryRow, type LicenceRow } from "@/lib/profileStats";
import { getLang, getT } from "@/lib/i18n/server";
import { LOCALES, plural, type T } from "@/lib/i18n";
export const dynamic = "force-dynamic";

/**
 * THE WORKER'S OWN RECORD — the one portable thing a casual has.
 *
 * Five years across thirty bosses leaves a labourer with nothing to show for it: no payslip trail they can
 * hold, no reference they own, no proof they turned up. `workerRecord()` (lib/profileStats.ts) is that proof,
 * and this screen is where they read it. It is also where "Owed to me" lives, which is the number people
 * actually open the app for — so that is the one ink cell, and ink means press-me, so it goes somewhere.
 *
 * EVERY WORD GOES THROUGH t(). /worker, /worker/explore and /worker/shift all run six languages and this
 * screen used to be hardcoded English — which meant a Nepali labourer could find a job and clock into it in
 * Nepali and then hit a wall of English at exactly the screen that says what he is owed. Nothing here is
 * typed as a literal string; `label` strings are kept inside the cell budget (18 characters at 1×1, 40 at
 * 2-wide) in every one of the six, because a 167px cell does not get wider just because Mongolian is longer.
 *
 * NOTHING ON THIS PAGE IS COUNTED BY THIS PAGE, with two exceptions that lib/ cannot answer today and that
 * are both marked below: what unapproved hours are worth, and how fast a particular boss has approved *this*
 * worker before. Both are derived from rows `workerRecord()` already returned — no second query — so the
 * screen can never disagree with /worker or /worker/me/shifts about the same shift.
 */

/**
 * Twenty weeks of grid, not fifty-two, and the number is the width of the hero tile rather than a guess.
 *
 * A 2-wide cell is 311px inside its padding on a 375px phone; at a 15px pitch that is 20.7 weeks, so twenty
 * columns fill the hero edge to edge at very nearly the native 12px day. Fifty-two would be 777px — the
 * heatmap's own source comment admits a year never fits a phone and is a thing you shove along with a thumb,
 * and a year squeezed into 311px is a 4.8px texture, not a record. The record behind it is untouched; this
 * only picks how much is drawn, and the sentence under it names the number so the two can never disagree.
 */
const HEATMAP_WEEKS_ON_PHONE = 20;

/**
 * The fortnight is the worker's OWN last 14 days and is deliberately not lined up with anybody's invoice.
 * Billing periods are anchored to each boss's signup day, so a worker on three bosses sits inside three
 * different cycles; "you and your boss see the same fortnight" would be false for at least two of them and
 * so it is not written anywhere on this screen. The per-boss rows below name each boss separately instead.
 */
const FORTNIGHT_DAYS = 14;

/**
 * When hours nobody has approved turn orange: two days, absolute, for every boss.
 *
 * Not "older than that boss's own average", which is self-referential and inverted — a boss who always
 * approves inside 6 h would trip orange at 7 h while a boss averaging 200 h stayed white at 150 h. That
 * flags the good ones and shields the bad ones. The boss's own pace still gets printed underneath, as
 * information, where it belongs.
 */
const SITTING_DAYS = 2;

/** Whole days between two plain days. Both parse to UTC midnight, so neither can slide a day around midnight. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** "Mar 2026" — how long someone has been here, to the month. A day would be false precision. */
const monthYear = (d: Date | string, locale: string) =>
  new Date(d).toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: TZ });

/** Each shift carries the overtime terms agreed when it was posted; a shift with none is on the Award. */
const ot = (h: HistoryRow): OtTerms =>
  ({ ot_mode: (h.ot_mode ?? "award") as OtTerms["ot_mode"], ot_after_hours: h.ot_after_hours ?? 8, ot_multiplier: h.ot_multiplier });

/**
 * What hours the boss hasn't looked at yet are worth.
 *
 * `workerRecord().gross` answers 0 for these, correctly — it prices `hours_approved` and there isn't one —
 * but a 0 in the fortnight bar would read as "that day paid nothing" when it means "nobody has approved it".
 * Priced through the same `payForShift()` the offer quoted and the boss's approve screen will use, so the
 * three figures agree, and it is only ever drawn under the words "hours not approved yet".
 */
const worth = (h: HistoryRow) =>
  payForShift(Number(h.hours_worked ?? h.hours ?? 0), Number(h.rate), ot(h)).gross;

/**
 * `myBookings()` selects `b.*`, so `approved_at` and `clock_out_at` ride on every row; `HistoryRow` only
 * names the columns the shared shift rows draw. Read defensively rather than by widening a type in lib/ that
 * this screen does not own: if either column ever stops being selected this answers null and the pace line
 * is left off the cell, instead of a 0 h that would read as "this boss approves instantly".
 */
const at = (h: HistoryRow, col: "clock_out_at" | "approved_at"): number | null => {
  const v = (h as unknown as Record<string, unknown>)[col];
  const ms = v == null ? NaN : new Date(v as string | Date).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/**
 * How long this boss has taken to approve THIS worker's hours before — their own experience of the boss, not
 * the site-wide average in `boss_stats`. Under five samples there is no median worth printing, so the cell
 * says how many it has instead of quietly averaging two numbers into a claim about a person.
 */
function pace(rows: HistoryRow[]): { hours: number | null; n: number } {
  const gaps = rows
    .map((h) => {
      const done = at(h, "clock_out_at"), ok = at(h, "approved_at");
      return done != null && ok != null && ok >= done ? (ok - done) / 3_600_000 : null;
    })
    .filter((x): x is number => x != null);
  const m = gaps.length >= SMALL_N ? median(gaps) : null;
  // Floored at 1 h: "approves in about 0 h" is not a sentence, and half an hour rounds to it.
  return { hours: m == null ? null : Math.max(1, Math.round(m)), n: gaps.length };
}

/** Plain words for a card's state. Never says "checked" unless a register check actually ran and matched. */
function cardWords(t: T, l: LicenceRow): { tone: Tone; label: string } {
  switch (l.status) {
    case "verified": return { tone: "green", label: t("Checked") };
    case "not_found": return { tone: "red", label: t("Not on the register") };
    case "expired": return { tone: "red", label: t("Expired") };
    case "mismatch": return { tone: "red", label: t("Name doesn't match") };
    case "checking": return { tone: "grey", label: t("Being checked") };
    default: return { tone: "grey", label: t("Not checked yet") };
  }
}

export default async function Me() {
  const u = await requireRole("worker");
  const [t, lang, r] = await Promise.all([getT(), getLang(), workerRecord(u.id)]);
  const locale = LOCALES[lang];
  const today = todayIso();
  const rel = r.reliability;
  const base = process.env.NEXT_PUBLIC_BASE_URL || "";

  // What they do, in their own order: the trades they have actually been paid for, then what they ticked.
  const doing = (r.trades.length ? r.trades.map((x) => x.role) : r.ticked).slice(0, 2);
  // Only a card a register check actually matched earns the green badge; everything else is in the list below.
  const wc = r.licences.find((l) => l.kind === "WC" && l.status === "verified");

  // ───────────────────────────────────────────────────────────────── owed to me
  const owedTotal = r.owed.reduce((a, b) => a + r.gross(b), 0);
  const oldestOwed = r.owed.reduce<HistoryRow | null>((a, b) => (a == null || b.day < a.day ? b : a), null);

  // ─────────────────────────────────────────────────── money over the fortnight
  const from = addDays(today, -(FORTNIGHT_DAYS - 1));
  const fortnight = r.history.filter((h) => h.day >= from && h.day <= today);
  const sum = (rows: HistoryRow[], of: (h: HistoryRow) => number) => rows.reduce((a, h) => a + of(h), 0);
  const paid = sum(fortnight.filter((h) => h.status === "paid"), r.gross);
  const waiting = sum(fortnight.filter((h) => h.status === "approved"), r.gross);
  const notApproved = sum(fortnight.filter((h) => h.status === "clocked_out"), worth);
  const fortnightTotal = paid + waiting + notApproved;
  const segments: Segment[] = [
    { label: t("Paid"), dollars: paid, tone: "paid" },
    { label: t("Waiting on payment"), dollars: waiting, tone: "owed" },
    { label: t("Hours not approved yet"), dollars: notApproved, tone: "unapproved" },
  ];

  // ──────────────────────────────────────────────── who is sitting on my hours
  // Grouped per boss, not per shift: three shifts with Dave are one phone call, and three rows saying
  // "Dave" would push the other two bosses off a cell that only has room for three.
  const byBoss = new Map<string, { name: string; phone: string; hours: number; oldest: string; bookingId: string }>();
  for (const h of r.history.filter((x) => x.status === "clocked_out")) {
    const hours = Number(h.hours_worked ?? h.hours ?? 0);
    const b = byBoss.get(h.boss_id);
    if (!b) byBoss.set(h.boss_id, { name: h.boss_name, phone: h.boss_phone, hours, oldest: h.day, bookingId: h.id });
    else {
      b.hours += hours;
      if (h.day < b.oldest) { b.oldest = h.day; b.bookingId = h.id; }
    }
  }
  const sitting = [...byBoss]
    .map(([id, b]) => ({
      id, ...b,
      days: Math.max(0, daysBetween(b.oldest, today)),
      // Kept on its own key rather than spread in: `pace()` also answers in hours, and flattening the two
      // would silently print how fast the boss approves where the hours they are sitting on should be.
      pace: pace(r.history.filter((h) => h.boss_id === id && SETTLED.includes(h.status))),
    }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 3);

  /**
   * THE ONE ORANGE ON THIS SCREEN, and it is spent on money already earned that somebody else is holding.
   * A card about to run out is real and gets the volume step below (`soft`); a card that has already run out
   * is not a job to do but a thing that is broken, so it is `warns` — the same shape /worker draws it in.
   */
  const hot = sitting.length > 0 && sitting[0].days >= SITTING_DAYS;

  /**
   * ...and the record below has to honour it too. A shift whose approved hours don't match what the worker
   * recorded draws orange in ShiftRow, and ten of those under an orange cell is four oranges or eleven —
   * which is none. So the colour goes to the newest unanswered one, and only when the cell above has not
   * already taken it. Every other mismatched row is `say-soft`: same words, same buttons, one step down.
   */
  const shown = r.history.slice(0, 10);
  const loudest = hot ? undefined : shown.find(wantsAnAnswer)?.id;

  // ─────────────────────────────────────────────────────────────────── my cards
  const soonest = addDays(today, 30);
  const runOut = r.licences.find((l) => l.status === "expired" || (l.expires_on != null && l.expires_on < today));
  const expiring = runOut ? null : r.licences.find((l) => l.expires_on != null && l.expires_on <= soonest);
  const cardName = (l: LicenceRow) => TICKETS[l.kind] ?? l.kind;
  const cardsTone: CellTone = runOut ? "warns" : expiring ? (hot ? "white" : "soft") : "white";

  // ───────────────────────────────────── days on the tools, the hero tile's worth
  const weeks = r.weeks.slice(-HEATMAP_WEEKS_ON_PHONE);
  const days = daysOn(weeks);
  const streak = weekStreak(weeks);

  const monthsOn = r.since ? Math.floor((Date.parse(today) - new Date(r.since).getTime()) / 2_629_800_000) : 0;

  return (
    <>
      <Header title={t("Me")} />
      <Page>
        <div className="card space-y-2">
          <div className="flex items-center gap-3">
            <Avatar name={r.name || u.name!} photo={r.photo} size={64} />
            <div className="flex-1 min-w-0">
              <div className="text-xl font-extrabold truncate">{r.name || u.name}</div>
              {/* Trade names are data a boss typed, not chrome, so they stay as they were written. */}
              {doing.length > 0 && <div className="text-steel truncate">{doing.join(" · ")}</div>}
            </div>
          </div>
          <div className="num">
            {[
              r.years_exp ? t("{n} yrs on the tools", { n: r.years_exp }) : null,
              r.since ? t("On OnSite since {month}", { month: monthYear(r.since, locale) }) : null,
            ].filter(Boolean).join(" · ")}
          </div>
          {wc && (
            <Flag tone="green">
              {wc.issued_state ? t("White Card checked, {state}", { state: wc.issued_state }) : t("White Card checked")}
            </Flag>
          )}
          {/* Who looked is never said, only how many. The promise is written down on /privacy. */}
          {r.lookers > 0 && (
            <div className="text-steel num">
              {plural(t, r.lookers, "{n} boss looked at your profile this week", "{n} bosses looked at your profile this week")}
            </div>
          )}
        </div>

        {/*
          THE RECORD AS A MOSAIC, and SIZE is the hierarchy.
          What somebody opens the app for is a 2x2 and it is ink, because ink means press-me and it goes
          somewhere. The two reliability figures are a 1x1 pair — a percentage and two words is the whole of
          what they are — and they interlock under the hero rather than each claiming a full-width row. The
          drawings below ARE their tiles: the heatmap, the year of hours and the five things worth reaching
          used to sit as footnotes under their own card headings, which is the shape this replaced.
        */}
        <div className="bento">
          {/*
            OWED TO ME — the number people open the app for, so it leads and it is ink.
            Ink is the press-me colour on every button in the app, so an ink cell that goes nowhere is a lie
            about what happens when you press it: this one opens the full list, where every boss's name, the
            figure they owe and the button that rings them already live. At $0 it drops to white rather than
            offering a black slab with nothing behind it.
          */}
          <BigMoney span={2} rows={2} hero href="/worker/me/shifts"
            tone={owedTotal > 0 ? "ink" : "white"} n={owedTotal} label={t("Owed to me")}
            sub={r.owed.length === 0
              ? <span className="c-prose">{t("When a boss approves your hours, it lands here.")}</span>
              : <>
                  <div>{plural(t, r.owed.length, "{n} shift approved and not paid", "{n} shifts approved and not paid")}</div>
                  {oldestOwed && (
                    <div>{t("Oldest: {name}, {n} days", {
                      name: oldestOwed.boss_name.split(" ")[0],
                      n: Math.max(0, daysBetween(oldestOwed.day, today)),
                    })}</div>
                  )}
                </>}
            sr={r.owed.length === 0
              ? t("Nothing approved and waiting. When a boss approves your hours, it lands here.")
              : t("{total} approved by your bosses and not yet paid, across {n} shifts.", { total: money(owedTotal), n: r.owed.length })} />

          {/*
            WHO'S SITTING ON MY HOURS — only drawn when somebody is. A cell that said "nobody, $0" would be
            the app inventing a number to fill a hole in the grid. Full width and as tall as the list needs:
            each row is a name, an ageing bar and a phone number, and a 56px call button owes the whole width.

            No `sr` prop on this one: Cell hides its whole body from a screen reader the moment `sr` is set,
            and the tap-to-call would go with it. The rows are real text and each ageing bar carries its own
            sentence, so what is spoken is already what is drawn.
          */}
          {sitting.length > 0 && (
            <Cell span={2} tone={hot ? "needs" : "white"} icon={hot ? CircleAlert : undefined}
              label={t("Who's sitting on my hours")}>
              <ul className="space-y-2 min-w-0">
                {sitting.map((b) => (
                  <li key={b.id} className="min-w-0">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="c-label truncate">{b.name.split(" ")[0]}</span>
                      <span className="c-label num shrink-0 ml-auto">
                        {plural(t, Math.round(b.hours * 10) / 10, "{n} hour", "{n} hours")}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 min-w-0">
                      <AgeBar days={b.days} threshold={SITTING_DAYS} className="shrink-0"
                        sr={t("Waiting {n} days. Past two days is worth a call.", { n: b.days })} />
                      <span className="c-sub num mt-0 shrink-0">
                        {plural(t, b.days, "{n} day waiting", "{n} days waiting")}
                      </span>
                    </div>
                    {/* The boss's own pace, as information and never as an excuse for the bar above it. */}
                    <div className="c-sub">
                      {b.pace.hours != null
                        ? t("{name} usually approves in about {n} h", { name: b.name.split(" ")[0], n: b.pace.hours })
                        : t("{n} approved so far with {name} — too few to say how fast.", { n: b.pace.n, name: b.name.split(" ")[0] })}
                    </div>
                    {/* The number, not "Call Dave": the label inside CallLink is English and this screen is not.
                        A phone number with a handset beside it needs no translating at all. */}
                    <CallLink phone={b.phone} onCall={workerLogCall.bind(null, b.id, b.bookingId)}
                      className="btn bg-white text-ink btn-sm w-full mt-1.5" />
                  </li>
                ))}
              </ul>
            </Cell>
          )}

          {/* TURN UP AND ON TIME — a 1x1 pair, side by side, which is the whole reason they were split in
              two: "Turn up and on time" is 19 characters in English and longer in four of the six, and a
              167px cell does not grow to meet it. Apart, every label clears the budget in every language,
              and the two of them interlock into one grid row instead of stacking two full-width slabs. */}
          <Ratio t={t} n={rel.showed} of={rel.past} label={t("Turned up")} caption={t("This is what a boss sees.")}
            sr={rel.past === 0
              ? t("Your first shift starts your record.")
              : t("You turned up to {n} of your last {of} shifts.", { n: rel.showed, of: rel.past })} />

          <Ratio t={t} n={rel.onTime} of={rel.clockIns} label={t("On time")} caption={t("Within ten minutes of the start.")}
            sr={rel.clockIns === 0
              ? t("Your first shift starts your record.")
              : t("You clocked in on time on {n} of your {of} clock-ins, within ten minutes of the start.", { n: rel.onTime, of: rel.clockIns })} />

          {/*
            MONEY THIS FORTNIGHT — one bar in three states, each named in words with its own figure under it.
            States and not categories, which is the only reason it is allowed to be one bar at all: paid,
            approved-and-waiting and not-approved-yet are three points on one journey, so their shares of a
            single bar mean something. A per-boss split would have to be labelled rows instead.

            `viz` puts the label on top and gives the drawing every pixel underneath — the difference between
            a bar wedged under a figure and a bar that is what the tile is for.
          */}
          <Cell viz span={2} rows={2} label={t("Money this fortnight")}
            sub={fortnightTotal === 0 ? <span className="c-prose">{t("Nothing in your last 14 days.")}</span> : undefined}
            sr={fortnightTotal === 0
              ? t("Nothing in your last 14 days.")
              : t("{total} over your last 14 days. {paid} paid, {owed} approved and waiting on payment, {unapproved} in hours the boss hasn't approved yet.",
                  { total: money(fortnightTotal), paid: money(paid), owed: money(waiting), unapproved: money(notApproved) })}>
            {fortnightTotal > 0 && (
              <div className="min-w-0">
                <div className="c-fig-2">{money(fortnightTotal)}</div>
                {/* Empty `sr`, because the cell's own sentence already says all three figures in the reader's
                    language; the bar's English default would otherwise sit in the markup behind it. */}
                <SegmentBar segments={segments} className="mt-2.5" sr="" />
              </div>
            )}
          </Cell>
        </div>

        {/* Four figures, four 1x1s, on a This year / All time switch. They draw their own bento. */}
        <RecordTiles year={tiles(t, r.tiles.year)} all={tiles(t, r.tiles.all)}
          yearLabel={t("This year")} allLabel={t("All time")} lockedSub={t("only you see this")} />

        {/*
          THE DRAWINGS, AS THE TILES. Each of these three renders its own cell: a 2x2 for the days, a 2x1 for
          the year of hours, a 2x2 for the five things worth reaching. None of them is a card with a heading
          and a chart underneath any more — the heading IS the tile's label and the drawing fills what is left.
        */}
        <div className="bento">
          <Heatmap weeks={weeks} span={2} rows={2}
            title={t("Days on the tools")}
            sub={days === 0 ? t("Your first shift starts your record.")
              : streak >= 2 ? plural(t, streak, "{n} week in a row", "{n} weeks in a row") : undefined}
            label={t("{n} days worked in the last {weeks} weeks.", { n: days, weeks: HEATMAP_WEEKS_ON_PHONE })} />

          {r.hours > 0 && <MonthBars span={2} rows={1} title={t("Hours by month")} months={r.months}
            most={t("most: {n}h in {month}", { n: bestMonth(r.months).hours, month: bestMonth(r.months).label })}
            hoursLabel={(month, hours) => t("{month} {n} hours", { month, n: hours })} />}

          {/* Five rows with the width to be read, not five 51px boxes with the label squeezed under the
              app's own text floor. An earned one is a filled ink chip with the mark reversed out of it. */}
          <Milestones span={2} rows={2} title={t("Milestones")} earnedLabel={t("Earned")} items={[
            { key: "first", label: t("First shift"), done: r.shifts >= 1, togo: t("{n} to go", { n: 1 }) },
            { key: "hours", label: t("100 hours"), done: r.hours >= 100, togo: t("{n} to go", { n: Math.ceil(100 - r.hours) }) },
            { key: "sites", label: t("10 sites"), done: r.sites >= 10, togo: t("{n} to go", { n: 10 - r.sites }) },
            { key: "rehires", label: t("5 rehires"), done: r.rehires >= 5, togo: t("{n} to go", { n: 5 - r.rehires }) },
            { key: "year", label: t("1 year on OnSite"), done: monthsOn >= 12, togo: t("in {n} months", { n: Math.max(1, 12 - monthsOn) }) },
          ]} />
        </div>

        {/*
          MY CARDS, AS TILES. One 2x1 that says what to do about them and links to where you do it, then one
          1x1 a card, each carrying its own state as colour + icon + words. This is the list that used to be
          a `.card` of five rows under a heading; as tiles a worker sees at a glance which of them is green
          and which is not, which is the only question anybody asks of this list.

          A card that has run out is not paperwork — it is jobs quietly no longer being offered — so the top
          tile says so and takes the tone. It drops to plain white when the hours cell above is already
          carrying the screen's one orange: two oranges on a screen is none.
        */}
        <div className="bento">
          <Cell span={2} tone={cardsTone} href="/worker/me/edit"
            icon={runOut || (expiring && !hot) ? CircleAlert : undefined}
            label={runOut ? t("{card} has run out", { card: cardName(runOut) })
              : expiring ? t("{card} expires {date}", { card: cardName(expiring), date: fmtDay(expiring.expires_on!, locale) })
              : t("My cards")}
            sub={runOut || expiring ? t("Add the new one.")
              : r.licences.length === 0
                ? <span className="c-prose">{t("Nearly every shift needs a White Card.")}</span>
                : <span className="c-prose">{t("Add or update your cards")}</span>} />

          {r.licences.map((l) => {
            const w = cardWords(t, l);
            // Renewing is not an emergency and is not painted like one: the tile above already carries
            // whichever card actually needs a hand, and orange in a list of five is orange in none of them.
            const renew = w.tone !== "red" && l.expires_on != null && l.expires_on <= soonest;
            return (
              <Cell key={l.kind} label={cardName(l)}
                sub={<span className="c-prose num">
                  {[l.issued_state, l.expires_on ? t("expires {date}", { date: fmtDay(l.expires_on, locale) }) : null]
                    .filter(Boolean).join(" · ") || t("State not given")}
                </span>}>
                {/* max-w-full so a long state ("Not on the register") wraps inside the badge rather than
                    pushing out of a one-column tile. */}
                <Flag tone={renew ? "grey" : w.tone} className="self-start max-w-full">
                  {renew ? t("Renew soon") : w.label}
                </Flag>
              </Cell>
            );
          })}
        </div>

        {/* The portable proof: hours by trade, which is the thing a casual has never been able to carry from
            one boss to the next, and the cards that back them. A list of trades is a list, so it stays one. */}
        <Section title={t("Work passport")} hint={t("Hours by trade, and the cards behind them.")} />
        <Facts facts={[
          ...(r.trades.length
            ? r.trades.map((x) => ({ label: x.role, value: t("{n} h", { n: x.hours }) }))
            : [{ label: t("No hours yet"), value: "—" }]),
          { label: t("Bosses who'd book you again"), value: r.rehires },
        ]} />

        <InviteLink url={`${base}/join/${r.invite_code}`} code={r.invite_code} mates={r.mates} />

        <Section title={t("Shifts")} hint={r.history.length ? t("Newest first.") : undefined} />
        {r.history.length === 0
          ? <Empty>{t("Nothing on the record yet. Your first shift starts it.")}</Empty>
          : <div className="card divide-y divide-line">
              {shown.map((h) => <ShiftRow key={h.id} h={h} t={t} gross={r.gross} loud={h.id === loudest} />)}
            </div>}
        {r.history.length > 10 && <Row href="/worker/me/shifts" title={t("All {n} shifts", { n: r.history.length })} />}

        <Row href="/worker/offers" title={t("My deal requests")} sub={t("Jobs where you asked for different pay or hours.")} />
        <Row href="/worker/me/edit" title={t("Edit profile")} sub={t("Photo, trades, languages, cards.")} />
        <Row href="/worker/me/settings" title={t("Settings")} sub={t("Where you work, alerts, sign-in, sign out.")} />
      </Page>
    </>
  );
}

/**
 * One reliability figure, drawn honestly at the size the sample deserves.
 *
 * Over five samples the percentage leads and the pips sit under it as the count behind it. Under five there
 * is no percentage at all — "2 of 3" is 67% and printing it that way is a claim three shifts cannot carry —
 * so the raw count leads at 16px and the pips are the whole mark. With nothing on the record it says so,
 * which is not the same statement as 0%.
 */
function Ratio({ t, n, of, label, caption, sr }: {
  t: T; n: number; of: number; label: string; caption: string; sr: string;
}) {
  if (of === 0) return <Cell label={label} sub={<span className="c-prose">{t("Your first shift starts your record.")}</span>} />;
  const big = of >= SMALL_N;
  return (
    <Cell label={label} sub={<span className="c-prose">{caption}</span>} sr={sr}>
      <div className="min-w-0">
        <div className={big ? "c-fig" : "c-label num"}>
          {big ? `${Math.round((100 * n) / of)}%` : t("{n} of {of}", { n, of })}
        </div>
        <Pips n={n} of={of} className="mt-1.5" />
      </div>
    </Cell>
  );
}

/** The four tiles, for one span of time. Earned is the only one nobody else ever sees. */
const tiles = (t: T, x: { hours: number; shifts: number; sites: number; earned: number }) => [
  { label: t("Hours"), n: x.hours },
  { label: t("Shifts"), n: x.shifts },
  { label: t("Sites"), n: x.sites },
  { label: t("Earned"), money: x.earned, locked: true },
];
