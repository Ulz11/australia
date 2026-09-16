import { settleInvoice } from "@/lib/billing";
import { callbackSigOk } from "@/lib/qpay";
/** QPay calls /api/qpay/callback/<our invoice no>/<hmac> when someone pays. Both live in the path, so whatever
 *  QPay appends as a query string can't break it. A bad signature is turned away before the DB or QPay hear of it,
 *  and even a good one only nudges settleInvoice, which asks QPay directly. Bodies stay terse on purpose. */
async function handle(_req: Request, { params }: { params: Promise<{ invoice: string; sig: string }> }) {
  const { invoice, sig } = await params;
  if (!/^[\w-]{1,45}$/.test(invoice) || !callbackSigOk(invoice, sig)) return new Response("not found", { status: 404 });
  try {
    const result = await settleInvoice(invoice);
    if (result === "unknown_invoice") return new Response("not found", { status: 404 });
    if (result === "paid" || result === "already_paid" || result === "closed") return new Response("SUCCESS");
    console.log("qpay callback", invoice, result);
    return new Response("PENDING", { status: 409 });           // not settled yet — let QPay try again; the cron sweep backs this up
  } catch (e) {
    console.error("qpay callback", invoice, e);
    return new Response("check failed", { status: 502 });
  }
}
export const GET = handle;
export const POST = handle;
