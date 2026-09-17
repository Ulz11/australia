import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { myBookings } from "@/lib/workerQueries";
import { ShiftLive } from "./ShiftLive";
import { todayIso } from "@/lib/util";
import { getT } from "@/lib/i18n/server";
import Link from "next/link";
export const dynamic = "force-dynamic";

export default async function ShiftPage() {
  const u = await requireRole("worker");
  const t = await getT();
  const all = await myBookings(u.id);
  const today = todayIso();
  const live = all.filter((b) => ["accepted", "clocked_in", "clocked_out"].includes(b.status) && b.day >= today).sort((a, b) => (a.day < b.day ? -1 : 1));
  return (
    <>
      <Header title={t("My shift")} />
      <Page>
        {live.length === 0 ? <Empty><div className="font-extrabold text-ink text-xl mb-2">{t("No shift booked")}</div><Link href="/worker/explore" className="btn-primary">{t("See what's near me")}</Link></Empty> :
          live.map((b, i) => <ShiftLive key={b.id} today={today} b={{ id: b.id, status: b.status, day: b.day, start_time: b.start_time, hours: Number(b.hours), rate: Number(b.rate), role: b.role, note: b.note, site: b.site, address: b.address, lat: b.lat, lng: b.lng, boss_name: b.boss_name, boss_phone: b.boss_phone, boss_id: b.boss_id, company: b.company, clock_in_at: b.clock_in_at, clock_out_at: b.clock_out_at, clock_in_dist_m: b.clock_in_dist_m, hours_worked: b.hours_worked, hours_approved: b.hours_approved }} primary={i === 0} />)}
      </Page>
    </>
  );
}
