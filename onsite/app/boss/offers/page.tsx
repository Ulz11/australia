import { sql } from "@/lib/db";
import { requireRole } from "@/lib/session";
import { Header, Page, Empty } from "@/components/Header";
import { Say } from "@/components/ui";
import { OfferCard } from "./OfferCard";
import { fmtDay, fmtTime } from "@/lib/util";
export const dynamic = "force-dynamic";

export default async function Offers() {
  const u = await requireRole("boss");
  const rows = await sql`
    SELECT o.id, o.status, o.from_role, o.message, o.rate, o.hours, o.start_time::text AS start_txt, o.created_at,
           s.id AS shift_id, s.day, s.rate AS shift_rate, s.hours AS shift_hours, s.start_time::text AS shift_start,
           s.spots, s.role, p.name AS site, us.name AS worker_name, w.photo, w.years_exp, w.trades,
           CASE WHEN st.past_shifts > 0 THEN ROUND(100.0 * st.showed / st.past_shifts) END AS score, st.completed,
           (SELECT COUNT(*) FROM bookings b WHERE b.shift_id = s.id AND b.status NOT IN ('removed','cancelled'))::int AS taken
    FROM offers o
    JOIN shifts s ON s.id = o.shift_id JOIN projects p ON p.id = s.project_id
    JOIN users us ON us.id = o.worker_id JOIN workers w ON w.user_id = o.worker_id
    LEFT JOIN worker_stats st ON st.worker_id = o.worker_id
    WHERE s.boss_id = ${u.id} AND o.from_role = 'worker'
    ORDER BY (o.status = 'pending') DESC, o.created_at DESC LIMIT 40`;
  const live = rows.filter((o) => o.status === "pending");

  return (
    <>
      <Header title="Requests" back="/boss" />
      <Page>
        {rows.length === 0 ? (
          <Empty>
            <div className="font-extrabold text-ink text-xl mb-1">No requests</div>
            <div>When a worker wants different pay or hours for one of your shifts, it lands here. You say yes, no, or offer your own number.</div>
          </Empty>
        ) : (
          <>
            {live.length > 0
              ? <Say tone="orange" title={`${live.length} worker${live.length > 1 ? "s want" : " wants"} to talk terms`} sub="Answer fast — they're looking at other jobs too." />
              : <Say tone="grey" title="Nothing waiting" sub="Old requests are below." />}
            {rows.map((o) => (
              <OfferCard key={o.id} o={{
                id: o.id, status: o.status, message: o.message,
                rate: o.rate == null ? null : Number(o.rate), hours: o.hours == null ? null : Number(o.hours),
                start_time: o.start_txt ? String(o.start_txt).slice(0, 5) : null,
                shift_rate: Number(o.shift_rate), shift_hours: Number(o.shift_hours), shift_start: String(o.shift_start).slice(0, 5),
                when: `${fmtDay(o.day)} · ${fmtTime(o.shift_start)}`, site: o.site, role: o.role,
                worker: o.worker_name, photo: o.photo, years: o.years_exp, trades: o.trades ?? [],
                score: o.score == null ? null : Number(o.score), done: Number(o.completed ?? 0),
                full: o.taken >= o.spots,
              }} />
            ))}
          </>
        )}
      </Page>
    </>
  );
}
