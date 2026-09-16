import type { TransactionSql } from "postgres";
import { sql } from "./db";
import { TZ } from "./util";
import {
  addDays, addMonths, gstRegistered, invoiceNumber, matchFeeCents,
  matchLineDescription, nextPeriod, splitGst, subscriptionCents, subscriptionLineDescription,
  trialDays, dueDateFor, payToolsOpen, type SubscriptionStatus,
} from "./subscription";

/**
 * Invoices, written to the database. No card, no gateway, nothing that moves money: an invoice here
 * is a record with a number on it, and a human marks it paid (npm run billing:paid).
 *
 * Everything that writes one goes through closePeriod(), which is the same idempotent step wherever
 * it is called from — the cron, "Start subscription", or re-subscribing. It locks the boss's row,
 * decides the lines, writes at most one invoice, and moves the period on. Running it twice for the
 * same period writes nothing the second time: (boss_id, period_start) is unique, and an introduction
 * that is already on a line is never picked up again.
 */

export type BossBilling = {
  user_id: string;
  company: string;
  abn: string | null;
  subscription_status: SubscriptionStatus;
  trial_ends_at: string | null;
  period_started_at: string | null;
  period_ends_at: string | null;
  subscription_cancelled_at: string | null;
};

export type InvoiceRow = {
  id: string; number: string; boss_id: string;
  period_start: string; period_end: string; issued_at: string; due_at: string;
  subtotal_cents: number; gst_cents: number; total_cents: number;
  status: "open" | "paid" | "void"; paid_at: string | null; paid_note: string | null;
};

export type InvoiceLineRow = {
  id: string; invoice_id: string; kind: "subscription" | "match"; description: string;
  qty: number; unit_cents: number; amount_cents: number; worker_id: string | null; booking_id: string | null;
};

type Line = { kind: "subscription" | "match"; description: string; qty: number; unit_cents: number; amount_cents: number; worker_id: string | null; booking_id: string | null; introduction_id?: string };

const BOSS_COLS = sql`b.user_id, b.company, b.abn, b.subscription_status, b.trial_ends_at, b.period_started_at, b.period_ends_at, b.subscription_cancelled_at`;

export async function bossBilling(bossId: string): Promise<BossBilling | null> {
  const [b] = await sql<BossBilling[]>`SELECT ${BOSS_COLS} FROM bosses b WHERE b.user_id = ${bossId}`;
  return b ?? null;
}

/** The Sydney year an invoice issued now belongs to — invoice numbers count within it. */
const sydneyYear = (at: Date) => Number(at.toLocaleDateString("en-CA", { timeZone: TZ }).slice(0, 4));

/** One number per invoice, sequential within the year, handed out inside the caller's transaction. */
async function takeInvoiceNumber(tx: TransactionSql, at: Date): Promise<string> {
  const year = sydneyYear(at);
  const [row] = await tx<{ last_number: number }[]>`
    INSERT INTO invoice_counters (year, last_number) VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE SET last_number = invoice_counters.last_number + 1
    RETURNING last_number`;
  return invoiceNumber(year, row.last_number);
}

/**
 * The matches this invoice bills: introductions that became billable (approved hours above zero)
 * before the period ended and have never been on an invoice. Anything billed after the period ended
 * belongs to the next one. A straggler from a period that closed without an invoice is picked up
 * here rather than quietly forgotten.
 */
async function matchLines(tx: TransactionSql, bossId: string, before: Date): Promise<Line[]> {
  const rows = await tx<{ id: string; worker_id: string; name: string | null; billed_booking_id: string | null }[]>`
    SELECT i.id, i.worker_id, u.name, i.billed_booking_id
    FROM introductions i JOIN users u ON u.id = i.worker_id
    WHERE i.boss_id = ${bossId} AND i.invoice_line_id IS NULL
      AND i.billed_at IS NOT NULL AND i.billed_at < ${before}
    ORDER BY i.billed_at`;
  const unit = matchFeeCents();
  return rows.map((r) => ({
    kind: "match" as const,
    description: matchLineDescription(r.name ?? "a worker"),
    qty: 1, unit_cents: unit, amount_cents: unit,
    worker_id: r.worker_id, booking_id: r.billed_booking_id, introduction_id: r.id,
  }));
}

