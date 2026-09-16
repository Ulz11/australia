import { sql } from "@/lib/db";
import { demoConsoleOn } from "@/lib/flags";

/** What just happened, for the control room's live feed. Demo mode only. */
export async function GET() {
  if (!demoConsoleOn()) return new Response("off", { status: 404 });
  const [events, counts] = await Promise.all([
    sql`SELECT n.id, n.kind, n.body, n.user_id, n.created_at, u.name, u.role
        FROM notifications n JOIN users u ON u.id = n.user_id
        ORDER BY n.created_at DESC LIMIT 25`,
    sql`SELECT
          (SELECT COUNT(*) FROM users WHERE role = 'boss')::int AS bosses,
          (SELECT COUNT(*) FROM users WHERE role = 'worker')::int AS workers,
          (SELECT COUNT(*) FROM projects WHERE NOT archived)::int AS sites,
          (SELECT COUNT(*) FROM shifts WHERE status = 'open' AND day >= CURRENT_DATE)::int AS open_shifts,
          (SELECT COUNT(*) FROM bookings WHERE status IN ('accepted','clocked_in'))::int AS live_bookings,
          (SELECT COUNT(*) FROM bookings WHERE status = 'clocked_out')::int AS to_approve,
          (SELECT COUNT(*) FROM bookings WHERE status = 'approved')::int AS owed,
          (SELECT COUNT(*) FROM offers WHERE status = 'pending')::int AS open_offers,
          (SELECT COUNT(*) FROM licences WHERE status = 'unchecked' AND recheck_at IS NULL)::int AS cards_to_check,   -- a card the cron is still re-checking isn't a person's job yet
          (SELECT COUNT(*) FROM notifications WHERE created_at > now() - interval '24 hours')::int AS notifs_24h,
          (SELECT COUNT(*) FROM introductions WHERE billed_at IS NOT NULL)::int AS matches_billed,
          (SELECT COUNT(*) FROM invoices WHERE status = 'open')::int AS invoices_open,
          (SELECT COUNT(*) FROM invoices)::int AS invoices`,
  ]);
  return Response.json({ events, counts: counts[0], at: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
