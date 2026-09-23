import type { TransactionSql } from "postgres";
import { sql } from "./db";
import { TZ } from "./util";
import {
  dueDateFor, gstRegistered, invoiceNumber, matchFeeCents,
  matchLineDescription, nextPeriod, splitGst,
} from "./subscription";

/**
 * Invoices, written to the database. No card and nothing here moves money: an invoice is a record with a
 * number on it. The boss pays it through QPay (lib/invoiceQpay.ts), and settling that QPay invoice marks this
 * one paid (lib/billing.ts). npm run billing:paid marks one paid by hand, for anything settled another way.
 *
 * An invoice bills introductions and nothing else — $2 each, every 14 days. There is no subscription line
 * and no line that isn't a match, so a fortnight in which OnSite introduced nobody produces **no invoice at
 * all**. That is the ordinary outcome for a quiet boss, not an error: writeInvoice returns null, the period
 * still moves on, and the screens have to say "nothing owed" in words rather than show a $0.00 invoice a
 * boss would open expecting to owe something.
 *
 * Everything that writes one goes through closePeriod(), which is the same idempotent step wherever it is
 * called from. It locks the boss's row, collects the unbilled introductions, writes at most one invoice, and
 * moves the fortnight on. Running it twice for the same fortnight writes nothing the second time:
 * (boss_id, period_start) is unique, and an introduction already on a line is never picked up again.
 */

export type BossBilling = {
  user_id: string;
  company: string;
  abn: string | null;
  period_started_at: string | null;
  period_ends_at: string | null;
};

export type InvoiceRow = {
  id: string; number: string; boss_id: string;
  period_start: string; period_end: string; issued_at: string; due_at: string;
  subtotal_cents: number; gst_cents: number; total_cents: number;
  status: "open" | "paid" | "void"; paid_at: string | null; paid_note: string | null;
  /** The QPay invoice that can pay this one (migration 011), the whole tögrög it asks for, and the rate it was raised at. */
  qpay_sender_invoice_no: string | null; qpay_amount_mnt: string | number | null; qpay_rate: string | null;
  /** Where that rate came from, the day it is for, and the Sydney day the QPay invoice was raised (migration 012). */
  qpay_rate_source: "mongolbank" | "fallback" | "env" | null; qpay_rate_as_of: string | null; qpay_raised_on: string | null;
  qpay_claimed_at: string | null;
};

export type InvoiceLineRow = {
  id: string; invoice_id: string;
  /**
   * "match" is the only kind written from now on. Invoices raised while there was a subscription still
   * carry their 'subscription' line and are still opened, printed and paid, so the type a read returns
   * keeps it — narrowing it here would only mean the screen renders a shape the database doesn't have.
   */
  kind: "subscription" | "match";
  description: string;
  qty: number; unit_cents: number; amount_cents: number; worker_id: string | null; booking_id: string | null;
};

/** What closePeriod writes. One kind, because one thing is charged. */
type Line = { kind: "match"; description: string; qty: number; unit_cents: number; amount_cents: number; worker_id: string | null; booking_id: string | null; introduction_id?: string };

const BOSS_COLS = sql`b.user_id, b.company, b.abn, b.period_started_at, b.period_ends_at`;

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
 * before the fortnight ended and have never been on an invoice. Anything billed after it ended belongs
 * to the next one. A straggler from a fortnight that closed without an invoice is picked up here rather
 * than quietly forgotten — and so is a match that accrued under the old monthly period, which is how
 * the switch to fortnights bills everyone once and nobody twice.
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

/**
 * Write one invoice and stamp the introductions it billed. Returns null when there is nothing to
 * bill — an empty invoice is not a record of anything, and under $2-a-match that is most fortnights —
 * and null again if this period already has one, which is what makes closing a period safe to repeat.
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

export type CloseOutcome = { invoiced: InvoiceRow | null; closed: boolean };
const NOTHING: CloseOutcome = { invoiced: null, closed: false };

/**
 * Move one boss's billing on by one fortnight, if the fortnight is over. One shape, one transaction:
 * close the fortnight that ended, bill the introductions that accrued in it, open the next one.
 *
 * `closed` says the fortnight moved on; `invoiced` is null whenever there was nothing to bill, which is
 * the common case and not a failure. The two are separate for exactly that reason — a caller that read
 * "no invoice" as "nothing happened" would close the same fortnight again on the next cron run.
 *
 * Safe to run twice. The boss's row is locked for the length of the transaction, so a second run either
 * waits and then finds period_ends_at already in the future, or — for a boss several fortnights behind —
 * closes the next one in turn, which is what should happen. Even if the row lock were lost, nothing is
 * double-billed: (boss_id, period_start) is unique and an introduction is only picked up while its
 * invoice_line_id is null.
 */
