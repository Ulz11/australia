import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Say } from "@/components/ui";
import { openShiftsNear, myBookings } from "@/lib/workerQueries";
import { Calendar } from "./Calendar";
import Link from "next/link";
export const dynamic = "force-dynamic";

export default async function WorkerHome() {
  const u = await requireRole("worker");
  const [[w], avail, shifts, bookingsAll, notes] = await Promise.all([
    sql`SELECT home IS NOT NULL AS has_home FROM workers WHERE user_id = ${u.id}`,
    sql`SELECT day::text, status FROM availability WHERE worker_id = ${u.id} AND day >= CURRENT_DATE - 45`,
    openShiftsNear(u.id),
    myBookings(u.id),
    sql`SELECT id, kind, body FROM notifications WHERE user_id = ${u.id} AND read_at IS NULL AND kind <> 'shift_match' ORDER BY created_at DESC LIMIT 3`,
  ]);
  const bookings = bookingsAll.filter((b) => ["accepted", "clocked_in", "clocked_out"].includes(b.status));
  const matched = shifts.filter((s) => s.notified && !s.mine).length;
  return (
    <>
      <Header title={`G'day, ${u.name?.split(" ")[0]}`} />
      <Page>
        {!w.has_home && <Link href="/worker/me" className="block"><Say tone="orange" title="Tell us where you live" sub="Tap here. We only show shifts near you." /></Link>}
        {matched > 0 && <Say tone="orange" title={`${matched} shift${matched > 1 ? "s" : ""} near you`} sub="Orange dot on the calendar. Tap the day, then tap Take it." />}
        {notes.map((n) => <Say key={n.id} tone={n.kind === "paid" ? "green" : n.kind === "removed" || n.kind === "cancelled" ? "red" : "dark"} title={n.body} />)}
        <Calendar
          availability={Object.fromEntries(avail.map((a) => [a.day, a.status]))}
          shifts={shifts.map((s) => ({ id: s.id, day: s.day, start_time: s.start_time, hours: Number(s.hours), rate: Number(s.rate), role: s.role, site: s.site, dist_m: s.dist_m, boss: s.company || s.boss_name, spots: s.spots, taken: s.taken, tickets_ok: s.tickets_ok, notified: s.notified, mine: s.mine, tickets_required: s.tickets_required, approve_h: s.approve_hours_avg, pay_d: s.pay_days_avg, ot_mode: s.ot_mode, ot_after_hours: Number(s.ot_after_hours), ot_multiplier: s.ot_multiplier == null ? null : Number(s.ot_multiplier), allow_offers: s.allow_offers, offered: s.offered }))}
          bookings={bookings.map((b) => ({ id: b.id, day: b.day, start_time: b.start_time, site: b.site, hours: Number(b.hours), status: b.status }))}
        />
      </Page>
    </>
  );
}
