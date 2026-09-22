import { sql } from "./db";
import { licencesForBoss } from "./bossQueries";
import { TICKETS } from "./award";
import { ON_SITE, SMALL_N, minutesLate, onTime, share } from "./profileStats";
import { siteToday } from "./siteClock";
import { todayIso } from "./util";
import { isExpired, licenceWords, type LicenceStatus } from "./verify";

/**
 * THE CREW BOARD — who in a boss's own crew actually turns up, and whose card is about to stop them.
 *
 * The screen this feeds used to be a list of names, a rate and "60 hours with you". Hours are the one
 * figure a boss already knows off the top of his head; the two he cannot know are whether Sam has ever
 * left him a man short, and whether Dave's forklift ticket ran out last Tuesday. `/boss/workers` was
 * already SELECTing `w.tickets` and throwing it away, so the only way to find an expired card was to open
 * every worker one at a time — which nobody does at 5am with a truck idling at the gate.
 *
 * TURNING UP IS COUNTED TWICE, ON PURPOSE, AND THE TWO ARE NEVER ADDED TOGETHER.
 *  - "with you" is this boss's own bookings. It is the figure a boss is actually asking for, and it is
 *    the only one allowed to carry the words "with you".
 *  - `worker_stats` is the worker's whole record across every boss on OnSite. It is used ONLY for someone
 *    who has no shifts with this boss yet — a crew member imported off a phone last week — and every
 *    sentence built from it says "elsewhere" out loud. Showing another boss's record as this boss's would
 *    be a quiet lie in the one place a boss decides who to put on a truck.
 *
 * RAIN IS NOT A NO-SHOW. A shift with `weather_stop` set is out of the denominator here, exactly as
 * `bossRecord` drops it from its no-show count (lib/profileStats.ts). `worker_stats` does not make that
 * distinction, which is one more reason these two numbers never meet in one sentence.
 *
 * NOTHING HERE IMPLIES ONSITE CHECKED A CARD. There is no national White Card register — verification is
 * per-jurisdiction and lib/verify.ts has the survey — so the overwhelming majority of cards sit at
 * `status = 'unchecked'` forever. Treating unchecked as a problem would paint this screen warm for most of
 * the country on day one and the colour would stop meaning anything by the end of that day. What this
 * module reports is a DATE: a card the worker entered has run out, or is about to. Every word describing a
 * card's state comes from `licenceWords()`, so a card cannot be called one thing here and another on the
 * worker's own screen.
 *
 * NULL MEANS WE COULD NOT CHECK. Every figure below is null when its statement threw, never zero. On a
 * tile "0 cards expiring" and "the licence query timed out" are the same six pixels and opposite facts,
 * and the second one is how a boss sends a man up an EWP on a dead ticket.
 */

/**
 * How far ahead a renewal is worth naming. Sixty days, because renewing through a state regulator means
 * booking onto a course, not filling in a form — a fortnight's notice is not enough to act on. It is a
 * horizon for LISTING, never for colour: the screen's one warm tone is spent only on a card that has
 * already run out under somebody who is on a shift the boss has already booked.
 */
export const CARD_HORIZON_DAYS = 60;

/** Bookings that mean this person is expected on a site the boss has already committed to. */
const COMING = ["accepted", "clocked_in"];

// ──────────────────────────────────────────────────────────────────────────── cards

export type CrewCard = {
  kind: string;
  /** "White Card" — the name printed on it, from lib/award's single list. */
  name: string;
  /** What the cell counts. `ok` covers both "checked and in date" and "on file, nobody can check it". */
  state: "expired" | "expiring" | "ok";
  /** Colour straight out of `licenceWords()`. A second vocabulary for the same card is how they drift. */
  tone: "grey" | "green" | "red";
  /** What the badge on the row says. Always words — the colour is never the message on its own. */
  flag: string;
  /** Days until it runs out; negative once it has; null when the worker gave no date. */
  days: number | null;
  /** No register of ours has ever confirmed this one. Informational — see the file comment. */
  unchecked: boolean;
};

