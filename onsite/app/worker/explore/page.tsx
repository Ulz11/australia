import { MapPin } from "lucide-react";
import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page } from "@/components/Header";
import { Say } from "@/components/ui";
import { openShiftsNear } from "@/lib/workerQueries";
import { Explore } from "./Explore";
import Link from "next/link";
export const dynamic = "force-dynamic";

export default async function ExplorePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const u = await requireRole("worker");
  const { q } = await searchParams;
  const [[w], shifts, sites] = await Promise.all([
    sql`SELECT ST_Y(home::geometry) AS lat, ST_X(home::geometry) AS lng, radius_km FROM workers WHERE user_id = ${u.id}`,
    openShiftsNear(u.id, { q }),
    sql`SELECT p.id, p.name, ST_Y(p.location::geometry) AS lat, ST_X(p.location::geometry) AS lng
        FROM projects p, workers w WHERE w.user_id = ${u.id} AND NOT p.archived AND w.home IS NOT NULL AND ST_DWithin(w.home, p.location, w.radius_km * 1000)`,
  ]);
  if (!w?.lat) return (<><Header title="Map" /><Page><Link href="/worker/me" className="block"><Say tone="orange" icon={MapPin} title="Tell us where you live" sub="Tap here. Then the map shows jobs near you." /></Link></Page></>);
  return (
    <>
      <Header title="Map" />
      <Page>
        <Explore home={[w.lng, w.lat]} radiusKm={w.radius_km} q={q ?? ""}
          sites={sites.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }))}
          shifts={shifts.map((s) => ({ id: s.id, project_id: s.project_id, day: s.day, start_time: s.start_time, hours: Number(s.hours), rate: Number(s.rate), role: s.role, site: s.site, dist_m: s.dist_m, boss: s.company || s.boss_name, spots: s.spots, taken: s.taken, tickets_ok: s.tickets_ok, notified: s.notified, mine: s.mine, tickets_required: s.tickets_required, approve_h: s.approve_hours_avg, pay_d: s.pay_days_avg, ot_mode: s.ot_mode, ot_after_hours: Number(s.ot_after_hours), ot_multiplier: s.ot_multiplier == null ? null : Number(s.ot_multiplier), allow_offers: s.allow_offers, offered: s.offered, avail: s.avail }))} />
      </Page>
    </>
  );
}
