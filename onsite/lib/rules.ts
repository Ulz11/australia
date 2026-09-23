import { AWARD_CASUAL_FLOOR, TICKETS, round2 } from "./award";

/** Hourly rate a boss may post: never under the Award casual floor; NaN/garbage → floor. */
export function clampRate(rate: unknown): number {
  const n = Number(rate);
  if (!Number.isFinite(n)) return AWARD_CASUAL_FLOOR;
  return round2(Math.max(AWARD_CASUAL_FLOOR, n));
}

/** Ticket codes for a shift/worker: White Card first, known codes only, no duplicates. */
export function normaliseTickets(codes: unknown[]): string[] {
  const known = Object.keys(TICKETS);
  const out = ["WC"];
  for (const c of codes) if (typeof c === "string" && known.includes(c) && !out.includes(c)) out.push(c);
  return out;
}

export const BATCH_MULTIPLIER = 3; // notify 3× the open spots per round
export const ROUND_MINUTES = 20;   // widen to the next batch after 20 min

/** Workers to notify this round: 3× the spots still open. A 2-person shift wakes 6 phones, not 600. */
export function batchSize(s: { spots: number; taken: number }): number {
  return Math.max(0, s.spots - s.taken) * BATCH_MULTIPLIER;
}

export const NEAR_SITE_M = 300;
/**
 * Ten minutes at the gate, and this file is the only place that number lives.
 *
 * It used to be 15 here and 10 in lib/profileStats.ts, so a worker who clocked in twelve minutes late
 * read "on time" on their own record and "late" on the boss's screen for the identical event — the kind
 * of thing that ends in an argument nobody can settle. It lives here rather than in profileStats because
 * lib/rules.ts is safe for a client component to import and profileStats pulls in the database.
 */
export const ON_TIME_GRACE_MIN = 10;
export type ClockInLook = "good" | "far" | "late" | "unknown";

/**
 * How a clock-in reads on the record. Nothing is blocked — this is a label, not a gate.
 * Order matters: no GPS → unknown; too far → far; too late → late; else good.
 */
export function clockInLooks(
  shift: { day: string; start_time: string },
  clock: { dist_m: number | null; at: string | Date },
  tz = "Australia/Sydney",
): ClockInLook {
  if (clock.dist_m == null) return "unknown";
  if (clock.dist_m > NEAR_SITE_M) return "far";
  const at = new Date(clock.at);
  const [h, m] = shift.start_time.split(":").map(Number);
  // scheduled start, expressed as minutes-of-day in site time; compare to the clock-in in the same zone
  const local = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const lh = Number(local.find((p) => p.type === "hour")!.value), lm = Number(local.find((p) => p.type === "minute")!.value);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
  const lateBy = (lh * 60 + lm) - (h * 60 + m);
  if (day !== shift.day || lateBy > ON_TIME_GRACE_MIN) return "late";
  return "good";
}

// ─────────────────────────────────────────── overtime agreed before the shift
import { payForDay, money, type PayLine } from "./award";

export type OtMode = "award" | "flat" | "custom";
export type OtTerms = { ot_mode: OtMode; ot_after_hours: number | string; ot_multiplier: number | string | null };
export type ShiftPay = PayLine & {
  /** true when the Award paid more than the agreed terms, so the Award was used */
  appliedFloor: boolean;
  /** plain sentence for the pay screen, e.g. "8h at $40.00, then 2h at 2× ($80.00)" */
  words: string;
};

/**
 * What a day is worth under the terms agreed when the shift was posted.
 *
 * The agreed terms are the promise; the Award is the floor. We work out both and
 * pay the higher, so a boss can offer better than the Award but never worse —
 * which is what stops the argument at the end of the week.
 */
export function payForShift(hoursIn: number, rateIn: number, terms: OtTerms): ShiftPay {
  const hours = Number.isFinite(Number(hoursIn)) ? Math.max(0, Number(hoursIn)) : 0;
  const rate = clampRate(rateIn);
  const after = Math.max(0, Number(terms.ot_after_hours ?? 8));
  const mult = terms.ot_multiplier == null ? null : Number(terms.ot_multiplier);

  const floor = payForDay(hours, rate, "award");
  let agreed: PayLine;
  if (terms.ot_mode === "award") agreed = floor;
  else if (terms.ot_mode === "flat") agreed = payForDay(hours, rate, "flat");
  else {
    const ordinary = Math.min(hours, after);
    const over = Math.max(0, hours - after);
    const m = mult && mult > 0 ? mult : 1;
    const gross = round2(ordinary * rate + over * rate * m);
    agreed = { ordinary, ot150: over, ot200: 0, gross, superAmt: round2(gross * 0.12) };
  }

  const appliedFloor = floor.gross > agreed.gross;
  const line = appliedFloor ? floor : agreed;
  return { ...line, appliedFloor, words: describeTerms(hours, rate, appliedFloor ? { ot_mode: "award", ot_after_hours: 8, ot_multiplier: null } : terms) };
}

