import { sql } from "./db";
import { qpayConfigured, type QpayQr } from "./qpay";
import { ONSITE_INVOICE, raiseInvoice, retireInvoice, settleInvoice } from "./billing";
import { audToMnt, type FxSource } from "./fxRate";
import { FX_UNAVAILABLE, QPAY_NOT_SET_UP, audCentsToMnt, qpayDescription } from "./subscription";
import { todayIso } from "./util";
import type { InvoiceRow } from "./invoicing";

/**
 * An OnSite invoice, paid through QPay — the only way one is paid.
 *
 * Nothing is raised on QPay until the boss taps "Pay with QPay" (payInvoiceWithQpay). A tap then:
 *   - reuses the QPay invoice already linked if it is still open, was raised today (Sydney), and asks for this
 *     invoice's A$ total at the rate it was raised at. The rate moving during the day doesn't replace it: a QR
 *     the boss may already have open in their bank app stays good until the day is out;
 *   - otherwise — a new day, or the A$ total changed — looks up the live rate (lib/fxRate.ts), retires the old
 *     one (cancelled on QPay, and checked for money first) and raises a new one, storing the link, amount, rate,
 *     where the rate came from, its day and the day it was raised, in one statement.
 * Two taps at once raise one: a tap first takes a short lease on the invoice row (invoices.qpay_claimed_at).
 * The lease is a plain column, never a held transaction, because QPay can take seconds to answer and the
 * pool is two connections. The other tap waits for the lease to go and then reuses what the first one made.
 *
 * Rendering the page never talks to QPay or to a rate source: it shows the linked QR, or an estimate at the
 * cached rate.
 *
 * Settling lives in lib/billing.ts (settleInvoice → markPaid), which every path goes through: QPay's callback,
 * the cron's reconcile, and this page's poll (invoicePayStatus).
 */

/** A tögrög amount and the rate it was worked out at. */
export type PayQuote = { amountMnt: number; rate: string; source: FxSource | null; asOf: string | null };

export type InvoicePayState =
  | { kind: "closed" }                                                             // paid or cancelled
  | { kind: "unavailable" }                                                        // no QPay credentials
  | { kind: "button"; quote: PayQuote | null; watch: boolean }                     // tap to get a QR; quote: an estimate at the cached rate (null: none known yet); watch: an older QR is still open, keep checking it
  | { kind: "qr"; quote: PayQuote; qr: QpayQr };                                   // ready to pay, at the rate it was raised at

export type PayFailure = "not_found" | "closed" | "unavailable" | "no_rate" | "busy" | "qpay_failed";
export type PayResult = { ok: true; state: "ready" | "paid" } | { ok: false; reason: PayFailure };
/** What the Pay button's form keeps between taps. */
export type PayFormState = { error: string | null };

export const payFailureWords: Record<PayFailure, string> = {
  not_found: "We couldn't find that invoice.",
  closed: "There's nothing left to pay on this invoice.",
  unavailable: QPAY_NOT_SET_UP,
  no_rate: FX_UNAVAILABLE,
  busy: "Your QR code is still being made. Give it a few seconds and tap again.",
  qpay_failed: "Couldn't get a QR code from QPay just now. Nothing was charged — try again in a minute.",
};

/** A lease older than this is a tap that died. Longer than the slowest QPay round (every call times out, with one re-login). */
const CLAIM = "3 minutes";
const WAIT_MS = 20_000, WAIT_STEP_MS = 250;

type LinkedQr = Pick<InvoiceRow, "total_cents" | "qpay_amount_mnt" | "qpay_rate" | "qpay_raised_on">;
type Linked = LinkedQr & {
  id: string; number: string; status: InvoiceRow["status"];
  qpay_sender_invoice_no: string | null; q_status: string | null; q_ready: boolean | null; claimed: boolean;
};

/** One boss's invoice with its QPay link as it stands. Another boss's invoice is simply not found. */
const linked = async (bossId: string, number: string) => (await sql<Linked[]>`
  SELECT i.id, i.number, i.status, i.total_cents, i.qpay_sender_invoice_no, i.qpay_amount_mnt, i.qpay_rate, i.qpay_raised_on,
         q.status AS q_status, (q.qpay_invoice_id IS NOT NULL AND q.qr IS NOT NULL) AS q_ready,
         (i.qpay_claimed_at IS NOT NULL AND i.qpay_claimed_at > now() - ${CLAIM}::interval) AS claimed
  FROM invoices i LEFT JOIN qpay_invoices q ON q.sender_invoice_no = i.qpay_sender_invoice_no
  WHERE i.number = ${number} AND i.boss_id = ${bossId}`)[0] ?? null;

/**
 * The stability rule, on what the invoice row remembers: the linked QR was raised today (Sydney), and asks for
 * this A$ total at the rate it was raised at. A changed total no longer works out to the stored amount (a cent
 * is at least ₮10 at any plausible rate). A QR raised before the day was kept counts as another day's.
 */