type LicenceRow = { kind: string; issued_state: string | null; expires_on: string | null; status: string; checked_at: string | null };

const daysFrom = (today: string, day: string) =>
  Math.round((Date.parse(day + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);

/** A renewal date said the way a boss says it out loud, rather than as a date he has to subtract from. */
const inWords = (d: number) => (d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);
const agoWords = (d: number) => (d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`);

/**
 * One card, as a boss may see it. `l` is `licencesForBoss()`'s hand-listed columns and nothing else — the
 * card NUMBER and the register's free-text note (which can quote a name) are not selected there, so they
 * cannot reach this function, this page, or the React payload the page ships to a phone.
 */
function cardFrom(l: LicenceRow, today: string): CrewCard {
  const name = TICKETS[l.kind] ?? l.kind;
  const days = l.expires_on ? daysFrom(today, l.expires_on.slice(0, 10)) : null;
  // The stored status and the date routinely disagree: a card checked in March runs out in April without
  // anybody re-checking it. The date wins, because it is the fact, and `isExpired` reads it on the site's
  // clock rather than the server's — a card is good until the end of its last day in Sydney, not in UTC.
  const expired = isExpired(l.expires_on) || l.status === "expired";
  const lw = licenceWords({ ...l, status: (expired ? "expired" : l.status) as LicenceStatus });
  const state: CrewCard["state"] = expired ? "expired"
    : days != null && days <= CARD_HORIZON_DAYS ? "expiring" : "ok";
  const flag = expired ? `${name} expired`
    : state === "expiring" ? `${name} runs out ${inWords(days as number)}`
    // 'not_found' and 'mismatch': a register answered and the answer was bad. The register's own words,
    // lowercased onto the card's name, rather than a fourth phrase in the app for the same fact.
    : lw.tone === "red" ? `${name} — ${lw.label.toLowerCase()}`
    : name;
  return { kind: l.kind, name, state, tone: lw.tone, flag, days, unchecked: l.status === "unchecked" };
}

export type CardsDue = {
  /** Cards run out or running out, worst first. An empty list is a real answer; null is a failed query. */
  due: { workerId: string; first: string; card: string; days: number; expired: boolean; coming: number }[];
  expired: number;
  expiring: number;
  /** Cards on file that no register of ours has ever checked. Never counted as a problem. */
  unchecked: number;
  /** Cards the crew has on file at all, so "nothing expiring" can't be misread as "nothing on file". */
  onFile: number;
  /** Something has ALREADY run out under somebody on a booked shift. The only thing that earns a tone. */
  liveRisk: boolean;
  sentence: string;
  sr: string;
};

// ────────────────────────────────────────────────────────────────────── turning up

/** Turning up, counted against THIS boss's bookings. Never mixed with `worker_stats` — see the file comment. */
export type Reliability = {
  /** Past shifts booked with this boss, rained-off days out. */
  shifts: number;
  showed: number;
  clockIns: number;
  onTime: number;
  /** Said yes and then pulled out. It counts on a record, and it is not the same thing as a no-show. */
  pulled: number;
};

export type CrewMember = {
  id: string;
  name: string;
  type: string;
  /** Null when the boss never set one. Rendered as "no rate set yet", never as $0.00. */
  rate: number | null;
  hours: number;
  /** With this boss. Null when the bookings statement threw. */
  record: Reliability | null;
  /** Booked on a shift that has not happened yet. Null when we could not check. */
  coming: number | null;
  /** Their tickets in the order the worker lists them, plus any card the array missed. */
  cards: CrewCard[] | null;
  /** The turn-up line for this row, with the sites it covers named inside it. */
  turnsUp: string;
};

export type TurnUp = {
  /** Crew who have actually worked for this boss — the "who" half of the spoken sentence. */
  people: number;
  shifts: number;
  showed: number;
  clockIns: number;
  onTime: number;
  pulled: number;
  /** Under the floor the cell shows the raw count and draws pips, never a percentage. */
  small: boolean;
  sentence: string;
  sr: string;
};

export type CrewBoard = {
  crew: CrewMember[] | null;
  turnUp: TurnUp | null;
  cards: CardsDue | null;
  /** In the app's own words, for the line at the foot of the screen. */
  couldNotCheck: string[];
};

// ─────────────────────────────────────────────────────────────────────── the queries

type CrewRow = {
  worker_id: string; type: string; rate: string | null; name: string; tickets: string[];
  past_shifts: string | number | null; st_showed: string | number | null;
};

type BookRow = {
  worker_id: string; status: string; clock_in_at: Date | string | null;
  hours_approved: string | null; day: string; start_time: string;
  weather_stop: string | null; tz: string; past: boolean;
};

const num = (v: unknown) => Number(v ?? 0) || 0;
const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export async function crewBoard(bossId: string): Promise<CrewBoard> {
  const today = todayIso();
  const couldNotCheck: string[] = [];
  /** A statement that throws becomes null and says so in words. It never becomes an empty list. */
  const ask = async <T>(words: string, q: Promise<T>): Promise<T | null> => {
    try { return await q; } catch (e) {
      couldNotCheck.push(words);
      console.error("crew board:", words, (e as Error)?.message);
      return null;
    }
  };

  const [rows, books] = await Promise.all([
    ask("your crew", sql<CrewRow[]>`
      SELECT c.worker_id, c.type, c.rate, us.name, w.tickets,
             st.past_shifts, st.showed AS st_showed
      FROM crew c
      JOIN users us ON us.id = c.worker_id
      JOIN workers w ON w.user_id = c.worker_id
      LEFT JOIN worker_stats st ON st.worker_id = c.worker_id
      WHERE c.boss_id = ${bossId}
      ORDER BY us.name`),

    /**
     * Every booking this crew has ever had with this boss, in one statement rather than one per worker.
     *
     * `agreed_start` before `s.start_time`, because a worker who agreed to a 7am start is not late at 7:05
     * on a shift posted for 6:30 — the same COALESCE `workerRecordForBoss` uses, so the two screens can
     * never call one clock-in on time here and late there.
     *
     * `past` is decided by Postgres against the SITE's zone and not by comparing strings in JavaScript: a
     * Perth job rolls its day over three hours after a Sydney one, and the pooler's session clock is GMT
     * (lib/siteClock.ts has the post-mortem). Get this wrong and this morning's 6:30 start counts as a
     * shift already missed, every morning, until 10am.
     */
    ask("who turned up", sql<BookRow[]>`
      SELECT b.worker_id, b.status, b.clock_in_at, b.hours_approved,
             s.day::text AS day, COALESCE(b.agreed_start, s.start_time)::text AS start_time,
             s.weather_stop, p.tz,
             (s.day < ${siteToday(sql`p.tz`)}) AS past
      FROM bookings b
      JOIN shifts s ON s.id = b.shift_id
      JOIN projects p ON p.id = s.project_id
      JOIN crew c ON c.worker_id = b.worker_id AND c.boss_id = ${bossId}
      WHERE s.boss_id = ${bossId} AND b.status <> 'removed'`),
  ]);

  if (!rows) return { crew: null, turnUp: null, cards: null, couldNotCheck };

  // One statement per worker, through the module that hand-lists the columns a boss may see. A crew is a
  // dozen people, so a dozen indexed lookups (licences_worker_idx) beats writing a second column list
  // here — the way a card number reaches a boss is somebody typing SELECT * in a hurry.
  const licences = await ask("their cards", Promise.all(rows.map((r) => licencesForBoss(r.worker_id))));

  const byWorker = new Map<string, BookRow[]>();
  for (const b of books ?? []) byWorker.set(b.worker_id, [...(byWorker.get(b.worker_id) ?? []), b]);

  const crew: CrewMember[] = rows.map((r, i) => {
    const mine = byWorker.get(r.worker_id) ?? [];
    const hours = round1(mine.filter((b) => b.status === "approved" || b.status === "paid")
      .reduce((a, b) => a + num(b.hours_approved), 0));

    let record: Reliability | null = null;
    let coming: number | null = null;
    if (books) {
      const past = mine.filter((b) => b.past && !b.weather_stop);
      const clockIns = mine.filter((b) => b.clock_in_at != null);
      record = {
        shifts: past.length,
        showed: past.filter((b) => ON_SITE.includes(b.status)).length,
        clockIns: clockIns.length,
        onTime: clockIns.filter((b) => onTime(minutesLate(b.day, b.start_time, b.clock_in_at!, b.tz))).length,
        pulled: mine.filter((b) => b.status === "cancelled").length,
      };
      coming = mine.filter((b) => !b.past && COMING.includes(b.status)).length;
    }

    // A card the worker holds but never listed in `workers.tickets` still shows. That array is the fast
    // path the matching query uses and it can fall behind the licences table; a card disappearing off this
    // screen because two columns disagree is the exact failure this screen exists to end.
    const held = licences?.[i] ?? null;
    const order = [...r.tickets, ...(held ?? []).map((l) => l.kind).filter((k) => !r.tickets.includes(k))];
    const cards: CrewCard[] | null = held === null ? null : order.map((kind) => {
      const l = held.find((x) => x.kind === kind);
      // A ticket claimed with no licence row behind it has no date and no check. It is still shown, and it
      // is counted among the never-checked, because "he says he has a White Card" is the honest reading.
      return l ? cardFrom(l, today)
        : { kind, name: TICKETS[kind] ?? kind, state: "ok" as const, tone: "grey" as const,
            flag: TICKETS[kind] ?? kind, days: null, unchecked: true };
    });

    return {
      id: r.worker_id, name: r.name, type: r.type,
      rate: r.rate == null ? null : Number(r.rate),
      hours, record, coming, cards,
      turnsUp: turnsUpWords(record, num(r.st_showed), num(r.past_shifts)),
    };
  });

  return { crew, turnUp: turnUpFrom(crew, books != null), cards: cardsDue(crew, books != null), couldNotCheck };
}

// ──────────────────────────────────────────────────────────────────────────── words

/**
 * The turn-up line on one crew row. Four sentences, and which one a row gets is decided by how much
 * record there actually is — never by which would fill the line most tidily.
 *
 * `share()` carries the small-number rule in both halves: under five samples it says "3 of 4" rather than
 * 75%, because a boss talked out of booking someone on three data points is the concrete harm here.
 */
function turnsUpWords(r: Reliability | null, elseShowed: number, elsePast: number): string {
  if (!r) return "Couldn't check their record just now";
  const pulled = r.pulled > 0 ? ` · pulled out ${r.pulled}×` : "";
  if (r.shifts >= SMALL_N) return `Turned up ${share(r.showed, r.shifts)} of the time with you · ${plural(r.shifts, "shift")}${pulled}`;
  if (r.shifts > 0) return `Turned up to ${share(r.showed, r.shifts)} shifts with you${pulled}`;
  // Nothing with this boss yet. Their record elsewhere is worth saying — it is part of why matching
  // offered them in the first place — but the word "elsewhere" is load-bearing and never comes off.
  if (elsePast > 0) return `No shifts with you yet · turns up ${share(elseShowed, elsePast)} of the time elsewhere`;
  return "No shifts on the record yet";
}

function turnUpFrom(crew: CrewMember[], booksOk: boolean): TurnUp | null {
  if (!booksOk) return null;
  const have = crew.filter((c) => (c.record?.shifts ?? 0) > 0);
  const sum = (f: (r: Reliability) => number) => have.reduce((a, c) => a + f(c.record as Reliability), 0);
  const shifts = sum((r) => r.shifts);
  const showed = sum((r) => r.showed);
  const clockIns = sum((r) => r.clockIns);
  const on = sum((r) => r.onTime);
  // Pull-outs are counted over the whole crew, not just those with a past shift: someone can say yes and
  // pull out of a shift that has not happened yet, and that is precisely the one a boss wants to know about.
  const pulled = crew.reduce((a, c) => a + (c.record?.pulled ?? 0), 0);

  if (shifts === 0) {
    return {
      people: 0, shifts: 0, showed: 0, clockIns: 0, onTime: 0, pulled, small: true,
      sentence: "Nobody in your crew has worked one of your shifts yet.",
      sr: `There are ${plural(crew.length, "person")} in your crew and none has worked a shift with you yet, so there is nothing to count.`,
    };
  }

  const late = clockIns > 0 ? ` On time for ${share(on, clockIns)} of ${plural(clockIns, "clock-in")}.` : "";
  const out = pulled > 0 ? ` ${plural(pulled, "pull-out")} after booking.` : "";
  return {
    people: have.length, shifts, showed, clockIns, onTime: on, pulled,
    small: shifts < SMALL_N,
    sentence: `${showed} of ${plural(shifts, "shift")} with you.${late}${out}`,
    sr: `Of the ${plural(have.length, "person")} in your crew who have worked for you, they turned up to ${showed} of the ${plural(shifts, "shift")} they booked with you, all time.${late}${out}`,
  };
}

/**
 * What is about to stop somebody working, said as a date and never as a verdict on the worker.
 *
 * Worst first means already-run-out first, then soonest, so the one name in the sentence is the one worth
 * a phone call tonight. An expired card under somebody with no shift booked is still listed and still
 * counted — it just does not earn the warm tone, because there is nobody to take off a truck in the
 * morning and the screen only has one of those to spend.
 */
function cardsDue(crew: CrewMember[], booksOk: boolean): CardsDue | null {
  // One worker's cards missing makes the count wrong in the direction that matters, so the whole cell says
  // it could not check rather than quietly reporting the cards it did manage to read.
  if (crew.some((c) => c.cards === null)) return null;

  const due: CardsDue["due"] = [];
  let unchecked = 0, onFile = 0;
  for (const c of crew) {
    for (const k of c.cards as CrewCard[]) {
      onFile++;
      if (k.unchecked && k.state === "ok") unchecked++;
      // No date means no sentence: "ran out" needs a day to count back from, and inventing one to fill the
      // line is the thing this file exists not to do. The row still shows the card in its own colour.
      if (k.state === "ok" || k.days == null) continue;
      due.push({
        workerId: c.id, first: c.name.split(" ")[0] || c.name, card: k.name,
        days: k.days, expired: k.state === "expired", coming: c.coming ?? 0,
      });
    }
  }
  due.sort((a, b) => a.days - b.days);
  const expired = due.filter((d) => d.expired).length;
  // Only a card that has ALREADY run out, under somebody rostered on. A renewal six weeks out is a job for
  // this month, not a job for right now, and colouring it costs the screen the tone that means right now.
  const liveRisk = booksOk && due.some((d) => d.expired && d.coming > 0);

  const note = unchecked > 0
    ? ` ${plural(unchecked, "other")} on file ${unchecked === 1 ? "has" : "have"} never been checked — there's no national register for those.`
    : "";
  const top = due[0];
  const sentence = !top
    ? onFile === 0
      ? "No card details on file for your crew. Ask to see them on site."
      : `Nothing runs out in the next ${CARD_HORIZON_DAYS} days.${note}`
    : `${top.first}'s ${top.card} ${top.expired ? `ran out ${agoWords(-top.days)}` : `runs out ${inWords(top.days)}`}.${
      due.length > 1 ? ` ${plural(due.length - 1, "other")} close behind.` : ""}${note}`;

  return {
    due, expired, expiring: due.length - expired, unchecked, onFile, liveRisk, sentence,
    sr: !top
      ? `${onFile === 0 ? "Your crew has no card details on file at all" : `None of the ${plural(onFile, "card")} your crew has on file runs out in the next ${CARD_HORIZON_DAYS} days`}.${note}`
      : `${plural(due.length, "card")} across your crew ${due.length === 1 ? "has" : "have"} run out or runs out inside ${CARD_HORIZON_DAYS} days. ${sentence}${
        liveRisk ? " Someone whose card has already run out is on a shift you have booked." : ""}`,
  };
}