function describeTerms(hours: number, rate: number, terms: OtTerms): string {
  const after = Math.max(0, Number(terms.ot_after_hours ?? 8));
  const base = `${trim(Math.min(hours, terms.ot_mode === "flat" ? hours : after))}h at ${money(rate)}`;
  if (terms.ot_mode === "flat" || hours <= after) return base;
  const over = trim(hours - after);
  if (terms.ot_mode === "custom") {
    const m = Number(terms.ot_multiplier) || 1;
    return `${base}, then ${over}h at ${trim(m)}× (${money(round2(rate * m))})`;
  }
  const at150 = Math.min(hours - after, 2), at200 = Math.max(0, hours - after - 2);
  const parts = [base, `${trim(at150)}h at 1.5× (${money(round2(rate * 1.5))})`];
  if (at200 > 0) parts.push(`${trim(at200)}h at 2× (${money(round2(rate * 2))})`);
  return parts.join(", then ");
}
const trim = (n: number) => String(Number(n.toFixed(2)));

/** The sentence a worker reads before taking a shift. */
export function otInWords(terms: OtTerms, rate: number): string {
  const after = trim(Math.max(0, Number(terms.ot_after_hours ?? 8)));
  if (terms.ot_mode === "flat") return `Every hour at ${money(clampRate(rate))}, no overtime rate.`;
  if (terms.ot_mode === "custom") {
    const m = Number(terms.ot_multiplier) || 1;
    return `After ${after} hours, ${trim(m)}× — ${money(round2(clampRate(rate) * m))} an hour.`;
  }
  return `After ${after} hours, 1.5× for two hours, then 2×. (Award)`;
}

// ────────────────────────────────────────────────────── deal requests (offers)
export const MAX_RATE = 300;
export const MAX_SHIFT_HOURS = 14;

export type OfferInput = { rate: number | null; hours: number | null; start_time: string | null; message: string };
export type OfferShift = { rate: number | string; hours: number | string; start_time: string; allow_offers: boolean; spots: number; taken: number; status: string };
export type OfferCheck =
  | { ok: true; changes: string[]; clean: OfferInput }
  | { ok: false; error: string };

/**
 * Validate a worker's deal request against the shift.
 * Anything equal to the shift is dropped, so the boss only ever reads what's different.
 */
export function checkOffer(s: OfferShift, input: OfferInput): OfferCheck {
  if (s.status !== "open") return { ok: false, error: "This shift is gone." };
  if (s.taken >= s.spots) return { ok: false, error: "Just filled. Sorry." };
  if (!s.allow_offers) return { ok: false, error: "This boss isn't taking offers on this shift." };

  const shiftRate = Number(s.rate), shiftHours = Number(s.hours);
  const changes: string[] = [];
  const clean: OfferInput = { rate: null, hours: null, start_time: null, message: String(input.message ?? "").trim().slice(0, 300) };

  if (input.rate != null && Number(input.rate) !== shiftRate) {
    const r = Number(input.rate);
    if (!Number.isFinite(r) || r > MAX_RATE) return { ok: false, error: `Rate has to be a real number under $${MAX_RATE}.` };
    if (r < AWARD_CASUAL_FLOOR) return { ok: false, error: `Can't ask for less than the Award — $${AWARD_CASUAL_FLOOR.toFixed(2)} an hour.` };
    clean.rate = round2(r);
    changes.push(`Rate ${money(shiftRate)} → ${money(clean.rate)}`);
  }
  if (input.hours != null && Number(input.hours) !== shiftHours) {
    const h = Number(input.hours);
    if (!Number.isFinite(h) || h < 1 || h > MAX_SHIFT_HOURS) return { ok: false, error: `Hours have to be between 1 and ${MAX_SHIFT_HOURS}.` };
    clean.hours = h;
    changes.push(`Hours ${Number(shiftHours)} → ${h}`);
  }
  if (input.start_time && input.start_time !== s.start_time.slice(0, 5)) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.start_time)) return { ok: false, error: "That start time doesn't look right." };
    clean.start_time = input.start_time;
    changes.push(`Start ${s.start_time.slice(0, 5)} → ${input.start_time}`);
  }
  if (changes.length === 0 && !clean.message) return { ok: false, error: "Change something or write a message first." };
  return { ok: true, changes, clean };
}

