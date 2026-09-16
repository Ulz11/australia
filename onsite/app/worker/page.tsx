import Link from "next/link";
import { Clock, MapPin } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Say, Section } from "@/components/ui";
import { offersFor, openShiftsNear, myBookings } from "@/lib/workerQueries";
import { Calendar } from "./Calendar";
import { ShiftOffers } from "./ShiftOffers";
import { fmtTime, todayIso } from "@/lib/util";
import { savedPushFingerprint } from "@/lib/alerts";
import { AlertsToggle } from "@/components/AlertsToggle";
export const dynamic = "force-dynamic";

/** "212 Marrickville Rd, Marrickville" → "Marrickville". A worker knows the suburb, not the street. */
const suburbOf = (address: string | null) => (address ?? "").split(",").pop()?.trim() || "";

export default async function WorkerHome() {
  const u = await requireRole("worker");
  const [[w], avail, offers, shifts, bookingsAll, notes] = await Promise.all([
    sql`SELECT home IS NOT NULL AS has_home FROM workers WHERE user_id = ${u.id}`,
    sql`SELECT day::text, status FROM availability WHERE worker_id = ${u.id} AND day >= CURRENT_DATE - 45`,
    offersFor(u.id),
    openShiftsNear(u.id),
    myBookings(u.id),
    sql`SELECT id, kind, body FROM notifications WHERE user_id = ${u.id} AND read_at IS NULL AND kind <> 'shift_match' ORDER BY created_at DESC LIMIT 3`,
  ]);
  const today = todayIso();
  const bookings = bookingsAll.filter((b) => ["accepted", "clocked_in", "clocked_out"].includes(b.status));
  const now = bookings.find((b) => b.day === today);
  const nowWords = now?.status === "clocked_in" ? "You're clocked in. Clock out when you finish."
    : now?.status === "clocked_out" ? "Done for the day. Your hours are with the boss."
    : "Clock in on the app when you get to the site.";

  return (
    <>
      <Header title={`G'day, ${u.name?.split(" ")[0]}`} />
      <Page>
        {!w.has_home && (
          <Link href="/worker/me" className="block">
            <Say tone="orange" icon={MapPin} title="Tell us where you live" sub="Tap here. We only show shifts near you." />
          </Link>
        )}

        {now && (
          <div className="say-dark">
            <div className="flex items-start gap-3">
              <Clock size={24} strokeWidth={2.25} aria-hidden className="shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="say-sub">Today</div>
                <div className="say-title">{now.site} · {fmtTime(now.start_time)} start</div>
                <div className="say-sub">{nowWords}</div>
              </div>
            </div>
            <Link href="/worker/shift" className="btn bg-white text-ink w-full mt-3">Open my shift</Link>
          </div>
        )}

        <Section title={offers.length > 0 ? `Offers for you · ${offers.length}` : "Offers for you"}
          hint={offers.length > 0 ? "A boss picked you for these. First to take it gets it." : undefined} />
        {offers.length === 0 ? (
          <div className="card text-steel">
            <div className="font-bold text-ink text-lg">No offers right now.</div>
            Mark the days you're free below and we'll buzz you when a boss nearby needs someone.
          </div>
        ) : (
          <ShiftOffers offers={offers.map((o) => ({
            id: o.id, day: o.day, start_time: o.start_time, hours: Number(o.hours), spots: o.spots, taken: o.taken,
            role: o.role, rate: Number(o.rate), site: o.site, suburb: suburbOf(o.address), dist_m: o.dist_m,
            boss: o.company || o.boss_name, tickets_required: o.tickets_required, tickets_ok: o.tickets_ok, missing: o.missing,
            allow_offers: o.allow_offers, offered: o.offered, direct: o.direct, clash: o.clash,
            ot_mode: o.ot_mode, ot_after_hours: Number(o.ot_after_hours), ot_multiplier: o.ot_multiplier == null ? null : Number(o.ot_multiplier),
          }))} />
        )}

        {process.env.VAPID_PUBLIC_KEY && <AlertsToggle publicKey={process.env.VAPID_PUBLIC_KEY} savedPush={await savedPushFingerprint(u.id)} role="worker" compact />}
        {notes.map((n) => <Say key={n.id} tone={n.kind === "paid" ? "green" : n.kind === "removed" || n.kind === "cancelled" ? "red" : "dark"} title={n.body} />)}

        <Section title="Your days" hint="Tap a day to say if you're free. Bosses nearby only see the days you mark." />
        <Calendar
          availability={Object.fromEntries(avail.map((a) => [a.day, a.status]))}
          shifts={shifts.map((s) => ({ id: s.id, day: s.day, start_time: s.start_time, hours: Number(s.hours), rate: Number(s.rate), role: s.role, site: s.site, dist_m: s.dist_m, boss: s.company || s.boss_name, spots: s.spots, taken: s.taken, tickets_ok: s.tickets_ok, notified: s.notified, mine: s.mine, tickets_required: s.tickets_required, approve_h: s.approve_hours_avg, pay_d: s.pay_days_avg, ot_mode: s.ot_mode, ot_after_hours: Number(s.ot_after_hours), ot_multiplier: s.ot_multiplier == null ? null : Number(s.ot_multiplier), allow_offers: s.allow_offers, offered: s.offered }))}
          bookings={bookings.map((b) => ({ id: b.id, day: b.day, start_time: b.start_time, site: b.site, hours: Number(b.hours), status: b.status }))}
        />
      </Page>
    </>
  );
}