const subscriptionLine = (start: Date, end: Date): Line => {
  const unit = subscriptionCents();
  return { kind: "subscription", description: subscriptionLineDescription(start, end), qty: 1, unit_cents: unit, amount_cents: unit, worker_id: null, booking_id: null };
};

/**
 * Write one invoice and stamp the introductions it billed. Returns null when there is nothing to
 * bill — an empty invoice is not a record of anything — and null again if this period already has
 * one, which is what makes closing a period safe to repeat.
 */
async function writeInvoice(tx: TransactionSql, p: { bossId: string; periodStart: Date; periodEnd: Date; lines: Line[]; at: Date }): Promise<InvoiceRow | null> {
  if (!p.lines.length) return null;
  const total = p.lines.reduce((a, l) => a + l.amount_cents, 0);
  if (total <= 0) return null;
  const { subtotal_cents, gst_cents, total_cents } = splitGst(total, gstRegistered());
  const number = await takeInvoiceNumber(tx, p.at);
  const [inv] = await tx<InvoiceRow[]>`
    INSERT INTO invoices (number, boss_id, period_start, period_end, issued_at, due_at, subtotal_cents, gst_cents, total_cents)
    VALUES (${number}, ${p.bossId}, ${p.periodStart}, ${p.periodEnd}, ${p.at}, ${dueDateFor(p.at)}, ${subtotal_cents}, ${gst_cents}, ${total_cents})
    ON CONFLICT (boss_id, period_start) DO NOTHING
    RETURNING *`;
  if (!inv) return null;                       // this period is already invoiced; the number is simply skipped
  for (const l of p.lines) {
    const [line] = await tx<{ id: string }[]>`
      INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents, amount_cents, worker_id, booking_id)
      VALUES (${inv.id}, ${l.kind}, ${l.description}, ${l.qty}, ${l.unit_cents}, ${l.amount_cents}, ${l.worker_id}, ${l.booking_id})
      RETURNING id`;
    if (l.introduction_id)
      await tx`UPDATE introductions SET invoice_line_id = ${line.id} WHERE id = ${l.introduction_id} AND invoice_line_id IS NULL`;
  }
  return inv;
}

export type CloseOutcome = { invoiced: InvoiceRow | null; lapsed: boolean; trialEnded: boolean; closed: boolean };
const NOTHING: CloseOutcome = { invoiced: null, lapsed: false, trialEnded: false, closed: false };

/**
 * Move one boss's billing on by one step, if a step is due. Three shapes, one transaction:
 *
 *   - the trial is over    → the subscription starts, and the first invoice goes out: this month's
 *                            subscription in advance, plus every match billed during the trial
 *   - the period is over   → next month's subscription in advance (unless the subscription is
 *                            ending, in which case it lapses instead) plus the matches this period
 *   - `force`              → "Start subscription" or re-subscribing: a period starting now, invoiced
 *                            at once, whatever the boss's status was
 *
 * Nothing due, nothing happens. No invoice is written for $0.
 */
