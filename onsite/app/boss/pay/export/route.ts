import { sql } from "@/lib/db";
import { getUser } from "@/lib/session";
import { payForShift } from "@/lib/rules";
import { addDays, weekStart, todayIso } from "@/lib/util";

export async function GET(req: Request) {
  const u = await getUser();
  if (!u || u.role !== "boss") return new Response("unauthorised", { status: 401 });
  const ws = weekStart(new URL(req.url).searchParams.get("week") || todayIso());
  const [boss] = await sql`SELECT company FROM bosses WHERE user_id = ${u.id}`;
  const rows = await sql`
    SELECT us.name, us.phone, s.day, COALESCE(b.agreed_rate, s.rate) AS rate, b.hours_approved, b.status, b.pay_reason,
           s.ot_mode, s.ot_after_hours, s.ot_multiplier, p.name AS site, c.type
    FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN users us ON us.id = b.worker_id JOIN projects p ON p.id = s.project_id
    LEFT JOIN crew c ON c.worker_id = b.worker_id AND c.boss_id = ${u.id}
    WHERE s.boss_id = ${u.id} AND b.status IN ('approved','paid') AND s.day BETWEEN ${ws} AND ${addDays(ws, 6)} ORDER BY us.name, s.day`;
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Worker", "Phone", "Type", "Date", "Site", "Hours", "Rate", "Overtime terms", "How it was paid", "Gross", "Super", "Status", "Note"].join(",")];
  for (const r of rows) {
    const p = payForShift(Number(r.hours_approved), Number(r.rate), { ot_mode: r.ot_mode, ot_after_hours: r.ot_after_hours, ot_multiplier: r.ot_multiplier });
    lines.push([r.name, r.phone, r.type ?? "casual", r.day, r.site, r.hours_approved, r.rate, r.ot_mode, p.words + (p.appliedFloor ? " (Award floor applied)" : ""), p.gross, p.superAmt, r.status, r.pay_reason ?? ""].map(esc).join(","));
  }
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${boss.company}-week-${ws}.csv"` } });
}
