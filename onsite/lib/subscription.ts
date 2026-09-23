/**
 * What the boss pays, as arithmetic — no database, no clock of its own. Every function takes the
 * numbers it needs and returns numbers, so the rules can be read and tested on their own.
 *
 * There is one charge, and it is the whole price list:
 *   - $2 the first time OnSite introduces a boss to a worker and that worker's hours are approved.
 *     Repeat shifts with that worker are free forever, and a boss's own crew is never an introduction.
 *
 * Invoiced every 14 days, due 7 days after that. There is no subscription, no trial, no monthly fee
 * and nothing that can lapse — so nothing in the app is ever switched off for not paying, and this
 * file has no notion of a boss's "status" for anything to key off. A fortnight in which OnSite
 * introduced nobody costs nothing and writes no invoice at all (lib/invoicing.ts).
 *
 * Money is whole cents everywhere. Prices are GST-inclusive: when OnSite is registered for GST the
 * invoice says so and shows the GST already inside the total (one eleventh), it is never added on top.
 * Dates that a person reads are Sydney dates (lib/util's TZ).
 *
 * Invoices are paid only through QPay, in tögrög from a Mongolian bank app. The one conversion — AUD cents
 * to whole tögrög at a rate per A$1, never a tögrög under — lives here too (audCentsToMnt). Where the rate
 * comes from is lib/fxRate.ts.
 */
import { TZ } from "./util";
import { qpayConfigured } from "./qpay";
import type { FxSource } from "./fxRate";

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

/**
 * How long a boss has to pay, and why it is its own number rather than the fortnight.
 *
 * The cycle is 14 days. If the terms were 14 days too, every invoice would still be inside its
 * payment window when the next one was raised, so a boss would permanently carry two open invoices
 * and "overdue" would only ever describe an invoice a month old. Seven days means the fortnight's
 * invoice is settled before the next fortnight closes, and one open invoice is the normal state.
 */
export const paymentTermsDays = (env?: Env) => intEnv("PAYMENT_TERMS_DAYS", 7, env);

/** GST_REGISTERED=1 → the invoice shows the GST inside the total. Anything else → no GST line at all. */
export const gstRegistered = (env: Env = process.env) => env.GST_REGISTERED === "1";

/**
 * Tögrög per 1 AUD — per Australian dollar, never per US dollar — from AUD_MNT_RATE, e.g. 2560. The manual rate:
 * lib/fxRate.ts uses it only when the live sources fail, or ahead of them with AUD_MNT_RATE_OVERRIDE=1. Kept as
 * the decimal text it was set as. Null when unset or not a plain positive number.
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

/**
 * Invoices can be paid through QPay: its credentials are set. Read at call time. The rate is looked up live when
 * the boss taps Pay (lib/fxRate.ts), so a rate that is briefly unavailable says so on the tap rather than here.
 */
export const qpayPayable = () => qpayConfigured();

/** "₮72,000" — whole tögrög with thousands separators. */
export const tugrik = (mnt: number | string) => "₮" + Math.round(Number(mnt)).toLocaleString("en-AU");

/** "A$24.00" — where the tögrög sit beside it, the dollars are said to be Australian. */
export const audMoney = (cents: number) => "A" + moneyCents(cents);

/** The rate a tögrög amount was worked out at, and where it came from. Source and day are null on a QR raised before they were kept. */
export type RateUsed = { rate: number | string; source: FxSource | null; asOf: string | null };

/** "17 Sept" — the day a rate is for (a plain date, so read as written, not moved into another time zone). */
export const fmtRateDay = (asOf: string) =>
  new Date(`${asOf}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });

/** "Bank of Mongolia rate for 17 Sept: ₮2,559.03 per A$1" */
export function rateWords(r: RateUsed): string {
  const n = Number(r.rate);
  const per = `₮${n.toLocaleString("en-AU", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 6 })} per A$1`;
  if (r.source === "mongolbank" && r.asOf) return `Bank of Mongolia rate for ${fmtRateDay(r.asOf)}: ${per}`;
  if (r.source === "fallback" && r.asOf) return `ExchangeRate-API rate for ${fmtRateDay(r.asOf)}: ${per}`;
  if (r.source === "env") return `Rate set by OnSite: ${per}`;
  return `at ${per}`;
}

/** "≈ ₮77,550 · Bank of Mongolia rate for 17 Sept: ₮2,350 per A$1" — the tögrög amount beside the A$ total it came from. */
export const mntWords = (mnt: number | string, r: RateUsed) => {
  const words = rateWords(r);
  return `≈ ${tugrik(mnt)}${words.startsWith("at ") ? " " : " · "}${words}`;
};

/** When no live rate can be had at the tap (lib/fxRate.ts returned null). */
export const FX_UNAVAILABLE = "Couldn't get today's exchange rate — try again in a few minutes.";
/** Where the Pay button would show the tögrög amount, before any rate is known. */
export const FX_AT_TAP = "The tögrög amount is worked out at today's exchange rate when you tap.";

/** What QPay shows the payer. The invoice number and nothing else — no names, no ABN. */
export const qpayDescription = (number: string) => `OnSite invoice ${number}`;

/** An open invoice when QPay can't take the payment: its credentials aren't set. Never invents bank details. */
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

/**
 * Days as milliseconds, added to an instant — never through a local-time date constructor.
 *
 * A fortnight has to be exactly 14 × 24 hours. Sydney's clocks move on the first Sunday in October and
 * the first in April, so a period built by setting a calendar date would be 13 days 23 hours one
 * fortnight a year and 14 days 1 hour another, and the boundary would walk an hour further every six
 * months until a boss's period started at 3am. Instant arithmetic doesn't have that drift.
 */
export const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

/** The billing cycle. Everything a boss is told about money is said in fortnights. */
export const FORTNIGHT_DAYS = 14;

/** The period that follows this one. Periods never overlap and never leave a gap. */
export const nextPeriod = (_start: Date, end: Date) => ({ start: end, end: addDays(end, FORTNIGHT_DAYS) });

/** An invoice is due PAYMENT_TERMS_DAYS after it is issued — seven days, by default. */
export const dueDateFor = (issuedAt: Date, env?: Env) => addDays(issuedAt, paymentTermsDays(env));

/**
 * GST on a GST-inclusive total. One eleventh of the total is the GST already in it — so a fortnight
 * of eleven introductions is $22.00 all up, of which $2.00 is GST, never $22.00 plus $2.20.
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

/**
 * Cents as money, the same way the rest of the app writes it.
 *
 * The name says cents out loud because lib/award.ts has a money() that takes dollars, and the two were
 * once imported side by side under aliases: that is how a $33 subscription shipped as "$3,300.00 a month".
 */
export const moneyCents = (cents: number) =>
  "$" + centsToDollars(cents).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$2 an introduction" with no cents when it is a round number of dollars — for a sentence, not a total. */
export const priceWords = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : moneyCents(cents));

/**
 * What this fortnight has cost so far. Only introductions cost anything, so this is a multiplication —
 * and a boss OnSite introduced nobody to this fortnight owes nothing, which is a real and common answer
 * the screens must be able to say in words rather than as a $0.00 tile.
 */
export function periodSoFar(p: { matches: number }, env?: Env) {
  const fee = matchFeeCents(env);
  return { matches: p.matches, fee, totalCents: p.matches * fee };
}

/** The line an invoice carries for one billable match. It is the only kind of line OnSite writes. */
export const matchLineDescription = (workerName: string) => `Introduction — ${workerName}`;
