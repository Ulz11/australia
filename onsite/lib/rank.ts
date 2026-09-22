/**
 * Which one thing needs the boss now, and what everything else waits behind.
 *
 * Today /boss paints every waiting thing the same colour: `state()` (app/boss/page.tsx:41-48) returns
 * tone "orange" for "3 to approve", for "a worker disagrees" and for "Needs 2 more", and Row draws all
 * three identically. So the hole at 6:30 tomorrow — the one that costs a day of concrete and a crane
 * nobody can send home — reads exactly like a licence renewal, and gets scrolled past. This file is the
 * order that ends that. One orange thing: the one with the shortest fuse.
 *
 * Pure. No database, no React, and no reading of the clock — `now` comes in as a parameter, so the whole
 * order can be tested at 5:59am on a Thursday without waiting for Thursday. Dollars arrive already priced
 * by payForShift() upstream; nothing here recomputes what a day is worth.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: **null means we could not check. It never means zero.**
 * Tenant 7 — the green "No." — is an assertion of absence built from all six inputs at once, and a green
 * "nothing needs you" that is really a query that timed out is the worst thing this screen can do: the
 * boss puts the phone down and the hole is still there at 6am. So a missing, errored or malformed input
 * can never reach the all-clear. It returns `state: "unknown"`, which the cell renders white ("We
 * couldn't check just now"), never green. Fail white, never fail green.
 */
import { money } from "./award";
import { hoursUntil } from "./rules";
import { TZ, addDays, fmtDay, fmtTime } from "./util";

/** Inside this many hours a short shift is the top of the list: after tonight there is nobody left to ring. */
export const HERO_HOURS = 24;
/** The week a boss can still do something about. Day 1 belongs to tenant 1. */
export const WEEK_DAYS = 7;
/** An invoice this close is worth the screen. Further out it is just a date. */
export const INVOICE_SOON_DAYS = 3;

/** The six things we ask the database. Any one of them can come back unreadable, and the words say which. */
export type InputName = "shifts" | "approvals" | "disputes" | "deals" | "invoices" | "onSite";

export type RankKey = "hole" | "approve" | "disputed" | "deal" | "week" | "invoice" | "clear";

export type RankedItem = {
  key: RankKey;
  /** 1 is the shortest fuse. The array is already in this order; the number is for tests and telemetry. */
  rank: number;
  /**
   * Orange or green, decided here and nowhere else — this file is the single source of the orange order.
   * It says what a thing *is*; the screen decides the volume (only items[0] may ever render `bg-hv`).
   */
  tone: "needs" | "go";
  label: string;
  /** The one big number. A cell has room for one, so a second figure rides in the sub. */
  figure: string;
  sub: string;
  /** Words for the ink button, or null when there is nothing to do (tenant 7). */
  action: string | null;
  href: string | null;
};

export type Urgency = {
  /** "live" — something needs the boss. "clear" — the green No. "unknown" — fail white, never green. */
  state: "live" | "clear" | "unknown";
  /** Highest first, one item per tenant. Empty only when state is "unknown". */
  items: RankedItem[];
  /** The inputs we could not read. Non-empty means no screen may claim nothing is waiting. */
  unchecked: InputName[];
};

/** A shift still short of workers, in the site's own calendar day and clock. */
export type ShortShift = {
  id: string;
  day: string;          // "2026-09-24"
  start_time: string;   // "06:30"
  spots: number;
  taken: number;
  site: string;
  project_id: string;
  role: string;
  /** "Perth time" — set only when the site's clock is not the reader's, so the sentence never has to guess. */
  tz_words?: string | null;
};

/** Hours clocked out and waiting on a yes. `dollars` is already through payForShift(), summed server-side. */
export type Approvals = { workers: number; hours: number; dollars: number; names: string[]; since: string | Date | null };

export type Dispute = { worker: string; worker_id: string; their_hours: number; your_hours: number; day: string; site: string };

/** A worker asking for different terms. `rate` is null when they asked about hours or wrote a message instead. */
export type Deal = { id: string; worker: string; rate: number | null; shift_rate: number; hours: number; day: string; site: string };

/** Cents, because that is how an invoice is stored. The one division into dollars happens below, out loud. */
export type Invoice = { cents: number; due_day: string; matches: number };

export type OnSite = { workers: number; sites: number };

