import { timingSafeEqual } from "node:crypto";
import { expandStaleShifts } from "@/lib/matching";
import { reconcileOpenInvoices } from "@/lib/billing";
import { closeBillingPeriods } from "@/lib/invoicing";
import { qpayConfigured } from "@/lib/qpay";
import { deliverAlerts } from "@/lib/alerts";
import { remindShifts } from "@/lib/reminders";
import { sweepCrewInvites } from "@/lib/crew";
import { sweepRateLimits } from "@/lib/ratelimit";
import { recheckLicences } from "@/lib/licenceRecheck";
import { warmAudToMnt } from "@/lib/fxRate";
/** Vercel Cron hits this every 20 minutes (vercel.json). Neon sleeps after 5 idle minutes, so it can sleep between runs.
 *  Widens matching on shifts still open after 20 min, re-checks QPay invoices whose callback never landed,
 *  keeps today's AUD → MNT rate cached (asking the Bank of Mongolia only when the cached one is over 6 h old),
 *  ends the free trials that are up and closes the billing periods that are over (lib/invoicing.ts),
 *  asks the White Card register again about cards it couldn't answer for (at most 5 a run), writes the
 *  shift reminders that are due (lib/reminders.ts), and sends any alert a crash left unsent. */
export async function GET(req: Request) {
  const key = req.headers.get("authorization")?.replace("Bearer ", "") ?? new URL(req.url).searchParams.get("key") ?? "";
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("CRON_SECRET not set", { status: 503 });
  const a = Buffer.from(key), b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new Response("nope", { status: 401 });
  const [matching, qpay, , fx] = await Promise.all([
    expandStaleShifts(),
    qpayConfigured() ? reconcileOpenInvoices().catch((e) => ({ error: String(e?.message ?? e) })) : null,   // billing trouble never stops matching
    sweepRateLimits().catch(() => null),
    // Warmed so a boss's tap finds a fresh rate. Where it came from and its day only — never the error text.
    (qpayConfigured() ? warmAudToMnt() : Promise.resolve(null))
      .then((q) => ({ source: q?.source ?? null, as_of: q?.asOf ?? null }))
      .catch((e) => { console.error("fx warm failed", e?.name ?? "error"); return { error: "fx failed" }; }),
  ]);
  // Ends the trials that are up and closes the periods that are over — on its own, after matching, so a
  // billing fault can never stop a shift being filled. Counts only, never a boss id.
  const billing = await closeBillingPeriods().catch((e) => {
    console.error("billing run failed", e?.code ?? e?.name ?? "error");
    return { error: "billing failed" };
  });
  // Counts only in what comes back: no card numbers, names or ids, and no error text that could carry one.
  const licences = await recheckLicences().catch((e) => {
    console.error("licence re-check run failed", e?.code ?? e?.name ?? "error");
    return { error: "licence re-check failed" };
  });
  // Reminders before the delivery below, so a shift reminder written this pass goes out in this pass.
  const reminders = await remindShifts().catch((e) => {
    console.error("reminders run failed", e?.code ?? e?.name ?? "error");
    return { error: "reminders failed" };
  });
  // A number a boss typed in is kept only long enough to recognise the person if they sign up (90 days).
  const crew = await sweepCrewInvites().catch(() => ({ error: "crew sweep failed" }));
  const alerts = await deliverAlerts().catch((e) => ({ error: String(e?.message ?? e) }));                  // last, so this round's offers and card results go too
  return Response.json({ ...matching, ...(qpay ? { qpay } : {}), fx, billing, licences, reminders, crew, alerts });
}