export async function closePeriod(bossId: string, opts: { now?: Date } = {}): Promise<CloseOutcome> {
  const now = opts.now ?? new Date();
  return (await sql.begin(async (tx) => {
    const [b] = await tx<BossBilling[]>`SELECT ${BOSS_COLS} FROM bosses b WHERE b.user_id = ${bossId} FOR UPDATE`;
    if (!b?.period_started_at || !b.period_ends_at) return NOTHING;

    const periodStart = new Date(b.period_started_at), periodEnd = new Date(b.period_ends_at);
    if (periodEnd > now) return NOTHING;

    const lines = await matchLines(tx, bossId, periodEnd);
    const invoiced = await writeInvoice(tx, { bossId, periodStart, periodEnd, lines, at: now });
    const next = nextPeriod(periodStart, periodEnd);
    await tx`UPDATE bosses SET period_started_at = ${next.start}, period_ends_at = ${next.end}
             WHERE user_id = ${bossId}`;
    return { invoiced, closed: true };
  })) as CloseOutcome;
}

/**
 * The cron's billing step, every 20 minutes: close the fortnights that are over. Counts only — no ids,
 * no names, nothing that could identify a boss in a log.
 *
 * LIMIT 500 is only safe while bosses' fortnights are spread across the calendar. Each boss's period is
 * anchored to their own signup day (migration 021), never to one shared date, so a run picks up the
 * handful whose fortnight ended in the last 20 minutes rather than the whole book on one morning.
 */
export async function closeBillingPeriods(now = new Date()): Promise<{ closed: number; invoiced: number }> {
  const due = await sql<{ user_id: string }[]>`
    SELECT user_id FROM bosses
    WHERE period_ends_at IS NOT NULL AND period_ends_at <= ${now}
    ORDER BY period_ends_at
    LIMIT 500`;
  const out = { closed: 0, invoiced: 0 };
  for (const { user_id } of due) {
    const r = await closePeriod(user_id, { now }).catch((e) => {
      console.error("billing: closing a period failed", (e as { code?: string })?.code ?? "error");   // never the boss or the message
      return null;
    });
    if (!r?.closed) continue;
    out.closed++;
    if (r.invoiced) out.invoiced++;
  }
  return out;
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

/** This fortnight so far: how many introductions are already billable and not yet on an invoice. */
export async function matchesThisFortnight(bossId: string): Promise<number> {
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

/**
 * npm run billing:paid — marks one paid by hand, for money that arrived some other way. QPay payments mark
 * themselves paid (lib/billing.ts). `qpayStillOpen` names a QPay invoice still linked and payable, so the
 * person running it can cancel that on QPay rather than let the boss pay twice.
 */
export async function markInvoicePaid(number: string, note: string | null): Promise<{ ok: true; invoice: InvoiceRow; qpayStillOpen: string | null } | { ok: false; reason: "unknown" | "already_paid" | "void" }> {
  const [existing] = await sql<InvoiceRow[]>`SELECT * FROM invoices WHERE number = ${number}`;
  if (!existing) return { ok: false, reason: "unknown" };
  if (existing.status === "paid") return { ok: false, reason: "already_paid" };
  if (existing.status === "void") return { ok: false, reason: "void" };
  const [invoice] = await sql<(InvoiceRow & { qpay_still_open: string | null })[]>`
    UPDATE invoices i SET status = 'paid', paid_at = now(), paid_note = ${note}
    WHERE i.number = ${number} AND i.status = 'open'
    RETURNING i.*, (SELECT q.sender_invoice_no FROM qpay_invoices q WHERE q.sender_invoice_no = i.qpay_sender_invoice_no AND q.status = 'open') AS qpay_still_open`;
  if (!invoice) return { ok: false, reason: "already_paid" };
  const { qpay_still_open, ...row } = invoice;
  return { ok: true, invoice: row, qpayStillOpen: qpay_still_open };
}