export type RankInput = {
  now: Date;
  /** The site's zone. Defaults to the app's, which is what every screen used before projects.tz existed. */
  tz?: string;
  shifts: ShortShift[] | null;
  approvals: Approvals | null;
  disputes: Dispute[] | null;
  deals: Deal[] | null;
  invoices: Invoice[] | null;
  onSite: OnSite | null;
};

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d/;

/**
 * Reading an input is all-or-nothing on purpose.
 *
 * A row with a NaN count, or a day the shape of garbage, is a row we cannot place in the order — and
 * quietly dropping it is the same false-absence bug one level down: the hole is still there, we just
 * stopped counting it. So one bad row marks the whole input unchecked, and the screen says so.
 */
const readShifts = (rows: ShortShift[] | null): ShortShift[] | null =>
  Array.isArray(rows) && rows.every((s) => s && fin(s.spots) && fin(s.taken) && DAY.test(s.day) && TIME.test(s.start_time)) ? rows : null;
const readApprovals = (a: Approvals | null): Approvals | null =>
  a && fin(a.workers) && fin(a.hours) && fin(a.dollars) ? a : null;
const readDisputes = (rows: Dispute[] | null): Dispute[] | null =>
  Array.isArray(rows) && rows.every((d) => d && fin(d.their_hours) && fin(d.your_hours) && DAY.test(d.day)) ? rows : null;
const readDeals = (rows: Deal[] | null): Deal[] | null =>
  Array.isArray(rows) && rows.every((d) => d && fin(d.shift_rate) && fin(d.hours) && DAY.test(d.day) && (d.rate == null || fin(d.rate))) ? rows : null;
const readInvoices = (rows: Invoice[] | null): Invoice[] | null =>
  Array.isArray(rows) && rows.every((i) => i && fin(i.cents) && fin(i.matches) && DAY.test(i.due_day)) ? rows : null;
const readOnSite = (o: OnSite | null): OnSite | null => (o && fin(o.workers) && fin(o.sites) ? o : null);

/** Today where the work is, not where the phone is. */
const dayIn = (now: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
/**
 * "Thursday". A plain date has no zone of its own, so it is anchored at UTC midnight and read back in UTC —
 * the only way it can't slide a day either side of midnight in Sydney (the same trick as util.fmtDay).
 */
const weekdayOf = (day: string) => new Date(day + "T00:00:00Z").toLocaleDateString("en-AU", { weekday: "long", timeZone: "UTC" });
const daysApart = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 864e5);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
/** "Sam" out of "Sam Lee", and "" when the name didn't come through — the sentences below handle that. */
const first = (name: string) => String(name ?? "").trim().split(/\s+/)[0] || "";
/** "Jay, Sam and Tui" — and past three it stops naming people and starts counting them. */
const namesInWords = (names: string[]): string => {
  const n = (names ?? []).map((s) => first(s)).filter(Boolean);
  if (n.length === 0) return "";
  if (n.length === 1) return n[0];
  if (n.length <= 3) return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
  return `${n.slice(0, 2).join(", ")} and ${n.length - 2} more`;
};
/** Hours the way a boss writes them: 9, not 9.00. */
const hrs = (n: number) => String(Number(n.toFixed(2)));
const short = (s: ShortShift) => Math.max(0, s.spots - s.taken);

/** How long until the gate opens, in the words a boss would use at the wheel. */
const awayWords = (h: number) => {
  if (h <= 0) return "it started already, still short";
  if (h < 1) return "it starts within the hour";
  return `${plural(Math.round(h), "hour")} away`;
};

/** "since 3:40pm" while it is still the same day; after that the day matters more than the minute. */
const sinceWords = (at: string | Date | null, today: string, tz: string): string => {
  if (at == null) return "";
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return "";
  const day = dayIn(t, tz);
  if (day !== today) return ` — since ${fmtDay(day)}`;
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t);
  const h = parts.find((p) => p.type === "hour")!.value, m = parts.find((p) => p.type === "minute")!.value;
  return ` — since ${fmtTime(`${h}:${m}`)}`;
};

/**
 * The seven tenants, in the order the judges settled on, and why the order is that way:
 *
 *  1 a shift inside 24 h with empty spots — a hole tomorrow costs a day of concrete and a crane, and by
 *    6am it cannot be undone. Everything below can still be fixed at lunchtime.
 *  2 hours waiting on you — someone worked and isn't paid yet. A day of waiting is a day of not trusting.
 *  3 a worker disagrees about hours — an argument that gets worse, not better, with time.
 *  4 a deal request — a worker holding a phone, deciding between your job and someone else's.
 *  5 gaps on days 2-7 — real, but there is time.
 *  6 an invoice — money, but ours, and it can wait a day.
 *  7 nothing live — the green "No.", and the only tenant that has to be *proved*.
 */