// ──────────────────────────────────────────────────────────── site crew cap
export type CrewStatus = { on: number; target: number | null; spare: number; over: boolean; words: string };

/** How full a site is: the boss's own crew plus anyone booked on upcoming shifts. */
export function crewStatus(x: { crew_target: number | null; own_crew: number; booked_ahead: number }): CrewStatus {
  const on = Math.max(0, x.own_crew) + Math.max(0, x.booked_ahead);
  const target = x.crew_target == null ? null : Math.max(0, Number(x.crew_target));
  if (target == null) return { on, target: null, spare: 0, over: false, words: `${on} on this site` };
  const spare = Math.max(0, target - on);
  const over = on > target;
  return {
    on, target, spare, over,
    words: over ? `${on} on site — ${on - target} over what you set` : spare === 0 ? `${on} of ${target} — site is full` : `${on} of ${target} — room for ${spare} more`,
  };
}

// ──────────────────────────────────────────────────────── weather / rain day
/**
 * What to pay when the weather stops work. A suggestion only — the boss types the
 * final number. Reflects the usual site practice (and the Award's inclement-weather
 * thinking): a worker who turned up gets the day, a worker who didn't gets nothing.
 */
export function weatherSuggestion(x: { scheduled: number; worked: number; clockedIn: boolean }): { hours: number; why: string } {
  const scheduled = Math.max(0, Number(x.scheduled) || 0);
  const worked = Math.max(0, Number(x.worked) || 0);
  if (!x.clockedIn) return { hours: 0, why: "Didn't turn up, so nothing is owed for the day." };
  if (worked > scheduled) return { hours: worked, why: "Worked longer than the shift — pay what they worked." };
  return { hours: scheduled, why: `Turned up and got sent home — the usual thing is to pay the full ${scheduled} hours.` };
}

// ────────────────────────────── what the marketplace simulation taught the engine
/** A worker with fewer shifts than this is "new" and gets a fair go. */
export const NEW_WORKER_SHIFTS = 3;
/** Ranking prior for a worker with no history — mid-pack, not the bottom. */
export const NEW_WORKER_PRIOR = 85;
export const URGENT_HOURS = 3;

export type Candidate = { user_id: string; past_shifts: number; score: number | null; dist_m: number; worked_before: boolean };

/**
 * Take the top N of a ranked pool, but hold one seat for someone new whenever the
 * batch has room for more than one person. Ranking new workers last meant 70% of
 * them never got a single notification in their first fortnight — they'd leave, and
 * the supply the whole thing depends on would leave with them. Costs nothing in fill
 * rate or no-shows (sim/marketplace.py).
 */
export function pickBatch<T extends Candidate>(ranked: T[], n: number): T[] {
  const top = ranked.slice(0, n);
  if (n < 2 || top.some((c) => c.past_shifts < NEW_WORKER_SHIFTS)) return top;
  const newbie = ranked.slice(n).find((c) => c.past_shifts < NEW_WORKER_SHIFTS);
  if (!newbie) return top;
  return [...top.slice(0, n - 1), newbie];
}

/**
 * A shift starting within three hours is an emergency — someone didn't turn up.
 * Wake three times as many phones and widen every 5 minutes instead of 20.
 */
export function urgencyOf(s: { day: string; start_time: string }, now: Date = new Date(), tz = "Australia/Sydney") {
  const hoursAway = hoursUntil(s, now, tz);
  const urgent = hoursAway <= URGENT_HOURS;
  return { urgent, batchMultiplier: urgent ? BATCH_MULTIPLIER * 3 : BATCH_MULTIPLIER, roundMinutes: urgent ? 5 : ROUND_MINUTES };
}

/** Hours from `now` until the shift starts, treating day + start_time as site-local. */
export function hoursUntil(s: { day: string; start_time: string }, now: Date, tz = "Australia/Sydney"): number {
  // Find the UTC offset in force at `now` for the site's zone, then build the start instant.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(now);
  const off = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+10:00";   // e.g. GMT+10:00
  const m = /([+-])(\d{2}):?(\d{2})/.exec(off);
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 600;
  const [h, mi] = s.start_time.slice(0, 5).split(":").map(Number);
  const startUtc = Date.UTC(Number(s.day.slice(0, 4)), Number(s.day.slice(5, 7)) - 1, Number(s.day.slice(8, 10)), h, mi) - offsetMin * 60_000;
  return (startUtc - now.getTime()) / 36e5;
}