export const raisedTodayForThisTotal = (r: LinkedQr, today: string) =>
  r.qpay_raised_on === today && r.qpay_rate !== null && r.qpay_amount_mnt !== null &&
  Number(r.qpay_amount_mnt) === audCentsToMnt(r.total_cents, String(r.qpay_rate));

/** The linked QPay invoice can be paid as it is: open, fully raised, and still today's for this total. */
const reusable = (r: Linked, today: string) => r.q_status === "open" && !!r.q_ready && raisedTodayForThisTotal(r, today);

const settled = (r: Linked | null): PayResult =>
  !r ? { ok: false, reason: "not_found" } : r.status === "paid" ? { ok: true, state: "paid" } : { ok: false, reason: "closed" };

/** The tap. `bossId` must be the signed-in boss: an invoice that isn't theirs is not found, and nothing is raised. */
export async function payInvoiceWithQpay(bossId: string, number: string): Promise<PayResult> {
  if (!qpayConfigured()) return { ok: false, reason: "unavailable" };
  const today = todayIso();                                          // one Sydney day for the whole tap
  const first = await linked(bossId, number);
  if (!first || first.status !== "open") return settled(first);
  if (reusable(first, today)) return { ok: true, state: "ready" };

  // Only now is a rate needed: the live one, looked up at the tap (cached for 6 h). Before the lease, so a slow
  // rate source never holds another tap up.
  const fx = await audToMnt();
  if (!fx) return { ok: false, reason: "no_rate" };
  const rate = String(fx.rate);

  const id = first.id, claimAt = new Date();                         // ms precision, so it compares exactly below
  const [claim] = await sql`
    UPDATE invoices SET qpay_claimed_at = ${claimAt}
    WHERE id = ${id} AND status = 'open' AND (qpay_claimed_at IS NULL OR qpay_claimed_at <= now() - ${CLAIM}::interval)
    RETURNING id`;
  if (!claim) return waitForOtherTap(bossId, number, today);

  try {
    const now = await linked(bossId, number);                        // as it stands now the lease is ours
    if (!now || now.status !== "open") return settled(now);
    if (reusable(now, today)) return { ok: true, state: "ready" };

    if (now.qpay_sender_invoice_no && now.q_status === "open" && (await retireInvoice(now.qpay_sender_invoice_no)) === "paid")
      return { ok: true, state: "paid" };                            // the old QR was paid after all — nothing new to raise

    const amountMnt = audCentsToMnt(now.total_cents, rate);
    const { senderInvoiceNo } = await raiseInvoice({ userId: bossId, purpose: ONSITE_INVOICE, amountMnt, description: qpayDescription(now.number) });
    const stored = await sql`
      UPDATE invoices SET qpay_sender_invoice_no = ${senderInvoiceNo}, qpay_amount_mnt = ${amountMnt}, qpay_rate = ${rate},
             qpay_rate_source = ${fx.source}, qpay_rate_as_of = ${fx.asOf}, qpay_raised_on = ${today}, qpay_claimed_at = NULL
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
async function waitForOtherTap(bossId: string, number: string, today: string): Promise<PayResult> {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
    const r = await linked(bossId, number);
    if (!r || r.status !== "open") return settled(r);
    if (!r.claimed) return reusable(r, today) ? { ok: true, state: "ready" } : { ok: false, reason: "busy" };
  }
  return { ok: false, reason: "busy" };
}

/**
 * What the invoice page shows under the total. Reads only — rendering the page never raises anything on QPay and
 * never fetches a rate: a QR raised today shows at the rate it was raised at, anything else shows an estimate at
 * the cached rate (the tap looks up the live one).
 */
export async function invoicePayState(inv: InvoiceRow): Promise<InvoicePayState> {
  if (inv.status !== "open") return { kind: "closed" };
  if (!qpayConfigured()) return { kind: "unavailable" };
  const [q] = inv.qpay_sender_invoice_no
    ? await sql<{ status: string; qr: QpayQr | null; raised: boolean }[]>`
        SELECT status, qr, qpay_invoice_id IS NOT NULL AS raised FROM qpay_invoices WHERE sender_invoice_no = ${inv.qpay_sender_invoice_no}`
    : [];
  const open = q?.status === "open" && q.raised;
  if (open && q.qr?.qr_image && raisedTodayForThisTotal(inv, todayIso()))
    return {
      kind: "qr", qr: q.qr,
      quote: { amountMnt: Number(inv.qpay_amount_mnt), rate: String(inv.qpay_rate), source: inv.qpay_rate_source, asOf: inv.qpay_rate_as_of },
    };
  const fx = await audToMnt({ cachedOnly: true });
  const quote = fx && { amountMnt: audCentsToMnt(inv.total_cents, String(fx.rate)), rate: String(fx.rate), source: fx.source, asOf: fx.asOf };
  return { kind: "button", quote, watch: open };
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
