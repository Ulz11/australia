/**
 * What the boss pays, as arithmetic — no database, no clock of its own. Every function takes the
 * numbers it needs and returns numbers, so the rules can be read and tested on their own.
 *
 * The two charges:
 *   - $33 a month for the pay tools, after a 3-day free trial. The subscription starts by itself
 *     when the trial ends; the first charge date is the trial end.
 *   - $2 the first time OnSite introduces a boss to a worker and that worker's hours are approved.
 *     Introductions bill from day one — the trial covers the subscription, not the matches.
 *
 * Money is whole cents everywhere. Prices are GST-inclusive: when OnSite is registered for GST the
 * invoice says so and shows the GST already inside the total (one eleventh), it is never added on top.
 * Dates that a person reads are Sydney dates (lib/util's TZ).
 */
import { TZ } from "./util";

/** The same loose shape lib/db.ts and lib/privacy.ts read the environment through. */
type Env = Record<string, string | undefined>;

const intEnv = (name: string, fallback: number, env: Env = process.env) => {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
};

/** Read at call time, never frozen at import — the same rule the demo switches follow. */
export const matchFeeCents = (env?: Env) => intEnv("MATCH_FEE_CENTS", 200, env);
export const subscriptionCents = (env?: Env) => intEnv("SUBSCRIPTION_CENTS", 3300, env);
export const trialDays = (env?: Env) => intEnv("TRIAL_DAYS", 3, env);

/** GST_REGISTERED=1 → the invoice shows the GST inside the total. Anything else → no GST line at all. */
export const gstRegistered = (env: Env = process.env) => env.GST_REGISTERED === "1";

/**
 * What an open invoice tells the boss to do. Never invents bank details: without
 * BILLING_PAY_INSTRUCTIONS it promises to send them instead of guessing an account number.
 */
export const payInstructions = (env: Env = process.env) =>
  env.BILLING_PAY_INSTRUCTIONS?.trim() || "We'll send you payment details.";

/** Who the invoice is from. Null when BUSINESS_NAME is unset — the invoice then shows no "From" block. */
export function billingBusiness(env: Env = process.env): { name: string; abn: string | null } | null {
  const name = env.BUSINESS_NAME?.trim();
  if (!name) return null;
  return { name, abn: env.BUSINESS_ABN?.replace(/\s/g, "") || null };
}

/** How long a boss has before the subscription starts. */
export const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
export const trialEndFrom = (signedUpAt: Date, env?: Env) => addDays(signedUpAt, trialDays(env));

/**
 * Anniversary billing: a month later on the same day of the month, with no proration. The 31st of a
 * month that has no 31st lands on the last day of the shorter one (31 Jan → 28 Feb), which is what
 * every subscription does and what "no proration" means here.
 */
export function addMonths(d: Date, n: number): Date {
  const day = d.getUTCDate();
  const shifted = new Date(d.getTime());
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() + n);
  const lastOfMonth = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(day, lastOfMonth));
  return shifted;
}

/** The period that follows this one. Periods never overlap and never leave a gap. */
export const nextPeriod = (start: Date, end: Date) => ({ start: end, end: addMonths(end, 1) });

/** An invoice is a record someone pays by hand, so it is due two weeks after it is issued. */
export const dueDateFor = (issuedAt: Date) => addDays(issuedAt, 14);

/**
 * GST on a GST-inclusive total. One eleventh of the total is the GST already in it — so a $33
 * subscription is $30 plus $3 GST, never $33 plus $3.30.
 */
export function splitGst(totalCents: number, registered: boolean): { subtotal_cents: number; gst_cents: number; total_cents: number } {
  const total = Math.round(totalCents);
  const gst = registered ? Math.round(total / 11) : 0;
  return { subtotal_cents: total - gst, gst_cents: gst, total_cents: total };
}

