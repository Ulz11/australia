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
 *
 * Invoices are paid only through QPay, in tögrög from a Mongolian bank app. The one conversion — AUD cents
 * to whole tögrög at AUD_MNT_RATE, never a tögrög under — lives here too (audCentsToMnt).
 */
import { TZ } from "./util";
import { qpayConfigured } from "./qpay";

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
 * Tögrög per 1 AUD, from AUD_MNT_RATE (Mongolbank's official daily rate, e.g. 2250). Kept as the decimal text
 * it was set as, so the amount is worked out exactly. Null when unset or not a plain positive number — then
 * QPay payment is off rather than charging at a guessed rate.
 */
export function audMntRate(env: Env = process.env): string | null {
  const raw = env.AUD_MNT_RATE?.trim();
  if (!raw || !/^\d{1,9}(\.\d{1,6})?$/.test(raw) || !(Number(raw) > 0)) return null;
  return raw.replace(/^0+(?=\d)/, "");
}

/**
 * What an invoice costs in QPay: the AUD total at the rate, in whole tögrög, rounded up — never a tögrög under.
 * The rule is ceil(total_cents / 100 × rate), done in integers: in floating point 14 cents at 2250 is
 * 315.00000000000006, which would round up to 316.
 */
export function audCentsToMnt(totalCents: number, rate: string): number {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error(`total must be whole cents, got ${totalCents}`);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!m || !(Number(rate) > 0)) throw new Error(`not a rate: ${rate}`);
  const frac = m[2] ?? "";
  const scaledRate = BigInt(m[1] + frac);                         // rate × 10^decimals
  const denominator = BigInt(100) * BigInt(10) ** BigInt(frac.length);
  const numerator = BigInt(totalCents) * scaledRate;
  return Number((numerator + denominator - BigInt(1)) / denominator);
}

/** Invoices can be paid right now: QPay's credentials are set and so is the rate. Read at call time. */
export const qpayPayable = (env: Env = process.env) => qpayConfigured() && audMntRate(env) !== null;

/** "₮72,000" — whole tögrög with thousands separators. */
export const tugrik = (mnt: number | string) => "₮" + Math.round(Number(mnt)).toLocaleString("en-AU");

/** "≈ ₮72,000 at ₮2,250 per $1" — the tögrög amount beside the AUD total it came from. */
export const mntWords = (mnt: number | string, rate: string) =>
  `≈ ${tugrik(mnt)} at ₮${Number(rate).toLocaleString("en-AU", { maximumFractionDigits: 6 })} per $1`;

/** What QPay shows the payer. The invoice number and nothing else — no names, no ABN. */
export const qpayDescription = (number: string) => `OnSite invoice ${number}`;

/** An open invoice when QPay can't take the payment: no rate, or no credentials. Never invents bank details. */
export const QPAY_NOT_SET_UP = "Payment by QPay isn't set up yet — we'll send you payment details.";
/** Under the QR and the bank buttons. */
export const QPAY_HOW_TO = "Pay in your bank app. This page updates by itself once QPay confirms it.";

/** The boss's push when QPay confirms the payment. `{number}` is filled in by the statement that marks it paid. */
export const INVOICE_PAID_WORDS = "Invoice {number} paid — thanks.";
export const invoicePaidWords = (number: string) => INVOICE_PAID_WORDS.replace("{number}", number);

/**
 * The line on every billing screen of a demo deployment. Once QPay can take a payment, the invoices there are
 * no longer harmless examples, and the line says so.
 */
export const demoBillingWords = (qpayOn: boolean) => qpayOn
  ? "This is a demo, but paying an invoice here sends real money through QPay."
  : "This is a demo — invoices here are examples and nothing is charged.";

/** Past its due date and still not paid. The only time an invoice is orange. */
export const isOverdue = (inv: { status: string; due_at: Date | string }, now: Date) =>
  inv.status === "open" && new Date(inv.due_at).getTime() < now.getTime();

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

/** An invoice is due two weeks after it is issued. */
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
