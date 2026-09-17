import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import {
  createQpayInvoice, cancelQpayInvoice, checkQpayPayment, callbackSig, payLinks, qpayGone,
  type PaymentCheck, type QpayInvoice,
} from "@/lib/qpay";
import { sendAlertsSoon } from "@/lib/alerts";
import { INVOICE_PAID_WORDS } from "@/lib/subscription";

/**
 * Money in, via QPay. Four moves:
 *  - raiseInvoice: write our row first, then ask QPay — so a callback can never arrive for a row we don't have.
 *    The QR, short link and bank links QPay hands back are kept on the row while it can be paid.
 *  - settleInvoice: ask QPay if it's paid; flip open → paid in one statement. Safe to call any number of times,
 *    and at most one QPay check per invoice every 10 s however often it's called. When the row pays an OnSite
 *    invoice (purpose onsite_invoice), that same statement marks the OnSite invoice paid and queues the boss's push.
 *  - retireInvoice: cancel one on QPay and make sure no money landed on it first — used when a new one replaces it.
 *  - reconcileOpenInvoices: the safety net for a callback that was lost or came early. Re-checks open invoices
 *    on a widening gap (age ÷ 3) for their first 24 h, a few at a time — never a tight poll.
 * Nothing here decides prices. Callers pass whole MNT.
 */

/** The purpose of a QPay invoice that pays an OnSite invoice (linked from invoices.qpay_sender_invoice_no). */
export const ONSITE_INVOICE = "onsite_invoice";

export async function raiseInvoice(p: { userId: string | null; purpose: string; amountMnt: number; description: string }): Promise<{ senderInvoiceNo: string; invoice: QpayInvoice }> {
  const senderInvoiceNo = `OS-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`.toUpperCase();
  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("NEXT_PUBLIC_BASE_URL must be set so QPay can call back");
  if (process.env.NODE_ENV === "production" && !base.startsWith("https://")) throw new Error("QPay callbacks need an https NEXT_PUBLIC_BASE_URL in production");

  await sql`INSERT INTO qpay_invoices (sender_invoice_no, user_id, purpose, amount_mnt) VALUES (${senderInvoiceNo}, ${p.userId}, ${p.purpose}, ${p.amountMnt})`;
  let invoice: QpayInvoice;
  try {
    invoice = await createQpayInvoice({
      senderInvoiceNo,
      amount: p.amountMnt,
      description: p.description,
      callbackUrl: `${base}/api/qpay/callback/${senderInvoiceNo}/${callbackSig(senderInvoiceNo)}`,
    });
  } catch (e) {
    await sql`UPDATE qpay_invoices SET status = 'failed' WHERE sender_invoice_no = ${senderInvoiceNo}`;
    throw e;
  }
  try {
    await sql`UPDATE qpay_invoices SET qpay_invoice_id = ${invoice.invoice_id}, qr = ${sql.json(payLinks(invoice))}
              WHERE sender_invoice_no = ${senderInvoiceNo}`;
  } catch (e) {
    await cancelQpayInvoice(invoice.invoice_id).catch((ce) =>          // don't leave a payable invoice we can't see
      console.error("qpay orphaned invoice — cancel by hand", { senderInvoiceNo, invoice_id: invoice.invoice_id }, ce));
    throw e;
  }
  return { senderInvoiceNo, invoice };
}

export type SettleResult = "paid" | "already_paid" | "not_paid" | "underpaid" | "closed" | "throttled" | "unknown_invoice";

export async function settleInvoice(senderInvoiceNo: string): Promise<SettleResult> {
  // Claim the right to check: open, has a QPay id, not checked in the last 10 s.
  const [claim] = await sql<{ qpay_invoice_id: string; amount_mnt: number }[]>`
    UPDATE qpay_invoices SET last_checked_at = now()
    WHERE sender_invoice_no = ${senderInvoiceNo} AND status = 'open' AND qpay_invoice_id IS NOT NULL
      AND (last_checked_at IS NULL OR last_checked_at < now() - interval '10 seconds')
    RETURNING qpay_invoice_id, amount_mnt`;
  if (!claim) {
    const [row] = await sql<{ status: string; qpay_invoice_id: string | null }[]>`
      SELECT status, qpay_invoice_id FROM qpay_invoices WHERE sender_invoice_no = ${senderInvoiceNo}`;
    if (!row || !row.qpay_invoice_id) return "unknown_invoice";
    return row.status === "paid" ? "already_paid" : row.status === "open" ? "throttled" : "closed";
  }

  const check = await checkQpayPayment(claim.qpay_invoice_id);
  if (!check.paid) return "not_paid";

  const paid = Math.round(check.paidAmount);
  if (paid < claim.amount_mnt) {
    await sql`UPDATE qpay_invoices SET payment_id = ${check.rows[0]?.payment_id ?? null}, paid_amount_mnt = ${paid} WHERE sender_invoice_no = ${senderInvoiceNo} AND status = 'open' AND (paid_amount_mnt IS NULL OR paid_amount_mnt <= ${paid})`;
    return "underpaid";
  }
  return (await markPaid(senderInvoiceNo, check)) ? "paid" : "already_paid";
}