/** OS-2026-000123 — the year it was issued in, then that year's count. */
export const invoiceNumber = (year: number, seq: number) => `OS-${year}-${String(seq).padStart(6, "0")}`;
/** Checked before a number typed into a URL or a script ever reaches the database. */
export const isInvoiceNumber = (n: string) => /^OS-\d{4}-\d{6}$/.test(n);

export const centsToDollars = (cents: number) => cents / 100;

/** A date the way a boss reads it: "Fri 20 Sept", in Sydney. */
export const fmtBillingDay = (d: Date | string, tz = TZ) =>
  new Date(d).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).replace(",", "");
/** The longer form for an invoice: "20 September 2026". */
export const fmtInvoiceDay = (d: Date | string, tz = TZ) =>
  new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: tz });

export type SubscriptionStatus = "trialing" | "active" | "cancelling" | "lapsed";

export type BillingState = {
  status: SubscriptionStatus;
  trial_ends_at: Date | string | null;
  period_ends_at: Date | string | null;
};

/**
 * The pay tools are the subscription, and they are the only thing that is. Posting shifts, matching,
 * Workers and approving hours never stop — approving is what makes a match billable, so charging for
 * it would mean charging a boss to be charged.
 */
export const payToolsOpen = (status: SubscriptionStatus) => status !== "lapsed";

/**
 * The status in words a boss doesn't have to decode. One line, one number, one date — the same
 * sentence on the Billing screen and in the upsell.
 */
export function statusWords(s: BillingState, env?: Env): { title: string; sub: string } {
  const price = money(subscriptionCents(env));
  const trial = s.trial_ends_at ? fmtBillingDay(s.trial_ends_at) : null;
  const ends = s.period_ends_at ? fmtBillingDay(s.period_ends_at) : null;
  switch (s.status) {
    case "trialing":
      return { title: trial ? `Free trial — ends ${trial}, then ${price} a month` : `Free trial — then ${price} a month`,
               sub: "Cancel any time. Posting shifts, matching and approving hours are always free." };
    case "active":
      return { title: ends ? `Subscribed — next invoice ${ends}` : "Subscribed", sub: `${price} a month for the pay tools.` };
    case "cancelling":
      return { title: ends ? `Cancelling — pay tools until ${ends}` : "Cancelling",
               sub: "No more invoices after that. You can start again whenever you want." };
    case "lapsed":
      return { title: "Not subscribed", sub: `The pay run, approvals record and export are ${price} a month.` };
  }
}

/** The upsell a lapsed boss sees instead of the pay run. */
export function upsellWords(trialEndsAt: Date | string | null, env?: Env): { title: string; sub: string } {
  const price = money(subscriptionCents(env));
  return {
    title: trialEndsAt ? `Your free trial ended on ${fmtBillingDay(trialEndsAt)}.` : "Your free trial has ended.",
    sub: `The pay run, approvals record and export are ${price} a month.`,
  };
}

/** Cents as money, the same way the rest of the app writes it. */
export const money = (cents: number) =>
  "$" + centsToDollars(cents).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$33 a month" with no cents when it is a round number of dollars — for a sentence, not a total. */
export const priceWords = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : money(cents));

/**
 * What this period has cost so far: the matches already billed in it, plus the subscription that
 * will be charged in advance for the next one (never charged while the subscription is ending).
 */
export function periodSoFar(p: { matches: number; status: SubscriptionStatus }, env?: Env) {
  const fee = matchFeeCents(env);
  const matchCents = p.matches * fee;
  const nextSubscription = p.status === "active" || p.status === "trialing" ? subscriptionCents(env) : 0;
  return { matches: p.matches, fee, matchCents, nextSubscription, totalCents: matchCents + nextSubscription };
}

/** The line an invoice carries for one billable match. */
export const matchLineDescription = (workerName: string) => `Introduction — ${workerName}`;
/** The subscription line, always the period it pays for. */
export const subscriptionLineDescription = (start: Date | string, end: Date | string) =>
  `OnSite pay tools — ${fmtInvoiceDay(start)} to ${fmtInvoiceDay(end)}`;
