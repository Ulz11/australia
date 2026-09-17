import { sql } from "./db";
import { qpayConfigured, type QpayQr } from "./qpay";
import { ONSITE_INVOICE, raiseInvoice, retireInvoice, settleInvoice } from "./billing";
import { QPAY_NOT_SET_UP, audCentsToMnt, audMntRate, qpayDescription } from "./subscription";
import type { InvoiceRow } from "./invoicing";

/**
 * An OnSite invoice, paid through QPay — the only way one is paid.
 *
 * Nothing is raised on QPay until the boss taps "Pay with QPay" (payInvoiceWithQpay). A tap then:
 *   - reuses the QPay invoice already linked, if it is still open and asks for the same tögrög at today's rate;
 *   - otherwise retires the old one (cancelled on QPay, and checked for money first) and raises a new one,
 *     storing the link, amount and rate in one statement.
 * Two taps at once raise one: a tap first takes a short lease on the invoice row (invoices.qpay_claimed_at).
 * The lease is a plain column, never a held transaction, because QPay can take seconds to answer and the
 * pool is two connections. The other tap waits for the lease to go and then reuses what the first one made.
 *
 * Settling lives in lib/billing.ts (settleInvoice → markPaid), which every path goes through: QPay's callback,
 * the cron's reconcile, and this page's poll (invoicePayStatus).
 */

export type InvoicePayState =
  | { kind: "closed" }                                                             // paid or cancelled
  | { kind: "unavailable" }                                                        // no rate, or no QPay credentials
  | { kind: "button"; amountMnt: number; rate: string; watch: boolean }            // tap to get a QR; watch: an older one is still open, keep checking it
  | { kind: "qr"; amountMnt: number; rate: string; qr: QpayQr };                   // ready to pay

export type PayFailure = "not_found" | "closed" | "unavailable" | "busy" | "qpay_failed";
export type PayResult = { ok: true; state: "ready" | "paid" } | { ok: false; reason: PayFailure };
/** What the Pay button's form keeps between taps. */
export type PayFormState = { error: string | null };

export const payFailureWords: Record<PayFailure, string> = {
  not_found: "We couldn't find that invoice.",
  closed: "There's nothing left to pay on this invoice.",
  unavailable: QPAY_NOT_SET_UP,
  busy: "Your QR code is still being made. Give it a few seconds and tap again.",
  qpay_failed: "Couldn't get a QR code from QPay just now. Nothing was charged — try again in a minute.",
};

/** A lease older than this is a tap that died. Longer than the slowest QPay round (every call times out, with one re-login). */
const CLAIM = "3 minutes";
const WAIT_MS = 20_000, WAIT_STEP_MS = 250;

type Linked = {
  id: string; number: string; status: InvoiceRow["status"]; total_cents: number;
  qpay_sender_invoice_no: string | null; qpay_amount_mnt: string | number | null;
  q_status: string | null; q_ready: boolean | null; claimed: boolean;
};

/** One boss's invoice with its QPay link as it stands. Another boss's invoice is simply not found. */
const linked = async (bossId: string, number: string) => (await sql<Linked[]>`
  SELECT i.id, i.number, i.status, i.total_cents, i.qpay_sender_invoice_no, i.qpay_amount_mnt,
         q.status AS q_status, (q.qpay_invoice_id IS NOT NULL AND q.qr IS NOT NULL) AS q_ready,
         (i.qpay_claimed_at IS NOT NULL AND i.qpay_claimed_at > now() - ${CLAIM}::interval) AS claimed
  FROM invoices i LEFT JOIN qpay_invoices q ON q.sender_invoice_no = i.qpay_sender_invoice_no
  WHERE i.number = ${number} AND i.boss_id = ${bossId}`)[0] ?? null;

/** The linked QPay invoice can be paid as it is: open, fully raised, and asking for today's amount. */
const reusable = (r: Linked, amountMnt: number) =>
  r.q_status === "open" && !!r.q_ready && r.qpay_amount_mnt !== null && Number(r.qpay_amount_mnt) === amountMnt;

const settled = (r: Linked | null): PayResult =>
  !r ? { ok: false, reason: "not_found" } : r.status === "paid" ? { ok: true, state: "paid" } : { ok: false, reason: "closed" };

