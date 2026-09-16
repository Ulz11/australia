import { randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { createQpayInvoice, cancelQpayInvoice, checkQpayPayment, callbackSig, type QpayInvoice } from "@/lib/qpay";

/**
 * Money in, via QPay. Three moves:
 *  - raiseInvoice: write our row first, then ask QPay — so a callback can never arrive for a row we don't have.
 *  - settleInvoice: ask QPay if it's paid; flip open → paid in one statement. Safe to call any number of times,
 *    and at most one QPay check per invoice every 10 s however often it's called.
 *  - reconcileOpenInvoices: the safety net for a callback that was lost or came early. Re-checks open invoices
 *    on a widening gap (age ÷ 3) for their first 24 h, a few at a time — never a tight poll.
 * Nothing here decides prices. Callers pass whole MNT.
 */

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
    await sql`UPDATE qpay_invoices SET qpay_invoice_id = ${invoice.invoice_id} WHERE sender_invoice_no = ${senderInvoiceNo}`;
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

  const paymentId = check.rows[0]?.payment_id ?? null;
  const paid = Math.round(check.paidAmount);
  if (paid < claim.amount_mnt) {
    await sql`UPDATE qpay_invoices SET payment_id = ${paymentId}, paid_amount_mnt = ${paid} WHERE sender_invoice_no = ${senderInvoiceNo} AND status = 'open' AND (paid_amount_mnt IS NULL OR paid_amount_mnt <= ${paid})`;
    return "underpaid";
  }
  const flipped = await sql`
    UPDATE qpay_invoices SET status = 'paid', payment_id = ${paymentId}, paid_amount_mnt = ${paid}, paid_at = now()
    WHERE sender_invoice_no = ${senderInvoiceNo} AND status = 'open'`;
  return flipped.count ? "paid" : "already_paid";
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