/**
 * The settlement hook: open → paid, and everything that follows from it, in ONE statement.
 *
 *   q     flips the QPay row (only while it is still open — that is what makes a second run a no-op)
 *   inv   if q pays an OnSite invoice, marks that invoice paid, only while it is still open
 *   told  one push-only notification for the boss, only for an invoice inv actually marked
 *
 * Data-modifying CTEs all run exactly once and commit together, so there is no moment where QPay is paid and
 * the OnSite invoice isn't, and no way for a retry to mark it twice or tell the boss twice. Returns whether
 * this call did the flip.
 */
async function markPaid(senderInvoiceNo: string, check: PaymentCheck): Promise<boolean> {
  const paymentId = check.rows[0]?.payment_id ?? null;
  const paid = Math.round(check.paidAmount);
  const note = paymentId ? `QPay payment ${paymentId}` : "QPay payment";
  const [r] = await sql<{ flipped: number; purpose: string | null; invoices: number }[]>`
    WITH q AS (
      UPDATE qpay_invoices SET status = 'paid', payment_id = ${paymentId}, paid_amount_mnt = ${paid}, paid_at = now(), qr = NULL
      WHERE sender_invoice_no = ${senderInvoiceNo} AND status = 'open'
      RETURNING sender_invoice_no, purpose
    ), inv AS (
      UPDATE invoices i SET status = 'paid', paid_at = now(), paid_note = ${note}
      FROM q
      WHERE q.purpose = ${ONSITE_INVOICE} AND i.qpay_sender_invoice_no = q.sender_invoice_no AND i.status = 'open'
      RETURNING i.boss_id, i.number
    ), told AS (
      INSERT INTO notifications (user_id, kind, body)
      SELECT boss_id, 'invoice_paid', replace(${INVOICE_PAID_WORDS}::text, '{number}', number) FROM inv
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM q)::int AS flipped, (SELECT purpose FROM q) AS purpose, (SELECT count(*) FROM inv)::int AS invoices`;
  if (r.invoices) sendAlertsSoon();
  else if (r.flipped && r.purpose === ONSITE_INVOICE)
    // Money arrived for an invoice that was already paid by hand or cancelled: a person has to sort out a refund.
    console.error("qpay: payment for an OnSite invoice that wasn't open — check it by hand", senderInvoiceNo);
  return r.flipped > 0;
}

export type RetireResult = "cancelled" | "paid" | "closed";

/**
 * Take a QPay invoice out of use because another replaces it. Cancel it on QPay first (an invoice that is
 * already gone is fine), THEN ask whether anything was paid on it — a cancelled invoice can't take a payment,
 * so that answer is final. Paid in full → settled like any payment, and the caller must not raise another.
 * If QPay wouldn't cancel it and it isn't paid, this throws: it may still be payable, and raising a second one
 * beside it could take the same bill twice.
 */
export async function retireInvoice(senderInvoiceNo: string): Promise<RetireResult> {
  const [row] = await sql<{ status: string; qpay_invoice_id: string | null; amount_mnt: number }[]>`
    SELECT status, qpay_invoice_id, amount_mnt FROM qpay_invoices WHERE sender_invoice_no = ${senderInvoiceNo}`;
  if (!row) return "closed";
  if (row.status === "paid") return "paid";
  if (row.status !== "open") return "closed";

  if (row.qpay_invoice_id) {
    let refused: unknown = null;
    await cancelQpayInvoice(row.qpay_invoice_id).catch((e) => { if (!qpayGone(e)) refused = e; });
    const check = await checkQpayPayment(row.qpay_invoice_id);
    const paid = Math.round(check.paidAmount);
    if (check.paid && paid >= row.amount_mnt) {
      await markPaid(senderInvoiceNo, check);
      return "paid";
    }
    if (refused) throw refused;
    if (check.paid) {
      await sql`UPDATE qpay_invoices SET payment_id = ${check.rows[0]?.payment_id ?? null}, paid_amount_mnt = ${paid} WHERE sender_invoice_no = ${senderInvoiceNo}`;
      console.error("qpay: part-paid invoice cancelled — refund it by hand", senderInvoiceNo);
    }
  }
  const done = await sql`UPDATE qpay_invoices SET status = 'cancelled', qr = NULL WHERE sender_invoice_no = ${senderInvoiceNo} AND status = 'open'`;
  if (done.count) return "cancelled";
  const [now] = await sql<{ status: string }[]>`SELECT status FROM qpay_invoices WHERE sender_invoice_no = ${senderInvoiceNo}`;
  return now?.status === "paid" ? "paid" : "closed";                  // a settle got there first
}

export async function reconcileOpenInvoices(limit = 10): Promise<{ checked: number; paid: number; errors: number }> {
  const due = await sql<{ sender_invoice_no: string }[]>`
    SELECT sender_invoice_no FROM qpay_invoices
    WHERE status = 'open' AND qpay_invoice_id IS NOT NULL
      AND created_at BETWEEN now() - interval '24 hours' AND now() - interval '1 minute'
      AND (last_checked_at IS NULL OR last_checked_at < now() - greatest(interval '2 minutes', (now() - created_at) / 3))
    ORDER BY last_checked_at NULLS FIRST, created_at DESC LIMIT ${limit}`;
  const results = await Promise.all(due.map((r) =>
    settleInvoice(r.sender_invoice_no).catch((e) => { console.error("qpay reconcile", r.sender_invoice_no, e); return "error" as const; })));
  return { checked: due.length, paid: results.filter((r) => r === "paid").length, errors: results.filter((r) => r === "error").length };
}