/** The tap. `bossId` must be the signed-in boss: an invoice that isn't theirs is not found, and nothing is raised. */
export async function payInvoiceWithQpay(bossId: string, number: string): Promise<PayResult> {
  const rate = audMntRate();
  if (!rate || !qpayConfigured()) return { ok: false, reason: "unavailable" };
  const first = await linked(bossId, number);
  if (!first || first.status !== "open") return settled(first);
  const amountMnt = audCentsToMnt(first.total_cents, rate);
  if (reusable(first, amountMnt)) return { ok: true, state: "ready" };

  const id = first.id, claimAt = new Date();                         // ms precision, so it compares exactly below
  const [claim] = await sql`
    UPDATE invoices SET qpay_claimed_at = ${claimAt}
    WHERE id = ${id} AND status = 'open' AND (qpay_claimed_at IS NULL OR qpay_claimed_at <= now() - ${CLAIM}::interval)
    RETURNING id`;
  if (!claim) return waitForOtherTap(bossId, number, amountMnt);

  try {
    const now = await linked(bossId, number);                        // as it stands now the lease is ours
    if (!now || now.status !== "open") return settled(now);
    if (reusable(now, amountMnt)) return { ok: true, state: "ready" };

    if (now.qpay_sender_invoice_no && now.q_status === "open" && (await retireInvoice(now.qpay_sender_invoice_no)) === "paid")
      return { ok: true, state: "paid" };                            // the old QR was paid after all — nothing new to raise

    const { senderInvoiceNo } = await raiseInvoice({ userId: bossId, purpose: ONSITE_INVOICE, amountMnt, description: qpayDescription(now.number) });
    const stored = await sql`
      UPDATE invoices SET qpay_sender_invoice_no = ${senderInvoiceNo}, qpay_amount_mnt = ${amountMnt}, qpay_rate = ${rate}, qpay_claimed_at = NULL
      WHERE id = ${id} AND status = 'open' AND qpay_claimed_at = ${claimAt}`;
    if (!stored.count) {
      // Paid or cancelled by hand while QPay was answering, or the lease ran out: this QR must not stay payable.
      await retireInvoice(senderInvoiceNo).catch((e) => console.error("qpay: couldn't retire an unlinked invoice — cancel by hand", senderInvoiceNo, e));
      const after = await linked(bossId, number);
      return after?.status === "open" ? { ok: false, reason: "busy" } : settled(after);
    }
    return { ok: true, state: "ready" };
  } catch (e) {
    console.error("qpay: couldn't set up payment for an invoice", (e as Error)?.message);   // QPay's words, never the boss
    return { ok: false, reason: "qpay_failed" };
  } finally {
    await sql`UPDATE invoices SET qpay_claimed_at = NULL WHERE id = ${id} AND qpay_claimed_at = ${claimAt}`.catch(() => {});
  }
}

/** Another tap holds the lease. Wait for it to finish (briefly), then reuse what it made. */
async function waitForOtherTap(bossId: string, number: string, amountMnt: number): Promise<PayResult> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    const r = await linked(bossId, number);
    if (!r || r.status !== "open") return settled(r);
    if (!r.claimed) return reusable(r, amountMnt) ? { ok: true, state: "ready" } : { ok: false, reason: "busy" };
  }
  return { ok: false, reason: "busy" };
}

/** What the invoice page shows under the total. Reads only — rendering the page never raises anything on QPay. */
export async function invoicePayState(inv: InvoiceRow): Promise<InvoicePayState> {
  if (inv.status !== "open") return { kind: "closed" };
  const rate = audMntRate();
  if (!rate || !qpayConfigured()) return { kind: "unavailable" };
  const amountMnt = audCentsToMnt(inv.total_cents, rate);
  if (!inv.qpay_sender_invoice_no) return { kind: "button", amountMnt, rate, watch: false };
  const [q] = await sql<{ status: string; qr: QpayQr | null; raised: boolean }[]>`
    SELECT status, qr, qpay_invoice_id IS NOT NULL AS raised FROM qpay_invoices WHERE sender_invoice_no = ${inv.qpay_sender_invoice_no}`;
  const open = q?.status === "open" && q.raised;
  if (open && q.qr?.qr_image && inv.qpay_amount_mnt !== null && Number(inv.qpay_amount_mnt) === amountMnt)
    return { kind: "qr", amountMnt, rate: inv.qpay_rate ?? rate, qr: q.qr };
  return { kind: "button", amountMnt, rate, watch: open };
}

/**
 * The page's poll: settle the linked QPay invoice (throttled in settleInvoice to one QPay check per 10 s),
 * then say where the invoice stands. Null when it isn't this boss's invoice.
 */
export async function invoicePayStatus(bossId: string, number: string): Promise<InvoiceRow["status"] | null> {
  const find = async () => (await sql<{ status: InvoiceRow["status"]; qpay_sender_invoice_no: string | null }[]>`
    SELECT status, qpay_sender_invoice_no FROM invoices WHERE number = ${number} AND boss_id = ${bossId}`)[0] ?? null;
  const inv = await find();
  if (!inv) return null;
  if (inv.status !== "open" || !inv.qpay_sender_invoice_no || !qpayConfigured()) return inv.status;
  const r = await settleInvoice(inv.qpay_sender_invoice_no).catch((e) => {
    console.error("qpay: poll check failed", (e as Error)?.message);
    return null;
  });
  if (r !== "paid" && r !== "already_paid") return inv.status;
  return (await find())?.status ?? inv.status;
}