export async function closePeriod(bossId: string, opts: { force?: boolean; now?: Date } = {}): Promise<CloseOutcome> {
  const now = opts.now ?? new Date();
  return (await sql.begin(async (tx) => {
    const [b] = await tx<BossBilling[]>`SELECT ${BOSS_COLS} FROM bosses b WHERE b.user_id = ${bossId} FOR UPDATE`;
    if (!b) return NOTHING;

    if (opts.force) {
      if (b.subscription_status === "active" || b.subscription_status === "cancelling") return NOTHING;   // already paying
      const start = now, end = addMonths(now, 1);
      const lines = [subscriptionLine(start, end), ...(await matchLines(tx, bossId, now))];
      const invoiced = await writeInvoice(tx, { bossId, periodStart: start, periodEnd: end, lines, at: now });
      await tx`UPDATE bosses SET subscription_status = 'active', period_started_at = ${start}, period_ends_at = ${end},
                 subscription_cancelled_at = NULL, trial_ends_at = COALESCE(trial_ends_at, ${start})
               WHERE user_id = ${bossId}`;
      return { invoiced, lapsed: false, trialEnded: b.subscription_status === "trialing", closed: true };
    }

    // The trial runs out: the subscription starts by itself, and this is the first invoice.
    if (b.subscription_status === "trialing") {
      if (!b.trial_ends_at || new Date(b.trial_ends_at) > now) return NOTHING;
      const trialEnd = new Date(b.trial_ends_at);
      const start = trialEnd, end = addMonths(trialEnd, 1);
      const lines = [subscriptionLine(start, end), ...(await matchLines(tx, bossId, trialEnd))];
      // The invoice covers the trial it closes — that is its period, and it keeps the first invoice
      // clear of the first month's own close later on. The subscription line pays for the month ahead.
      const invoiced = await writeInvoice(tx, { bossId, periodStart: addDays(trialEnd, -trialDays()), periodEnd: trialEnd, lines, at: now });
      await tx`UPDATE bosses SET subscription_status = 'active', period_started_at = ${start}, period_ends_at = ${end} WHERE user_id = ${bossId}`;
      return { invoiced, lapsed: false, trialEnded: true, closed: true };
    }

    if (b.subscription_status !== "active" && b.subscription_status !== "cancelling") return NOTHING;
    if (!b.period_started_at || !b.period_ends_at || new Date(b.period_ends_at) > now) return NOTHING;

    const periodStart = new Date(b.period_started_at), periodEnd = new Date(b.period_ends_at);
    const ending = b.subscription_status === "cancelling";
    const next = nextPeriod(periodStart, periodEnd);
    const lines = [
      ...(ending ? [] : [subscriptionLine(next.start, next.end)]),
      ...(await matchLines(tx, bossId, periodEnd)),
    ];
    const invoiced = await writeInvoice(tx, { bossId, periodStart, periodEnd, lines, at: now });
    await tx`UPDATE bosses SET subscription_status = ${ending ? "lapsed" : b.subscription_status},
               period_started_at = ${next.start}, period_ends_at = ${next.end}
             WHERE user_id = ${bossId}`;
    return { invoiced, lapsed: ending, trialEnded: false, closed: true };
  })) as CloseOutcome;
}

/**
 * The cron's billing step, every 20 minutes: end the trials that are up and close the periods that
 * are over. Counts only — no ids, no names, nothing that could identify a boss in a log.
 */
export async function closeBillingPeriods(now = new Date()): Promise<{ trials_ended: number; closed: number; invoiced: number; lapsed: number }> {
  const due = await sql<{ user_id: string }[]>`
    SELECT user_id FROM bosses
    WHERE (subscription_status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at <= ${now})
       OR (subscription_status IN ('active','cancelling') AND period_ends_at IS NOT NULL AND period_ends_at <= ${now})
    ORDER BY period_ends_at NULLS FIRST
    LIMIT 500`;
  const out = { trials_ended: 0, closed: 0, invoiced: 0, lapsed: 0 };
  for (const { user_id } of due) {
    const r = await closePeriod(user_id, { now }).catch((e) => {
      console.error("billing: closing a period failed", (e as { code?: string })?.code ?? "error");   // never the boss or the message
      return null;
    });
    if (!r?.closed) continue;
    out.closed++;
    if (r.trialEnded) out.trials_ended++;
    if (r.invoiced) out.invoiced++;
    if (r.lapsed) out.lapsed++;
  }
  return out;
}

/** "Start subscription", from the upsell or from Billing. Invoices at once, from a period starting now. */
export const startSubscription = (bossId: string, now = new Date()) => closePeriod(bossId, { force: true, now });