export function rankUrgency(input: RankInput): Urgency {
  const tz = input.tz || TZ;
  const now = input.now;
  const items: RankedItem[] = [];
  const unchecked: InputName[] = [];

  // Every judgement below is "how far is this from now", so a clock we can't read makes all six unreadable.
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    return { state: "unknown", items: [], unchecked: ["shifts", "approvals", "disputes", "deals", "invoices", "onSite"] };

  const today = dayIn(now, tz);
  const lastDay = addDays(today, WEEK_DAYS - 1);

  const shifts = readShifts(input.shifts);
  const approvals = readApprovals(input.approvals);
  const disputes = readDisputes(input.disputes);
  const deals = readDeals(input.deals);
  const invoices = readInvoices(input.invoices);
  const onSite = readOnSite(input.onSite);
  if (!shifts) unchecked.push("shifts");
  if (!approvals) unchecked.push("approvals");
  if (!disputes) unchecked.push("disputes");
  if (!deals) unchecked.push("deals");
  if (!invoices) unchecked.push("invoices");
  if (!onSite) unchecked.push("onSite");

  // A shift that hasn't happened yet and is still short. Yesterday's hole isn't something a boss can act
  // on, so it is out; this morning's is in, because a worker can still walk on at ten.
  const week = shifts ? shifts.filter((s) => s.day >= today && s.day <= lastDay) : [];
  const gaps = week.filter((s) => short(s) > 0).map((s) => ({ s, away: hoursUntil(s, now, tz) })).sort((a, b) => a.away - b.away);

  // ── 1 · the hole inside 24 hours
  const soon = gaps.filter((g) => g.away <= HERO_HOURS);
  if (soon.length > 0) {
    const g = soon[0], s = g.s;
    const spots = soon.reduce((n, x) => n + short(x.s), 0);
    const when = s.day === today ? "today" : s.day === addDays(today, 1) ? "tomorrow" : weekdayOf(s.day);
    const more = soon.length > 1 ? `, and ${plural(soon.length - 1, "more job")}` : "";
    items.push({
      key: "hole", rank: 1, tone: "needs",
      label: `Short for ${when}`,
      figure: plural(spots, "spot"),
      sub: `${s.site}, ${fmtTime(s.start_time)} start${s.tz_words ? ` (${s.tz_words})` : ""} — ${awayWords(g.away)}${more}`,
      action: "Ask more workers",
      href: `/boss/shifts/${s.id}`,
    });
  }

  // ── 2 · hours clocked out, waiting on a yes
  if (approvals && approvals.workers > 0) {
    const who = namesInWords(approvals.names) || plural(approvals.workers, "worker");
    items.push({
      key: "approve", rank: 2, tone: "needs",
      label: "Hours waiting on you",
      figure: `${approvals.hours.toFixed(1)} h`,
      sub: `${money(approvals.dollars)} · ${who}${sinceWords(approvals.since, today, tz)}`,
      action: "Approve",
      href: "/boss/approve",
    });
  }

  // ── 3 · a worker disagrees. Oldest first: the argument that has had the longest to set.
  if (disputes && disputes.length > 0) {
    const rows = [...disputes].sort((a, b) => a.day.localeCompare(b.day));
    const d = rows[0], n = rows.length, who = first(d.worker);
    const more = n > 1 ? `, and ${n - 1} more` : "";
    items.push({
      key: "disputed", rank: 3, tone: "needs",
      label: n === 1 ? `${who || "A worker"} disagrees about hours` : `${n} workers disagree about hours`,
      figure: n === 1 ? `${hrs(d.their_hours)} h vs ${hrs(d.your_hours)} h` : `${n} to settle`,
      sub: `${weekdayOf(d.day)}, ${d.site}${more}. Both numbers stay on record.`,
      // The call is the whole action here, so the button says who is being rung. With no name there is
      // nothing to promise, and a button that says "Call" and then can't is worse than one that opens the page.
      action: who ? `Call ${who}` : "Open it",
      href: `/boss/crew/${d.worker_id}`,
    });
  }

  // ── 4 · a deal request. They are looking at other jobs while this sits here.
  if (deals && deals.length > 0) {
    const rows = [...deals].sort((a, b) => a.day.localeCompare(b.day));
    const o = rows[0], n = rows.length, who = first(o.worker) || "A worker";
    const more = n > 1 ? `, and ${n - 1} more` : "";
    const gap = o.rate == null ? 0 : o.rate - o.shift_rate;
    const up = gap > 0;
    items.push({
      key: "deal", rank: 4, tone: "needs",
      label: gap === 0 ? `${who} wants to talk terms` : `${who} wants ${money(o.rate!)} an hour`,
      figure: gap === 0 ? plural(n, "request") : `${up ? "+" : "−"}${money(Math.abs(gap))}/h`,
      sub: gap === 0
        ? `${weekdayOf(o.day)}, ${o.site}${more}.`
        : `${money(Math.abs(gap) * o.hours)} ${up ? "more" : "less"} for the day. ${weekdayOf(o.day)}${more}.`,
      action: "Accept",
      href: "/boss/deals",
    });
  }

  // ── 5 · the rest of the week, named by its worst day — the day you would ring about.
  const later = gaps.filter((g) => g.away > HERO_HOURS);
  if (later.length > 0) {
    const byDay = new Map<string, number>();
    for (const g of later) byDay.set(g.s.day, (byDay.get(g.s.day) ?? 0) + short(g.s));
    const total = [...byDay.values()].reduce((a, b) => a + b, 0);
    // Ties go to the earlier day: it is the one that runs out of time first.
    const [worstDay, worstN] = [...byDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const lead = later.filter((g) => g.s.day === worstDay).sort((a, b) => short(b.s) - short(a.s))[0].s;
    const day = weekdayOf(worstDay);
    items.push({
      key: "week", rank: 5, tone: "needs",
      label: "Short this week",
      figure: plural(total, "spot"),
      sub: total === 1 ? `${day} at ${lead.site}` : worstN === total ? `all of them ${day}` : `${worstN} of them ${day}`,
      action: `Fill ${day}`,
      href: `/boss/post?day=${worstDay}&project=${lead.project_id}&role=${encodeURIComponent(lead.role)}`,
    });
  }

  // ── 6 · the invoice, once it is close enough to matter
  if (invoices && invoices.length > 0) {
    const rows = [...invoices].sort((a, b) => a.due_day.localeCompare(b.due_day));
    const inv = rows[0], out = daysApart(today, inv.due_day);
    if (out <= INVOICE_SOON_DAYS) {
      const late = out < 0 ? `${plural(-out, "day")} ago · ` : "";
      items.push({
        key: "invoice", rank: 6, tone: "needs",
        label: out < 0 ? "Invoice overdue" : out === 0 ? "Invoice due today" : out === 1 ? "Invoice due tomorrow" : `Invoice due ${weekdayOf(inv.due_day)}`,
        // An invoice is stored in cents (lib/invoicing) and money() takes dollars. The division lives here,
        // named and on its own, so the 100× that shipped in 8f912ee can never happen quietly again.
        figure: money(inv.cents / 100) + (rows.length > 1 ? ` + ${rows.length - 1} more` : ""),
        sub: `${late}${plural(inv.matches, "introduction")} this fortnight`,
        action: "Open the invoice",
        href: "/boss/money",
      });
    }
  }

  if (items.length > 0) return { state: "live", items, unchecked };

  // ── 7 · nothing live. Only reachable when all six inputs answered; anything short of that is white.
  if (unchecked.length > 0) return { state: "unknown", items: [], unchecked };

  const site = onSite!;
  const bills = invoices!;
  const on = site.workers === 0 ? "Nobody on site today"
    : site.sites > 1 ? `${site.workers} on site across ${plural(site.sites, "site")}`
    : `${site.workers} on site`;
  const jobs = week.length === 0 ? "nothing booked in the next week"
    : week.length === 1 ? "your one job is full"
    : week.length === 2 ? "both jobs full"
    : `all ${week.length} jobs full`;
  const next = [...bills].sort((a, b) => a.due_day.localeCompare(b.due_day))[0];
  const bill = !next ? "no invoice this fortnight"
    : `invoice not due until ${daysApart(today, next.due_day) <= WEEK_DAYS ? weekdayOf(next.due_day) : fmtDay(next.due_day)}`;

  return {
    state: "clear",
    items: [{
      key: "clear", rank: 7, tone: "go",
      label: "Anything waiting on you?",
      figure: "No",
      sub: [on, jobs, bill].join(" · "),
      action: null,
      href: null,
    }],
    unchecked: [],
  };
}
