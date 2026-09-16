import { timingSafeEqual } from "node:crypto";
import { expandStaleShifts } from "@/lib/matching";
import { reconcileOpenInvoices } from "@/lib/billing";
import { qpayConfigured } from "@/lib/qpay";
import { deliverAlerts } from "@/lib/alerts";
import { sweepRateLimits } from "@/lib/ratelimit";
/** Hit this every 4 minutes — also keeps the free-tier Neon compute awake (it sleeps after 5 idle min).
 *  Widens matching on shifts still open after 20 min, re-checks QPay invoices whose callback never landed,
 *  and sends any alert a crash left unsent. */
export async function GET(req: Request) {
  const key = req.headers.get("authorization")?.replace("Bearer ", "") ?? new URL(req.url).searchParams.get("key") ?? "";
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("CRON_SECRET not set", { status: 503 });
  const a = Buffer.from(key), b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return new Response("nope", { status: 401 });
  const [matching, qpay] = await Promise.all([
    expandStaleShifts(),
    qpayConfigured() ? reconcileOpenInvoices().catch((e) => ({ error: String(e?.message ?? e) })) : null,   // billing trouble never stops matching
    sweepRateLimits().catch(() => null),
  ]);
  const alerts = await deliverAlerts().catch((e) => ({ error: String(e?.message ?? e) }));                  // after matching, so this round's offers go too
  return Response.json({ ...matching, ...(qpay ? { qpay } : {}), alerts });
}