/** Cancel: the pay tools keep working to the end of the period that is paid for, then lapse. */
export async function cancelSubscription(bossId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE bosses SET subscription_status = 'cancelling', subscription_cancelled_at = now()
    WHERE user_id = ${bossId} AND subscription_status IN ('trialing','active')`;
  return rows.count > 0;
}

/**
 * Changed their mind before the period ran out. This month is already paid for, so nothing is
 * invoiced and the period is left exactly as it was — it only takes the ending date off.
 */
export async function resumeSubscription(bossId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE bosses SET subscription_status = 'active', subscription_cancelled_at = NULL
    WHERE user_id = ${bossId} AND subscription_status = 'cancelling'`;
  return rows.count > 0;
}

/** What the boss may use. Only the pay tools are gated; posting, matching and approving never are. */
export async function payToolsAllowed(bossId: string): Promise<{ allowed: boolean; boss: BossBilling | null }> {
  const boss = await bossBilling(bossId);
  return { allowed: !!boss && payToolsOpen(boss.subscription_status), boss };
}

export const listInvoices = (bossId: string) =>
  sql<InvoiceRow[]>`SELECT * FROM invoices WHERE boss_id = ${bossId} ORDER BY issued_at DESC, number DESC`;

export async function invoiceWithLines(number: string, bossId?: string): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] } | null> {
  const [invoice] = await sql<InvoiceRow[]>`
    SELECT * FROM invoices WHERE number = ${number} ${bossId ? sql`AND boss_id = ${bossId}` : sql``}`;
  if (!invoice) return null;
  const lines = await sql<InvoiceLineRow[]>`SELECT * FROM invoice_lines WHERE invoice_id = ${invoice.id} ORDER BY kind DESC, description`;
  return { invoice, lines };
}

/** This period so far: how many matches are already billed in it, for the Billing screen. */
export async function matchesThisPeriod(bossId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM introductions
    WHERE boss_id = ${bossId} AND invoice_line_id IS NULL AND billed_at IS NOT NULL`;
  return r?.n ?? 0;
}

/**
 * Is this pair an introduction OnSite made that hasn't been billed yet? Drives the one line next to
 * the approve button, so the boss sees the $2 before they cause it, not afterwards on an invoice.
 */
export async function unbilledIntroduction(bossId: string, workerId: string): Promise<boolean> {
  const [r] = await sql`
    SELECT 1 FROM introductions WHERE boss_id = ${bossId} AND worker_id = ${workerId} AND billed_at IS NULL`;
  return !!r;
}

/** npm run billing:list — every invoice, newest first, with who it is for. */
export const allInvoices = (limit = 200) =>
  sql<(InvoiceRow & { company: string; boss_name: string | null })[]>`
    SELECT i.*, b.company, u.name AS boss_name
    FROM invoices i JOIN bosses b ON b.user_id = i.boss_id JOIN users u ON u.id = i.boss_id
    ORDER BY i.issued_at DESC, i.number DESC LIMIT ${limit}`;

/** npm run billing:paid — the only way an invoice becomes paid. Nothing in the app charges anything. */
export async function markInvoicePaid(number: string, note: string | null): Promise<{ ok: true; invoice: InvoiceRow } | { ok: false; reason: "unknown" | "already_paid" | "void" }> {
  const [existing] = await sql<InvoiceRow[]>`SELECT * FROM invoices WHERE number = ${number}`;
  if (!existing) return { ok: false, reason: "unknown" };
  if (existing.status === "paid") return { ok: false, reason: "already_paid" };
  if (existing.status === "void") return { ok: false, reason: "void" };
  const [invoice] = await sql<InvoiceRow[]>`
    UPDATE invoices SET status = 'paid', paid_at = now(), paid_note = ${note}
    WHERE number = ${number} AND status = 'open' RETURNING *`;
  return invoice ? { ok: true, invoice } : { ok: false, reason: "already_paid" };
}

