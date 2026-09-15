import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Say } from "@/components/ui";
import { OfferRow } from "./OfferRow";
import { fmtDay, fmtTime } from "@/lib/util";
import Link from "next/link";
export const dynamic = "force-dynamic";

export default async function MyOffers() {
  const u = await requireRole("worker");
  const offers = await sql`
    SELECT o.*, o.start_time::text AS start_txt, s.rate AS shift_rate, s.hours AS shift_hours, s.start_time::text AS shift_start,
           s.day, s.status AS shift_status, p.name AS site, us.name AS boss_name, bo.company
    FROM offers o JOIN shifts s ON s.id = o.shift_id JOIN projects p ON p.id = s.project_id
    JOIN users us ON us.id = s.boss_id JOIN bosses bo ON bo.user_id = s.boss_id
    WHERE o.worker_id = ${u.id} AND o.status <> 'countered'
    ORDER BY o.created_at DESC LIMIT 40`;
  const live = offers.filter((o) => o.status === "pending");
  const past = offers.filter((o) => o.status !== "pending");

  return (
    <>
      <Header title="My requests" back="/worker" />
      <Page>
        {offers.length === 0 ? (
          <Empty>
            <div className="font-extrabold text-ink text-xl mb-1">No requests yet</div>
            <div className="mb-4">Found a job you like but the pay or hours don't suit? Open it and tap <b>Ask for a different deal</b>.</div>
            <Link href="/worker/explore" className="btn-primary">See what's near me</Link>
          </Empty>
        ) : (
          <>
            {live.length > 0 && <Say tone="orange" title={`${live.length} waiting on a boss`} sub="You'll get a message the moment one answers." />}
            {live.map((o) => <OfferRow key={o.id} o={pack(o)} />)}
            {past.length > 0 && <div className="text-xl font-extrabold pt-2">Done</div>}
            {past.map((o) => <OfferRow key={o.id} o={pack(o)} />)}
          </>
        )}
      </Page>
    </>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pack(o: any) {
  return {
    id: o.id, status: o.status, from_role: o.from_role, message: o.message,
    rate: o.rate == null ? null : Number(o.rate), hours: o.hours == null ? null : Number(o.hours),
    start_time: o.start_txt ? String(o.start_txt).slice(0, 5) : null,
    shift_rate: Number(o.shift_rate), shift_hours: Number(o.shift_hours), shift_start: String(o.shift_start).slice(0, 5),
    when: `${fmtDay(o.day)} · ${fmtTime(o.shift_start)}`, site: o.site, boss: o.company || o.boss_name,
    dead: o.shift_status === "cancelled",
  };
}
